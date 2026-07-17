-- ============================================================================
-- ApnaKhata — Migration 003: Credit & Banking enhancements
-- Depends on: database/schema.sql (credit_score_metrics, credit_passports,
--             risk_tier, touch_updated_at)
--
-- Adds:
--   1. Signed Credit Passport PDF export — no schema change (credit_passports
--      already exists); passports are written by CreditPassportService with an
--      Ed25519 signature and a per-user hash chain.
--   2. Score history & trend — credit_score_history, auto-snapshotted daily
--      whenever credit_score_metrics changes.
--   3. Direct lender API integration — lender_submissions + enums.
--   (The score simulator is pure computation over credit_score_metrics; no
--    schema needed.)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Enumerated types
-- ----------------------------------------------------------------------------
CREATE TYPE partner_lender  AS ENUM ('SBI', 'ICICI', 'HDFC', 'AXIS', 'KOTAK');
CREATE TYPE lender_decision AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'PRE_APPROVED', 'DECLINED', 'ERROR');

-- ============================================================================
-- 2. SCORE HISTORY & TREND
-- ============================================================================
CREATE TABLE credit_score_history (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    snapshot_date            DATE         NOT NULL DEFAULT CURRENT_DATE,
    score                    SMALLINT     NOT NULL,
    tier                     risk_tier    NOT NULL,
    repayment_velocity_score NUMERIC(5,2) NOT NULL,
    consistency_score        NUMERIC(5,2) NOT NULL,
    retention_score          NUMERIC(5,2) NOT NULL,
    inventory_turn_score     NUMERIC(5,2) NOT NULL,
    recorded_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT score_history_uq    UNIQUE (user_id, snapshot_date),   -- one point per day
    CONSTRAINT score_history_range CHECK (score BETWEEN 300 AND 900)
);

CREATE INDEX idx_score_history_user ON credit_score_history (user_id, snapshot_date);

-- Snapshot the latest metrics into history on every recompute (dedup per day).
CREATE OR REPLACE FUNCTION snapshot_credit_score() RETURNS trigger AS $$
BEGIN
    INSERT INTO credit_score_history (
        user_id, snapshot_date, score, tier,
        repayment_velocity_score, consistency_score, retention_score, inventory_turn_score
    ) VALUES (
        NEW.user_id, CURRENT_DATE, NEW.calculated_credit_score, NEW.tier,
        NEW.repayment_velocity_score, NEW.consistency_score, NEW.retention_score, NEW.inventory_turn_score
    )
    ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
        score                    = EXCLUDED.score,
        tier                     = EXCLUDED.tier,
        repayment_velocity_score = EXCLUDED.repayment_velocity_score,
        consistency_score        = EXCLUDED.consistency_score,
        retention_score          = EXCLUDED.retention_score,
        inventory_turn_score     = EXCLUDED.inventory_turn_score,
        recorded_at              = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_snapshot_credit
    AFTER INSERT OR UPDATE ON credit_score_metrics
    FOR EACH ROW EXECUTE FUNCTION snapshot_credit_score();

-- ============================================================================
-- 3. DIRECT LENDER API INTEGRATION
-- ============================================================================
CREATE TABLE lender_submissions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID            NOT NULL REFERENCES users (id),
    passport_id        UUID            NOT NULL REFERENCES credit_passports (id),
    lender             partner_lender  NOT NULL,
    status             lender_decision NOT NULL DEFAULT 'SUBMITTED',
    requested_amount   NUMERIC(14,2)   NOT NULL,
    approved_amount    NUMERIC(14,2),
    interest_rate_pct  NUMERIC(5,2),
    external_reference VARCHAR(64),                   -- lender-side application id
    response_json      JSONB,                         -- raw lender response
    submitted_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT lender_req_pos      CHECK (requested_amount > 0),
    CONSTRAINT lender_approved_ok  CHECK (approved_amount IS NULL OR approved_amount >= 0)
);

CREATE INDEX idx_lender_sub_user     ON lender_submissions (user_id, submitted_at DESC);
CREATE INDEX idx_lender_sub_passport ON lender_submissions (passport_id);

CREATE TRIGGER trg_lender_touch
    BEFORE UPDATE ON lender_submissions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
