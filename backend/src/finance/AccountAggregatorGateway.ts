/**
 * ApnaKhata — Account Aggregator (Sahamati / AA) gateway
 * ------------------------------------------------------
 * India's consented-data-sharing rail: as an FIU (Financial Information User),
 * ApnaKhata requests a consent, the borrower approves it in their AA app, and
 * the borrower's bank (FIP) shares statement data — turning underwriting from
 * score-only into cash-flow-based. This interface keeps the service
 * AA-agnostic; the sandbox stands in for a real AA (Finvu/OneMoney/etc.).
 *
 * The sandbox is deliberately NOT random: it derives a plausible cash-flow
 * profile from the borrower's own ledger throughput, so demo underwriting is
 * coherent with the rest of the app and stable across runs.
 */

import { randomBytes } from 'crypto';

export interface ConsentRequest {
  borrowerId: string;
  months: number;
}

export interface ConsentHandle {
  consentHandle: string;
}

export interface FinancialSummary {
  months: number;
  avgMonthlyInflow: number;
  avgMonthlyOutflow: number;
  avgBalance: number;
  minBalance: number;
  bounceCount: number;
  inflowCv: number; // coefficient of variation of monthly inflow (volatility)
}

/** Ledger-derived hint the sandbox uses to synthesise a coherent profile. */
export interface LedgerProfile {
  annualTradeValue: number; // throughput through the ApnaKhata ledger
  averageDelayDays: number; // repayment behaviour (feeds a plausible bounce count)
}

export interface AccountAggregatorGateway {
  requestConsent(req: ConsentRequest): Promise<ConsentHandle>;
  fetchFinancials(consentHandle: string, months: number, profile: LedgerProfile): Promise<FinancialSummary>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class SandboxAccountAggregatorGateway implements AccountAggregatorGateway {
  async requestConsent(_req: ConsentRequest): Promise<ConsentHandle> {
    return { consentHandle: `AA-${randomBytes(8).toString('hex').toUpperCase()}` };
  }

  async fetchFinancials(_consentHandle: string, months: number, profile: LedgerProfile): Promise<FinancialSummary> {
    // Bank inflow tends to exceed ledgered trade (cash sales, other income);
    // scale ledger throughput up modestly for a realistic current-account view.
    const monthlyTrade = Math.max(profile.annualTradeValue, 0) / 12;
    const avgMonthlyInflow = round2(monthlyTrade * 1.25 + 8000);
    const avgMonthlyOutflow = round2(avgMonthlyInflow * 0.82); // net-positive operator
    const avgBalance = round2(avgMonthlyInflow * 0.45);
    // Late payers keep tighter balances and bounce more.
    const stress = Math.min(Math.max(profile.averageDelayDays, 0) / 30, 2);
    const minBalance = round2(avgBalance * (0.25 - 0.12 * stress)); // can dip negative under stress
    const bounceCount = Math.round(stress * 2);
    const inflowCv = round2(0.12 + 0.06 * stress); // steadier inflow = lower volatility

    return {
      months,
      avgMonthlyInflow,
      avgMonthlyOutflow,
      avgBalance,
      minBalance,
      bounceCount,
      inflowCv,
    };
  }
}
