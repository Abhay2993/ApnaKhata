/**
 * ApnaKhata — Auto-accounting (books of record)
 * ---------------------------------------------
 * Turns the events already captured — retail sales, consumer credit, purchases,
 * stock movements, cash drawer, credit lines, loans — into a Profit & Loss and
 * a Balance Sheet with no manual bookkeeping. This is the "become the system of
 * record" moat: once a shop's financial statements live here, leaving is
 * expensive. Read-only; nothing is written.
 *
 *   Revenue = retail sales (ledger) + consumer credit sales (khata).
 *   COGS    = Σ (units sold × wholesale cost) from stock movements.
 *   Balance sheet = assets (cash, inventory, receivables) − liabilities
 *                   (payables, credit-line drawn, outstanding loans) = equity.
 */

import { Pool } from 'pg';

export interface ProfitAndLoss {
  period: { from: string; to: string };
  revenue: number; // goods sold at retail (from stock movements)
  unitsSold: number;
  costOfGoodsSold: number;
  grossProfit: number;
  grossMarginPct: number;
  expenses: { cashExpenses: number; financingCost: number; total: number };
  netProfit: number;
}

export interface BalanceSheet {
  asOf: string;
  assets: { cash: number; inventory: number; receivables: number; total: number };
  liabilities: { payables: number; creditLineDrawn: number; loans: number; total: number };
  equity: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

export class AccountingService {
  constructor(private readonly db: Pool) {}

  async profitAndLoss(ownerId: string, from?: string, to?: string): Promise<ProfitAndLoss> {
    const toDate = to ?? iso(new Date());
    const fromDate = from ?? iso(new Date(Date.now() - 90 * 86400000));

    // Trading account from goods that actually left the shelf: revenue at retail
    // and COGS at wholesale come from the SAME stock movements, so gross profit
    // is always the real markup (no phantom revenue/cost mismatch).
    const { rows } = await this.db.query<{ revenue: string; cogs: string; units: string; cash_expenses: string }>(
      `
      SELECT
        COALESCE((SELECT SUM(-sm.delta * i.retail_price)
                  FROM stock_movements sm JOIN inventory i ON i.id = sm.inventory_id
                  WHERE sm.owner_id = $1 AND sm.reason = 'SALE' AND sm.delta < 0
                    AND sm.time::date BETWEEN $2 AND $3), 0)                                 AS revenue,
        COALESCE((SELECT SUM(-sm.delta * i.wholesale_price)
                  FROM stock_movements sm JOIN inventory i ON i.id = sm.inventory_id
                  WHERE sm.owner_id = $1 AND sm.reason = 'SALE' AND sm.delta < 0
                    AND sm.time::date BETWEEN $2 AND $3), 0)                                 AS cogs,
        COALESCE((SELECT SUM(-sm.delta)
                  FROM stock_movements sm
                  WHERE sm.owner_id = $1 AND sm.reason = 'SALE' AND sm.delta < 0
                    AND sm.time::date BETWEEN $2 AND $3), 0)                                 AS units,
        COALESCE((SELECT SUM(m.amount) FROM cash_drawer_movements m
                  JOIN cash_drawer_days d ON d.id = m.drawer_id
                  WHERE d.owner_id = $1 AND m.direction = 'OUT' AND m.reason IN ('EXPENSE','PAYOUT')
                    AND m.created_at::date BETWEEN $2 AND $3), 0)                            AS cash_expenses
      `,
      [ownerId, fromDate, toDate],
    );
    const r = rows[0];
    const revenue = round2(Number(r.revenue));
    const cogs = round2(Number(r.cogs));
    const grossProfit = round2(revenue - cogs);

    // Financing cost: accrued interest on outstanding loans + credit line over the window.
    const windowDays = daysBetween(fromDate, toDate);
    const { rows: fin } = await this.db.query<{ financing: string }>(
      `
      SELECT
        COALESCE((SELECT SUM(principal * interest_rate_pct / 100 * LEAST($2, tenure_days) / 365)
                  FROM loans WHERE borrower_id = $1 AND status = 'ACTIVE'), 0)
        + COALESCE((SELECT SUM((sanctioned_limit - available_limit) * interest_rate_pct / 100 * $2 / 365)
                    FROM credit_lines WHERE borrower_id = $1), 0) AS financing
      `,
      [ownerId, windowDays],
    );
    const financingCost = round2(Number(fin[0].financing));
    const cashExpenses = round2(Number(r.cash_expenses));
    const expensesTotal = round2(cashExpenses + financingCost);

    return {
      period: { from: fromDate, to: toDate },
      revenue,
      unitsSold: Number(r.units),
      costOfGoodsSold: cogs,
      grossProfit,
      grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
      expenses: { cashExpenses, financingCost, total: expensesTotal },
      netProfit: round2(grossProfit - expensesTotal),
    };
  }

  async balanceSheet(ownerId: string, asOf?: string): Promise<BalanceSheet> {
    const asOfDate = asOf ?? iso(new Date());
    const { rows } = await this.db.query<{
      cash: string; inventory: string; consumer_recv: string; b2b_recv: string;
      payables: string; credit_drawn: string; loans: string;
    }>(
      `
      SELECT
        COALESCE((SELECT (opening_balance
                          + COALESCE((SELECT SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END)
                                      FROM cash_drawer_movements WHERE drawer_id = d.id), 0))
                  FROM cash_drawer_days d WHERE d.owner_id = $1 ORDER BY business_date DESC LIMIT 1), 0) AS cash,
        COALESCE((SELECT SUM(current_stock * wholesale_price) FROM inventory WHERE owner_id = $1), 0)     AS inventory,
        COALESCE((SELECT SUM(balance) FROM v_customer_balances WHERE owner_id = $1 AND balance > 0), 0)   AS consumer_recv,
        COALESCE((SELECT SUM(balance_remaining) FROM transactions_ledger
                  WHERE sender_id = $1 AND kind = 'B2B_INVOICE' AND balance_remaining > 0), 0)            AS b2b_recv,
        COALESCE((SELECT SUM(balance_remaining) FROM transactions_ledger
                  WHERE receiver_id = $1 AND balance_remaining > 0), 0)                                   AS payables,
        COALESCE((SELECT SUM(sanctioned_limit - available_limit) FROM credit_lines WHERE borrower_id = $1), 0) AS credit_drawn,
        COALESCE((SELECT SUM(principal) FROM loans WHERE borrower_id = $1 AND status = 'ACTIVE'), 0)      AS loans
      `,
      [ownerId],
    );
    const r = rows[0];
    const cash = round2(Number(r.cash));
    const inventory = round2(Number(r.inventory));
    const receivables = round2(Number(r.consumer_recv) + Number(r.b2b_recv));
    const assetsTotal = round2(cash + inventory + receivables);

    const payables = round2(Number(r.payables));
    const creditLineDrawn = round2(Number(r.credit_drawn));
    const loans = round2(Number(r.loans));
    const liabilitiesTotal = round2(payables + creditLineDrawn + loans);

    return {
      asOf: asOfDate,
      assets: { cash, inventory, receivables, total: assetsTotal },
      liabilities: { payables, creditLineDrawn, loans, total: liabilitiesTotal },
      equity: round2(assetsTotal - liabilitiesTotal),
    };
  }
}

const daysBetween = (from: string, to: string): number =>
  Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000));
