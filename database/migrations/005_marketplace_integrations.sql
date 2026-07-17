-- ============================================================================
-- ApnaKhata — Migration 005: Dealer marketplace & billing integrations
-- Depends on: database/schema.sql .. migrations/004_billing_compliance.sql
--
-- Adds:
--   1. Dealer marketplace — dealer_products (a distributor's sellable catalog)
--      so shopkeepers can discover wholesalers and order from them. Ordering
--      reuses the existing purchase-order flow.
--   2. Billing-system integrations — api_integrations (per-integration key +
--      secret for external POS/ERP billing systems) and integration_events
--      (idempotency), so a consumer sale pushed from Tally/Vyapar/Marg/POS
--      decrements inventory live.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy product search

CREATE TYPE integration_source AS ENUM ('TALLY', 'VYAPAR', 'MARG', 'POS', 'CUSTOM');

-- ----------------------------------------------------------------------------
-- 1. Dealer catalog — what a distributor offers to shopkeepers
-- ----------------------------------------------------------------------------
CREATE TABLE dealer_products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dealer_id       UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sku             VARCHAR(64)   NOT NULL,
    product_name    TEXT          NOT NULL,
    category        TEXT          NOT NULL DEFAULT 'GENERAL',
    brand           TEXT,
    hsn_code        VARCHAR(8),
    gst_rate        NUMERIC(4,2)  NOT NULL DEFAULT 0,
    wholesale_price NUMERIC(14,2) NOT NULL,
    mrp             NUMERIC(14,2),
    moq             INTEGER       NOT NULL DEFAULT 1,   -- minimum order quantity
    pack_size       INTEGER       NOT NULL DEFAULT 1,
    unit            VARCHAR(16)   NOT NULL DEFAULT 'PCS',
    lead_time_days  INTEGER       NOT NULL DEFAULT 3,
    available       BOOLEAN       NOT NULL DEFAULT TRUE,
    is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT dealer_sku_uq    UNIQUE (dealer_id, sku),
    CONSTRAINT dealer_price_pos CHECK (wholesale_price >= 0),
    CONSTRAINT dealer_moq_pos   CHECK (moq >= 1),
    CONSTRAINT dealer_pack_pos  CHECK (pack_size >= 1)
);

CREATE INDEX idx_dealer_products_dealer    ON dealer_products (dealer_id) WHERE is_active;
CREATE INDEX idx_dealer_products_category  ON dealer_products (category) WHERE is_active AND available;
CREATE INDEX idx_dealer_products_name_trgm ON dealer_products USING gin (product_name gin_trgm_ops);

CREATE TRIGGER trg_dealer_products_touch
    BEFORE UPDATE ON dealer_products
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. External billing/ERP integrations
-- ----------------------------------------------------------------------------
CREATE TABLE api_integrations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      UUID               NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          TEXT               NOT NULL,
    source        integration_source NOT NULL DEFAULT 'CUSTOM',
    api_key       VARCHAR(48)        NOT NULL UNIQUE,   -- public identifier (X-Integration-Key)
    secret        VARCHAR(96)        NOT NULL,          -- HMAC key (shown once at creation)
    enabled       BOOLEAN            NOT NULL DEFAULT TRUE,
    last_event_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ        NOT NULL DEFAULT now()
);

CREATE INDEX idx_integrations_owner ON api_integrations (owner_id);

-- Idempotency + audit of every ingested event.
CREATE TABLE integration_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id  UUID         NOT NULL REFERENCES api_integrations (id) ON DELETE CASCADE,
    idempotency_key VARCHAR(128) NOT NULL,
    event_type      VARCHAR(32)  NOT NULL,
    payload         JSONB,
    processed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT integration_event_uq UNIQUE (integration_id, idempotency_key)
);

CREATE INDEX idx_integration_events_int ON integration_events (integration_id, processed_at DESC);

COMMIT;
