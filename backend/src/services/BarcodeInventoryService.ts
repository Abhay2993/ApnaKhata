/**
 * ApnaKhata — Barcode Inventory Service
 * -------------------------------------
 * Backend for camera-based scanning (no extra hardware): the mobile scanner
 * resolves an EAN/UPC/QR code to an inventory item, then either stocks in a
 * new batch (goods inward) or sells FEFO (billing counter). Both paths are
 * atomic in the database (`stock_in_batch()` / `consume_stock_fefo()`).
 */

import { Pool } from 'pg';

export interface ScannedProduct {
  inventoryId: string;
  sku: string;
  productName: string;
  unit: string;
  barcode: string;
  currentStock: number;
  retailPrice: number;
  wholesalePrice: number;
  nearestExpiry: string | null; // earliest open batch expiry, if any
}

export interface StockInInput {
  ownerId: string;
  barcode: string;
  quantity: number;
  batchNumber?: string;
  expiryDate?: string; // ISO date
  locationId?: string;
  unitCost?: number;
}

export interface SaleLine {
  barcode: string;
  quantity: number;
}

export interface SaleResult {
  inventoryId: string;
  sku: string;
  quantity: number;
  lineTotal: number;
}

export class BarcodeInventoryService {
  constructor(private readonly db: Pool) {}

  /** Attach (or replace) the barcode on an inventory item. */
  async assignBarcode(inventoryId: string, barcode: string): Promise<void> {
    const code = barcode.trim();
    if (!code) throw new Error('barcode cannot be empty');
    await this.db.query(`UPDATE inventory SET barcode = $2 WHERE id = $1`, [inventoryId, code]);
  }

  /** Resolve a scanned code to the owner's product, with live stock. */
  async lookup(ownerId: string, barcode: string): Promise<ScannedProduct | null> {
    const { rows } = await this.db.query<{
      id: string;
      sku: string;
      product_name: string;
      unit: string;
      barcode: string;
      current_stock: string;
      retail_price: string;
      wholesale_price: string;
      nearest_expiry: Date | null;
    }>(
      `
      SELECT i.id, i.sku, i.product_name, i.unit, i.barcode, i.current_stock,
             i.retail_price, i.wholesale_price,
             (SELECT MIN(b.expiry_date) FROM inventory_batches b
               WHERE b.inventory_id = i.id AND b.qty_remaining > 0
                 AND b.expiry_date IS NOT NULL) AS nearest_expiry
      FROM inventory i
      WHERE i.owner_id = $1 AND i.barcode = $2 AND i.is_active
      `,
      [ownerId, barcode.trim()],
    );
    const row = rows[0];
    if (!row) return null;

    return {
      inventoryId: row.id,
      sku: row.sku,
      productName: row.product_name,
      unit: row.unit,
      barcode: row.barcode,
      currentStock: Number(row.current_stock),
      retailPrice: Number(row.retail_price),
      wholesalePrice: Number(row.wholesale_price),
      nearestExpiry: row.nearest_expiry ? row.nearest_expiry.toISOString().slice(0, 10) : null,
    };
  }

  /** Scan-driven goods inward: creates an expiry-aware batch atomically. */
  async stockIn(input: StockInInput): Promise<{ batchId: string; newStock: number }> {
    if (input.quantity <= 0) throw new Error('quantity must be positive');

    const product = await this.lookup(input.ownerId, input.barcode);
    if (!product) throw new Error(`no product with barcode ${input.barcode} for this owner`);

    const { rows } = await this.db.query<{ stock_in_batch: string }>(
      `SELECT stock_in_batch($1, $2, $3, $4, $5, $6)`,
      [
        product.inventoryId,
        input.quantity,
        input.batchNumber ?? `SCAN-${new Date().toISOString().slice(0, 10)}`,
        input.expiryDate ?? null,
        input.locationId ?? null,
        input.unitCost ?? null,
      ],
    );

    return { batchId: rows[0].stock_in_batch, newStock: product.currentStock + input.quantity };
  }

  /**
   * Scan-driven billing: consume each line FEFO (oldest expiry sold first)
   * in one transaction, returning priced lines for the receipt.
   */
  async sell(ownerId: string, lines: SaleLine[]): Promise<{ lines: SaleResult[]; total: number }> {
    if (lines.length === 0) throw new Error('nothing to bill');

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const results: SaleResult[] = [];
      for (const line of lines) {
        if (line.quantity <= 0) throw new Error(`quantity must be positive for ${line.barcode}`);

        const { rows } = await client.query<{
          id: string;
          sku: string;
          retail_price: string;
        }>(
          `SELECT id, sku, retail_price FROM inventory
            WHERE owner_id = $1 AND barcode = $2 AND is_active`,
          [ownerId, line.barcode.trim()],
        );
        const product = rows[0];
        if (!product) throw new Error(`no product with barcode ${line.barcode} for this owner`);

        await client.query(`SELECT consume_stock_fefo($1, $2, 'SALE')`, [product.id, line.quantity]);

        results.push({
          inventoryId: product.id,
          sku: product.sku,
          quantity: line.quantity,
          lineTotal: line.quantity * Number(product.retail_price),
        });
      }

      await client.query('COMMIT');
      return { lines: results, total: results.reduce((sum, l) => sum + l.lineTotal, 0) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
