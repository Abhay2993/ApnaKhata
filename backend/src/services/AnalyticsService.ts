/**
 * ApnaKhata — Profit & Business-Health Analytics
 * ----------------------------------------------
 * Turns the ledger from a record-keeper into an advisor. All read-only over
 * data we already capture: inventory prices (wholesale vs retail), sales from
 * stock_movements, and receivables/payables from the ledger.
 *
 *   getProfitAnalytics — per-product margin, gross profit, fastest movers, and
 *                        dead stock (capital tied up in items that aren't selling).
 *   getBusinessHealth  — inventory value, DIO/DSO/DPO + cash-conversion cycle,
 *                        an estimated cash-runway, and a 0–100 health score.
 */

import { Pool } from 'pg';

import { clamp01 } from './creditScoring';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface ProductProfit {
  inventoryId: string;
  sku: string;
  productName: string;
  currentStock: number;
  unit: string;
  wholesalePrice: number;
  retailPrice: number;
  unitMargin: number;
  marginPct: number; // of retail
  unitsSold: number; // in window
  revenue: number;
  cogs: number;
  grossProfit: number;
  stockValue: number; // at wholesale
}

export interface ProfitAnalytics {
  windowDays: number;
  summary: {
    totalRevenue: number;
    totalCogs: number;
    grossProfit: number;
    grossMarginPct: number;
    inventoryValue: number;
    deadStockValue: number;
  };
  fastestMovers: ProductProfit[];
  deadStock: ProductProfit[];
  products: ProductProfit[];
}

export interface BusinessHealth {
  inventoryValue: number;
  receivables: number;
  payables: number;
  overdueReceivables: number;
  daysInventoryOutstanding: number | null;
  daysSalesOutstanding: number | null;
  daysPayableOutstanding: number | null;
  cashConversionCycleDays: number | null;
  dailyGrossProfit: number;
  cashPositive: boolean;
  cashRunwayDays: number | null; // null when cash-positive
  healthScore: number; // 0..100
  rating: 'STRONG' | 'STABLE' | 'WATCH' | 'AT_RISK';
  advice: string[];
}

export class AnalyticsService {
  constructor(private readonly db: Pool) {}

  async getProfitAnalytics(ownerId: string, windowDays = 90): Promise<ProfitAnalytics> {
    const days = Math.min(Math.max(windowDays, 1), 365);
    const products = await this.productProfit(ownerId, days);

    const summary = products.reduce(
      (acc, p) => ({
        totalRevenue: acc.totalRevenue + p.revenue,
        totalCogs: acc.totalCogs + p.cogs,
        grossProfit: acc.grossProfit + p.grossProfit,
        inventoryValue: acc.inventoryValue + p.stockValue,
        deadStockValue: acc.deadStockValue + (p.unitsSold === 0 ? p.stockValue : 0),
      }),
      { totalRevenue: 0, totalCogs: 0, grossProfit: 0, inventoryValue: 0, deadStockValue: 0 },
    );

    return {
      windowDays: days,
      summary: {
        totalRevenue: round2(summary.totalRevenue),
        totalCogs: round2(summary.totalCogs),
        grossProfit: round2(summary.grossProfit),
        grossMarginPct: summary.totalRevenue > 0 ? round2((summary.grossProfit / summary.totalRevenue) * 100) : 0,
        inventoryValue: round2(summary.inventoryValue),
        deadStockValue: round2(summary.deadStockValue),
      },
      fastestMovers: [...products]
        .filter((p) => p.unitsSold > 0)
        .sort((a, b) => b.unitsSold - a.unitsSold)
        .slice(0, 5),
      deadStock: products
        .filter((p) => p.unitsSold === 0 && p.currentStock > 0)
        .sort((a, b) => b.stockValue - a.stockValue),
      products,
    };
  }

  async getBusinessHealth(ownerId: string): Promise<BusinessHealth> {
    const products = await this.productProfit(ownerId, 90);
    const inventoryValue = round2(products.reduce((s, p) => s + p.stockValue, 0));
    const deadStockValue = round2(products.reduce((s, p) => s + (p.unitsSold === 0 ? p.stockValue : 0), 0));
    const revenue90 = products.reduce((s, p) => s + p.revenue, 0);
    const cogs90 = products.reduce((s, p) => s + p.cogs, 0);
    const grossMarginPct = revenue90 > 0 ? (revenue90 - cogs90) / revenue90 : 0;

    const led = await this.ledgerPositions(ownerId);
    const dailyCogs = cogs90 / 90;
    const dailyRevenue = revenue90 / 90;
    const purchases90 = led.purchases90;

    const dio = dailyCogs > 0 ? round2(inventoryValue / dailyCogs) : null;
    const dso = dailyRevenue > 0 && led.receivables > 0 ? round2(led.receivables / dailyRevenue) : dailyRevenue > 0 ? 0 : null;
    const dpo = purchases90 > 0 && led.payables > 0 ? round2(led.payables / (purchases90 / 90)) : purchases90 > 0 ? 0 : null;
    const ccc = dio !== null && dso !== null && dpo !== null ? round2(dio + dso - dpo) : null;

    const dailyGrossProfit = round2((revenue90 - cogs90) / 90);
    const cashPositive = dailyGrossProfit >= 0;
    const liquidBuffer = led.receivables + inventoryValue;
    const cashRunwayDays = cashPositive ? null : Math.floor(liquidBuffer / Math.abs(dailyGrossProfit));

    // Health score: margin (35) + turnover (30) + collections (20) + dead-stock (15).
    const marginScore = clamp01(grossMarginPct / 0.25);
    const turnoverScore = dio === null ? 0.5 : clamp01(1 - (dio - 25) / 95);
    const overdueRatio = led.receivables > 0 ? led.overdueReceivables / led.receivables : 0;
    const collectionScore = clamp01(1 - overdueRatio);
    const deadScore = inventoryValue > 0 ? clamp01(1 - deadStockValue / inventoryValue) : 1;
    const healthScore = Math.round(
      100 * (0.35 * marginScore + 0.3 * turnoverScore + 0.2 * collectionScore + 0.15 * deadScore),
    );
    const rating = healthScore >= 75 ? 'STRONG' : healthScore >= 55 ? 'STABLE' : healthScore >= 35 ? 'WATCH' : 'AT_RISK';

    const advice: string[] = [];
    if (grossMarginPct < 0.12) advice.push('Gross margin is thin — review pricing on high-volume lines.');
    if (dio !== null && dio > 60) advice.push(`Stock is turning slowly (${dio} days) — trim slow movers.`);
    if (deadStockValue > 0) advice.push(`₹${Math.round(deadStockValue)} is tied up in dead stock — run a clearance.`);
    if (overdueRatio > 0.3) advice.push('A large share of receivables is overdue — push collections.');
    if (advice.length === 0) advice.push('Healthy: margins, turnover, and collections are all in good shape.');

    return {
      inventoryValue,
      receivables: round2(led.receivables),
      payables: round2(led.payables),
      overdueReceivables: round2(led.overdueReceivables),
      daysInventoryOutstanding: dio,
      daysSalesOutstanding: dso,
      daysPayableOutstanding: dpo,
      cashConversionCycleDays: ccc,
      dailyGrossProfit,
      cashPositive,
      cashRunwayDays,
      healthScore,
      rating,
      advice,
    };
  }

  private async productProfit(ownerId: string, days: number): Promise<ProductProfit[]> {
    const { rows } = await this.db.query<{
      id: string;
      sku: string;
      product_name: string;
      current_stock: string;
      unit: string;
      wholesale_price: string;
      retail_price: string;
      units_sold: string | null;
    }>(
      `
      SELECT i.id, i.sku, i.product_name, i.current_stock, i.unit, i.wholesale_price, i.retail_price,
             s.units_sold
      FROM inventory i
      LEFT JOIN (
        SELECT inventory_id, SUM(ABS(delta)) AS units_sold
        FROM stock_movements
        WHERE owner_id = $1 AND reason = 'SALE' AND time >= now() - ($2 || ' days')::interval
        GROUP BY inventory_id
      ) s ON s.inventory_id = i.id
      WHERE i.owner_id = $1 AND i.is_active
      `,
      [ownerId, days],
    );

    return rows.map((r) => {
      const wholesale = Number(r.wholesale_price);
      const retail = Number(r.retail_price);
      const stock = Number(r.current_stock);
      const unitsSold = Number(r.units_sold ?? 0);
      const unitMargin = round2(retail - wholesale);
      return {
        inventoryId: r.id,
        sku: r.sku,
        productName: r.product_name,
        currentStock: stock,
        unit: r.unit,
        wholesalePrice: wholesale,
        retailPrice: retail,
        unitMargin,
        marginPct: retail > 0 ? round2((unitMargin / retail) * 100) : 0,
        unitsSold,
        revenue: round2(unitsSold * retail),
        cogs: round2(unitsSold * wholesale),
        grossProfit: round2(unitsSold * unitMargin),
        stockValue: round2(stock * wholesale),
      };
    });
  }

  private async ledgerPositions(ownerId: string): Promise<{
    receivables: number;
    payables: number;
    overdueReceivables: number;
    purchases90: number;
  }> {
    const { rows } = await this.db.query<{
      receivables: string;
      payables: string;
      overdue: string;
      purchases90: string;
    }>(
      `
      SELECT
        COALESCE((SELECT SUM(balance_remaining) FROM transactions_ledger
                  WHERE sender_id = $1 AND payment_status <> 'PAID'), 0) AS receivables,
        COALESCE((SELECT SUM(balance_remaining) FROM transactions_ledger
                  WHERE receiver_id = $1 AND payment_status <> 'PAID'), 0) AS payables,
        COALESCE((SELECT SUM(balance_remaining) FROM transactions_ledger
                  WHERE sender_id = $1 AND payment_status <> 'PAID' AND due_date < CURRENT_DATE), 0) AS overdue,
        COALESCE((SELECT SUM(amount) FROM transactions_ledger
                  WHERE receiver_id = $1 AND kind = 'B2B_INVOICE' AND created_at >= now() - interval '90 days'), 0) AS purchases90
      `,
      [ownerId],
    );
    const r = rows[0];
    return {
      receivables: Number(r.receivables),
      payables: Number(r.payables),
      overdueReceivables: Number(r.overdue),
      purchases90: Number(r.purchases90),
    };
  }
}
