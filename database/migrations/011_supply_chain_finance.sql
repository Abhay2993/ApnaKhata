-- ============================================================================
-- ApnaKhata — Migration 011: Anchor-led supply-chain finance (OCEN + AA)
-- Depends on: schema.sql, 003_credit_banking.sql, 006_bnpl_itc_eway.sql
--
-- The lending rail. Three layers:
--   • aa_consents / aa_financial_summaries — the Account Aggregator (Sahamati)
--     consent + the cash-flow snapshot pulled under it (bank inflow/outflow,
--     balances, bounces) that turns underwriting from score-only to cash-flow.
--   • loan_applications — an OCEN-style application carrying an underwriting
--     snapshot (credit score + AA signals + the anchor trade relationship).
--   • loan_offers / loans — competing lender bids and the accepted, disbursed
--     loan. Anchor-led: the distributor's verified trade history with the
--     retailer improves the retailer's terms.
-- ============================================================================

BEGIN;

-- --- Account Aggregator ------------------------------------------------------
CREATE TYPE aa_consent_status AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'EXPIRED', 'REVOKED');

CREATE TABLE aa_consents (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id    UUID              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose        VARCHAR(48)       NOT NULL DEFAULT 'LOAN_UNDERWRITING',
    consent_handle VARCHAR(64) UNIQUE,                       -- issued by the AA
    status         aa_consent_status NOT NULL DEFAULT 'PENDING',
    months         INTEGER           NOT NULL DEFAULT 6,     -- lookback window
    created_at     TIMESTAMPTZ       NOT NULL DEFAULT now(),
    approved_at    TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ
);

CREATE INDEX idx_aa_consents_borrower ON aa_consents (borrower_id, created_at DESC);

CREATE TABLE aa_financial_summaries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consent_id          UUID          NOT NULL REFERENCES aa_consents (id) ON DELETE CASCADE,
    borrower_id         UUID          NOT NULL REFERENCES users (id),
    months              INTEGER       NOT NULL,
    avg_monthly_inflow  NUMERIC(14,2) NOT NULL,
    avg_monthly_outflow NUMERIC(14,2) NOT NULL,
    avg_balance         NUMERIC(14,2) NOT NULL,
    min_balance         NUMERIC(14,2) NOT NULL,
    bounce_count        INTEGER       NOT NULL DEFAULT 0,
    inflow_cv           NUMERIC(6,3)  NOT NULL DEFAULT 0,    -- coefficient of variation (volatility)
    fetched_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_aa_summaries_borrower ON aa_financial_summaries (borrower_id, fetched_at DESC);

-- --- OCEN loan applications, offers, loans -----------------------------------
CREATE TYPE loan_app_status   AS ENUM ('SUBMITTED', 'OFFERED', 'ACCEPTED', 'DISBURSED', 'REJECTED', 'WITHDRAWN');
CREATE TYPE loan_offer_status AS ENUM ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED');

CREATE TABLE loan_applications (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id       UUID            NOT NULL REFERENCES users (id) ON DELETE CASCADE,  -- retailer
    anchor_id         UUID            REFERENCES users (id),                              -- distributor
    amount_requested  NUMERIC(14,2)   NOT NULL,
    tenure_days       INTEGER         NOT NULL DEFAULT 90,
    purpose           VARCHAR(48)     NOT NULL DEFAULT 'WORKING_CAPITAL',
    status            loan_app_status NOT NULL DEFAULT 'SUBMITTED',
    -- underwriting snapshot (immutable record of what the decision was based on)
    credit_score      INTEGER,
    risk_grade        VARCHAR(2),                             -- A | B | C | D
    recommended_limit NUMERIC(14,2),
    anchor_strength   NUMERIC(5,4),                           -- 0..1
    aa_consent_id     UUID            REFERENCES aa_consents (id),
    underwriting      JSONB,                                  -- full signal breakdown
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT loan_amount_pos    CHECK (amount_requested > 0),
    CONSTRAINT loan_tenure_pos    CHECK (tenure_days > 0),
    CONSTRAINT loan_anchor_differ CHECK (anchor_id IS NULL OR anchor_id <> borrower_id)
);

CREATE INDEX idx_loan_apps_borrower ON loan_applications (borrower_id, created_at DESC);

CREATE TRIGGER trg_loan_app_touch BEFORE UPDATE ON loan_applications
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE loan_offers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id    UUID              NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
    lender_key        VARCHAR(24)       NOT NULL,
    lender_name       VARCHAR(64)       NOT NULL,
    sanctioned_amount NUMERIC(14,2)     NOT NULL,
    interest_rate_pct NUMERIC(5,2)      NOT NULL,
    tenure_days       INTEGER           NOT NULL,
    processing_fee    NUMERIC(14,2)     NOT NULL DEFAULT 0,
    emi_amount        NUMERIC(14,2)     NOT NULL,
    total_repayable   NUMERIC(14,2)     NOT NULL,
    status            loan_offer_status NOT NULL DEFAULT 'OFFERED',
    valid_until       DATE,
    created_at        TIMESTAMPTZ       NOT NULL DEFAULT now(),

    CONSTRAINT offer_amount_pos CHECK (sanctioned_amount > 0)
);

CREATE INDEX idx_loan_offers_app ON loan_offers (application_id, interest_rate_pct);

CREATE TABLE loans (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id    UUID          NOT NULL REFERENCES loan_applications (id),
    offer_id          UUID          NOT NULL REFERENCES loan_offers (id),
    borrower_id       UUID          NOT NULL REFERENCES users (id),
    lender_key        VARCHAR(24)   NOT NULL,
    lender_name       VARCHAR(64)   NOT NULL,
    principal         NUMERIC(14,2) NOT NULL,
    interest_rate_pct NUMERIC(5,2)  NOT NULL,
    tenure_days       INTEGER       NOT NULL,
    disbursed_to_anchor NUMERIC(14,2) NOT NULL DEFAULT 0,     -- amount routed to settle the distributor
    settlement_payment_id UUID      REFERENCES payments (id),
    status            VARCHAR(12)   NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | CLOSED
    disbursed_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT loan_principal_pos CHECK (principal > 0)
);

CREATE INDEX idx_loans_borrower ON loans (borrower_id, disbursed_at DESC);

COMMIT;
