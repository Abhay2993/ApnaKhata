/**
 * ApnaKhata — Anchor-led supply-chain finance (OCEN LSP)
 * ------------------------------------------------------
 * The lending rail. ApnaKhata acts as the OCEN Loan Service Provider: it
 * underwrites a retailer from three signals no competitor holds together, then
 * broadcasts one application to a panel of lenders and collects competing
 * offers.
 *
 *   1. Credit Passport score      — behaviour in the B2B ledger.
 *   2. Account Aggregator cash-flow — consented bank statement signals.
 *   3. Anchor trade relationship   — the retailer's verified history with a
 *      specific distributor (volume, on-time settlement, tenure). This is the
 *      moat: a strong anchor relationship improves the retailer's grade, limit
 *      and rate, and on acceptance the loan settles the retailer's dues to that
 *      distributor through the FIFO engine.
 */

import { Pool } from 'pg';

import { AccountAggregatorService } from './AccountAggregatorService';
import { CreditScoreEvaluator } from './CreditScoreEvaluator';
import { LenderOffer, OcenLenderNetwork, RiskGrade } from '../finance/OcenLenderNetwork';
import { computeLedgerProfile } from '../finance/ledgerProfile';

export interface AnchorRelationship {
  anchorId: string;
  anchorName: string;
  invoiceCount: number;
  totalTrade: number;
  outstanding: number;
  tenureMonths: number;
  onTimeRate: number | null; // of settled invoices
  strength: number; // 0..1 composite
}

export interface UnderwritingResult {
  creditScore: number;
  tier: string;
  grade: RiskGrade;
  recommendedLimit: number;
  anchorStrength: number;
  usedAccountAggregator: boolean;
  signals: Record<string, number | null>;
  rationale: string[];
}

export interface LoanApplication {
  id: string;
  borrowerId: string;
  anchorId: string | null;
  amountRequested: number;
  tenureDays: number;
  purpose: string;
  status: string;
  creditScore: number | null;
  riskGrade: string | null;
  recommendedLimit: number | null;
  anchorStrength: number | null;
  underwriting: UnderwritingResult | null;
  createdAt: string;
  offers?: LoanOfferRecord[];
}

export interface LoanOfferRecord extends LenderOffer {
  id: string;
  status: string;
}

export interface DisbursedLoan {
  id: string;
  lenderName: string;
  principal: number;
  interestRatePct: number;
  tenureDays: number;
  disbursedToAnchor: number;
  status: string;
  disbursedAt: string;
}

const round0 = (n: number): number => Math.round(n);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const GRADE_CEILING: Record<RiskGrade, number> = { A: 500000, B: 300000, C: 150000, D: 60000 };

export class SupplyChainFinanceService {
  private readonly evaluator: CreditScoreEvaluator;
  private readonly network: OcenLenderNetwork;

  constructor(
    private readonly db: Pool,
    private readonly aa: AccountAggregatorService = new AccountAggregatorService(db),
    evaluator?: CreditScoreEvaluator,
    network?: OcenLenderNetwork,
  ) {
    this.evaluator = evaluator ?? new CreditScoreEvaluator(db);
    this.network = network ?? new OcenLenderNetwork();
  }

  /** The retailer's verified trade relationship with a specific distributor. */
  async getAnchorRelationship(borrowerId: string, anchorId: string): Promise<AnchorRelationship> {
    const { rows } = await this.db.query<{
      anchor_name: string | null; invoice_count: string; total_trade: string; outstanding: string;
      first_at: Date | null; settled_count: string; on_time_count: string;
    }>(
      `
      WITH inv AS (
        SELECT COUNT(*) AS invoice_count,
               COALESCE(SUM(amount), 0)            AS total_trade,
               COALESCE(SUM(balance_remaining), 0) AS outstanding,
               MIN(created_at)                     AS first_at
        FROM transactions_ledger
        WHERE sender_id = $2 AND receiver_id = $1 AND kind = 'B2B_INVOICE'
      ),
      settled AS (
        SELECT tl.due_date, MAX(p.paid_at) AS settled_at
        FROM transactions_ledger tl
        JOIN payment_allocations pa ON pa.transaction_id = tl.id
        JOIN payments p ON p.id = pa.payment_id
        WHERE tl.sender_id = $2 AND tl.receiver_id = $1 AND tl.payment_status = 'PAID' AND tl.due_date IS NOT NULL
        GROUP BY tl.id, tl.due_date
      )
      SELECT (SELECT business_name FROM users WHERE id = $2) AS anchor_name,
             inv.invoice_count, inv.total_trade, inv.outstanding, inv.first_at,
             (SELECT COUNT(*) FROM settled)                                        AS settled_count,
             (SELECT COUNT(*) FILTER (WHERE settled_at::date <= due_date) FROM settled) AS on_time_count
      FROM inv
      `,
      [borrowerId, anchorId],
    );
    const r = rows[0];
    const invoiceCount = Number(r.invoice_count);
    const settledCount = Number(r.settled_count);
    const onTimeRate = settledCount > 0 ? Number(r.on_time_count) / settledCount : null;
    const tenureMonths = r.first_at ? monthsBetween(r.first_at, new Date()) : 0;
    const totalTrade = Number(r.total_trade);

    // Composite strength: mostly on-time behaviour, plus relationship depth.
    const onTimeScore = onTimeRate ?? 0.5;
    const tenureScore = clamp01(tenureMonths / 12);
    const volumeScore = clamp01(totalTrade / 500000);
    const strength = invoiceCount === 0 ? 0 : round4(clamp01(0.5 * onTimeScore + 0.25 * tenureScore + 0.25 * volumeScore));

    return {
      anchorId,
      anchorName: r.anchor_name ?? 'Unknown',
      invoiceCount,
      totalTrade,
      outstanding: Number(r.outstanding),
      tenureMonths,
      onTimeRate: onTimeRate === null ? null : round4(onTimeRate),
      strength,
    };
  }

  /** Underwrite without persisting — the preview a borrower sees before applying. */
  async underwrite(borrowerId: string, input: { anchorId?: string; amountRequested: number; tenureDays: number }): Promise<UnderwritingResult> {
    if (!(input.amountRequested > 0)) throw new Error('amount requested must be positive');

    const [evaluation, profile, aaSummary] = await Promise.all([
      this.evaluator.evaluate(borrowerId),
      computeLedgerProfile(this.db, borrowerId),
      this.aa.latestSummary(borrowerId),
    ]);
    const anchor = input.anchorId ? await this.getAnchorRelationship(borrowerId, input.anchorId) : null;
    const anchorStrength = anchor?.strength ?? 0;

    const scoreNorm = clamp01((evaluation.score - 300) / 600);
    const rationale: string[] = [
      `Credit Passport score ${evaluation.score} (${evaluation.tier}).`,
    ];

    // Account Aggregator cash-flow score.
    let aaScore: number | null = null;
    if (aaSummary) {
      const netMargin = aaSummary.avgMonthlyInflow > 0
        ? clamp01((aaSummary.avgMonthlyInflow - aaSummary.avgMonthlyOutflow) / aaSummary.avgMonthlyInflow / 0.3)
        : 0;
      const balanceScore = aaSummary.minBalance >= 0 ? 1 : 0.3;
      const bounceScore = 1 - Math.min(aaSummary.bounceCount / 4, 1);
      const volScore = 1 - Math.min(aaSummary.inflowCv / 0.3, 1);
      aaScore = clamp01(0.35 * netMargin + 0.25 * balanceScore + 0.25 * bounceScore + 0.15 * volScore);
      rationale.push(`Bank cash-flow (AA): avg inflow ₹${Math.round(aaSummary.avgMonthlyInflow).toLocaleString('en-IN')}/mo, ${aaSummary.bounceCount} bounce(s).`);
    } else {
      rationale.push('No bank data connected — connect via Account Aggregator for a better limit and rate.');
    }

    if (anchor && anchor.invoiceCount > 0) {
      rationale.push(
        `Anchor ${anchor.anchorName}: ${anchor.invoiceCount} invoices, ₹${Math.round(anchor.totalTrade).toLocaleString('en-IN')} traded, ` +
        `${anchor.onTimeRate != null ? Math.round(anchor.onTimeRate * 100) : '—'}% on-time — strength ${(anchorStrength * 100).toFixed(0)}%.`,
      );
    }

    const composite = aaScore != null
      ? 0.45 * scoreNorm + 0.25 * anchorStrength + 0.30 * aaScore
      : 0.65 * scoreNorm + 0.35 * anchorStrength;

    const grade: RiskGrade = composite >= 0.75 ? 'A' : composite >= 0.6 ? 'B' : composite >= 0.45 ? 'C' : 'D';

    // Recommended limit blends ledger throughput and AA inflow, boosted by the anchor.
    const throughputBase = profile.annualTradeValue * 0.25;
    const base = aaSummary ? 0.5 * throughputBase + 0.5 * (aaSummary.avgMonthlyInflow * 2) : throughputBase;
    const anchorBoost = 1 + 0.3 * anchorStrength;
    const recommendedLimit = Math.min(
      Math.max(round0((base * anchorBoost) / 1000) * 1000, 25000),
      GRADE_CEILING[grade],
    );
    rationale.push(`Grade ${grade}; recommended limit ₹${recommendedLimit.toLocaleString('en-IN')}.`);

    return {
      creditScore: evaluation.score,
      tier: evaluation.tier,
      grade,
      recommendedLimit,
      anchorStrength,
      usedAccountAggregator: aaSummary != null,
      signals: {
        scoreNorm: round4(scoreNorm),
        anchorStrength,
        aaScore: aaScore != null ? round4(aaScore) : null,
        onTimeRate: anchor?.onTimeRate ?? null,
        annualTradeValue: round0(profile.annualTradeValue),
        avgMonthlyInflow: aaSummary?.avgMonthlyInflow ?? null,
        composite: round4(composite),
      },
      rationale,
    };
  }

  /** Underwrite, persist the application, and solicit competing lender offers. */
  async createApplication(
    borrowerId: string,
    input: { anchorId?: string; amountRequested: number; tenureDays?: number; purpose?: string; aaConsentId?: string },
  ): Promise<LoanApplication> {
    const tenureDays = input.tenureDays ?? 90;
    const uw = await this.underwrite(borrowerId, { anchorId: input.anchorId, amountRequested: input.amountRequested, tenureDays });

    const offers = this.network.solicit({
      grade: uw.grade,
      creditScore: uw.creditScore,
      recommendedLimit: uw.recommendedLimit,
      amountRequested: input.amountRequested,
      tenureDays,
      anchorStrength: uw.anchorStrength,
    });

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<AppRow>(
        `
        INSERT INTO loan_applications
          (borrower_id, anchor_id, amount_requested, tenure_days, purpose, status,
           credit_score, risk_grade, recommended_limit, anchor_strength, aa_consent_id, underwriting)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
        `,
        [
          borrowerId, input.anchorId ?? null, input.amountRequested, tenureDays,
          input.purpose ?? 'WORKING_CAPITAL', offers.length > 0 ? 'OFFERED' : 'REJECTED',
          uw.creditScore, uw.grade, uw.recommendedLimit, uw.anchorStrength,
          input.aaConsentId ?? null, JSON.stringify(uw),
        ],
      );
      const appId = rows[0].id;

      for (const o of offers) {
        await client.query(
          `
          INSERT INTO loan_offers
            (application_id, lender_key, lender_name, sanctioned_amount, interest_rate_pct,
             tenure_days, processing_fee, emi_amount, total_repayable, valid_until)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CURRENT_DATE + 7)
          `,
          [appId, o.lenderKey, o.lenderName, o.sanctionedAmount, o.interestRatePct, o.tenureDays, o.processingFee, o.emiAmount, o.totalRepayable],
        );
      }
      await client.query('COMMIT');
      return this.getApplication(borrowerId, appId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getApplication(borrowerId: string, applicationId: string): Promise<LoanApplication> {
    const { rows } = await this.db.query<AppRow>(
      `SELECT * FROM loan_applications WHERE id = $1 AND borrower_id = $2`,
      [applicationId, borrowerId],
    );
    if (rows.length === 0) throw new Error('loan application not found');
    const { rows: offerRows } = await this.db.query<OfferRow>(
      `SELECT * FROM loan_offers WHERE application_id = $1 ORDER BY interest_rate_pct, sanctioned_amount DESC`,
      [applicationId],
    );
    return mapApplication(rows[0], offerRows);
  }

  async listApplications(borrowerId: string): Promise<LoanApplication[]> {
    const { rows } = await this.db.query<AppRow>(
      `SELECT * FROM loan_applications WHERE borrower_id = $1 ORDER BY created_at DESC`,
      [borrowerId],
    );
    return rows.map((r) => mapApplication(r, []));
  }

  /**
   * Accept a lender's offer: disburse the loan and, when it's anchor-led, route
   * the proceeds to settle the retailer's outstanding dues to that distributor
   * through the FIFO engine — the working-capital use case, closed end to end.
   */
  async acceptOffer(borrowerId: string, applicationId: string, offerId: string): Promise<{ loan: DisbursedLoan; application: LoanApplication }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows: appRows } = await client.query<AppRow>(
        `SELECT * FROM loan_applications WHERE id = $1 AND borrower_id = $2 FOR UPDATE`,
        [applicationId, borrowerId],
      );
      const app = appRows[0];
      if (!app) throw new Error('loan application not found');
      if (app.status !== 'OFFERED') throw new Error(`application is ${app.status.toLowerCase()}, cannot accept an offer`);

      const { rows: offerRows } = await client.query<OfferRow>(
        `SELECT * FROM loan_offers WHERE id = $1 AND application_id = $2`,
        [offerId, applicationId],
      );
      const offer = offerRows[0];
      if (!offer) throw new Error('offer not found for this application');

      await client.query(`UPDATE loan_offers SET status = 'DECLINED' WHERE application_id = $1`, [applicationId]);
      await client.query(`UPDATE loan_offers SET status = 'ACCEPTED' WHERE id = $1`, [offerId]);
      await client.query(`UPDATE loan_applications SET status = 'DISBURSED' WHERE id = $1`, [applicationId]);

      const sanctioned = Number(offer.sanctioned_amount);
      let disbursedToAnchor = 0;
      let settlementPaymentId: string | null = null;

      if (app.anchor_id) {
        const { rows: dueRows } = await client.query<{ outstanding: string }>(
          `SELECT COALESCE(SUM(balance_remaining), 0) AS outstanding
             FROM transactions_ledger
            WHERE receiver_id = $1 AND sender_id = $2 AND balance_remaining > 0 AND NOT is_disputed`,
          [borrowerId, app.anchor_id],
        );
        disbursedToAnchor = Math.min(sanctioned, Number(dueRows[0].outstanding));
        if (disbursedToAnchor > 0) {
          const { rows: payRows } = await client.query<{ id: string }>(
            `
            INSERT INTO payments (payer_id, payee_id, amount, method, reference)
            VALUES ($1, $2, $3, 'SCF_LOAN', $4) RETURNING id
            `,
            [borrowerId, app.anchor_id, disbursedToAnchor, offer.lender_key],
          );
          settlementPaymentId = payRows[0].id;
          await client.query(`SELECT apply_payment_fifo($1)`, [settlementPaymentId]);
        }
      }

      const { rows: loanRows } = await client.query<LoanRow>(
        `
        INSERT INTO loans
          (application_id, offer_id, borrower_id, lender_key, lender_name, principal,
           interest_rate_pct, tenure_days, disbursed_to_anchor, settlement_payment_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
        `,
        [applicationId, offerId, borrowerId, offer.lender_key, offer.lender_name, sanctioned,
         offer.interest_rate_pct, offer.tenure_days, disbursedToAnchor, settlementPaymentId],
      );

      await client.query('COMMIT');
      const application = await this.getApplication(borrowerId, applicationId);
      return { loan: mapLoan(loanRows[0]), application };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

interface AppRow {
  id: string; borrower_id: string; anchor_id: string | null; amount_requested: string; tenure_days: number;
  purpose: string; status: string; credit_score: number | null; risk_grade: string | null;
  recommended_limit: string | null; anchor_strength: string | null; underwriting: UnderwritingResult | null; created_at: Date;
}
interface OfferRow {
  id: string; lender_key: string; lender_name: string; sanctioned_amount: string; interest_rate_pct: string;
  tenure_days: number; processing_fee: string; emi_amount: string; total_repayable: string; status: string;
}
interface LoanRow {
  id: string; lender_name: string; principal: string; interest_rate_pct: string; tenure_days: number;
  disbursed_to_anchor: string; status: string; disbursed_at: Date;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const monthsBetween = (a: Date, b: Date): number =>
  Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));

function mapApplication(r: AppRow, offers: OfferRow[]): LoanApplication {
  return {
    id: r.id,
    borrowerId: r.borrower_id,
    anchorId: r.anchor_id,
    amountRequested: Number(r.amount_requested),
    tenureDays: r.tenure_days,
    purpose: r.purpose,
    status: r.status,
    creditScore: r.credit_score,
    riskGrade: r.risk_grade,
    recommendedLimit: r.recommended_limit === null ? null : Number(r.recommended_limit),
    anchorStrength: r.anchor_strength === null ? null : Number(r.anchor_strength),
    underwriting: r.underwriting,
    createdAt: r.created_at.toISOString(),
    offers: offers.map(mapOffer),
  };
}

const mapOffer = (o: OfferRow): LoanOfferRecord => ({
  id: o.id,
  lenderKey: o.lender_key,
  lenderName: o.lender_name,
  sanctionedAmount: Number(o.sanctioned_amount),
  interestRatePct: Number(o.interest_rate_pct),
  tenureDays: o.tenure_days,
  processingFee: Number(o.processing_fee),
  emiAmount: Number(o.emi_amount),
  totalRepayable: Number(o.total_repayable),
  status: o.status,
});

const mapLoan = (r: LoanRow): DisbursedLoan => ({
  id: r.id,
  lenderName: r.lender_name,
  principal: Number(r.principal),
  interestRatePct: Number(r.interest_rate_pct),
  tenureDays: r.tenure_days,
  disbursedToAnchor: Number(r.disbursed_to_anchor),
  status: r.status,
  disbursedAt: r.disbursed_at.toISOString(),
});
