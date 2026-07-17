/**
 * ApnaKhata — Credit History Service
 * ----------------------------------
 * Reads the daily score snapshots (credit_score_history, auto-populated by the
 * trigger in migration 003) into a trend series for the score chart, plus a
 * summary a UI can headline ("+34 over 90 days, improving").
 */

import { Pool } from 'pg';

import { RiskTier } from './creditScoring';

export interface ScorePoint {
  date: string; // ISO date
  score: number;
  tier: RiskTier;
  pillars: {
    repaymentVelocity: number;
    transactionConsistency: number;
    supplierRetention: number;
    inventoryTurn: number;
  };
}

export interface ScoreTrend {
  points: ScorePoint[];
  first: number | null;
  latest: number | null;
  change: number; // latest - first over the window
  direction: 'improving' | 'declining' | 'flat' | 'insufficient-data';
}

export class CreditHistoryService {
  constructor(private readonly db: Pool) {}

  /** Trend over the last `days` (default 180), oldest → newest. */
  async getTrend(userId: string, days = 180): Promise<ScoreTrend> {
    const { rows } = await this.db.query<{
      snapshot_date: Date;
      score: number;
      tier: RiskTier;
      repayment_velocity_score: string;
      consistency_score: string;
      retention_score: string;
      inventory_turn_score: string;
    }>(
      `
      SELECT snapshot_date, score, tier,
             repayment_velocity_score, consistency_score, retention_score, inventory_turn_score
      FROM credit_score_history
      WHERE user_id = $1 AND snapshot_date >= CURRENT_DATE - ($2::int)
      ORDER BY snapshot_date ASC
      `,
      [userId, days],
    );

    const points: ScorePoint[] = rows.map((r) => ({
      date: r.snapshot_date.toISOString().slice(0, 10),
      score: r.score,
      tier: r.tier,
      pillars: {
        repaymentVelocity: Number(r.repayment_velocity_score),
        transactionConsistency: Number(r.consistency_score),
        supplierRetention: Number(r.retention_score),
        inventoryTurn: Number(r.inventory_turn_score),
      },
    }));

    if (points.length === 0) {
      return { points, first: null, latest: null, change: 0, direction: 'insufficient-data' };
    }

    const first = points[0].score;
    const latest = points[points.length - 1].score;
    const change = latest - first;
    const direction =
      points.length < 2 ? 'insufficient-data' : change > 0 ? 'improving' : change < 0 ? 'declining' : 'flat';

    return { points, first, latest, change, direction };
  }
}
