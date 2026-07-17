/**
 * ApnaKhata — Purchase Order Service
 * ----------------------------------
 * Powers the dashboard's one-tap reorder: `createFromForecast()` turns a
 * forecast recommendation into a SUBMITTED purchase order addressed to the
 * item's preferred distributor in a single call. Goods receipt is atomic in
 * the database (`receive_purchase_order()`): it closes the PO, raises the B2B
 * invoice on the ledger, and stocks every line into expiry-aware batches.
 *
 * Status flow: DRAFT → SUBMITTED → ACCEPTED → DISPATCHED → RECEIVED
 *              (CANCELLED allowed any time before RECEIVED)
 */

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';

export type PoStatus = 'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';

export interface PoItemInput {
  sku: string;
  productName: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  source?: 'FORECAST' | 'MANUAL' | 'SCAN';
  expiryDate?: string; // ISO date, if known at ordering time
}

export interface PurchaseOrderItem extends Required<Omit<PoItemInput, 'expiryDate'>> {
  id: string;
  expiryDate: string | null;
  lineTotal: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  buyerId: string;
  supplierId: string;
  status: PoStatus;
  totalAmount: number;
  invoiceId: string | null;
  items: PurchaseOrderItem[];
  createdAt: string;
}

const ALLOWED_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: [], // terminal transitions happen via receive()
  RECEIVED: [],
  CANCELLED: [],
};

export class PurchaseOrderService {
  constructor(private readonly db: Pool) {}

  /**
   * One-tap reorder: read the item's latest stored forecast and preferred
   * supplier, then create and submit a PO for the recommended quantity.
   */
  async createFromForecast(inventoryId: string): Promise<PurchaseOrder> {
    const { rows } = await this.db.query<{
      owner_id: string;
      sku: string;
      product_name: string;
      unit: string;
      wholesale_price: string;
      preferred_supplier_id: string | null;
      recommended_order_qty: number | null;
    }>(
      `
      SELECT i.owner_id, i.sku, i.product_name, i.unit, i.wholesale_price,
             i.preferred_supplier_id, d.recommended_order_qty
      FROM inventory i
      LEFT JOIN demand_forecasts d ON d.inventory_id = i.id
      WHERE i.id = $1
      `,
      [inventoryId],
    );
    const item = rows[0];
    if (!item) throw new Error('inventory item not found');
    if (!item.preferred_supplier_id) {
      throw new Error('no preferred supplier set for this item; choose a distributor first');
    }
    const qty = item.recommended_order_qty ?? 0;
    if (qty <= 0) throw new Error('no positive reorder recommendation on record for this item');

    return this.createOrder({
      buyerId: item.owner_id,
      supplierId: item.preferred_supplier_id,
      submit: true,
      items: [
        {
          sku: item.sku,
          productName: item.product_name,
          unit: item.unit,
          quantity: qty,
          unitPrice: Number(item.wholesale_price),
          source: 'FORECAST',
        },
      ],
    });
  }

  /** Create a PO (optionally already SUBMITTED) with its line items. */
  async createOrder(input: {
    buyerId: string;
    supplierId: string;
    items: PoItemInput[];
    notes?: string;
    expectedDeliveryDate?: string;
    submit?: boolean;
  }): Promise<PurchaseOrder> {
    if (input.items.length === 0) throw new Error('a purchase order needs at least one item');
    for (const item of input.items) {
      if (item.quantity <= 0) throw new Error(`quantity must be positive for ${item.sku}`);
      if (item.unitPrice < 0) throw new Error(`unit price cannot be negative for ${item.sku}`);
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const poNumber = this.buildPoNumber();
      const { rows } = await client.query<{ id: string }>(
        `
        INSERT INTO purchase_orders (po_number, buyer_id, supplier_id, status, notes, expected_delivery_date)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        `,
        [
          poNumber,
          input.buyerId,
          input.supplierId,
          input.submit ? 'SUBMITTED' : 'DRAFT',
          input.notes ?? null,
          input.expectedDeliveryDate ?? null,
        ],
      );
      const poId = rows[0].id;

      for (const item of input.items) {
        await client.query(
          `
          INSERT INTO purchase_order_items (po_id, sku, product_name, unit, quantity, unit_price, source, expiry_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            poId,
            item.sku,
            item.productName,
            item.unit ?? 'PCS',
            item.quantity,
            item.unitPrice,
            item.source ?? 'MANUAL',
            item.expiryDate ?? null,
          ],
        );
      }

      await client.query('COMMIT');
      return this.getOrder(poId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Advance the PO through its lifecycle (supplier accepts, dispatches, …). */
  async transition(poId: string, to: Exclude<PoStatus, 'DRAFT' | 'RECEIVED'>): Promise<PurchaseOrder> {
    const { rows } = await this.db.query<{ status: PoStatus }>(
      `SELECT status FROM purchase_orders WHERE id = $1`,
      [poId],
    );
    if (!rows[0]) throw new Error('purchase order not found');
    const from = rows[0].status;
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new Error(`cannot move purchase order from ${from} to ${to}`);
    }

    await this.db.query(`UPDATE purchase_orders SET status = $2 WHERE id = $1`, [poId, to]);
    return this.getOrder(poId);
  }

  /**
   * Goods receipt: atomically closes the PO, raises the ledger invoice, and
   * stocks all lines into batches at the given location. Idempotent replay
   * returns the same invoice.
   */
  async receive(poId: string, locationId?: string, dueDays = 30): Promise<{ invoiceId: string; order: PurchaseOrder }> {
    const { rows } = await this.db.query<{ receive_purchase_order: string }>(
      `SELECT receive_purchase_order($1, $2, $3)`,
      [poId, locationId ?? null, dueDays],
    );
    return { invoiceId: rows[0].receive_purchase_order, order: await this.getOrder(poId) };
  }

  async getOrder(poId: string, client: PoolClient | Pool = this.db): Promise<PurchaseOrder> {
    const { rows } = await client.query<{
      id: string;
      po_number: string;
      buyer_id: string;
      supplier_id: string;
      status: PoStatus;
      invoice_id: string | null;
      created_at: Date;
    }>(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]);
    const po = rows[0];
    if (!po) throw new Error('purchase order not found');

    const { rows: itemRows } = await client.query<{
      id: string;
      sku: string;
      product_name: string;
      unit: string;
      quantity: string;
      unit_price: string;
      source: 'FORECAST' | 'MANUAL' | 'SCAN';
      expiry_date: Date | null;
    }>(`SELECT * FROM purchase_order_items WHERE po_id = $1 ORDER BY sku`, [poId]);

    const items: PurchaseOrderItem[] = itemRows.map((r) => ({
      id: r.id,
      sku: r.sku,
      productName: r.product_name,
      unit: r.unit,
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
      source: r.source,
      expiryDate: r.expiry_date ? r.expiry_date.toISOString().slice(0, 10) : null,
      lineTotal: Number(r.quantity) * Number(r.unit_price),
    }));

    return {
      id: po.id,
      poNumber: po.po_number,
      buyerId: po.buyer_id,
      supplierId: po.supplier_id,
      status: po.status,
      totalAmount: items.reduce((sum, i) => sum + i.lineTotal, 0),
      invoiceId: po.invoice_id,
      items,
      createdAt: po.created_at.toISOString(),
    };
  }

  /** `PO-20260716-4F2A9C` — date-stamped, random suffix, unique-indexed. */
  private buildPoNumber(): string {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `PO-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  }
}
