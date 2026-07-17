/**
 * ApnaKhata — Dashboard Service
 * -----------------------------
 * Single read model for the shopkeeper dashboard: credit summary, cash-flow
 * balances, and forecast-driven stock alerts. One call so the mobile/web
 * client renders the whole screen from a single request.
 */

import { Pool } from 'pg';

import { RiskTier } from './creditScoring';

export interface DashboardCredit {
  score: number;
  tier: RiskTier;
  loanStatus: 'PRE_APPROVED' | 'UNDER_REVIEW' | 'NOT_ELIGIBLE';
  preApprovedLimit: number;
  partnerBank: string;
}

export interface DashboardCashFlow {
  receivables: number;
  payables: number;
  todayCollections: number;
}

export interface DashboardStockAlert {
  inventoryId: string;
  productName: string;
  sku: string;
  currentStock: number;
  unit: string;
  daysUntilStockout: number | null;
  recommendedOrderQty: number;
  distributorName: string;
}

export interface Dashboard {
  businessName: string;
  credit: DashboardCredit | null;
  cashFlow: DashboardCashFlow;
  stockAlerts: DashboardStockAlert[];
}

export class DashboardService {
  constructor(private readonly db: Pool) {}

  async getDashboard(userId: string): Promise<Dashboard> {
    const [user, credit, cashFlow, alerts] = await Promise.all([
      this.businessName(userId),
      this.credit(userId),
      this.cashFlow(userId),
      this.stockAlerts(userId),
    ]);
    return { businessName: user, credit, cashFlow, stockAlerts: alerts };
  }

  private async businessName(userId: string): Promise<string> {
    const { rows } = await this.db.query<{ business_name: string }>(
      `SELECT business_name FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows[0]) throw new Error('user not found');
    return rows[0].business_name;
  }

  private async credit(userId: string): Promise<DashboardCredit | null> {
    const { rows } = await this.db.query<{
      calculated_credit_score: number;
      tier: RiskTier;
    }>(`SELECT calculated_credit_score, tier FROM credit_score_metrics WHERE user_id = $1`, [userId]);
    if (!rows[0]) return null;

    const score = rows[0].calculated_credit_score;
    const tier = rows[0].tier;
    // Indicative working-capital line off tier (the real figure comes from a
    // lender submission; this is the dashboard headline).
    const preApprovedLimit = tier === 'PRIME' ? 250000 : tier === 'SUBPRIME' ? 100000 : 0;
    const loanStatus = tier === 'PRIME' ? 'PRE_APPROVED' : tier === 'SUBPRIME' ? 'UNDER_REVIEW' : 'NOT_ELIGIBLE';
    return { score, tier, loanStatus, preApprovedLimit, partnerBank: 'HDFC Bank' };
  }

  private async cashFlow(userId: string): Promise<DashboardCashFlow> {
    const { rows } = await this.db.query<{
      receivables: string;
      payables: string;
      today_collections: string;
    }>(
      `
      SELECT
        COALESCE((SELECT SUM(balance_remaining) FROM transactions_ledger
                  WHERE sender_id = $1 AND payment_status <> 'PAID'), 0) AS receivables,
        COALESCE((SELECT SUM(balance_remaining) FROM transactions_ledger
                  WHERE receiver_id = $1 AND payment_status <> 'PAID'), 0) AS payables,
        COALESCE((SELECT SUM(amount) FROM payments
                  WHERE payee_id = $1 AND paid_at::date = CURRENT_DATE), 0) AS today_collections
      `,
      [userId],
    );
    const r = rows[0];
    return {
      receivables: Number(r.receivables),
      payables: Number(r.payables),
      todayCollections: Number(r.today_collections),
    };
  }

  private async stockAlerts(userId: string): Promise<DashboardStockAlert[]> {
    const { rows } = await this.db.query<{
      inventory_id: string;
      product_name: string;
      sku: string;
      current_stock: string;
      unit: string;
      recommended_order_qty: number | null;
      predicted_stockout_date: Date | null;
      distributor_name: string | null;
    }>(
      `
      SELECT i.id AS inventory_id, i.product_name, i.sku, i.current_stock, i.unit,
             d.recommended_order_qty, d.predicted_stockout_date,
             sup.business_name AS distributor_name
      FROM inventory i
      LEFT JOIN demand_forecasts d ON d.inventory_id = i.id
      LEFT JOIN users sup ON sup.id = i.preferred_supplier_id
      WHERE i.owner_id = $1 AND i.is_active
        AND (i.current_stock <= i.minimum_threshold OR d.predicted_stockout_date IS NOT NULL)
      ORDER BY d.predicted_stockout_date ASC NULLS LAST, i.current_stock ASC
      LIMIT 20
      `,
      [userId],
    );

    return rows.map((r) => ({
      inventoryId: r.inventory_id,
      productName: r.product_name,
      sku: r.sku,
      currentStock: Number(r.current_stock),
      unit: r.unit,
      daysUntilStockout: r.predicted_stockout_date
        ? Math.round((r.predicted_stockout_date.getTime() - Date.now()) / 86_400_000)
        : null,
      recommendedOrderQty: r.recommended_order_qty ?? 0,
      distributorName: r.distributor_name ?? 'Unassigned',
    }));
  }
}
