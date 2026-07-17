/**
 * ApnaKhata — Lender gateway abstraction
 * --------------------------------------
 * Partner banks (SBI, ICICI, HDFC, …) each expose their own working-capital
 * pre-approval sandbox. This interface lets the submission service stay
 * lender-agnostic; the SandboxLenderGateway below is a deterministic stand-in
 * for those sandboxes, and real adapters (per-bank REST clients) implement the
 * same contract behind a per-lender API key/mTLS.
 */

import { randomBytes } from 'crypto';

import { RiskTier } from '../services/creditScoring';

export type Lender = 'SBI' | 'ICICI' | 'HDFC' | 'AXIS' | 'KOTAK';
export type LenderDecision = 'SUBMITTED' | 'UNDER_REVIEW' | 'PRE_APPROVED' | 'DECLINED' | 'ERROR';

export interface LenderApplication {
  lender: Lender;
  passportId: string;
  score: number;
  tier: RiskTier;
  requestedAmount: number;
  annualTradeValue: number; // from the passport ledger summary
}

export interface LenderResponse {
  status: LenderDecision;
  approvedAmount: number | null;
  interestRatePct: number | null;
  externalReference: string;
  raw: Record<string, unknown>;
}

export interface LenderGateway {
  submit(application: LenderApplication): Promise<LenderResponse>;
}

/**
 * Deterministic sandbox: lends a fraction of annual trade throughput, gated by
 * tier. Mirrors how a bank would size unsecured working capital off ledger
 * behaviour rather than collateral.
 */
export class SandboxLenderGateway implements LenderGateway {
  async submit(app: LenderApplication): Promise<LenderResponse> {
    const ref = `${app.lender}-${randomBytes(4).toString('hex').toUpperCase()}`;
    // Throughput-based ceiling, with a floor so thin-but-clean files still get an offer.
    const throughputCap = Math.max(app.annualTradeValue * 0.3, 50000);
    const round = (n: number) => Math.round(n / 1000) * 1000;

    if (app.tier === 'HIGH_RISK') {
      return {
        status: 'DECLINED',
        approvedAmount: null,
        interestRatePct: null,
        externalReference: ref,
        raw: { reason: 'score below lender threshold', tier: app.tier, score: app.score },
      };
    }

    if (app.tier === 'PRIME') {
      const approved = round(Math.min(app.requestedAmount, throughputCap));
      return {
        status: 'PRE_APPROVED',
        approvedAmount: approved,
        interestRatePct: 14.5,
        externalReference: ref,
        raw: { tier: app.tier, score: app.score, cap: round(throughputCap) },
      };
    }

    // SUBPRIME: strong enough for a smaller pre-approval; weaker files go to review.
    if (app.score >= 660) {
      const approved = round(Math.min(app.requestedAmount, throughputCap * 0.6));
      return {
        status: 'PRE_APPROVED',
        approvedAmount: approved,
        interestRatePct: 19.0,
        externalReference: ref,
        raw: { tier: app.tier, score: app.score, cap: round(throughputCap * 0.6) },
      };
    }

    return {
      status: 'UNDER_REVIEW',
      approvedAmount: null,
      interestRatePct: null,
      externalReference: ref,
      raw: { tier: app.tier, score: app.score, note: 'manual underwriting required' },
    };
  }
}
