-- ============================================================================
-- ApnaKhata — Migration 004: Billing & Compliance
-- Depends on: database/schema.sql .. migrations/003_credit_banking.sql
--
-- Adds:
--   1. GST-compliant invoicing — invoice_line_items with HSN + CGST/SGST/IGST
--      splits under existing transactions_ledger headers, plus GSTR-1 views
--      (rate-wise B2B and HSN summary) for filing-ready exports.
--   2. E-invoicing / IRN — einvoice_records storing the IRN, acknowledgement,
--      and signed QR returned by the Invoice Registration Portal.
--   3. Receipts (thermal ESC/POS + PDF + WhatsApp) need no schema — they render
--      from the header + line items.
-- ============================================================================

BEGIN;

CREATE TYPE einvoice_status AS ENUM ('GENERATED', 'CANCELLED');

-- ----------------------------------------------------------------------------
-- GST fields on the invoice header
-- ----------------------------------------------------------------------------
ALTER TABLE transactions_ledger ADD COLUMN invoice_date DATE;              -- defaults to created_at::date in views
ALTER TABLE transactions_ledger ADD COLUMN place_of_supply VARCHAR(2);     -- GST state code of supply

-- ----------------------------------------------------------------------------
-- 1. Invoice line items — the GST truth under each ledger header.
--    Intra-state supplies split tax into CGST+SGST; inter-state uses IGST.
-- ----------------------------------------------------------------------------
CREATE TABLE invoice_line_items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID          NOT NULL REFERENCES transactions_ledger (id) ON DELETE CASCADE,
    line_no        INTEGER       NOT NULL,
    sku            VARCHAR(64),
    description    TEXT          NOT NULL,
    hsn_code       VARCHAR(8)    NOT NULL,
    quantity       NUMERIC(12,3) NOT NULL,
    unit           VARCHAR(16)   NOT NULL DEFAULT 'PCS',
    unit_price     NUMERIC(14,2) NOT NULL,
    taxable_value  NUMERIC(14,2) NOT NULL,
    gst_rate       NUMERIC(4,2)  NOT NULL,
    cgst_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total     NUMERIC(14,2) NOT NULL,

    CONSTRAINT line_no_uq         UNIQUE (transaction_id, line_no),
    CONSTRAINT line_qty_pos       CHECK (quantity > 0),
    CONSTRAINT line_price_nonneg  CHECK (unit_price >= 0),
    CONSTRAINT line_taxable_ok    CHECK (taxable_value >= 0),
    CONSTRAINT line_taxes_nonneg  CHECK (cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0),
    -- a supply is either intra-state (CGST+SGST) or inter-state (IGST), never both
    CONSTRAINT line_tax_exclusive CHECK (igst_amount = 0 OR (cgst_amount = 0 AND sgst_amount = 0))
);

CREATE INDEX idx_line_items_txn ON invoice_line_items (transaction_id);
CREATE INDEX idx_line_items_hsn ON invoice_line_items (hsn_code);

-- ----------------------------------------------------------------------------
-- 2. E-invoice records — one IRN per invoice, unique + idempotent
-- ----------------------------------------------------------------------------
CREATE TABLE einvoice_records (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID            NOT NULL UNIQUE REFERENCES transactions_ledger (id) ON DELETE CASCADE,
    irn            CHAR(64)        NOT NULL UNIQUE,     -- SHA-256 per IRP spec
    ack_no         VARCHAR(20)     NOT NULL,
    ack_date       TIMESTAMPTZ     NOT NULL,
    status         einvoice_status NOT NULL DEFAULT 'GENERATED',
    signed_qr      TEXT            NOT NULL,            -- IRP-signed QR payload
    irp_response   JSONB,
    cancel_reason  TEXT,
    cancelled_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_einvoice_txn ON einvoice_records (transaction_id);

-- ----------------------------------------------------------------------------
-- GSTR-1 views
-- ----------------------------------------------------------------------------

-- Rate-wise B2B outward supplies (GSTR-1 table 4): one row per invoice × rate.
CREATE VIEW v_gstr1_b2b AS
SELECT
    tl.sender_id                                          AS supplier_id,
    su.gstin                                              AS supplier_gstin,
    ru.gstin                                              AS buyer_gstin,
    ru.business_name                                      AS buyer_name,
    tl.id                                                 AS transaction_id,
    tl.invoice_number,
    COALESCE(tl.invoice_date, tl.created_at::date)        AS invoice_date,
    date_trunc('month', COALESCE(tl.invoice_date, tl.created_at::date))::date AS period_month,
    tl.amount                                             AS invoice_value,
    COALESCE(tl.place_of_supply, ru.state_code)           AS place_of_supply,
    li.gst_rate,
    SUM(li.taxable_value)                                 AS taxable_value,
    SUM(li.cgst_amount)                                   AS cgst,
    SUM(li.sgst_amount)                                   AS sgst,
    SUM(li.igst_amount)                                   AS igst
FROM transactions_ledger tl
JOIN users su ON su.id = tl.sender_id
LEFT JOIN users ru ON ru.id = tl.receiver_id
JOIN invoice_line_items li ON li.transaction_id = tl.id
WHERE tl.kind = 'B2B_INVOICE'
GROUP BY tl.sender_id, su.gstin, ru.gstin, ru.business_name, tl.id,
         tl.invoice_number, tl.invoice_date, tl.created_at, tl.amount,
         tl.place_of_supply, ru.state_code, li.gst_rate;

-- HSN-wise summary of all outward supplies (GSTR-1 table 12), monthly grain.
CREATE VIEW v_gstr1_hsn AS
SELECT
    tl.sender_id                                          AS supplier_id,
    date_trunc('month', COALESCE(tl.invoice_date, tl.created_at::date))::date AS period_month,
    li.hsn_code,
    li.unit                                               AS uqc,
    li.gst_rate,
    SUM(li.quantity)                                      AS total_quantity,
    SUM(li.taxable_value)                                 AS taxable_value,
    SUM(li.cgst_amount)                                   AS cgst,
    SUM(li.sgst_amount)                                   AS sgst,
    SUM(li.igst_amount)                                   AS igst
FROM transactions_ledger tl
JOIN invoice_line_items li ON li.transaction_id = tl.id
WHERE tl.kind IN ('B2B_INVOICE', 'RETAIL_SALE')
GROUP BY tl.sender_id, period_month, li.hsn_code, li.unit, li.gst_rate;

COMMIT;
