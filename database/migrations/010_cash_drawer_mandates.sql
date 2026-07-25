-- ============================================================================
-- ApnaKhata — Migration 010: Cash-drawer reconciliation + UPI AutoPay mandates
-- Depends on: database/schema.sql (users, payments, apply_payment_fifo)
--
-- Two quick wins that build on the existing ledger:
--   • cash_drawer_days / cash_drawer_movements — the daily "cash vs digital"
--     close every shop does: opening float, cash in/out, expected vs counted.
--   • upi_mandates / mandate_executions — recurring e-mandate (UPI AutoPay) for
--     distributor payments; an execution creates a real payment and settles it
--     through the FIFO engine.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Cash-drawer reconciliation
-- ---------------------------------------------------------------------------
CREATE TYPE cash_drawer_status AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE cash_direction     AS ENUM ('IN', 'OUT');

CREATE TABLE cash_drawer_days (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    business_date   DATE          NOT NULL,
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    counted_closing NUMERIC(14,2),                       -- physically counted at close
    status          cash_drawer_status NOT NULL DEFAULT 'OPEN',
    opened_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,

    CONSTRAINT cash_day_uq        UNIQUE (owner_id, business_date),
    CONSTRAINT cash_opening_pos   CHECK (opening_balance >= 0)
);

CREATE TABLE cash_drawer_movements (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    drawer_id  UUID           NOT NULL REFERENCES cash_drawer_days (id) ON DELETE CASCADE,
    direction  cash_direction NOT NULL,
    amount     NUMERIC(14,2)  NOT NULL,
    reason     VARCHAR(48)    NOT NULL DEFAULT 'CASH_SALE',  -- CASH_SALE | PAYOUT | DEPOSIT | EXPENSE
    note       TEXT,
    created_at TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT cash_move_amount_pos CHECK (amount > 0)
);

CREATE INDEX idx_cash_moves ON cash_drawer_movements (drawer_id, created_at);

-- ---------------------------------------------------------------------------
-- UPI AutoPay / e-mandate for recurring distributor payments
-- ---------------------------------------------------------------------------
CREATE TYPE mandate_status    AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'REVOKED');
CREATE TYPE mandate_frequency AS ENUM ('WEEKLY', 'MONTHLY');

CREATE TABLE upi_mandates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payer_id        UUID          NOT NULL REFERENCES users (id),   -- shopkeeper
    payee_id        UUID          NOT NULL REFERENCES users (id),   -- distributor
    max_amount      NUMERIC(14,2) NOT NULL,                          -- per-debit cap
    frequency       mandate_frequency NOT NULL DEFAULT 'MONTHLY',
    umn             VARCHAR(64) UNIQUE,                              -- Unique Mandate Number (NPCI)
    payer_vpa       VARCHAR(128),
    status          mandate_status NOT NULL DEFAULT 'PENDING',
    next_debit_date DATE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT mandate_amount_pos   CHECK (max_amount > 0),
    CONSTRAINT mandate_parties_diff CHECK (payer_id <> payee_id)
);

CREATE INDEX idx_mandates_payer ON upi_mandates (payer_id, status);
CREATE INDEX idx_mandates_due   ON upi_mandates (next_debit_date) WHERE status = 'ACTIVE';

CREATE TRIGGER trg_mandate_touch BEFORE UPDATE ON upi_mandates
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE mandate_executions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mandate_id  UUID          NOT NULL REFERENCES upi_mandates (id) ON DELETE CASCADE,
    amount      NUMERIC(14,2) NOT NULL,
    payment_id  UUID          REFERENCES payments (id),
    executed_at TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT mandate_exec_amount_pos CHECK (amount > 0)
);

CREATE INDEX idx_mandate_execs ON mandate_executions (mandate_id, executed_at DESC);

COMMIT;
