-- ============================================================================
-- ApnaKhata — Migration 007: Profit analytics & distributor scheme engine
-- Depends on: database/schema.sql .. migrations/006_bnpl_itc_eway.sql
--
-- Adds:
--   1. (No schema) Profit & business-health analytics are read-only over
--      inventory prices + stock_movements + the ledger — see AnalyticsService.
--   2. dealer_schemes — slab / buy-x-get-y / flat-percent trade schemes a
--      distributor attaches to their catalog; applied at quote/order time.
-- ============================================================================

BEGIN;

CREATE TYPE scheme_type AS ENUM ('VOLUME_SLAB', 'BUY_X_GET_Y', 'FLAT_PERCENT');

CREATE TABLE dealer_schemes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dealer_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    scheme_type scheme_type NOT NULL,
    sku         VARCHAR(64),          -- NULL = not product-specific
    category    TEXT,                 -- NULL = not category-specific
    config      JSONB       NOT NULL, -- shape depends on scheme_type (see SchemeService)
    valid_from  DATE,                 -- NULL = open start
    valid_to    DATE,                 -- NULL = open end
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT scheme_dates_ok CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to)
);

CREATE INDEX idx_dealer_schemes_dealer   ON dealer_schemes (dealer_id) WHERE is_active;
CREATE INDEX idx_dealer_schemes_sku      ON dealer_schemes (dealer_id, sku) WHERE is_active AND sku IS NOT NULL;
CREATE INDEX idx_dealer_schemes_category ON dealer_schemes (dealer_id, category) WHERE is_active AND category IS NOT NULL;

CREATE TRIGGER trg_dealer_schemes_touch
    BEFORE UPDATE ON dealer_schemes
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
