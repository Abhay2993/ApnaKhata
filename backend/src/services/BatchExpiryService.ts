/**
 * ApnaKhata — Batch & Expiry Service
 * ----------------------------------
 * Near-expiry alerting and expired write-off over `inventory_batches`, plus
 * the batch payload the forecasting service needs to compute expiry-aware
 * usable stock (see forecast.py `batches` input).
 */

import { Pool } from 'pg';

export interface ExpiringBatch {
  batchId: string;
  inventoryId: string;
  sku: string;
  productName: string;
  batchNumber: string;
  expiryDate: string;
  daysToExpiry: number;
  qtyRemaining: number;
  valueAtRisk: number; // at wholesale price, INR
}

export interface ForecastBatch {
  quantity: number;
  expiry_date: string | null; // snake_case: shipped straight to forecast.py
}

export class BatchExpiryService {
  constructor(private readonly db: Pool) {}

  /** Batches expiring within `withinDays`, soonest (and priciest) first. */
  async nearExpiry(ownerId: string, withinDays = 30): Promise<ExpiringBatch[]> {
    const { rows } = await this.db.query<{
      batch_id: string;
      inventory_id: string;
      sku: string;
      product_name: string;
      batch_number: string;
      expiry_date: Date;
      days_to_expiry: number;
      qty_remaining: string;
      value_at_risk: string;
    }>(
      `
      SELECT batch_id, inventory_id, sku, product_name, batch_number,
             expiry_date, days_to_expiry, qty_remaining, value_at_risk
      FROM v_expiring_stock
      WHERE owner_id = $1 AND days_to_expiry <= $2
      ORDER BY days_to_expiry ASC, value_at_risk DESC
      `,
      [ownerId, withinDays],
    );

    return rows.map((r) => ({
      batchId: r.batch_id,
      inventoryId: r.inventory_id,
      sku: r.sku,
      productName: r.product_name,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date.toISOString().slice(0, 10),
      daysToExpiry: r.days_to_expiry,
      qtyRemaining: Number(r.qty_remaining),
      valueAtRisk: Number(r.value_at_risk),
    }));
  }

  /**
   * Zero out every expired batch for the owner (scheduled daily). The DB
   * function adjusts aggregate stock and writes ADJUSTMENT movements.
   */
  async writeOffExpired(ownerId: string, asOf?: string): Promise<{ unitsWrittenOff: number }> {
    const { rows } = await this.db.query<{ write_off_expired: string }>(
      `SELECT write_off_expired($1, COALESCE($2::date, CURRENT_DATE))`,
      [ownerId, asOf ?? null],
    );
    return { unitsWrittenOff: Number(rows[0].write_off_expired) };
  }

  /**
   * Open batches for one item in the exact shape forecast.py expects, so the
   * forecast can discount stock that will expire before demand reaches it.
   */
  async getBatchesForForecast(inventoryId: string): Promise<ForecastBatch[]> {
    const { rows } = await this.db.query<{ qty_remaining: string; expiry_date: Date | null }>(
      `
      SELECT qty_remaining, expiry_date
      FROM inventory_batches
      WHERE inventory_id = $1 AND qty_remaining > 0
      ORDER BY expiry_date ASC NULLS LAST
      `,
      [inventoryId],
    );

    return rows.map((r) => ({
      quantity: Number(r.qty_remaining),
      expiry_date: r.expiry_date ? r.expiry_date.toISOString().slice(0, 10) : null,
    }));
  }
}
