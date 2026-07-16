-- ============================================================================
-- ApnaKhata — PostgreSQL DDL
-- Target: PostgreSQL 16 (+ TimescaleDB extension for stock_movements)
--
-- Conventions:
--   * All money is NUMERIC(14,2) in INR. Never floats.
--   * All timestamps are TIMESTAMPTZ (stored UTC, rendered IST client-side).
--   * Soft business identifiers (phone, GSTIN) are unique where required by KYC.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive emails
-- CREATE EXTENSION IF NOT EXISTS timescaledb; -- enable on the analytics node

-- ----------------------------------------------------------------------------
-- Enumerated types
-- ----------------------------------------------------------------------------
CREATE TYPE user_role       AS ENUM ('DISTRIBUTOR', 'SHOPKEEPER');
CREATE TYPE payment_status  AS ENUM ('PAID', 'PARTIAL', 'DUE');
CREATE TYPE ledger_kind     AS ENUM ('B2B_INVOICE', 'RETAIL_SALE', 'CREDIT_NOTE');
CREATE TYPE movement_reason AS ENUM ('SALE', 'PURCHASE', 'RETURN', 'ADJUSTMENT', 'ERP_SYNC');
CREATE TYPE risk_tier       AS ENUM ('PRIME', 'SUBPRIME', 'HIGH_RISK');

-- ----------------------------------------------------------------------------
-- users — both personas in one table, discriminated by role
-- ----------------------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role            user_role     NOT NULL,
    business_name   TEXT          NOT NULL,
    owner_name      TEXT          NOT NULL,
    phone           VARCHAR(15)   NOT NULL UNIQUE,          -- E.164, +91XXXXXXXXXX
    email           CITEXT        UNIQUE,
    gstin           VARCHAR(15)   UNIQUE,                   -- nullable: many kiranas are unregistered
    address_line    TEXT,
    city            TEXT,
    state_code      VARCHAR(2),                             -- GST state code, e.g. '27'
    pincode         VARCHAR(6),
    password_hash   TEXT          NOT NULL,
    is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT users_phone_format CHECK (phone ~ '^\+?[0-9]{10,15}$'),
    CONSTRAINT users_gstin_format CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$')
);

CREATE INDEX idx_users_role         ON users (role) WHERE is_active;
CREATE INDEX idx_users_city_role    ON users (city, role);

-- ----------------------------------------------------------------------------
-- inventory — SKU-level stock, owned by either persona
-- ----------------------------------------------------------------------------
CREATE TABLE inventory (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id           UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sku                VARCHAR(64)   NOT NULL,
    product_name       TEXT          NOT NULL,
    category           TEXT          NOT NULL DEFAULT 'GENERAL',
    unit               VARCHAR(16)   NOT NULL DEFAULT 'PCS',  -- PCS | KG | LTR | BOX ...
    pack_size          INTEGER       NOT NULL DEFAULT 1,      -- distributor case size
    current_stock      NUMERIC(12,3) NOT NULL DEFAULT 0,
    minimum_threshold  NUMERIC(12,3) NOT NULL DEFAULT 0,
    wholesale_price    NUMERIC(14,2) NOT NULL,
    retail_price       NUMERIC(14,2) NOT NULL,
    hsn_code           VARCHAR(8),
    gst_rate           NUMERIC(4,2)  NOT NULL DEFAULT 0,      -- percent
    is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT inventory_owner_sku_uq   UNIQUE (owner_id, sku),
    CONSTRAINT inventory_stock_nonneg   CHECK (current_stock >= 0),
    CONSTRAINT inventory_prices_pos     CHECK (wholesale_price >= 0 AND retail_price >= 0),
    CONSTRAINT inventory_pack_size_pos  CHECK (pack_size > 0)
);

CREATE INDEX idx_inventory_owner_category ON inventory (owner_id, category) WHERE is_active;
-- Static low-stock alerting: fast partial scan of items at/below threshold.
CREATE INDEX idx_inventory_low_stock
    ON inventory (owner_id)
    WHERE is_active AND current_stock <= minimum_threshold;

-- ----------------------------------------------------------------------------
-- transactions_ledger — every invoice / credit note between two parties.
--   sender_id   = party owed money (creditor: distributor on a B2B invoice)
--   receiver_id = party who owes    (debtor: shopkeeper on a B2B invoice)
--   For retail sales receiver_id is NULL and customer details are inline.
-- ----------------------------------------------------------------------------
CREATE TABLE transactions_ledger (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                ledger_kind    NOT NULL DEFAULT 'B2B_INVOICE',
    sender_id           UUID           NOT NULL REFERENCES users (id),
    receiver_id         UUID           REFERENCES users (id),
    retail_customer     TEXT,                                  -- name/phone for RETAIL_SALE
    invoice_number      VARCHAR(64)    NOT NULL,
    amount              NUMERIC(14,2)  NOT NULL,
    balance_remaining   NUMERIC(14,2)  NOT NULL,
    payment_status      payment_status NOT NULL DEFAULT 'DUE',
    due_date            DATE,
    bill_attachment_url TEXT,
    external_source     VARCHAR(32),                           -- 'TALLY' | 'VYAPAR' | 'MARG' | NULL
    external_ref        VARCHAR(128),                          -- ERP-side voucher id
    is_disputed         BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT ledger_amount_pos        CHECK (amount > 0),
    CONSTRAINT ledger_balance_bounds    CHECK (balance_remaining >= 0 AND balance_remaining <= amount),
    CONSTRAINT ledger_parties_distinct  CHECK (receiver_id IS NULL OR sender_id <> receiver_id),
    CONSTRAINT ledger_b2b_has_receiver  CHECK (kind = 'RETAIL_SALE' OR receiver_id IS NOT NULL),
    CONSTRAINT ledger_status_consistent CHECK (
        (payment_status = 'PAID'    AND balance_remaining = 0) OR
        (payment_status = 'PARTIAL' AND balance_remaining > 0 AND balance_remaining < amount) OR
        (payment_status = 'DUE'     AND balance_remaining = amount)
    ),
    CONSTRAINT ledger_invoice_uq UNIQUE (sender_id, invoice_number)
);

-- FIFO settlement scan: open invoices for a debtor→creditor pair, oldest due first.
CREATE INDEX idx_ledger_fifo
    ON transactions_ledger (receiver_id, sender_id, due_date ASC, created_at ASC)
    WHERE payment_status <> 'PAID';
-- Receivables dashboard for a creditor.
CREATE INDEX idx_ledger_receivables
    ON transactions_ledger (sender_id, payment_status, due_date);
-- Credit engine: everything a debtor has ever owed.
CREATE INDEX idx_ledger_debtor_history ON transactions_ledger (receiver_id, created_at);
-- Webhook idempotency lookups from ERPs.
CREATE UNIQUE INDEX idx_ledger_external_ref
    ON transactions_ledger (external_source, external_ref)
    WHERE external_source IS NOT NULL;

-- ----------------------------------------------------------------------------
-- payments + payment_allocations — one cash event, many invoice applications.
-- The allocation trail is the audit evidence banks require.
-- ----------------------------------------------------------------------------
CREATE TABLE payments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payer_id         UUID          NOT NULL REFERENCES users (id),
    payee_id         UUID          NOT NULL REFERENCES users (id),
    amount           NUMERIC(14,2) NOT NULL,
    unapplied_amount NUMERIC(14,2) NOT NULL DEFAULT 0,   -- residue held as advance credit
    method           VARCHAR(16)   NOT NULL DEFAULT 'UPI', -- UPI | CASH | NEFT | CHEQUE
    reference        VARCHAR(128),                         -- UTR / cheque no.
    paid_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT payments_amount_pos    CHECK (amount > 0),
    CONSTRAINT payments_residue_ok    CHECK (unapplied_amount >= 0 AND unapplied_amount <= amount),
    CONSTRAINT payments_parties_diff  CHECK (payer_id <> payee_id)
);

CREATE INDEX idx_payments_pair ON payments (payer_id, payee_id, paid_at DESC);

CREATE TABLE payment_allocations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id     UUID          NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
    transaction_id UUID          NOT NULL REFERENCES transactions_ledger (id),
    amount_applied NUMERIC(14,2) NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT alloc_amount_pos CHECK (amount_applied > 0),
    CONSTRAINT alloc_uq         UNIQUE (payment_id, transaction_id)
);

CREATE INDEX idx_alloc_transaction ON payment_allocations (transaction_id);

-- ----------------------------------------------------------------------------
-- credit_score_metrics — materialized output of the credit engine
-- ----------------------------------------------------------------------------
CREATE TABLE credit_score_metrics (
    user_id                 UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    repayment_velocity_score NUMERIC(5,2) NOT NULL,   -- 0..100 pillar sub-score
    consistency_score        NUMERIC(5,2) NOT NULL,   -- 0..100
    retention_score          NUMERIC(5,2) NOT NULL,   -- 0..100
    inventory_turn_score     NUMERIC(5,2) NOT NULL,   -- 0..100
    average_delay_days       NUMERIC(7,2) NOT NULL DEFAULT 0,
    debt_to_income_ratio     NUMERIC(7,4),
    days_inventory_outstanding NUMERIC(7,2),
    calculated_credit_score  SMALLINT     NOT NULL,
    tier                     risk_tier    NOT NULL,
    data_coverage_months     SMALLINT     NOT NULL DEFAULT 0,
    last_updated             TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT score_range CHECK (calculated_credit_score BETWEEN 300 AND 900)
);

CREATE INDEX idx_credit_tier ON credit_score_metrics (tier, calculated_credit_score DESC);

-- ----------------------------------------------------------------------------
-- credit_passports — append-only, hash-chained issuance log for signed PDFs
-- ----------------------------------------------------------------------------
CREATE TABLE credit_passports (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users (id),
    score          SMALLINT    NOT NULL,
    tier           risk_tier   NOT NULL,
    report_json    JSONB       NOT NULL,          -- canonical signed payload
    report_sha256  CHAR(64)    NOT NULL,
    signature      TEXT        NOT NULL,          -- Ed25519, base64
    signing_key_id VARCHAR(32) NOT NULL,
    prev_hash      CHAR(64)    NOT NULL,          -- hash-chain to previous passport
    pdf_url        TEXT,
    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_passports_user ON credit_passports (user_id, issued_at DESC);

-- ----------------------------------------------------------------------------
-- stock_movements — append-only time series feeding the ML forecaster.
-- Convert to a TimescaleDB hypertable on the analytics node.
-- ----------------------------------------------------------------------------
CREATE TABLE stock_movements (
    time          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    inventory_id  UUID            NOT NULL REFERENCES inventory (id) ON DELETE CASCADE,
    owner_id      UUID            NOT NULL REFERENCES users (id),
    delta         NUMERIC(12,3)   NOT NULL,      -- negative = sold/out, positive = received
    reason        movement_reason NOT NULL,
    ledger_id     UUID            REFERENCES transactions_ledger (id),
    stock_after   NUMERIC(12,3)   NOT NULL,

    CONSTRAINT movements_delta_nonzero CHECK (delta <> 0)
);

-- SELECT create_hypertable('stock_movements', 'time', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX idx_movements_item_time ON stock_movements (inventory_id, time DESC);
CREATE INDEX idx_movements_owner_time ON stock_movements (owner_id, time DESC);

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_touch     BEFORE UPDATE ON users               FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_inventory_touch BEFORE UPDATE ON inventory           FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_ledger_touch    BEFORE UPDATE ON transactions_ledger FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ----------------------------------------------------------------------------
-- Settlement engine: FIFO application of a payment to open invoices.
-- Runs inside the caller's transaction; caller should use SERIALIZABLE or
-- rely on the row locks taken here.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_payment_fifo(p_payment_id UUID)
RETURNS TABLE (transaction_id UUID, amount_applied NUMERIC(14,2)) AS $$
DECLARE
    v_payment   payments%ROWTYPE;
    v_invoice   RECORD;
    v_remaining NUMERIC(14,2);
    v_slice     NUMERIC(14,2);
BEGIN
    SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment % not found', p_payment_id;
    END IF;

    v_remaining := v_payment.amount;

    FOR v_invoice IN
        SELECT tl.id, tl.balance_remaining
        FROM transactions_ledger tl
        WHERE tl.receiver_id = v_payment.payer_id      -- debtor
          AND tl.sender_id   = v_payment.payee_id      -- creditor
          AND tl.payment_status <> 'PAID'
        ORDER BY tl.due_date ASC NULLS LAST, tl.created_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_slice := LEAST(v_remaining, v_invoice.balance_remaining);

        INSERT INTO payment_allocations (payment_id, transaction_id, amount_applied)
        VALUES (p_payment_id, v_invoice.id, v_slice);

        UPDATE transactions_ledger
        SET balance_remaining = balance_remaining - v_slice,
            payment_status    = CASE WHEN balance_remaining - v_slice = 0
                                     THEN 'PAID'::payment_status
                                     ELSE 'PARTIAL'::payment_status END
        WHERE id = v_invoice.id;

        v_remaining := v_remaining - v_slice;
        transaction_id := v_invoice.id;
        amount_applied := v_slice;
        RETURN NEXT;
    END LOOP;

    UPDATE payments SET unapplied_amount = v_remaining WHERE id = p_payment_id;
    RETURN;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Receivables aging view — powers the dashboard and credit engine
-- ----------------------------------------------------------------------------
CREATE VIEW v_receivables_aging AS
SELECT
    tl.sender_id                                   AS creditor_id,
    tl.receiver_id                                 AS debtor_id,
    COUNT(*)                                       AS open_invoices,
    SUM(tl.balance_remaining)                      AS total_outstanding,
    SUM(tl.balance_remaining) FILTER (WHERE tl.due_date >= CURRENT_DATE)                                        AS current_bucket,
    SUM(tl.balance_remaining) FILTER (WHERE tl.due_date <  CURRENT_DATE AND tl.due_date >= CURRENT_DATE - 30)   AS overdue_1_30,
    SUM(tl.balance_remaining) FILTER (WHERE tl.due_date <  CURRENT_DATE - 30 AND tl.due_date >= CURRENT_DATE - 60) AS overdue_31_60,
    SUM(tl.balance_remaining) FILTER (WHERE tl.due_date <  CURRENT_DATE - 60)                                   AS overdue_60_plus
FROM transactions_ledger tl
WHERE tl.payment_status <> 'PAID'
  AND tl.kind = 'B2B_INVOICE'
GROUP BY tl.sender_id, tl.receiver_id;

COMMIT;
