-- ============================================================================
-- ApnaKhata — Migration 012: Credit-line-on-UPI + embedded RuPay card
-- Depends on: schema.sql (users, payments, apply_payment_fifo)
--
-- NPCI enabled pre-sanctioned credit lines on UPI: a shopkeeper pays a
-- distributor by scanning the same UPI QR, but the funds draw from a sanctioned
-- revolving line instead of a bank balance. ApnaKhata becomes the credit issuer
-- of record — the stickiest payment rail there is.
--
--   credit_lines     — the sanctioned revolving line + its virtual RuPay card.
--   credit_line_txns — draws (a UPI payment funded by the line, settled FIFO)
--                      and repayments that free the limit back up.
-- ============================================================================

BEGIN;

CREATE TYPE credit_line_status AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE credit_line_direction AS ENUM ('DRAW', 'REPAYMENT');

CREATE TABLE credit_lines (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id      UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    lender_key       VARCHAR(24)   NOT NULL DEFAULT 'APNAKHATA',
    lender_name      VARCHAR(64)   NOT NULL DEFAULT 'ApnaKhata Credit',
    sanctioned_limit NUMERIC(14,2) NOT NULL,
    available_limit  NUMERIC(14,2) NOT NULL,
    interest_rate_pct NUMERIC(5,2)  NOT NULL DEFAULT 18.0,
    status           credit_line_status NOT NULL DEFAULT 'ACTIVE',
    -- Embedded virtual RuPay card (tokenised in production; only last4 stored).
    card_last4       VARCHAR(4)    NOT NULL,
    card_network     VARCHAR(12)   NOT NULL DEFAULT 'RUPAY',
    card_expiry      VARCHAR(5)    NOT NULL,                 -- MM/YY
    upi_handle       VARCHAR(64),                            -- shop@apnakhata (credit-line VPA)
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT cl_one_per_borrower UNIQUE (borrower_id),
    CONSTRAINT cl_limit_pos        CHECK (sanctioned_limit > 0),
    CONSTRAINT cl_available_bounds CHECK (available_limit >= 0 AND available_limit <= sanctioned_limit)
);

CREATE TRIGGER trg_credit_line_touch BEFORE UPDATE ON credit_lines
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE credit_line_txns (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_line_id    UUID          NOT NULL REFERENCES credit_lines (id) ON DELETE CASCADE,
    direction         credit_line_direction NOT NULL,
    amount            NUMERIC(14,2) NOT NULL,
    counterparty_id   UUID          REFERENCES users (id),   -- distributor paid, for a DRAW
    counterparty_name VARCHAR(96),                            -- merchant / payee label
    upi_ref           VARCHAR(32)   NOT NULL,                 -- UPI transaction reference
    payment_id        UUID          REFERENCES payments (id), -- the ledger payment a draw created
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT clt_amount_pos CHECK (amount > 0)
);

CREATE INDEX idx_cl_txns ON credit_line_txns (credit_line_id, created_at DESC);

COMMIT;
