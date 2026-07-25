-- ============================================================================
-- ApnaKhata — Migration 015: Fraud & trust graph
-- Depends on: schema.sql (transactions_ledger, users), 001 (invoice_disputes)
--
-- Detection itself is read-only over the transaction graph (circular-trade
-- rings, structuring under the e-way-bill threshold, duplicate invoices, ITC
-- risk). This table is the triage workflow on top: a shopkeeper (or a lender
-- consuming the trust score) raises a case from a finding and works it to
-- resolution. The trust score it protects complements the Credit Passport and
-- dealer reliability rating.
-- ============================================================================

BEGIN;

CREATE TYPE fraud_case_status AS ENUM ('OPEN', 'REVIEWING', 'CONFIRMED', 'DISMISSED');
CREATE TYPE fraud_severity    AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TABLE fraud_cases (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      UUID              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    case_type     VARCHAR(32)       NOT NULL,               -- CIRCULAR_TRADE | STRUCTURING | DUPLICATE_INVOICE | ITC_RISK | DISPUTE_RATIO
    severity      fraud_severity    NOT NULL DEFAULT 'MEDIUM',
    subject_label VARCHAR(160)      NOT NULL,               -- human label (ring members / counterparty)
    detail        JSONB,
    status        fraud_case_status NOT NULL DEFAULT 'OPEN',
    created_at    TIMESTAMPTZ       NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ
);

CREATE INDEX idx_fraud_cases ON fraud_cases (owner_id, status, created_at DESC);

COMMIT;
