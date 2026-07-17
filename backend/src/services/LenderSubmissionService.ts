/**
 * ApnaKhata — Lender Submission Service
 * -------------------------------------
 * Submits a signed Credit Passport to a partner bank's pre-approval sandbox
 * and records the decision. Non-custodial: ApnaKhata never touches funds — it
 * hands the bank a verifiable risk attestation and stores what came back.
 */

import { Pool } from 'pg';

import { Lender, LenderDecision, LenderGateway, SandboxLenderGateway } from '../lenders/LenderGateway';
import { CreditPassportService } from './CreditPassportService';
import { RiskTier } from './creditScoring';

export interface SubmitInput {
  userId: string;
  lender: Lender;
  requestedAmount: number;
  /** Reuse an existing passport; otherwise a fresh one is issued and signed. */
  passportId?: string;
}

export interface LenderSubmission {
  id: string;
  userId: string;
  passportId: string;
  lender: Lender;
  status: LenderDecision;
  requestedAmount: number;
  approvedAmount: number | null;
  interestRatePct: number | null;
  externalReference: string | null;
  submittedAt: string;
}

export class LenderSubmissionService {
  constructor(
    private readonly db: Pool,
    private readonly passports: CreditPassportService,
    private readonly gateway: LenderGateway = new SandboxLenderGateway(),
  ) {}

  /** Issue-or-reuse a passport, submit it, and persist the lender's decision. */
  async submit(input: SubmitInput): Promise<LenderSubmission> {
    if (input.requestedAmount <= 0) throw new Error('requestedAmount must be positive');

    const passport = input.passportId
      ? await this.loadPassport(input.passportId)
      : await this.issueFresh(input.userId);

    const response = await this.gateway.submit({
      lender: input.lender,
      passportId: passport.passportId,
      score: passport.score,
      tier: passport.tier,
      requestedAmount: input.requestedAmount,
      annualTradeValue: passport.annualTradeValue,
    });

    const { rows } = await this.db.query<{ id: string; submitted_at: Date }>(
      `
      INSERT INTO lender_submissions (
        user_id, passport_id, lender, status, requested_amount,
        approved_amount, interest_rate_pct, external_reference, response_json
      )
      SELECT $1, cp.id, $2, $3, $4, $5, $6, $7, $8
      FROM credit_passports cp
      WHERE cp.report_json->>'passportId' = $9
      RETURNING id, submitted_at
      `,
      [
        input.userId,
        input.lender,
        response.status,
        input.requestedAmount,
        response.approvedAmount,
        response.interestRatePct,
        response.externalReference,
        JSON.stringify(response.raw),
        passport.passportId,
      ],
    );
    if (!rows[0]) throw new Error('passport not found for submission');

    return {
      id: rows[0].id,
      userId: input.userId,
      passportId: passport.passportId,
      lender: input.lender,
      status: response.status,
      requestedAmount: input.requestedAmount,
      approvedAmount: response.approvedAmount,
      interestRatePct: response.interestRatePct,
      externalReference: response.externalReference,
      submittedAt: rows[0].submitted_at.toISOString(),
    };
  }

  async listForUser(userId: string): Promise<LenderSubmission[]> {
    const { rows } = await this.db.query<SubmissionRow>(
      `
      SELECT ls.id, ls.user_id, ls.lender, ls.status, ls.requested_amount,
             ls.approved_amount, ls.interest_rate_pct, ls.external_reference,
             ls.submitted_at, cp.report_json->>'passportId' AS passport_id
      FROM lender_submissions ls
      JOIN credit_passports cp ON cp.id = ls.passport_id
      WHERE ls.user_id = $1
      ORDER BY ls.submitted_at DESC
      `,
      [userId],
    );
    return rows.map(mapSubmission);
  }

  private async issueFresh(userId: string): Promise<{
    passportId: string;
    score: number;
    tier: RiskTier;
    annualTradeValue: number;
  }> {
    const issued = await this.passports.issue(userId);
    return {
      passportId: issued.passportId,
      score: issued.score,
      tier: issued.tier,
      annualTradeValue: issued.report.ledgerSummary.totalTradeValue12m,
    };
  }

  private async loadPassport(passportId: string): Promise<{
    passportId: string;
    score: number;
    tier: RiskTier;
    annualTradeValue: number;
  }> {
    const { rows } = await this.db.query<{ score: number; tier: RiskTier; trade_value: string }>(
      `
      SELECT score, tier, (report_json->'ledgerSummary'->>'totalTradeValue12m')::numeric AS trade_value
      FROM credit_passports WHERE report_json->>'passportId' = $1
      `,
      [passportId],
    );
    if (!rows[0]) throw new Error('passport not found');
    return {
      passportId,
      score: rows[0].score,
      tier: rows[0].tier,
      annualTradeValue: Number(rows[0].trade_value ?? 0),
    };
  }
}

interface SubmissionRow {
  id: string;
  user_id: string;
  lender: Lender;
  status: LenderDecision;
  requested_amount: string;
  approved_amount: string | null;
  interest_rate_pct: string | null;
  external_reference: string | null;
  submitted_at: Date;
  passport_id: string;
}

function mapSubmission(r: SubmissionRow): LenderSubmission {
  return {
    id: r.id,
    userId: r.user_id,
    passportId: r.passport_id,
    lender: r.lender,
    status: r.status,
    requestedAmount: Number(r.requested_amount),
    approvedAmount: r.approved_amount === null ? null : Number(r.approved_amount),
    interestRatePct: r.interest_rate_pct === null ? null : Number(r.interest_rate_pct),
    externalReference: r.external_reference,
    submittedAt: r.submitted_at.toISOString(),
  };
}
