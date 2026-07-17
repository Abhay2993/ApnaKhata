/**
 * ApnaKhata — Distributor Demand Service
 * --------------------------------------
 * The distributor-side procurement view: every retailer forecast run is
 * recorded via `recordForecast()`; `getAggregatedDemand()` rolls the latest
 * forecast per retailer item up to the distributor named as preferred
 * supplier, so they can plan bulk procurement upstream before the reorders
 * actually arrive.
 */

import { Pool } from 'pg';

export interface ForecastRecord {
  inventoryId: string;
  ownerId: string; // retailer
  sku: string;
  dailyDemandMean: number;
  safetyStock: number;
  recommendedOrderQty: number;
  predictedStockoutDate: string | null; // ISO date
  modelUsed: string;
}

export interface AggregatedDemandRow {
  sku: string;
  productName: string;
  retailerCount: number;
  totalRecommendedQty: number;
  combinedDailyDemand: number;
  earliestStockout: string | null;
  latestForecastAt: string;
}

export interface RetailerDemandRow {
  retailerId: string;
  retailerName: string;
  recommendedOrderQty: number;
  dailyDemandMean: number;
  predictedStockoutDate: string | null;
}

export class DistributorDemandService {
  constructor(private readonly db: Pool) {}

  /** Upsert the latest forecast for an item (one live row per inventory_id). */
  async recordForecast(record: ForecastRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO demand_forecasts (
        inventory_id, owner_id, sku, daily_demand_mean, safety_stock,
        recommended_order_qty, predicted_stockout_date, model_used, computed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      ON CONFLICT (inventory_id) DO UPDATE SET
        daily_demand_mean       = EXCLUDED.daily_demand_mean,
        safety_stock            = EXCLUDED.safety_stock,
        recommended_order_qty   = EXCLUDED.recommended_order_qty,
        predicted_stockout_date = EXCLUDED.predicted_stockout_date,
        model_used              = EXCLUDED.model_used,
        computed_at             = now()
      `,
      [
        record.inventoryId,
        record.ownerId,
        record.sku,
        record.dailyDemandMean,
        record.safetyStock,
        record.recommendedOrderQty,
        record.predictedStockoutDate,
        record.modelUsed,
      ],
    );
  }

  /**
   * SKU-level demand rollup across all retailers who name this distributor
   * as preferred supplier — urgent (earliest stockout) first.
   */
  async getAggregatedDemand(distributorId: string): Promise<AggregatedDemandRow[]> {
    const { rows } = await this.db.query<{
      sku: string;
      product_name: string;
      retailer_count: string;
      total_recommended_qty: string;
      combined_daily_demand: string;
      earliest_stockout: Date | null;
      latest_forecast_at: Date;
    }>(
      `
      SELECT sku, product_name, retailer_count, total_recommended_qty,
             combined_daily_demand, earliest_stockout, latest_forecast_at
      FROM v_distributor_demand
      WHERE distributor_id = $1
      ORDER BY earliest_stockout ASC NULLS LAST, total_recommended_qty DESC
      `,
      [distributorId],
    );

    return rows.map((r) => ({
      sku: r.sku,
      productName: r.product_name,
      retailerCount: Number(r.retailer_count),
      totalRecommendedQty: Number(r.total_recommended_qty),
      combinedDailyDemand: Number(r.combined_daily_demand),
      earliestStockout: r.earliest_stockout ? r.earliest_stockout.toISOString().slice(0, 10) : null,
      latestForecastAt: r.latest_forecast_at.toISOString(),
    }));
  }

  /** Per-retailer breakdown behind one SKU's aggregate row. */
  async getRetailerBreakdown(distributorId: string, sku: string): Promise<RetailerDemandRow[]> {
    const { rows } = await this.db.query<{
      owner_id: string;
      business_name: string;
      recommended_order_qty: number;
      daily_demand_mean: string;
      predicted_stockout_date: Date | null;
    }>(
      `
      SELECT d.owner_id, u.business_name, d.recommended_order_qty,
             d.daily_demand_mean, d.predicted_stockout_date
      FROM demand_forecasts d
      JOIN inventory i ON i.id = d.inventory_id
      JOIN users u     ON u.id = d.owner_id
      WHERE i.preferred_supplier_id = $1 AND d.sku = $2
      ORDER BY d.predicted_stockout_date ASC NULLS LAST
      `,
      [distributorId, sku],
    );

    return rows.map((r) => ({
      retailerId: r.owner_id,
      retailerName: r.business_name,
      recommendedOrderQty: r.recommended_order_qty,
      dailyDemandMean: Number(r.daily_demand_mean),
      predictedStockoutDate: r.predicted_stockout_date
        ? r.predicted_stockout_date.toISOString().slice(0, 10)
        : null,
    }));
  }
}
