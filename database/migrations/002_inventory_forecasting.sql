-- ============================================================================
-- ApnaKhata — Migration 002: Inventory & Forecasting enhancements
-- Depends on: database/schema.sql, migrations/001_payments_ledger.sql
--
-- Adds five capabilities around the forecasting loop:
--   1. One-tap reorder → purchase orders (PO lifecycle, receipt books the
--      B2B invoice and stocks in automatically)
--   2. Barcode/QR support on inventory for camera-based stock-in & billing
--   3. Batch & expiry tracking (FEFO consumption, near-expiry alerts,
--      expired write-off)
--   4. Multi-location / warehouse stock (godowns + transfers)
--   5. Demand aggregation for the distributor-side procurement view
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Enumerated types
-- ----------------------------------------------------------------------------
CREATE TYPE po_status     AS ENUM ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'DISPATCHED', 'RECEIVED', 'CANCELLED');
CREATE TYPE location_kind AS ENUM ('STORE', 'GODOWN');

-- ----------------------------------------------------------------------------
-- Inventory extensions: barcode + preferred supplier (drives one-tap reorder
-- and the distributor demand rollup)
-- ----------------------------------------------------------------------------
ALTER TABLE inventory ADD COLUMN barcode VARCHAR(64);
ALTER TABLE inventory ADD COLUMN preferred_supplier_id UUID REFERENCES users (id);

CREATE UNIQUE INDEX idx_inventory_owner_barcode
    ON inventory (owner_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_inventory_supplier
    ON inventory (preferred_supplier_id) WHERE preferred_supplier_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. Stock locations (a shop floor plus any number of godowns)
-- ----------------------------------------------------------------------------
CREATE TABLE stock_locations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT          NOT NULL,
    kind       location_kind NOT NULL DEFAULT 'STORE',
    address    TEXT,
    is_default BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT location_name_uq UNIQUE (owner_id, name)
);

-- At most one default location per owner.
CREATE UNIQUE INDEX idx_location_default ON stock_locations (owner_id) WHERE is_default;

-- ----------------------------------------------------------------------------
-- 3. Inventory batches — expiry-aware stock, FEFO-consumed.
-- inventory.current_stock stays the owner-level aggregate; batches carry
-- expiry and location detail underneath it.
-- ----------------------------------------------------------------------------
CREATE TABLE inventory_batches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id  UUID          NOT NULL REFERENCES inventory (id) ON DELETE CASCADE,
    location_id   UUID          REFERENCES stock_locations (id),
    batch_number  VARCHAR(64)   NOT NULL,
    expiry_date   DATE,                                   -- NULL = non-perishable
    qty_received  NUMERIC(12,3) NOT NULL,
    qty_remaining NUMERIC(12,3) NOT NULL,
    unit_cost     NUMERIC(14,2),
    received_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT batch_qty_received_pos CHECK (qty_received > 0),
    CONSTRAINT batch_qty_remaining_ok CHECK (qty_remaining >= 0 AND qty_remaining <= qty_received)
);

-- FEFO scan: open batches for an item, earliest expiry first.
CREATE INDEX idx_batches_fefo
    ON inventory_batches (inventory_id, expiry_date ASC NULLS LAST, received_at ASC)
    WHERE qty_remaining > 0;
CREATE INDEX idx_batches_expiry
    ON inventory_batches (expiry_date) WHERE qty_remaining > 0 AND expiry_date IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 1. Purchase orders
-- ----------------------------------------------------------------------------
CREATE TABLE purchase_orders (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number              VARCHAR(32)  NOT NULL UNIQUE,
    buyer_id               UUID         NOT NULL REFERENCES users (id),
    supplier_id            UUID         NOT NULL REFERENCES users (id),
    status                 po_status    NOT NULL DEFAULT 'DRAFT',
    notes                  TEXT,
    expected_delivery_date DATE,
    invoice_id             UUID         REFERENCES transactions_ledger (id),
    received_at            TIMESTAMPTZ,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT po_parties_differ CHECK (buyer_id <> supplier_id)
);

CREATE INDEX idx_po_buyer    ON purchase_orders (buyer_id, status, created_at DESC);
CREATE INDEX idx_po_supplier ON purchase_orders (supplier_id, status, created_at DESC);

CREATE TRIGGER trg_po_touch BEFORE UPDATE ON purchase_orders
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_order_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id        UUID          NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
    sku          VARCHAR(64)   NOT NULL,
    product_name TEXT          NOT NULL,
    unit         VARCHAR(16)   NOT NULL DEFAULT 'PCS',
    quantity     NUMERIC(12,3) NOT NULL,
    unit_price   NUMERIC(14,2) NOT NULL,
    source       VARCHAR(16)   NOT NULL DEFAULT 'MANUAL',  -- FORECAST | MANUAL | SCAN
    expiry_date  DATE,                                     -- filled at goods receipt if known

    CONSTRAINT po_item_qty_pos   CHECK (quantity > 0),
    CONSTRAINT po_item_price_ok  CHECK (unit_price >= 0),
    CONSTRAINT po_item_sku_uq    UNIQUE (po_id, sku)
);

CREATE INDEX idx_po_items ON purchase_order_items (po_id);

-- ----------------------------------------------------------------------------
-- 5. Demand forecast store — latest forecast per inventory item, written by
-- the backend after each forecasting run; the distributor view aggregates it.
-- ----------------------------------------------------------------------------
CREATE TABLE demand_forecasts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id            UUID          NOT NULL UNIQUE REFERENCES inventory (id) ON DELETE CASCADE,
    owner_id                UUID          NOT NULL REFERENCES users (id),
    sku                     VARCHAR(64)   NOT NULL,
    daily_demand_mean       NUMERIC(12,3) NOT NULL,
    safety_stock            NUMERIC(12,3) NOT NULL DEFAULT 0,
    recommended_order_qty   INTEGER       NOT NULL DEFAULT 0,
    predicted_stockout_date DATE,
    model_used              VARCHAR(32)   NOT NULL,
    computed_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_forecasts_owner ON demand_forecasts (owner_id);

-- ----------------------------------------------------------------------------
-- Functions
-- ----------------------------------------------------------------------------

-- Stock in a batch (goods receipt or manual entry): batch row + aggregate
-- stock + movement, atomically.
CREATE OR REPLACE FUNCTION stock_in_batch(
    p_inventory_id UUID,
    p_qty          NUMERIC,
    p_batch_number VARCHAR,
    p_expiry_date  DATE    DEFAULT NULL,
    p_location_id  UUID    DEFAULT NULL,
    p_unit_cost    NUMERIC DEFAULT NULL,
    p_ledger_id    UUID    DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_inv      inventory%ROWTYPE;
    v_batch_id UUID;
BEGIN
    IF p_qty <= 0 THEN
        RAISE EXCEPTION 'stock-in quantity must be positive';
    END IF;

    SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'inventory item % not found', p_inventory_id;
    END IF;

    INSERT INTO inventory_batches (inventory_id, location_id, batch_number, expiry_date, qty_received, qty_remaining, unit_cost)
    VALUES (p_inventory_id, p_location_id, p_batch_number, p_expiry_date, p_qty, p_qty, p_unit_cost)
    RETURNING id INTO v_batch_id;

    UPDATE inventory SET current_stock = current_stock + p_qty WHERE id = p_inventory_id;

    INSERT INTO stock_movements (inventory_id, owner_id, delta, reason, ledger_id, stock_after)
    VALUES (p_inventory_id, v_inv.owner_id, p_qty, 'PURCHASE', p_ledger_id, v_inv.current_stock + p_qty);

    RETURN v_batch_id;
END;
$$ LANGUAGE plpgsql;

-- Consume stock FEFO (earliest expiry first; loose un-batched stock last).
-- Used by billing/sales. Errors if total stock is insufficient.
CREATE OR REPLACE FUNCTION consume_stock_fefo(
    p_inventory_id UUID,
    p_qty          NUMERIC,
    p_reason       movement_reason DEFAULT 'SALE',
    p_location_id  UUID DEFAULT NULL
) RETURNS TABLE (batch_id UUID, qty_consumed NUMERIC) AS $$
DECLARE
    v_inv       inventory%ROWTYPE;
    v_batch     RECORD;
    v_remaining NUMERIC(12,3);
    v_slice     NUMERIC(12,3);
BEGIN
    IF p_qty <= 0 THEN
        RAISE EXCEPTION 'consume quantity must be positive';
    END IF;

    SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'inventory item % not found', p_inventory_id;
    END IF;
    IF v_inv.current_stock < p_qty THEN
        RAISE EXCEPTION 'insufficient stock: have %, need %', v_inv.current_stock, p_qty;
    END IF;

    v_remaining := p_qty;

    FOR v_batch IN
        SELECT b.id, b.qty_remaining
        FROM inventory_batches b
        WHERE b.inventory_id = p_inventory_id
          AND b.qty_remaining > 0
          AND (p_location_id IS NULL OR b.location_id = p_location_id)
        ORDER BY b.expiry_date ASC NULLS LAST, b.received_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_slice := LEAST(v_remaining, v_batch.qty_remaining);

        UPDATE inventory_batches SET qty_remaining = qty_remaining - v_slice WHERE id = v_batch.id;

        v_remaining := v_remaining - v_slice;
        batch_id := v_batch.id;
        qty_consumed := v_slice;
        RETURN NEXT;
    END LOOP;

    -- Any residue comes out of loose (un-batched) stock.
    IF v_remaining > 0 THEN
        batch_id := NULL;
        qty_consumed := v_remaining;
        RETURN NEXT;
    END IF;

    UPDATE inventory SET current_stock = current_stock - p_qty WHERE id = p_inventory_id;

    INSERT INTO stock_movements (inventory_id, owner_id, delta, reason, stock_after)
    VALUES (p_inventory_id, v_inv.owner_id, -p_qty, p_reason, v_inv.current_stock - p_qty);

    RETURN;
END;
$$ LANGUAGE plpgsql;

-- Write off every expired batch for an owner. Idempotent (zeroed batches
-- don't match again). Returns total units written off.
CREATE OR REPLACE FUNCTION write_off_expired(p_owner_id UUID, p_as_of DATE DEFAULT CURRENT_DATE)
RETURNS NUMERIC AS $$
DECLARE
    v_batch RECORD;
    v_total NUMERIC(12,3) := 0;
    v_stock NUMERIC(12,3);
BEGIN
    FOR v_batch IN
        SELECT b.id, b.qty_remaining, b.inventory_id
        FROM inventory_batches b
        JOIN inventory i ON i.id = b.inventory_id
        WHERE i.owner_id = p_owner_id
          AND b.expiry_date IS NOT NULL
          AND b.expiry_date < p_as_of
          AND b.qty_remaining > 0
        ORDER BY b.inventory_id
        FOR UPDATE OF b
    LOOP
        SELECT current_stock INTO v_stock FROM inventory WHERE id = v_batch.inventory_id FOR UPDATE;

        UPDATE inventory_batches SET qty_remaining = 0 WHERE id = v_batch.id;
        UPDATE inventory
        SET current_stock = GREATEST(current_stock - v_batch.qty_remaining, 0)
        WHERE id = v_batch.inventory_id;

        INSERT INTO stock_movements (inventory_id, owner_id, delta, reason, stock_after)
        VALUES (v_batch.inventory_id, p_owner_id, -LEAST(v_batch.qty_remaining, v_stock), 'ADJUSTMENT',
                GREATEST(v_stock - v_batch.qty_remaining, 0));

        v_total := v_total + v_batch.qty_remaining;
    END LOOP;

    RETURN v_total;
END;
$$ LANGUAGE plpgsql;

-- Move stock between two of the owner's locations, FEFO from the source,
-- preserving batch identity (batch number, expiry, cost) at the target.
CREATE OR REPLACE FUNCTION transfer_stock(
    p_inventory_id UUID,
    p_from_location UUID,
    p_to_location   UUID,
    p_qty           NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    v_batch     RECORD;
    v_remaining NUMERIC(12,3);
    v_slice     NUMERIC(12,3);
BEGIN
    IF p_qty <= 0 THEN
        RAISE EXCEPTION 'transfer quantity must be positive';
    END IF;
    IF p_from_location = p_to_location THEN
        RAISE EXCEPTION 'source and target locations are the same';
    END IF;

    v_remaining := p_qty;

    FOR v_batch IN
        SELECT b.id, b.batch_number, b.expiry_date, b.unit_cost, b.qty_remaining
        FROM inventory_batches b
        WHERE b.inventory_id = p_inventory_id
          AND b.location_id = p_from_location
          AND b.qty_remaining > 0
        ORDER BY b.expiry_date ASC NULLS LAST, b.received_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_slice := LEAST(v_remaining, v_batch.qty_remaining);

        UPDATE inventory_batches SET qty_remaining = qty_remaining - v_slice WHERE id = v_batch.id;

        INSERT INTO inventory_batches
            (inventory_id, location_id, batch_number, expiry_date, qty_received, qty_remaining, unit_cost)
        VALUES
            (p_inventory_id, p_to_location, v_batch.batch_number, v_batch.expiry_date, v_slice, v_slice, v_batch.unit_cost);

        v_remaining := v_remaining - v_slice;
    END LOOP;

    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'insufficient stock at source location: short by %', v_remaining;
    END IF;

    RETURN p_qty;   -- aggregate owner stock is unchanged; batches carry the trail
END;
$$ LANGUAGE plpgsql;

-- Goods receipt: close the PO, raise the B2B invoice on the ledger, and stock
-- every line into batches — one atomic operation.
CREATE OR REPLACE FUNCTION receive_purchase_order(
    p_po_id       UUID,
    p_location_id UUID    DEFAULT NULL,
    p_due_days    INTEGER DEFAULT 30
) RETURNS UUID AS $$
DECLARE
    v_po         purchase_orders%ROWTYPE;
    v_item       RECORD;
    v_total      NUMERIC(14,2);
    v_invoice_id UUID;
    v_inv_id     UUID;
BEGIN
    SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'purchase order % not found', p_po_id;
    END IF;
    IF v_po.status = 'RECEIVED' THEN
        RETURN v_po.invoice_id;                    -- idempotent replay
    END IF;
    IF v_po.status NOT IN ('SUBMITTED', 'ACCEPTED', 'DISPATCHED') THEN
        RAISE EXCEPTION 'purchase order % cannot be received from status %', p_po_id, v_po.status;
    END IF;

    SELECT COALESCE(SUM(quantity * unit_price), 0) INTO v_total
    FROM purchase_order_items WHERE po_id = p_po_id;
    IF v_total <= 0 THEN
        RAISE EXCEPTION 'purchase order % has no billable items', p_po_id;
    END IF;

    INSERT INTO transactions_ledger
        (kind, sender_id, receiver_id, invoice_number, amount, balance_remaining, payment_status, due_date)
    VALUES
        ('B2B_INVOICE', v_po.supplier_id, v_po.buyer_id, v_po.po_number, v_total, v_total, 'DUE',
         CURRENT_DATE + p_due_days)
    RETURNING id INTO v_invoice_id;

    FOR v_item IN SELECT * FROM purchase_order_items WHERE po_id = p_po_id LOOP
        SELECT id INTO v_inv_id FROM inventory
        WHERE owner_id = v_po.buyer_id AND sku = v_item.sku;

        IF v_inv_id IS NULL THEN
            INSERT INTO inventory
                (owner_id, sku, product_name, unit, wholesale_price, retail_price, preferred_supplier_id)
            VALUES
                (v_po.buyer_id, v_item.sku, v_item.product_name, v_item.unit,
                 v_item.unit_price, v_item.unit_price, v_po.supplier_id)
            RETURNING id INTO v_inv_id;
        END IF;

        PERFORM stock_in_batch(
            v_inv_id, v_item.quantity, v_po.po_number,
            v_item.expiry_date, p_location_id, v_item.unit_price, v_invoice_id
        );
    END LOOP;

    UPDATE purchase_orders
    SET status = 'RECEIVED', invoice_id = v_invoice_id, received_at = now()
    WHERE id = p_po_id;

    RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Views
-- ----------------------------------------------------------------------------

-- Near-expiry stock with value at risk (filter days_to_expiry in queries).
CREATE VIEW v_expiring_stock AS
SELECT
    b.id                              AS batch_id,
    i.owner_id,
    i.id                              AS inventory_id,
    i.sku,
    i.product_name,
    b.batch_number,
    b.location_id,
    b.expiry_date,
    b.qty_remaining,
    (b.expiry_date - CURRENT_DATE)    AS days_to_expiry,
    b.qty_remaining * i.wholesale_price AS value_at_risk
FROM inventory_batches b
JOIN inventory i ON i.id = b.inventory_id
WHERE b.qty_remaining > 0
  AND b.expiry_date IS NOT NULL;

-- Distributor procurement rollup: latest forecast demand across every
-- retailer whose item names this distributor as preferred supplier.
CREATE VIEW v_distributor_demand AS
SELECT
    i.preferred_supplier_id           AS distributor_id,
    i.sku,
    MAX(i.product_name)               AS product_name,
    COUNT(DISTINCT d.owner_id)        AS retailer_count,
    SUM(d.recommended_order_qty)      AS total_recommended_qty,
    SUM(d.daily_demand_mean)          AS combined_daily_demand,
    MIN(d.predicted_stockout_date)    AS earliest_stockout,
    MAX(d.computed_at)                AS latest_forecast_at
FROM demand_forecasts d
JOIN inventory i ON i.id = d.inventory_id
WHERE i.preferred_supplier_id IS NOT NULL
GROUP BY i.preferred_supplier_id, i.sku;

COMMIT;
