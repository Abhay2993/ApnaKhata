/**
 * ApnaKhata — Shared credit-scoring math
 * --------------------------------------
 * The single source of truth for how pillar sub-scores combine into a
 * 300–900 score and a risk tier. Both CreditScoreEvaluator (from live ledger
 * data) and CreditSimulatorService (from hypothetical inputs) import these,
 * so a "what-if" projection can never drift from a real evaluation.
 */

export type RiskTier = 'PRIME' | 'SUBPRIME' | 'HIGH_RISK';

export const WEIGHTS = {
  repayment: 0.4,
  consistency: 0.3,
  retention: 0.2,
  inventoryTurn: 0.1,
} as const;

export const SCORE_FLOOR = 300;
export const SCORE_CEILING = 900;
export const PRIME_THRESHOLD = 740;
export const SUBPRIME_THRESHOLD = 580;

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Normalised pillar sub-scores in [0, 1]. */
export interface NormalizedPillars {
  repayment: number;
  consistency: number;
  retention: number;
  inventoryTurn: number;
}

/**
 * Repayment pillar from value-weighted average days-late.
 * <= 0 days late maps to [0.9, 1.0]; lateness decays with a 30-day half-life.
 * (Mirrors CreditScoreEvaluator.scoreRepaymentSpeed for a non-empty sample.)
 */
export function repaymentNormalizedFromDelay(avgDelayDays: number): number {
  return avgDelayDays <= 0
    ? clamp01(0.9 + Math.min(-avgDelayDays, 10) / 100)
    : clamp01(0.9 * Math.pow(0.5, avgDelayDays / 30));
}

/**
 * Inventory-turn pillar from Days of Inventory Outstanding.
 * Linear: 25 days or better → 1.0, 120+ days → 0.0.
 * (Mirrors CreditScoreEvaluator.scoreInventoryTurn.)
 */
export function inventoryTurnNormalizedFromDio(dio: number): number {
  return clamp01(1 - (dio - 25) / 95);
}

/** Weighted composite of the four normalised pillars. */
export function composite(pillars: NormalizedPillars): number {
  return (
    pillars.repayment * WEIGHTS.repayment +
    pillars.consistency * WEIGHTS.consistency +
    pillars.retention * WEIGHTS.retention +
    pillars.inventoryTurn * WEIGHTS.inventoryTurn
  );
}

/**
 * Thin-file damping: below 3 months of history the composite is pulled toward
 * the midpoint proportionally to coverage.
 */
export function applyDamping(compositeScore: number, coverageMonths: number): number {
  const confidence = clamp01(coverageMonths / 3);
  return compositeScore * confidence + 0.5 * (1 - confidence);
}

/** Map a damped composite in [0, 1] onto the 300–900 band. */
export function scoreFromDamped(damped: number): number {
  return Math.round(SCORE_FLOOR + damped * (SCORE_CEILING - SCORE_FLOOR));
}

export function tierFromScore(score: number): RiskTier {
  return score >= PRIME_THRESHOLD ? 'PRIME' : score >= SUBPRIME_THRESHOLD ? 'SUBPRIME' : 'HIGH_RISK';
}

/** Full pipeline: normalised pillars + coverage → { score, tier }. */
export function scoreFromPillars(
  pillars: NormalizedPillars,
  coverageMonths: number,
): { score: number; tier: RiskTier } {
  const score = scoreFromDamped(applyDamping(composite(pillars), coverageMonths));
  return { score, tier: tierFromScore(score) };
}
