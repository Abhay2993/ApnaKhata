-- ============================================================================
-- ApnaKhata — Migration 013: Three-sided consumer graph (loyalty + ONDC)
-- Depends on: 008_customers_voice.sql (customers), schema.sql (inventory, ledger)
--
-- Extends the network from distributor↔retailer to the END CONSUMER:
--   • loyalty_accounts / loyalty_txns — a points program tied to the customer
--     khata; the kirana's customer relationships now live in ApnaKhata, so they
--     can't leave.
--   • ondc_listings / ondc_orders — the kirana's live inventory published as a
--     sellable catalog on the Open Network for Digital Commerce; consumer orders
--     land as retail sales that draw down stock.
-- ============================================================================

BEGIN;

CREATE TYPE loyalty_tier AS ENUM ('SILVER', 'GOLD', 'PLATINUM');
CREATE TYPE loyalty_direction AS ENUM ('EARN', 'REDEEM');

CREATE TABLE loyalty_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID          NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    owner_id        UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    points_balance  INTEGER       NOT NULL DEFAULT 0,
    lifetime_points INTEGER       NOT NULL DEFAULT 0,
    tier            loyalty_tier  NOT NULL DEFAULT 'SILVER',
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT loyalty_one_per_customer UNIQUE (customer_id),
    CONSTRAINT loyalty_points_nonneg    CHECK (points_balance >= 0)
);

CREATE INDEX idx_loyalty_owner ON loyalty_accounts (owner_id, points_balance DESC);

CREATE TABLE loyalty_txns (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID              NOT NULL REFERENCES loyalty_accounts (id) ON DELETE CASCADE,
    direction     loyalty_direction NOT NULL,
    points        INTEGER           NOT NULL,
    reason        VARCHAR(48)       NOT NULL DEFAULT 'PURCHASE',
    ref           VARCHAR(64),
    created_at    TIMESTAMPTZ       NOT NULL DEFAULT now(),

    CONSTRAINT loyalty_txn_points_pos CHECK (points > 0)
);

CREATE INDEX idx_loyalty_txns ON loyalty_txns (account_id, created_at DESC);

CREATE TRIGGER trg_loyalty_touch BEFORE UPDATE ON loyalty_accounts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- --- ONDC storefront ---------------------------------------------------------
CREATE TABLE ondc_listings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sku          VARCHAR(64)   NOT NULL,
    ondc_item_id VARCHAR(64)   NOT NULL,                     -- id on the ONDC network
    price        NUMERIC(12,2) NOT NULL,
    listed_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT ondc_listing_uq UNIQUE (owner_id, sku)
);

CREATE TYPE ondc_order_status AS ENUM ('RECEIVED', 'FULFILLED', 'CANCELLED');

CREATE TABLE ondc_orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    ondc_order_id VARCHAR(64)   NOT NULL,
    buyer_name    VARCHAR(96),
    buyer_phone   VARCHAR(15),
    buyer_pincode VARCHAR(6),
    items         JSONB         NOT NULL,                    -- [{sku,name,qty,price}]
    total         NUMERIC(14,2) NOT NULL,
    status        ondc_order_status NOT NULL DEFAULT 'RECEIVED',
    ledger_id     UUID          REFERENCES transactions_ledger (id),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT ondc_order_uq UNIQUE (owner_id, ondc_order_id)
);

CREATE INDEX idx_ondc_orders ON ondc_orders (owner_id, created_at DESC);

COMMIT;
