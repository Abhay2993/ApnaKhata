/**
 * ApnaKhata — OCEN lender network
 * -------------------------------
 * OCEN (Open Credit Enablement Network) lets a Loan Service Provider (ApnaKhata,
 * the app the borrower uses) broadcast one application to many lenders, each of
 * which returns its own offer. This models that panel: every lender has a policy
 * (risk appetite, rate card, ticket ceiling) and bids independently on the
 * underwriting bundle. Real lenders implement the same `bid` contract behind
 * their OCEN endpoints; here they're deterministic sandboxes so offers are
 * stable and comparable.
 */

export type RiskGrade = 'A' | 'B' | 'C' | 'D';

export interface UnderwritingBundle {
  grade: RiskGrade;
  creditScore: number;
  recommendedLimit: number;
  amountRequested: number;
  tenureDays: number;
  anchorStrength: number; // 0..1 — verified trade relationship with the anchor
}

export interface LenderOffer {
  lenderKey: string;
  lenderName: string;
  sanctionedAmount: number;
  interestRatePct: number;
  tenureDays: number;
  processingFee: number;
  emiAmount: number;
  totalRepayable: number;
}

interface LenderPolicy {
  key: string;
  name: string;
  minGrade: RiskGrade; // worst grade this lender will touch
  baseRatePct: number; // annual, for grade A
  maxTicket: number;
  feePct: number; // processing fee as % of sanctioned
  anchorDiscountPct: number; // rate cut for a strong anchor relationship (the moat)
}

const GRADE_RANK: Record<RiskGrade, number> = { A: 4, B: 3, C: 2, D: 1 };
const GRADE_SPREAD: Record<RiskGrade, number> = { A: 0, B: 1.5, C: 3.5, D: 6 };
const round0 = (n: number): number => Math.round(n);
const round2 = (n: number): number => Math.round(n * 100) / 100;

// A panel spanning a development bank, a private bank, and two NBFC/fintechs, so
// the borrower sees genuinely different offers to choose between.
const PANEL: LenderPolicy[] = [
  { key: 'SIDBI',    name: 'SIDBI (development bank)',  minGrade: 'C', baseRatePct: 12.5, maxTicket: 300000, feePct: 0.5, anchorDiscountPct: 1.0 },
  { key: 'HDFC',     name: 'HDFC Bank',                 minGrade: 'B', baseRatePct: 14.0, maxTicket: 500000, feePct: 1.0, anchorDiscountPct: 0.75 },
  { key: 'ABCAPITAL',name: 'Aditya Birla Capital NBFC', minGrade: 'C', baseRatePct: 16.5, maxTicket: 250000, feePct: 1.5, anchorDiscountPct: 0.5 },
  { key: 'FLEXI',    name: 'FlexiLoan (fintech NBFC)',  minGrade: 'D', baseRatePct: 20.0, maxTicket: 120000, feePct: 2.0, anchorDiscountPct: 0.5 },
];

export class OcenLenderNetwork {
  constructor(private readonly panel: LenderPolicy[] = PANEL) {}

  /** Every lender whose policy admits this bundle returns an offer, best rate first. */
  solicit(bundle: UnderwritingBundle): LenderOffer[] {
    const offers: LenderOffer[] = [];
    for (const lender of this.panel) {
      const offer = this.bid(lender, bundle);
      if (offer) offers.push(offer);
    }
    return offers.sort((a, b) => a.interestRatePct - b.interestRatePct || b.sanctionedAmount - a.sanctionedAmount);
  }

  private bid(lender: LenderPolicy, b: UnderwritingBundle): LenderOffer | null {
    if (GRADE_RANK[b.grade] < GRADE_RANK[lender.minGrade]) return null; // outside risk appetite

    const sanctioned = round0(Math.min(b.amountRequested, b.recommendedLimit, lender.maxTicket) / 1000) * 1000;
    if (sanctioned < 5000) return null; // not worth originating

    // Rate = base + grade spread − anchor discount (scaled by relationship strength).
    const rate = round2(
      Math.max(lender.baseRatePct + GRADE_SPREAD[b.grade] - lender.anchorDiscountPct * b.anchorStrength, 8),
    );
    const processingFee = round2((sanctioned * lender.feePct) / 100);
    const interest = round2((sanctioned * rate * b.tenureDays) / (100 * 365));
    const totalRepayable = round2(sanctioned + interest + processingFee);
    const months = Math.max(Math.round(b.tenureDays / 30), 1);
    const emiAmount = round2((sanctioned + interest) / months);

    return {
      lenderKey: lender.key,
      lenderName: lender.name,
      sanctionedAmount: sanctioned,
      interestRatePct: rate,
      tenureDays: b.tenureDays,
      processingFee,
      emiAmount,
      totalRepayable,
    };
  }
}
