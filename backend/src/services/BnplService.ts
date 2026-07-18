/**
 * ApnaKhata — BNPL / Working-Capital Financing
 * --------------------------------------------
 * Point-of-purchase credit: a shopkeeper finances an outstanding distributor
 * bill through a partner NBFC. The NBFC settles the distributor immediately
 * (the distributor's receivable is marked paid via the ledger), and the
 * shopkeeper repays the NBFC over a short tenure for a flat fee.
 *
 * Non-custodial: ApnaKhata sizes the offer from the user's existing credit
 * score and records the obligation; funds move on the NBFC's rails.
 * Eligibility, limit, and fee all key off credit_score_metrics + trailing
 * trade throughput, so the same risk engine that powers the credit passport
 * powers the offer.
 */

import { Pool } from 'pg';

import { Lender } from '../lenders/LenderGateway';
import { RiskTier } from './creditScoring';

const TENURES = [15, 30, 60] as const;
export type Tenure = (typeof TENURES)[number];

// Flat fee for the tenure, by tier. (Illustrative partner-NBFC pricing.)
const FEE_TABLE: Record<Exclude<RiskTier, 'HIGH_RISK'>, Record<Tenure, number>> = {
  PRIME: { 15: 1.0, 30: 1.5, 60: 2.5 },
  SUBPRIME: { 15: 1.8, 30: 2.5, 60: 4.0 },
};

export interface BnplOffer {
  eligible: boolean;
  reason?: string;
  tier: RiskTier | null;
  approvedLimit: number;
  outstanding: number;
  availableLimit: number;
  lender: Lender;
  feeSchedule: { tenureDays: Tenure; feeRatePct: number }[];
}

export interface Financing {
  id: string;
  shopkeeperId: string;
  lender: Lender;
  invoiceId: string;
  principal: number;
  feeRatePct: number;
  feeAmount: number;
  totalRepayable: number;
  amountRepaid: number;
  tenureDays: number;
  dueDate: string;
  status: 'ACTIVE' | 'REPAID' | 'OVERDUE' | 'DEFAULTED';
  disbursedAt: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class BnplService {
  constructor(
    private readonly db: Pool,
    private readonly lender: Lender = 'HDFC',
  ) {}

  /** The shopkeeper's current BNPL standing: limit, utilisation, fee schedule. */
  async getOffer(shopkeeperId: string): Promise<BnplOffer> {
    const sizing = await this.sizeLimit(shopkeeperId);
    const outstanding = await this.outstanding(shopkeeperId);

    if (!sizing.eligible) {
      return {
        eligible: false,
        reason: sizing.reason,
        tier: sizing.tier,
        approvedLimit: 0,
        outstanding,
        availableLimit: 0,
        lender: this.lender,
        feeSchedule: [],
      };
    }

    const tierKey = sizing.tier as Exclude<RiskTier, 'HIGH_RISK'>;
    return {
      eligible: true,
      tier: sizing.tier,
      approvedLimit: sizing.approvedLimit,
      outstanding,
      availableLimit: round2(Math.max(sizing.approvedLimit - outstanding, 0)),
      lender: this.lender,
      feeSchedule: TENURES.map((t) => ({ tenureDays: t, feeRatePct: FEE_TABLE[tierKey][t] })),
    };
  }

  /** A concrete quote for financing one outstanding distributor invoice. */
  async quoteInvoice(
    shopkeeperId: string,
    invoiceId: string,
    tenureDays: Tenure,
  ): Promise<{ principal: number; feeRatePct: number; feeAmount: number; totalRepayable: number; dueDate: string }> {
    const invoice = await this.loadFinanceableInvoice(shopkeeperId, invoiceId);
    const offer = await this.getOffer(shopkeeperId);
    if (!offer.eligible) throw new Error(`not eligible for BNPL: ${offer.reason}`);
    const feeRatePct = FEE_TABLE[offer.tier as Exclude<RiskTier, 'HIGH_RISK'>][tenureDays];
    const feeAmount = round2((invoice.balance * feeRatePct) / 100);
    const dueDate = new Date(Date.now() + tenureDays * 86_400_000).toISOString().slice(0, 10);
    return {
      principal: invoice.balance,
      feeRatePct,
      feeAmount,
      totalRepayable: round2(invoice.balance + feeAmount),
      dueDate,
    };
  }

  /**
   * Finance a distributor invoice: the NBFC settles the distributor (a BNPL
   * payment clears the invoice), and a repayment obligation is booked against
   * the shopkeeper — atomically.
   */
  async financeInvoice(shopkeeperId: string, invoiceId: string, tenureDays: Tenure): Promise<Financing> {
    if (!TENURES.includes(tenureDays)) throw new Error('invalid tenure; choose 15, 30, or 60 days');

    const offer = await this.getOffer(shopkeeperId);
    if (!offer.eligible) throw new Error(`not eligible for BNPL: ${offer.reason}`);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows: invRows } = await client.query<{
        balance_remaining: string;
        sender_id: string;
        amount: string;
      }>(
        `SELECT balance_remaining, sender_id, amount FROM transactions_ledger
          WHERE id = $1 AND receiver_id = $2 AND kind = 'B2B_INVOICE' AND payment_status <> 'PAID'
          FOR UPDATE`,
        [invoiceId, shopkeeperId],
      );
      const invoice = invRows[0];
      if (!invoice) throw new Error('invoice not found or not financeable');
      const principal = Number(invoice.balance_remaining);
      if (principal > offer.availableLimit) {
        throw new Error(`amount exceeds available BNPL limit (${offer.availableLimit})`);
      }

      const feeRatePct = FEE_TABLE[offer.tier as Exclude<RiskTier, 'HIGH_RISK'>][tenureDays];
      const feeAmount = round2((principal * feeRatePct) / 100);
      const totalRepayable = round2(principal + feeAmount);
      const dueDate = new Date(Date.now() + tenureDays * 86_400_000).toISOString().slice(0, 10);

      // NBFC disburses to the distributor: a BNPL payment clears the invoice.
      const { rows: payRows } = await client.query<{ id: string }>(
        `INSERT INTO payments (payer_id, payee_id, amount, method, reference)
         VALUES ($1, $2, $3, 'BNPL', 'bnpl-disbursement') RETURNING id`,
        [shopkeeperId, invoice.sender_id, principal],
      );
      const paymentId = payRows[0].id;
      await client.query(
        `INSERT INTO payment_allocations (payment_id, transaction_id, amount_applied) VALUES ($1, $2, $3)`,
        [paymentId, invoiceId, principal],
      );
      await client.query(
        `UPDATE transactions_ledger SET balance_remaining = 0, payment_status = 'PAID' WHERE id = $1`,
        [invoiceId],
      );

      const { rows: finRows } = await client.query<{ id: string; disbursed_at: Date }>(
        `INSERT INTO bnpl_financings (
           shopkeeper_id, lender, invoice_id, payment_id, principal, fee_rate_pct,
           fee_amount, total_repayable, tenure_days, due_date
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, disbursed_at`,
        [shopkeeperId, this.lender, invoiceId, paymentId, principal, feeRatePct, feeAmount, totalRepayable, tenureDays, dueDate],
      );

      await client.query('COMMIT');
      return {
        id: finRows[0].id,
        shopkeeperId,
        lender: this.lender,
        invoiceId,
        principal,
        feeRatePct,
        feeAmount,
        totalRepayable,
        amountRepaid: 0,
        tenureDays,
        dueDate,
        status: 'ACTIVE',
        disbursedAt: finRows[0].disbursed_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Shopkeeper repays the NBFC; closes the financing when fully repaid. */
  async repay(financingId: string, amount: number): Promise<Financing> {
    if (amount <= 0) throw new Error('repayment amount must be positive');
    const { rows } = await this.db.query<{ total_repayable: string; amount_repaid: string }>(
      `SELECT total_repayable, amount_repaid FROM bnpl_financings WHERE id = $1 FOR UPDATE`,
      [financingId],
    );
    if (!rows[0]) throw new Error('financing not found');
    const newRepaid = Math.min(Number(rows[0].amount_repaid) + amount, Number(rows[0].total_repayable));

    await this.db.query(
      `UPDATE bnpl_financings
         SET amount_repaid = $2,
             status = CASE WHEN $2 >= total_repayable THEN 'REPAID'::bnpl_status ELSE status END
       WHERE id = $1`,
      [financingId, newRepaid],
    );
    return this.get(financingId);
  }

  async list(shopkeeperId: string): Promise<Financing[]> {
    const { rows } = await this.db.query<FinancingRow>(
      `SELECT * FROM bnpl_financings WHERE shopkeeper_id = $1 ORDER BY created_at DESC`,
      [shopkeeperId],
    );
    return rows.map(mapFinancing);
  }

  async get(financingId: string): Promise<Financing> {
    const { rows } = await this.db.query<FinancingRow>(`SELECT * FROM bnpl_financings WHERE id = $1`, [financingId]);
    if (!rows[0]) throw new Error('financing not found');
    return mapFinancing(rows[0]);
  }

  private async sizeLimit(
    shopkeeperId: string,
  ): Promise<{ eligible: boolean; reason?: string; tier: RiskTier | null; approvedLimit: number }> {
    const { rows } = await this.db.query<{ tier: RiskTier; score: number }>(
      `SELECT tier, calculated_credit_score AS score FROM credit_score_metrics WHERE user_id = $1`,
      [shopkeeperId],
    );
    if (!rows[0]) {
      return { eligible: false, reason: 'no credit score yet; trade activity builds eligibility', tier: null, approvedLimit: 0 };
    }
    const tier = rows[0].tier;
    if (tier === 'HIGH_RISK') {
      return { eligible: false, reason: 'credit tier below the financing threshold', tier, approvedLimit: 0 };
    }

    const { rows: tv } = await this.db.query<{ annual: string | null }>(
      `SELECT SUM(amount) AS annual FROM transactions_ledger
        WHERE receiver_id = $1 AND kind = 'B2B_INVOICE' AND created_at >= now() - interval '12 months'`,
      [shopkeeperId],
    );
    const annualTrade = Number(tv[0]?.annual ?? 0);
    const round1000 = (n: number) => Math.round(n / 1000) * 1000;
    const approvedLimit =
      tier === 'PRIME'
        ? round1000(Math.min(annualTrade * 0.25, 500000))
        : round1000(Math.min(annualTrade * 0.12, 150000));

    return { eligible: approvedLimit > 0, reason: approvedLimit > 0 ? undefined : 'insufficient trade history', tier, approvedLimit };
  }

  private async outstanding(shopkeeperId: string): Promise<number> {
    const { rows } = await this.db.query<{ o: string | null }>(
      `SELECT SUM(total_repayable - amount_repaid) AS o FROM bnpl_financings
        WHERE shopkeeper_id = $1 AND status IN ('ACTIVE','OVERDUE')`,
      [shopkeeperId],
    );
    return round2(Number(rows[0]?.o ?? 0));
  }

  private async loadFinanceableInvoice(shopkeeperId: string, invoiceId: string): Promise<{ balance: number }> {
    const { rows } = await this.db.query<{ balance_remaining: string }>(
      `SELECT balance_remaining FROM transactions_ledger
        WHERE id = $1 AND receiver_id = $2 AND kind = 'B2B_INVOICE' AND payment_status <> 'PAID'`,
      [invoiceId, shopkeeperId],
    );
    if (!rows[0]) throw new Error('invoice not found or not financeable');
    return { balance: Number(rows[0].balance_remaining) };
  }
}

interface FinancingRow {
  id: string;
  shopkeeper_id: string;
  lender: Lender;
  invoice_id: string;
  principal: string;
  fee_rate_pct: string;
  fee_amount: string;
  total_repayable: string;
  amount_repaid: string;
  tenure_days: number;
  due_date: Date;
  status: Financing['status'];
  disbursed_at: Date;
}

function mapFinancing(r: FinancingRow): Financing {
  return {
    id: r.id,
    shopkeeperId: r.shopkeeper_id,
    lender: r.lender,
    invoiceId: r.invoice_id,
    principal: Number(r.principal),
    feeRatePct: Number(r.fee_rate_pct),
    feeAmount: Number(r.fee_amount),
    totalRepayable: Number(r.total_repayable),
    amountRepaid: Number(r.amount_repaid),
    tenureDays: r.tenure_days,
    dueDate: r.due_date.toISOString().slice(0, 10),
    status: r.status,
    disbursedAt: r.disbursed_at.toISOString(),
  };
}
