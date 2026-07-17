/**
 * ApnaKhata — Credit Score Evaluator
 * --------------------------------------
 * Computes a bank-ready credit score (300–900) for a user from observed
 * ledger behaviour, persists it to `credit_score_metrics`, and returns the
 * full pillar breakdown for the Credit Risk Passport.
 *
 * Pillars (per bank-partnership spec):
 *   Repayment speed ............ 40%
 *   Transaction consistency .... 30%
 *   Supplier retention/disputes  20%
 *   Inventory turn (DIO) ....... 10%
 *
 * All pillar sub-scores are normalised to [0, 1] before weighting, then the
 * composite is mapped linearly onto [300, 900].
 */

import { Pool } from 'pg';

import {
  applyDamping,
  clamp01,
  composite,
  inventoryTurnNormalizedFromDio,
  repaymentNormalizedFromDelay,
  RiskTier,
  scoreFromDamped,
  tierFromScore,
} from './creditScoring';

export type { RiskTier };

export interface PillarBreakdown {
  repaymentVelocity: number; // 0..100
  transactionConsistency: number; // 0..100
  supplierRetention: number; // 0..100
  inventoryTurn: number; // 0..100
}

export interface CreditEvaluation {
  userId: string;
  score: number; // 300..900
  tier: RiskTier;
  pillars: PillarBreakdown;
  averageDelayDays: number;
  daysInventoryOutstanding: number | null;
  dataCoverageMonths: number;
  evaluatedAt: Date;
}

/** Months of ledger history considered by every pillar query. */
const LOOKBACK_MONTHS = 12;

export class CreditScoreEvaluator {
  constructor(private readonly db: Pool) {}

  /**
   * Evaluate, persist, and return the credit profile for a user.
   * Safe to run repeatedly (upserts `credit_score_metrics`).
   */
  async evaluate(userId: string): Promise<CreditEvaluation> {
    const [repayment, consistency, retention, inventoryTurn] = await Promise.all([
      this.scoreRepaymentSpeed(userId),
      this.scoreTransactionConsistency(userId),
      this.scoreSupplierRetention(userId),
      this.scoreInventoryTurn(userId),
    ]);

    // Thin files must not look like strong files: below 3 months of history the
    // composite is pulled toward the midpoint proportionally to coverage.
    const coverage = consistency.coverageMonths;
    const damped = applyDamping(
      composite({
        repayment: repayment.normalized,
        consistency: consistency.normalized,
        retention: retention.normalized,
        inventoryTurn: inventoryTurn.normalized,
      }),
      coverage,
    );

    const score = scoreFromDamped(damped);
    const tier: RiskTier = tierFromScore(score);

    const evaluation: CreditEvaluation = {
      userId,
      score,
      tier,
      pillars: {
        repaymentVelocity: Math.round(repayment.normalized * 100),
        transactionConsistency: Math.round(consistency.normalized * 100),
        supplierRetention: Math.round(retention.normalized * 100),
        inventoryTurn: Math.round(inventoryTurn.normalized * 100),
      },
      averageDelayDays: repayment.averageDelayDays,
      daysInventoryOutstanding: inventoryTurn.dio,
      dataCoverageMonths: coverage,
      evaluatedAt: new Date(),
    };

    await this.persist(evaluation);
    return evaluation;
  }

  /**
   * Pillar 1 (40%) — Repayment speed.
   * Value-weighted average of (settlement date − due date) across paid/partial
   * invoices where the user is the debtor. Early payment (negative delay)
   * earns a bonus; delay decays the score exponentially with a 30-day
   * half-life, so a chronic 60-day-late payer scores ~0.25.
   */
  private async scoreRepaymentSpeed(
    userId: string,
  ): Promise<{ normalized: number; averageDelayDays: number }> {
    const { rows } = await this.db.query<{ avg_delay: string | null; n: string }>(
      `
      SELECT
        SUM(delay_days * amount_applied) / NULLIF(SUM(amount_applied), 0) AS avg_delay,
        COUNT(*) AS n
      FROM (
        SELECT
          pa.amount_applied,
          EXTRACT(EPOCH FROM (p.paid_at::date::timestamp - tl.due_date::timestamp)) / 86400.0 AS delay_days
        FROM payment_allocations pa
        JOIN payments p             ON p.id = pa.payment_id
        JOIN transactions_ledger tl ON tl.id = pa.transaction_id
        WHERE tl.receiver_id = $1
          AND tl.due_date IS NOT NULL
          AND p.paid_at >= now() - ($2 || ' months')::interval
      ) d
      `,
      [userId, LOOKBACK_MONTHS],
    );

    const sampleSize = Number(rows[0]?.n ?? 0);
    if (sampleSize === 0) return { normalized: 0.5, averageDelayDays: 0 }; // neutral: no evidence either way

    const avgDelay = Number(rows[0].avg_delay ?? 0);
    const normalized = repaymentNormalizedFromDelay(avgDelay);

    return { normalized, averageDelayDays: Math.round(avgDelay * 100) / 100 };
  }

  /**
   * Pillar 2 (30%) — Transaction consistency.
   * Rewards (a) trading in most months of the window and (b) low month-to-month
   * value volatility (coefficient of variation).
   */
  private async scoreTransactionConsistency(
    userId: string,
  ): Promise<{ normalized: number; coverageMonths: number }> {
    const { rows } = await this.db.query<{ month: Date; total: string }>(
      `
      SELECT date_trunc('month', created_at) AS month, SUM(amount) AS total
      FROM transactions_ledger
      WHERE (receiver_id = $1 OR sender_id = $1)
        AND created_at >= now() - ($2 || ' months')::interval
      GROUP BY 1
      `,
      [userId, LOOKBACK_MONTHS],
    );

    const activeMonths = rows.length;
    if (activeMonths === 0) return { normalized: 0, coverageMonths: 0 };

    const totals = rows.map((r) => Number(r.total));
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;

    const coverageScore = clamp01(activeMonths / LOOKBACK_MONTHS);
    const stabilityScore = clamp01(1 - cv / 1.5); // CV ≥ 1.5 → fully erratic

    return {
      normalized: clamp01(0.6 * coverageScore + 0.4 * stabilityScore),
      coverageMonths: activeMonths,
    };
  }

  /**
   * Pillar 3 (20%) — Supplier retention & dispute rate.
   * Tenure-weighted supplier stability, penalised by the share of invoices
   * flagged as disputed.
   */
  private async scoreSupplierRetention(userId: string): Promise<{ normalized: number }> {
    const { rows } = await this.db.query<{
      supplier_count: string;
      avg_tenure_months: string | null;
      dispute_rate: string | null;
    }>(
      `
      SELECT
        COUNT(DISTINCT tl.sender_id) AS supplier_count,
        AVG(EXTRACT(EPOCH FROM (now() - first_seen)) / 2592000.0) AS avg_tenure_months,
        AVG(CASE WHEN tl.is_disputed THEN 1.0 ELSE 0.0 END) AS dispute_rate
      FROM transactions_ledger tl
      JOIN (
        SELECT sender_id, MIN(created_at) AS first_seen
        FROM transactions_ledger
        WHERE receiver_id = $1
        GROUP BY sender_id
      ) firsts ON firsts.sender_id = tl.sender_id
      WHERE tl.receiver_id = $1
        AND tl.created_at >= now() - ($2 || ' months')::interval
      `,
      [userId, LOOKBACK_MONTHS],
    );

    const supplierCount = Number(rows[0]?.supplier_count ?? 0);
    if (supplierCount === 0) return { normalized: 0.4 }; // mildly below neutral: no B2B trail

    const avgTenureMonths = Number(rows[0].avg_tenure_months ?? 0);
    const disputeRate = Number(rows[0].dispute_rate ?? 0);

    const tenureScore = clamp01(avgTenureMonths / 12); // a year of stable relationships = full marks
    const breadthScore = clamp01(supplierCount / 5); // diversification up to 5 suppliers
    const disputePenalty = clamp01(disputeRate * 4); // 25% disputed invoices zeroes the pillar

    return { normalized: clamp01((0.7 * tenureScore + 0.3 * breadthScore) * (1 - disputePenalty)) };
  }

  /**
   * Pillar 4 (10%) — Inventory turn via Days of Inventory Outstanding.
   * DIO = average inventory value at wholesale / daily cost of goods sold.
   * 25 days or better = full marks; 120+ days = zero.
   */
  private async scoreInventoryTurn(
    userId: string,
  ): Promise<{ normalized: number; dio: number | null }> {
    const { rows } = await this.db.query<{ inv_value: string | null; daily_cogs: string | null }>(
      `
      SELECT
        (SELECT SUM(current_stock * wholesale_price)
           FROM inventory WHERE owner_id = $1 AND is_active) AS inv_value,
        (SELECT SUM(ABS(sm.delta) * i.wholesale_price) / 90.0
           FROM stock_movements sm
           JOIN inventory i ON i.id = sm.inventory_id
          WHERE sm.owner_id = $1
            AND sm.reason = 'SALE'
            AND sm.time >= now() - interval '90 days') AS daily_cogs
      `,
      [userId],
    );

    const invValue = Number(rows[0]?.inv_value ?? 0);
    const dailyCogs = Number(rows[0]?.daily_cogs ?? 0);
    if (dailyCogs <= 0 || invValue <= 0) return { normalized: 0.5, dio: null }; // neutral: no signal

    const dio = invValue / dailyCogs;
    const normalized = inventoryTurnNormalizedFromDio(dio);
    return { normalized, dio: Math.round(dio * 100) / 100 };
  }

  private async persist(e: CreditEvaluation): Promise<void> {
    await this.db.query(
      `
      INSERT INTO credit_score_metrics (
        user_id, repayment_velocity_score, consistency_score, retention_score,
        inventory_turn_score, average_delay_days, days_inventory_outstanding,
        calculated_credit_score, tier, data_coverage_months, last_updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (user_id) DO UPDATE SET
        repayment_velocity_score   = EXCLUDED.repayment_velocity_score,
        consistency_score          = EXCLUDED.consistency_score,
        retention_score            = EXCLUDED.retention_score,
        inventory_turn_score       = EXCLUDED.inventory_turn_score,
        average_delay_days         = EXCLUDED.average_delay_days,
        days_inventory_outstanding = EXCLUDED.days_inventory_outstanding,
        calculated_credit_score    = EXCLUDED.calculated_credit_score,
        tier                       = EXCLUDED.tier,
        data_coverage_months       = EXCLUDED.data_coverage_months,
        last_updated               = now()
      `,
      [
        e.userId,
        e.pillars.repaymentVelocity,
        e.pillars.transactionConsistency,
        e.pillars.supplierRetention,
        e.pillars.inventoryTurn,
        e.averageDelayDays,
        e.daysInventoryOutstanding,
        e.score,
        e.tier,
        e.dataCoverageMonths,
      ],
    );
  }
}
