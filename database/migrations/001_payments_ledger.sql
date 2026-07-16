-- ============================================================================
-- ApnaKhata — Migration 001: Payments & Ledger enhancements
-- Depends on: database/schema.sql (base schema)
--
-- Adds five capabilities that extend the FIFO settlement engine:
--   1. UPI deep-link collection + UTR auto-reconciliation
--   2. Automated payment reminders (aging-bucket escalation)
--   3. Partial-payment plans / EMI (child installments per invoice)
--   4. Interest / late-fee accrual (per-distributor terms)
--   5. Dispute & credit-note workflow
--
-- Every money-moving operation is a SERIALIZABLE-safe plpgsql function so the
-- backend never has to orchestrate multi-statement writes by hand.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Enumerated types
-- ----------------------------------------------------------------------------
CREATE TYPE upi_collection_status AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'FAILED');
CREATE TYPE reminder_channel      AS ENUM ('SMS', 'WHATSAPP');
CREATE TYPE aging_bucket          AS ENUM ('CURRENT', 'OVERDUE_1_30', 'OVERDUE_31_60', 'OVERDUE_60_PLUS');
CREATE TYPE reminder_status       AS ENUM ('QUEUED', 'SENT', 'FAILED');
CREATE TYPE payment_plan_status   AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'DEFAULTED');
CREATE TYPE installment_status    AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE');
CREATE TYPE dispute_status        AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED_UPHELD', 'RESOLVED_REJECTED', 'WITHDRAWN');

-- ============================================================================
-- 1. UPI DEEP-LINK COLLECTION + AUTO-RECONCILIATION
-- ============================================================================
CREATE TABLE upi_collection_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID          REFERENCES transactions_ledger (id) ON DELETE SET NULL,
    payer_id        UUID          NOT NULL REFERENCES users (id),   -- debtor who scans/pays
    payee_id        UUID          NOT NULL REFERENCES users (id),   -- creditor who collects
    amount          NUMERIC(14,2) NOT NULL,
    payee_vpa       TEXT          NOT NULL,                         -- collector's UPI VPA
    payee_name      TEXT          NOT NULL,
    transaction_ref VARCHAR(35)   NOT NULL UNIQUE,                  -- our tr= we reconcile on
    upi_intent_url  TEXT          NOT NULL,
    status          upi_collection_status NOT NULL DEFAULT 'PENDING',
    utr             VARCHAR(32),                                    -- bank UTR on completion
    payment_id      UUID          REFERENCES payments (id),
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT upi_amount_pos     CHECK (amount > 0),
    CONSTRAINT upi_parties_differ CHECK (payer_id <> payee_id)
);

CREATE INDEX idx_upi_pending    ON upi_collection_requests (payee_id, status) WHERE status = 'PENDING';
CREATE UNIQUE INDEX idx_upi_utr ON upi_collection_requests (utr) WHERE utr IS NOT NULL;

CREATE TRIGGER trg_upi_touch BEFORE UPDATE ON upi_collection_requests
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Reconcile a UPI collection: create the payment, run FIFO, close the request.
-- Idempotent: replaying the same completed request returns the original payment.
CREATE OR REPLACE FUNCTION reconcile_upi_collection(p_request_id UUID, p_utr VARCHAR)
RETURNS UUID AS $$
DECLARE
    v_req        upi_collection_requests%ROWTYPE;
    v_payment_id UUID;
BEGIN
    SELECT * INTO v_req FROM upi_collection_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'upi collection request % not found', p_request_id;
    END IF;

    IF v_req.status = 'COMPLETED' THEN
        RETURN v_req.payment_id;              -- idempotent replay
    END IF;

    INSERT INTO payments (payer_id, payee_id, amount, method, reference, paid_at)
    VALUES (v_req.payer_id, v_req.payee_id, v_req.amount, 'UPI', p_utr, now())
    RETURNING id INTO v_payment_id;

    PERFORM apply_payment_fifo(v_payment_id);  -- reuse the existing settlement engine

    UPDATE upi_collection_requests
    SET status = 'COMPLETED', utr = p_utr, payment_id = v_payment_id, updated_at = now()
    WHERE id = p_request_id;

    RETURN v_payment_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 2. AUTOMATED PAYMENT REMINDERS
-- ============================================================================
-- Per-invoice aging view (the base v_receivables_aging aggregates per pair;
-- reminders need invoice-level granularity to escalate correctly).
CREATE VIEW v_invoice_aging AS
SELECT
    tl.id             AS invoice_id,
    tl.sender_id      AS creditor_id,
    tl.receiver_id    AS debtor_id,
    tl.invoice_number,
    tl.balance_remaining AS outstanding,
    tl.due_date,
    CASE
        WHEN tl.due_date >= CURRENT_DATE          THEN 'CURRENT'
        WHEN tl.due_date >= CURRENT_DATE - 30     THEN 'OVERDUE_1_30'
        WHEN tl.due_date >= CURRENT_DATE - 60     THEN 'OVERDUE_31_60'
        ELSE 'OVERDUE_60_PLUS'
    END::aging_bucket AS bucket
FROM transactions_ledger tl
WHERE tl.payment_status <> 'PAID'
  AND tl.kind = 'B2B_INVOICE'
  AND tl.due_date IS NOT NULL;

-- One escalation policy per (distributor, bucket).
CREATE TABLE reminder_policies (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id    UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    bucket            aging_bucket  NOT NULL,
    channel           reminder_channel NOT NULL DEFAULT 'WHATSAPP',
    enabled           BOOLEAN       NOT NULL DEFAULT TRUE,
    min_interval_days INTEGER       NOT NULL DEFAULT 3,   -- cadence throttle
    template_key      TEXT          NOT NULL DEFAULT 'reminder.default',
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT reminder_policy_uq        UNIQUE (distributor_id, bucket),
    CONSTRAINT reminder_interval_nonneg  CHECK (min_interval_days >= 0)
);

-- Audit log of every reminder dispatched.
CREATE TABLE payment_reminders (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id         UUID          NOT NULL REFERENCES transactions_ledger (id) ON DELETE CASCADE,
    debtor_id          UUID          NOT NULL REFERENCES users (id),
    creditor_id        UUID          NOT NULL REFERENCES users (id),
    bucket             aging_bucket  NOT NULL,
    channel            reminder_channel NOT NULL,
    outstanding_amount NUMERIC(14,2) NOT NULL,
    status             reminder_status  NOT NULL DEFAULT 'QUEUED',
    provider_message_id TEXT,
    error_detail       TEXT,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    sent_at            TIMESTAMPTZ
);

CREATE INDEX idx_reminders_invoice ON payment_reminders (invoice_id, created_at DESC);
CREATE INDEX idx_reminders_debtor  ON payment_reminders (debtor_id, created_at DESC);

-- Invoices that are due for a reminder right now, honouring each policy's cadence.
CREATE OR REPLACE FUNCTION invoices_due_for_reminder(p_distributor_id UUID DEFAULT NULL)
RETURNS TABLE (
    invoice_id         UUID,
    creditor_id        UUID,
    debtor_id          UUID,
    bucket             aging_bucket,
    channel            reminder_channel,
    outstanding        NUMERIC(14,2),
    template_key       TEXT
) AS $$
    SELECT
        a.invoice_id, a.creditor_id, a.debtor_id, a.bucket, p.channel, a.outstanding, p.template_key
    FROM v_invoice_aging a
    JOIN reminder_policies p
      ON p.distributor_id = a.creditor_id
     AND p.bucket = a.bucket
     AND p.enabled
    WHERE a.bucket <> 'CURRENT'                       -- only nudge overdue invoices
      AND (p_distributor_id IS NULL OR a.creditor_id = p_distributor_id)
      AND NOT EXISTS (
          SELECT 1 FROM payment_reminders r
          WHERE r.invoice_id = a.invoice_id
            AND r.status <> 'FAILED'
            AND r.created_at > now() - (p.min_interval_days || ' days')::interval
      );
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- 3. PARTIAL-PAYMENT PLANS / EMI
-- ============================================================================
CREATE TABLE payment_plans (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id        UUID          NOT NULL REFERENCES transactions_ledger (id) ON DELETE CASCADE,
    debtor_id         UUID          NOT NULL REFERENCES users (id),
    creditor_id       UUID          NOT NULL REFERENCES users (id),
    principal         NUMERIC(14,2) NOT NULL,
    installment_count INTEGER       NOT NULL,
    frequency_days    INTEGER       NOT NULL DEFAULT 30,
    interest_rate_pct NUMERIC(5,2)  NOT NULL DEFAULT 0,   -- flat interest on principal
    start_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
    status            payment_plan_status NOT NULL DEFAULT 'ACTIVE',
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT plan_principal_pos    CHECK (principal > 0),
    CONSTRAINT plan_count_pos        CHECK (installment_count BETWEEN 1 AND 60),
    CONSTRAINT plan_frequency_pos    CHECK (frequency_days BETWEEN 1 AND 90),
    CONSTRAINT plan_one_per_invoice  UNIQUE (invoice_id)
);

CREATE INDEX idx_plans_debtor ON payment_plans (debtor_id, status);

CREATE TABLE payment_plan_installments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id     UUID          NOT NULL REFERENCES payment_plans (id) ON DELETE CASCADE,
    sequence    INTEGER       NOT NULL,
    due_date    DATE          NOT NULL,
    amount_due  NUMERIC(14,2) NOT NULL,
    amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
    status      installment_status NOT NULL DEFAULT 'PENDING',
    paid_at     TIMESTAMPTZ,

    CONSTRAINT installment_seq_uq   UNIQUE (plan_id, sequence),
    CONSTRAINT installment_due_pos  CHECK (amount_due > 0),
    CONSTRAINT installment_paid_ok  CHECK (amount_paid >= 0)
);

CREATE INDEX idx_installments_due ON payment_plan_installments (due_date) WHERE status <> 'PAID';

-- Build the amortised schedule for a plan; the final installment absorbs rounding.
CREATE OR REPLACE FUNCTION generate_installment_schedule(p_plan_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_plan      payment_plans%ROWTYPE;
    v_total     NUMERIC(14,2);
    v_base      NUMERIC(14,2);
    v_remainder NUMERIC(14,2);
    v_amt       NUMERIC(14,2);
    i           INTEGER;
BEGIN
    SELECT * INTO v_plan FROM payment_plans WHERE id = p_plan_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment plan % not found', p_plan_id;
    END IF;

    v_total     := round(v_plan.principal * (1 + v_plan.interest_rate_pct / 100.0), 2);
    v_base      := trunc(v_total / v_plan.installment_count, 2);
    v_remainder := v_total - (v_base * v_plan.installment_count);

    FOR i IN 1..v_plan.installment_count LOOP
        v_amt := v_base + CASE WHEN i = v_plan.installment_count THEN v_remainder ELSE 0 END;
        INSERT INTO payment_plan_installments (plan_id, sequence, due_date, amount_due)
        VALUES (p_plan_id, i, v_plan.start_date + ((i - 1) * v_plan.frequency_days), v_amt);
    END LOOP;

    RETURN v_plan.installment_count;
END;
$$ LANGUAGE plpgsql;

-- Record a payment against an installment: books a payment, allocates it to the
-- parent invoice (audit trail), advances the installment, and closes the plan
-- when the final installment is cleared.
CREATE OR REPLACE FUNCTION record_plan_installment_payment(
    p_installment_id UUID,
    p_amount         NUMERIC,
    p_method         VARCHAR DEFAULT 'UPI',
    p_reference      VARCHAR DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_inst        payment_plan_installments%ROWTYPE;
    v_plan        payment_plans%ROWTYPE;
    v_inv         transactions_ledger%ROWTYPE;
    v_payment_id  UUID;
    v_apply       NUMERIC(14,2);
    v_new_balance NUMERIC(14,2);
    v_new_paid    NUMERIC(14,2);
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'installment payment amount must be positive';
    END IF;

    SELECT * INTO v_inst FROM payment_plan_installments WHERE id = p_installment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'installment % not found', p_installment_id;
    END IF;
    SELECT * INTO v_plan FROM payment_plans          WHERE id = v_inst.plan_id FOR UPDATE;
    SELECT * INTO v_inv  FROM transactions_ledger    WHERE id = v_plan.invoice_id FOR UPDATE;

    INSERT INTO payments (payer_id, payee_id, amount, method, reference)
    VALUES (v_plan.debtor_id, v_plan.creditor_id, p_amount, p_method, p_reference)
    RETURNING id INTO v_payment_id;

    -- Apply to the plan's parent invoice specifically (not generic FIFO).
    v_apply := LEAST(p_amount, v_inv.balance_remaining);
    IF v_apply > 0 THEN
        INSERT INTO payment_allocations (payment_id, transaction_id, amount_applied)
        VALUES (v_payment_id, v_inv.id, v_apply);

        v_new_balance := v_inv.balance_remaining - v_apply;
        UPDATE transactions_ledger
        SET balance_remaining = v_new_balance,
            payment_status = CASE
                WHEN v_new_balance = 0          THEN 'PAID'::payment_status
                WHEN v_new_balance = v_inv.amount THEN 'DUE'::payment_status
                ELSE 'PARTIAL'::payment_status END
        WHERE id = v_inv.id;
    END IF;

    UPDATE payments SET unapplied_amount = p_amount - v_apply WHERE id = v_payment_id;

    v_new_paid := v_inst.amount_paid + p_amount;
    UPDATE payment_plan_installments
    SET amount_paid = v_new_paid,
        status  = CASE WHEN v_new_paid >= v_inst.amount_due THEN 'PAID'::installment_status
                       ELSE 'PARTIAL'::installment_status END,
        paid_at = CASE WHEN v_new_paid >= v_inst.amount_due THEN now() ELSE v_inst.paid_at END
    WHERE id = p_installment_id;

    UPDATE payment_plans
    SET status = 'COMPLETED'
    WHERE id = v_plan.id
      AND NOT EXISTS (
          SELECT 1 FROM payment_plan_installments
          WHERE plan_id = v_plan.id AND status <> 'PAID'
      );

    RETURN v_payment_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 4. INTEREST / LATE-FEE ACCRUAL
-- ============================================================================
CREATE TABLE distributor_credit_terms (
    distributor_id          UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    grace_period_days       INTEGER      NOT NULL DEFAULT 0,
    daily_interest_rate_pct NUMERIC(6,4) NOT NULL DEFAULT 0,   -- percent per day on balance
    max_interest_pct        NUMERIC(6,2),                      -- cap as % of invoice amount (NULL = uncapped)
    enabled                 BOOLEAN      NOT NULL DEFAULT TRUE,
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT terms_grace_nonneg CHECK (grace_period_days >= 0),
    CONSTRAINT terms_rate_nonneg  CHECK (daily_interest_rate_pct >= 0)
);

CREATE TABLE interest_accruals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID          NOT NULL REFERENCES transactions_ledger (id) ON DELETE CASCADE,
    accrual_date    DATE          NOT NULL,
    days_overdue    INTEGER       NOT NULL,
    base_amount     NUMERIC(14,2) NOT NULL,
    interest_amount NUMERIC(14,2) NOT NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT accrual_uq UNIQUE (invoice_id, accrual_date)   -- one accrual per invoice per day
);

CREATE INDEX idx_accruals_invoice ON interest_accruals (invoice_id, accrual_date);

-- Accrue a day of late-fee interest on every eligible overdue invoice.
-- Idempotent per day via the (invoice_id, accrual_date) unique key.
CREATE OR REPLACE FUNCTION accrue_interest(p_as_of DATE DEFAULT CURRENT_DATE)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    INSERT INTO interest_accruals (invoice_id, accrual_date, days_overdue, base_amount, interest_amount)
    SELECT
        tl.id,
        p_as_of,
        (p_as_of - tl.due_date)                                            AS days_overdue,
        tl.balance_remaining                                               AS base_amount,
        round(tl.balance_remaining * (t.daily_interest_rate_pct / 100.0), 2) AS interest_amount
    FROM transactions_ledger tl
    JOIN distributor_credit_terms t ON t.distributor_id = tl.sender_id
    WHERE tl.kind = 'B2B_INVOICE'
      AND tl.payment_status <> 'PAID'
      AND tl.due_date IS NOT NULL
      AND NOT tl.is_disputed                                    -- pause accrual while disputed
      AND t.enabled
      AND t.daily_interest_rate_pct > 0
      AND (p_as_of - tl.due_date) > t.grace_period_days
      AND (
          t.max_interest_pct IS NULL
          OR COALESCE((SELECT SUM(ia.interest_amount) FROM interest_accruals ia WHERE ia.invoice_id = tl.id), 0)
             < round(tl.amount * t.max_interest_pct / 100.0, 2)
      )
    ON CONFLICT (invoice_id, accrual_date) DO NOTHING;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Total owed = outstanding principal + accrued interest.
CREATE VIEW v_invoice_balance_with_interest AS
SELECT
    tl.id                         AS invoice_id,
    tl.sender_id                  AS creditor_id,
    tl.receiver_id                AS debtor_id,
    tl.balance_remaining          AS principal_outstanding,
    COALESCE(SUM(ia.interest_amount), 0)                        AS accrued_interest,
    tl.balance_remaining + COALESCE(SUM(ia.interest_amount), 0) AS total_due
FROM transactions_ledger tl
LEFT JOIN interest_accruals ia ON ia.invoice_id = tl.id
WHERE tl.payment_status <> 'PAID'
  AND tl.kind = 'B2B_INVOICE'
GROUP BY tl.id;

-- ============================================================================
-- 5. DISPUTE & CREDIT-NOTE WORKFLOW
-- ============================================================================
CREATE TABLE invoice_disputes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID          NOT NULL REFERENCES transactions_ledger (id) ON DELETE CASCADE,
    raised_by       UUID          NOT NULL REFERENCES users (id),
    reason          TEXT          NOT NULL,
    disputed_amount NUMERIC(14,2) NOT NULL,
    status          dispute_status NOT NULL DEFAULT 'OPEN',
    resolution_note TEXT,
    credit_note_id  UUID          REFERENCES transactions_ledger (id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,

    CONSTRAINT dispute_amount_pos CHECK (disputed_amount > 0)
);

CREATE INDEX idx_disputes_invoice ON invoice_disputes (invoice_id, status);
CREATE INDEX idx_disputes_open    ON invoice_disputes (status) WHERE status IN ('OPEN', 'UNDER_REVIEW');

-- Raise a dispute and flag the invoice.
CREATE OR REPLACE FUNCTION raise_dispute(
    p_invoice_id UUID, p_raised_by UUID, p_reason TEXT, p_disputed_amount NUMERIC
) RETURNS UUID AS $$
DECLARE
    v_dispute_id UUID;
BEGIN
    INSERT INTO invoice_disputes (invoice_id, raised_by, reason, disputed_amount)
    VALUES (p_invoice_id, p_raised_by, p_reason, p_disputed_amount)
    RETURNING id INTO v_dispute_id;

    UPDATE transactions_ledger SET is_disputed = TRUE WHERE id = p_invoice_id;
    RETURN v_dispute_id;
END;
$$ LANGUAGE plpgsql;

-- Resolve a dispute in the buyer's favour: issue a CREDIT_NOTE ledger row
-- (parties reversed, fully applied) and reduce the disputed invoice's balance.
CREATE OR REPLACE FUNCTION resolve_dispute_with_credit_note(
    p_dispute_id UUID, p_credit_amount NUMERIC, p_note TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_dispute     invoice_disputes%ROWTYPE;
    v_inv         transactions_ledger%ROWTYPE;
    v_credit      NUMERIC(14,2);
    v_new_balance NUMERIC(14,2);
    v_new_status  payment_status;
    v_cn_id       UUID;
BEGIN
    SELECT * INTO v_dispute FROM invoice_disputes WHERE id = p_dispute_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'dispute % not found', p_dispute_id;
    END IF;
    IF v_dispute.status IN ('RESOLVED_UPHELD', 'RESOLVED_REJECTED', 'WITHDRAWN') THEN
        RAISE EXCEPTION 'dispute % is already closed', p_dispute_id;
    END IF;

    SELECT * INTO v_inv FROM transactions_ledger WHERE id = v_dispute.invoice_id FOR UPDATE;

    v_credit := LEAST(p_credit_amount, v_inv.balance_remaining);
    IF v_credit <= 0 THEN
        RAISE EXCEPTION 'credit amount must be positive and invoice must have an outstanding balance';
    END IF;

    v_new_balance := v_inv.balance_remaining - v_credit;
    v_new_status  := CASE
        WHEN v_new_balance = 0            THEN 'PAID'::payment_status
        WHEN v_new_balance = v_inv.amount THEN 'DUE'::payment_status
        ELSE 'PARTIAL'::payment_status END;

    INSERT INTO transactions_ledger (
        kind, sender_id, receiver_id, invoice_number, amount, balance_remaining, payment_status, due_date
    ) VALUES (
        'CREDIT_NOTE', v_inv.receiver_id, v_inv.sender_id,
        'CN-' || v_inv.invoice_number || '-' || left(p_dispute_id::text, 8),
        v_credit, 0, 'PAID', NULL
    ) RETURNING id INTO v_cn_id;

    UPDATE transactions_ledger
    SET balance_remaining = v_new_balance,
        payment_status    = v_new_status,
        is_disputed       = FALSE
    WHERE id = v_inv.id;

    UPDATE invoice_disputes
    SET status = 'RESOLVED_UPHELD', resolution_note = p_note,
        credit_note_id = v_cn_id, resolved_at = now()
    WHERE id = p_dispute_id;

    RETURN v_cn_id;
END;
$$ LANGUAGE plpgsql;

-- Reject a dispute: clear the flag, no ledger change.
CREATE OR REPLACE FUNCTION reject_dispute(p_dispute_id UUID, p_note TEXT DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    UPDATE invoice_disputes
    SET status = 'RESOLVED_REJECTED', resolution_note = p_note, resolved_at = now()
    WHERE id = p_dispute_id
      AND status NOT IN ('RESOLVED_UPHELD', 'RESOLVED_REJECTED', 'WITHDRAWN');

    UPDATE transactions_ledger tl
    SET is_disputed = FALSE
    FROM invoice_disputes d
    WHERE d.id = p_dispute_id AND tl.id = d.invoice_id
      AND NOT EXISTS (
          SELECT 1 FROM invoice_disputes o
          WHERE o.invoice_id = d.invoice_id AND o.id <> d.id
            AND o.status IN ('OPEN', 'UNDER_REVIEW')
      );
END;
$$ LANGUAGE plpgsql;

COMMIT;
