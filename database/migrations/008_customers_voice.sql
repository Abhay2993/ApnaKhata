-- ============================================================================
-- ApnaKhata — Migration 008: Customer khata (consumer udhaar) for voice & WhatsApp
-- Depends on: database/schema.sql .. migrations/007_analytics_schemes.sql
--
-- Voice entries ("Ramesh ko paanch sau udhaar") and the WhatsApp bot both land
-- as customer ledger entries, so this adds the consumer-udhaar ledger every
-- kirana keeps — the Khatabook core the B2B ledger didn't cover.
-- ============================================================================

BEGIN;

CREATE TYPE customer_entry_type AS ENUM ('CREDIT', 'PAYMENT');
-- CREDIT  = shop extended credit / customer took goods  → customer owes more
-- PAYMENT = customer paid                               → customer owes less

CREATE TABLE customers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    phone      VARCHAR(15),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT customer_name_owner_uq UNIQUE (owner_id, name)   -- voice looks up by name
);

CREATE INDEX idx_customers_owner ON customers (owner_id);
CREATE INDEX idx_customers_phone ON customers (phone) WHERE phone IS NOT NULL;

CREATE TABLE customer_ledger_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID                NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    owner_id    UUID                NOT NULL REFERENCES users (id),
    entry_type  customer_entry_type NOT NULL,
    amount      NUMERIC(14,2)       NOT NULL,
    note        TEXT,
    source      VARCHAR(16)         NOT NULL DEFAULT 'MANUAL',  -- VOICE | MANUAL | WHATSAPP
    transcript  TEXT,                                          -- original utterance, for audit
    created_at  TIMESTAMPTZ         NOT NULL DEFAULT now(),

    CONSTRAINT customer_entry_amount_pos CHECK (amount > 0)
);

CREATE INDEX idx_customer_entries ON customer_ledger_entries (customer_id, created_at DESC);
CREATE INDEX idx_customer_entries_owner ON customer_ledger_entries (owner_id, created_at DESC);

-- Running balance per customer (positive = customer owes the shop).
CREATE VIEW v_customer_balances AS
SELECT
    c.id       AS customer_id,
    c.owner_id,
    c.name,
    c.phone,
    COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS balance,
    MAX(e.created_at) AS last_activity
FROM customers c
LEFT JOIN customer_ledger_entries e ON e.customer_id = c.id
GROUP BY c.id;

COMMIT;
