/**
 * ApnaKhata — Credit Simulator ("what-if")
 * ----------------------------------------
 * Projects how a behavioural change would move a user's score, using the exact
 * same math as CreditScoreEvaluator (via creditScoring.ts) so the nudge a
 * shopkeeper sees matches what they'll actually get. Operates on the stored
 * credit_score_metrics: pillar sub-scores are held fixed except the one the
 * scenario touches, which is recomputed from the hypothetical raw input.
 */

import { Pool } from 'pg';

import {
  applyDamping,
  composite,
  inventoryTurnNormalizedFromDio,
  NormalizedPillars,
  repaymentNormalizedFromDelay,
  RiskTier,
  scoreFromDamped,
  tierFromScore,
} from './creditScoring';

export interface Scenario {
  /** Clear distributor bills this many days sooner (shifts avg days-late down). */
  payDaysEarlier?: number;
  /** Or set the target average days-late outright. */
  targetAvgDelayDays?: number;
  /** Cut Days of Inventory Outstanding by this many days. */
  reduceDioByDays?: number;
  /** Or set the target DIO outright. */
  targetDio?: number;
}

interface CurrentState {
  pillars: NormalizedPillars;
  score: number;
  tier: RiskTier;
  avgDelayDays: number;
  dio: number | null;
  coverageMonths: number;
}

export interface SimulationResult {
  scenario: Scenario;
  current: { score: number; tier: RiskTier };
  projected: { score: number; tier: RiskTier };
  scoreDelta: number;
  tierChanged: boolean;
  explanation: string;
}

export interface Suggestion extends SimulationResult {
  label: string;
}

export class CreditSimulatorService {
  constructor(private readonly db: Pool) {}

  /** Project a single scenario. */
  async simulate(userId: string, scenario: Scenario): Promise<SimulationResult> {
    const state = await this.loadState(userId);
    return this.project(state, scenario);
  }

  /**
   * Pre-baked nudges for the dashboard: the highest-leverage moves and the
   * score bump each would produce. Skips DIO scenarios when DIO is unknown.
   */
  async suggestions(userId: string): Promise<{ current: { score: number; tier: RiskTier }; suggestions: Suggestion[] }> {
    const state = await this.loadState(userId);
    const candidates: { label: string; scenario: Scenario }[] = [
      { label: 'Pay bills 10 days earlier', scenario: { payDaysEarlier: 10 } },
      { label: 'Pay bills 20 days earlier', scenario: { payDaysEarlier: 20 } },
    ];
    if (state.dio !== null) {
      candidates.push({ label: 'Cut inventory days by 15', scenario: { reduceDioByDays: 15 } });
      candidates.push({ label: 'Cut inventory days by 30', scenario: { reduceDioByDays: 30 } });
    }

    const suggestions = candidates
      .map(({ label, scenario }) => ({ label, ...this.project(state, scenario) }))
      .filter((s) => s.scoreDelta > 0) // only surface moves that actually help
      .sort((a, b) => b.scoreDelta - a.scoreDelta);

    return { current: { score: state.score, tier: state.tier }, suggestions };
  }

  private project(state: CurrentState, scenario: Scenario): SimulationResult {
    const pillars: NormalizedPillars = { ...state.pillars };
    const notes: string[] = [];

    // Repayment pillar
    if (scenario.payDaysEarlier !== undefined || scenario.targetAvgDelayDays !== undefined) {
      const newDelay =
        scenario.targetAvgDelayDays !== undefined
          ? scenario.targetAvgDelayDays
          : state.avgDelayDays - (scenario.payDaysEarlier ?? 0);
      pillars.repayment = repaymentNormalizedFromDelay(newDelay);
      notes.push(`avg days-late ${state.avgDelayDays.toFixed(1)} → ${newDelay.toFixed(1)}`);
    }

    // Inventory-turn pillar
    if (scenario.reduceDioByDays !== undefined || scenario.targetDio !== undefined) {
      if (state.dio === null) {
        notes.push('DIO unknown — inventory-turn effect not modelled');
      } else {
        const newDio =
          scenario.targetDio !== undefined ? scenario.targetDio : Math.max(state.dio - (scenario.reduceDioByDays ?? 0), 0);
        pillars.inventoryTurn = inventoryTurnNormalizedFromDio(newDio);
        notes.push(`DIO ${state.dio.toFixed(1)} → ${newDio.toFixed(1)} days`);
      }
    }

    const projectedScore = scoreFromDamped(applyDamping(composite(pillars), state.coverageMonths));
    const projectedTier = tierFromScore(projectedScore);
    const delta = projectedScore - state.score;

    return {
      scenario,
      current: { score: state.score, tier: state.tier },
      projected: { score: projectedScore, tier: projectedTier },
      scoreDelta: delta,
      tierChanged: projectedTier !== state.tier,
      explanation:
        (delta >= 0 ? `+${delta} points` : `${delta} points`) +
        (projectedTier !== state.tier ? ` (moves to ${projectedTier})` : '') +
        (notes.length ? ` — ${notes.join('; ')}` : ''),
    };
  }

  private async loadState(userId: string): Promise<CurrentState> {
    const { rows } = await this.db.query<{
      repayment_velocity_score: string;
      consistency_score: string;
      retention_score: string;
      inventory_turn_score: string;
      average_delay_days: string;
      days_inventory_outstanding: string | null;
      calculated_credit_score: number;
      tier: RiskTier;
      data_coverage_months: number;
    }>(`SELECT * FROM credit_score_metrics WHERE user_id = $1`, [userId]);
    const m = rows[0];
    if (!m) throw new Error('no credit score on record for user; evaluate the score first');

    return {
      pillars: {
        repayment: Number(m.repayment_velocity_score) / 100,
        consistency: Number(m.consistency_score) / 100,
        retention: Number(m.retention_score) / 100,
        inventoryTurn: Number(m.inventory_turn_score) / 100,
      },
      score: m.calculated_credit_score,
      tier: m.tier,
      avgDelayDays: Number(m.average_delay_days),
      dio: m.days_inventory_outstanding === null ? null : Number(m.days_inventory_outstanding),
      coverageMonths: m.data_coverage_months,
    };
  }
}
