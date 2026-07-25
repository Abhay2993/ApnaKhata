/**
 * ApnaKhata — Festival demand planner
 * -----------------------------------
 * The Prophet forecaster already models Indian festival seasonality; this
 * surfaces it as proactive advice: "Diwali is in 18 days — order 3× your usual
 * salt by Oct 27 so it lands in time." For each upcoming festival it combines
 * the stored per-item forecast (daily demand, current stock) with a
 * festival-specific demand uplift and the supplier's lead time to produce a
 * stock-up list with an order-by date. Read-only over demand_forecasts +
 * inventory.
 */

import { Pool } from 'pg';

export interface Festival {
  name: string;
  date: string; // ISO
  daysAway: number;
  uplift: number; // demand multiplier during the run-up window
  windowDays: number; // festival buying window
}

export interface StockUpItem {
  inventoryId: string;
  sku: string;
  productName: string;
  currentStock: number;
  unit: string;
  dailyDemandMean: number;
  festivalDemand: number; // expected demand across the window at uplift
  suggestedOrderQty: number;
  orderByDate: string; // festival date − lead time
  distributorName: string | null;
}

export interface FestivalPlan {
  festival: Festival;
  items: StockUpItem[];
  advice: string;
}

// Lunar-calendar dates vary by year; maintained here (extend annually).
const FESTIVALS: { name: string; date: string; uplift: number; windowDays: number }[] = [
  { name: 'Holi', date: '2026-03-04', uplift: 2.0, windowDays: 5 },
  { name: 'Raksha Bandhan', date: '2026-08-28', uplift: 1.5, windowDays: 4 },
  { name: 'Ganesh Chaturthi', date: '2026-09-14', uplift: 1.8, windowDays: 7 },
  { name: 'Navratri', date: '2026-10-11', uplift: 1.7, windowDays: 9 },
  { name: 'Dussehra', date: '2026-10-20', uplift: 1.8, windowDays: 5 },
  { name: 'Diwali', date: '2026-11-08', uplift: 3.0, windowDays: 10 },
  { name: 'Christmas', date: '2026-12-25', uplift: 1.4, windowDays: 5 },
  { name: 'Makar Sankranti / Pongal', date: '2027-01-14', uplift: 1.6, windowDays: 5 },
  { name: 'Holi', date: '2027-03-22', uplift: 2.0, windowDays: 5 },
  { name: 'Diwali', date: '2027-10-29', uplift: 3.0, windowDays: 10 },
];

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const daysBetween = (a: Date, b: Date): number => Math.ceil((b.getTime() - a.getTime()) / 86400000);

export class FestivalPlannerService {
  constructor(private readonly db: Pool) {}

  /** Festivals inside the horizon (default 60 days), nearest first. */
  upcoming(today = new Date(), horizonDays = 60): Festival[] {
    return FESTIVALS.map((f) => ({ ...f, daysAway: daysBetween(today, new Date(f.date)) }))
      .filter((f) => f.daysAway >= 0 && f.daysAway <= horizonDays)
      .sort((a, b) => a.daysAway - b.daysAway)
      .map((f) => ({ name: f.name, date: f.date, daysAway: f.daysAway, uplift: f.uplift, windowDays: f.windowDays }));
  }

  /** Stock-up plan for the next festival(s) in the horizon. */
  async getPlan(ownerId: string, today = new Date(), horizonDays = 60): Promise<FestivalPlan[]> {
    const festivals = this.upcoming(today, horizonDays);
    if (festivals.length === 0) return [];

    const { rows } = await this.db.query<{
      inventory_id: string;
      sku: string;
      product_name: string;
      unit: string;
      current_stock: string;
      daily_demand_mean: string;
      lead_time_days: number | null;
      distributor_name: string | null;
    }>(
      `
      SELECT i.id AS inventory_id, i.sku, i.product_name, i.unit, i.current_stock,
             f.daily_demand_mean,
             dp.lead_time_days,
             u.business_name AS distributor_name
      FROM demand_forecasts f
      JOIN inventory i ON i.id = f.inventory_id
      LEFT JOIN users u ON u.id = i.preferred_supplier_id
      LEFT JOIN dealer_products dp ON dp.dealer_id = i.preferred_supplier_id AND dp.sku = i.sku
      WHERE f.owner_id = $1 AND f.daily_demand_mean > 0
      ORDER BY f.daily_demand_mean DESC
      `,
      [ownerId],
    );

    return festivals.map((festival) => {
      const items: StockUpItem[] = [];
      for (const r of rows) {
        const daily = Number(r.daily_demand_mean);
        const stock = Number(r.current_stock);
        // Demand across the buying window at festival uplift, plus normal
        // consumption between now and the window opening.
        const runUpDays = Math.max(festival.daysAway - festival.windowDays, 0);
        const festivalDemand = daily * festival.uplift * festival.windowDays;
        const needed = festivalDemand + daily * runUpDays - stock;
        if (needed <= 0) continue;

        const lead = r.lead_time_days ?? 3;
        const orderBy = new Date(festival.date);
        orderBy.setDate(orderBy.getDate() - festival.windowDays - lead);

        items.push({
          inventoryId: r.inventory_id,
          sku: r.sku,
          productName: r.product_name,
          currentStock: stock,
          unit: r.unit,
          dailyDemandMean: daily,
          festivalDemand: Math.ceil(festivalDemand),
          suggestedOrderQty: Math.ceil(needed),
          orderByDate: iso(orderBy < today ? today : orderBy),
          distributorName: r.distributor_name,
        });
      }

      const advice =
        items.length === 0
          ? `${festival.name} is ${festival.daysAway} days away — current stock covers the expected ${festival.uplift}× demand.`
          : `${festival.name} is ${festival.daysAway} days away and demand typically runs ${festival.uplift}× — ` +
            `stock up ${items.length} item${items.length > 1 ? 's' : ''} (order by ${items[0].orderByDate}).`;

      return { festival, items, advice };
    });
  }
}
