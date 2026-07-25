-- ============================================================================
-- ApnaKhata — Migration 014: CA marketplace + GST-notice handling
-- Depends on: schema.sql, 004_billing_compliance.sql, 006_bnpl_itc_eway.sql
--
-- Becoming the system of record deepens the compliance moat. Auto-accounting
-- (P&L, balance sheet) is read-only over existing data, so it needs no tables;
-- this migration adds the two workflows that do:
--   • ca_professionals / ca_engagements — a chartered-accountant marketplace the
--     shop engages for filing, audit, and notice response.
--   • gst_notices — track GST notices, auto-draft a response from the shop's own
--     GST data, and hand it to a CA.
-- ============================================================================

BEGIN;

CREATE TABLE ca_professionals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(96)  NOT NULL,
    firm            VARCHAR(96),
    membership_no   VARCHAR(24),                              -- ICAI membership no.
    city            VARCHAR(48),
    specializations TEXT[]       NOT NULL DEFAULT '{}',       -- GST, ITR, AUDIT, NOTICE
    rating          NUMERIC(2,1) NOT NULL DEFAULT 4.5,
    min_fee         NUMERIC(10,2) NOT NULL DEFAULT 0,
    max_fee         NUMERIC(10,2) NOT NULL DEFAULT 0,
    languages       TEXT[]       NOT NULL DEFAULT '{}',
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_ca_active ON ca_professionals (is_active, rating DESC);

CREATE TYPE engagement_status AS ENUM ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

CREATE TABLE ca_engagements (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     UUID              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    ca_id        UUID              NOT NULL REFERENCES ca_professionals (id),
    service_type VARCHAR(32)       NOT NULL,                  -- GST_FILING | ITR | AUDIT | NOTICE_RESPONSE
    status       engagement_status NOT NULL DEFAULT 'REQUESTED',
    fee_quoted   NUMERIC(10,2),
    notes        TEXT,
    notice_id    UUID,                                        -- set FK below (after gst_notices)
    created_at   TIMESTAMPTZ       NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE INDEX idx_ca_engagements ON ca_engagements (owner_id, created_at DESC);

CREATE TRIGGER trg_ca_engagement_touch BEFORE UPDATE ON ca_engagements
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TYPE gst_notice_status AS ENUM ('OPEN', 'DRAFTED', 'RESPONDED', 'RESOLVED');

CREATE TABLE gst_notices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    notice_type     VARCHAR(32)       NOT NULL,               -- ITC_MISMATCH | GSTR3B_LATE | GSTR1_3B_MISMATCH | DRC_01 | OTHER
    reference_no    VARCHAR(48),                              -- notice reference on the portal
    period          VARCHAR(7),                               -- 'YYYY-MM'
    amount_involved NUMERIC(14,2)     NOT NULL DEFAULT 0,
    due_date        DATE,
    status          gst_notice_status NOT NULL DEFAULT 'OPEN',
    description     TEXT,
    response_draft  TEXT,
    assigned_ca_id  UUID              REFERENCES ca_professionals (id),
    created_at      TIMESTAMPTZ       NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE INDEX idx_gst_notices ON gst_notices (owner_id, status, due_date);

CREATE TRIGGER trg_gst_notice_touch BEFORE UPDATE ON gst_notices
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE ca_engagements
    ADD CONSTRAINT ca_engagement_notice_fk FOREIGN KEY (notice_id) REFERENCES gst_notices (id) ON DELETE SET NULL;

COMMIT;
