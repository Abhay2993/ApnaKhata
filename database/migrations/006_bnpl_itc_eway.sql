-- ============================================================================
-- ApnaKhata — Migration 006: Embedded BNPL financing, GSTR-2B ITC matching,
--                            and e-way bills
-- Depends on: database/schema.sql .. migrations/005_marketplace_integrations.sql
--
-- Adds:
--   1. bnpl_financings — point-of-purchase working-capital financing. A partner
--      NBFC settles a distributor invoice on the shopkeeper's behalf; the
--      shopkeeper repays the NBFC over a short tenure. Eligibility/limit reuse
--      the existing credit score.
--   2. gstr2b_records — the buyer's auto-drafted ITC statement (as filed by
--      suppliers) for reconciliation against their purchase book.
--   3. eway_bills — e-way bill records for goods movement above the threshold.
-- ============================================================================

BEGIN;

CREATE TYPE bnpl_status AS ENUM ('ACTIVE', 'REPAID', 'OVERDUE', 'DEFAULTED');
CREATE TYPE ewb_status  AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED');

-- ----------------------------------------------------------------------------
-- 1. BNPL financings (reuses partner_lender from migration 003)
-- ----------------------------------------------------------------------------
CREATE TABLE bnpl_financings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shopkeeper_id     UUID           NOT NULL REFERENCES users (id),
    lender            partner_lender NOT NULL,
    invoice_id        UUID           NOT NULL REFERENCES transactions_ledger (id),  -- the distributor bill settled
    payment_id        UUID           REFERENCES payments (id),                      -- disbursement to the distributor
    principal         NUMERIC(14,2)  NOT NULL,        -- amount financed
    fee_rate_pct      NUMERIC(5,2)   NOT NULL,        -- flat fee for the tenure
    fee_amount        NUMERIC(14,2)  NOT NULL,
    total_repayable   NUMERIC(14,2)  NOT NULL,        -- principal + fee
    amount_repaid     NUMERIC(14,2)  NOT NULL DEFAULT 0,
    tenure_days       INTEGER        NOT NULL,
    disbursed_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    due_date          DATE           NOT NULL,
    status            bnpl_status    NOT NULL DEFAULT 'ACTIVE',
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT bnpl_principal_pos  CHECK (principal > 0),
    CONSTRAINT bnpl_repaid_ok      CHECK (amount_repaid >= 0 AND amount_repaid <= total_repayable),
    CONSTRAINT bnpl_tenure_pos     CHECK (tenure_days > 0),
    CONSTRAINT bnpl_one_per_invoice UNIQUE (invoice_id)   -- an invoice is financed at most once
);

CREATE INDEX idx_bnpl_shopkeeper ON bnpl_financings (shopkeeper_id, status);
CREATE INDEX idx_bnpl_due        ON bnpl_financings (due_date) WHERE status = 'ACTIVE';

CREATE TRIGGER trg_bnpl_touch BEFORE UPDATE ON bnpl_financings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. GSTR-2B records — inward supplies as filed by the buyer's suppliers
--    (imported from the GST portal / GSP, or from a supplier's GSTR-1).
-- ----------------------------------------------------------------------------
CREATE TABLE gstr2b_records (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_gstin    VARCHAR(15)   NOT NULL,
    supplier_gstin VARCHAR(15)   NOT NULL,
    supplier_name  TEXT,
    invoice_number VARCHAR(64)   NOT NULL,
    invoice_date   DATE          NOT NULL,
    period         CHAR(6)       NOT NULL,             -- MMYYYY
    taxable_value  NUMERIC(14,2) NOT NULL,
    cgst           NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst           NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst           NUMERIC(14,2) NOT NULL DEFAULT 0,
    imported_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT gstr2b_uq UNIQUE (buyer_gstin, supplier_gstin, invoice_number, period)
);

CREATE INDEX idx_gstr2b_buyer ON gstr2b_records (buyer_gstin, period);

-- ----------------------------------------------------------------------------
-- 3. E-way bills
-- ----------------------------------------------------------------------------
CREATE TABLE eway_bills (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID          NOT NULL UNIQUE REFERENCES transactions_ledger (id) ON DELETE CASCADE,
    ewb_no         VARCHAR(12)    NOT NULL UNIQUE,     -- 12-digit e-way bill number
    status         ewb_status     NOT NULL DEFAULT 'ACTIVE',
    vehicle_no     VARCHAR(16),
    transport_mode VARCHAR(16)    NOT NULL DEFAULT 'ROAD',
    distance_km    INTEGER        NOT NULL,
    valid_upto     TIMESTAMPTZ    NOT NULL,
    generated_response JSONB,
    cancel_reason  TEXT,
    cancelled_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX idx_eway_txn ON eway_bills (transaction_id);

COMMIT;
