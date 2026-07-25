/**
 * ApnaKhata — Account Aggregator service
 * --------------------------------------
 * Orchestrates the AA consent lifecycle and the cash-flow pull:
 *   createConsent → (borrower approves in their AA app) → fetchFinancials.
 * In production the AA notifies consent approval via webhook; the sandbox
 * exposes `approveConsent` to simulate that step. The fetched summary is stored
 * and feeds underwriting.
 */

import { Pool } from 'pg';

import { AccountAggregatorGateway, FinancialSummary, SandboxAccountAggregatorGateway } from '../finance/AccountAggregatorGateway';
import { computeLedgerProfile } from '../finance/ledgerProfile';

export type AaConsentStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'EXPIRED' | 'REVOKED';

export interface AaConsent {
  id: string;
  purpose: string;
  consentHandle: string | null;
  status: AaConsentStatus;
  months: number;
  createdAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
}

export interface AaSummary extends FinancialSummary {
  id: string;
  consentId: string;
  fetchedAt: string;
}

export class AccountAggregatorService {
  constructor(
    private readonly db: Pool,
    private readonly gateway: AccountAggregatorGateway = new SandboxAccountAggregatorGateway(),
  ) {}

  /** Raise a consent request (PENDING until the borrower approves). */
  async createConsent(borrowerId: string, months = 6, purpose = 'LOAN_UNDERWRITING'): Promise<AaConsent> {
    if (months < 1 || months > 24) throw new Error('months must be between 1 and 24');
    const { consentHandle } = await this.gateway.requestConsent({ borrowerId, months });
    const { rows } = await this.db.query<ConsentRow>(
      `
      INSERT INTO aa_consents (borrower_id, purpose, consent_handle, months, status)
      VALUES ($1, $2, $3, $4, 'PENDING')
      RETURNING *
      `,
      [borrowerId, purpose, consentHandle, months],
    );
    return mapConsent(rows[0]);
  }

  /** Simulate the borrower approving the consent in their AA app. */
  async approveConsent(borrowerId: string, consentId: string): Promise<AaConsent> {
    const { rows } = await this.db.query<ConsentRow>(
      `
      UPDATE aa_consents
         SET status = 'ACTIVE', approved_at = now(), expires_at = now() + interval '90 days'
       WHERE id = $1 AND borrower_id = $2 AND status = 'PENDING'
      RETURNING *
      `,
      [consentId, borrowerId],
    );
    if (rows.length === 0) throw new Error('consent not found or not pending');
    return mapConsent(rows[0]);
  }

  /** Pull the statement summary under an ACTIVE consent and store it. */
  async fetchFinancials(borrowerId: string, consentId: string): Promise<AaSummary> {
    const { rows: consents } = await this.db.query<ConsentRow>(
      `SELECT * FROM aa_consents WHERE id = $1 AND borrower_id = $2`,
      [consentId, borrowerId],
    );
    const consent = consents[0];
    if (!consent) throw new Error('consent not found');
    if (consent.status !== 'ACTIVE') throw new Error('consent is not active — approve it first');

    const profile = await computeLedgerProfile(this.db, borrowerId);
    const summary = await this.gateway.fetchFinancials(consent.consent_handle as string, consent.months, profile);

    const { rows } = await this.db.query<SummaryRow>(
      `
      INSERT INTO aa_financial_summaries
        (consent_id, borrower_id, months, avg_monthly_inflow, avg_monthly_outflow,
         avg_balance, min_balance, bounce_count, inflow_cv)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [consentId, borrowerId, summary.months, summary.avgMonthlyInflow, summary.avgMonthlyOutflow,
       summary.avgBalance, summary.minBalance, summary.bounceCount, summary.inflowCv],
    );
    return mapSummary(rows[0]);
  }

  async listConsents(borrowerId: string): Promise<AaConsent[]> {
    const { rows } = await this.db.query<ConsentRow>(
      `SELECT * FROM aa_consents WHERE borrower_id = $1 ORDER BY created_at DESC`,
      [borrowerId],
    );
    return rows.map(mapConsent);
  }

  /** Most recent cash-flow summary for a borrower (used by underwriting). */
  async latestSummary(borrowerId: string): Promise<AaSummary | null> {
    const { rows } = await this.db.query<SummaryRow>(
      `SELECT * FROM aa_financial_summaries WHERE borrower_id = $1 ORDER BY fetched_at DESC LIMIT 1`,
      [borrowerId],
    );
    return rows.length ? mapSummary(rows[0]) : null;
  }
}

interface ConsentRow {
  id: string; purpose: string; consent_handle: string | null; status: AaConsentStatus;
  months: number; created_at: Date; approved_at: Date | null; expires_at: Date | null;
}
interface SummaryRow {
  id: string; consent_id: string; months: number; avg_monthly_inflow: string; avg_monthly_outflow: string;
  avg_balance: string; min_balance: string; bounce_count: number; inflow_cv: string; fetched_at: Date;
}

const mapConsent = (r: ConsentRow): AaConsent => ({
  id: r.id,
  purpose: r.purpose,
  consentHandle: r.consent_handle,
  status: r.status,
  months: r.months,
  createdAt: r.created_at.toISOString(),
  approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
  expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
});

const mapSummary = (r: SummaryRow): AaSummary => ({
  id: r.id,
  consentId: r.consent_id,
  months: r.months,
  avgMonthlyInflow: Number(r.avg_monthly_inflow),
  avgMonthlyOutflow: Number(r.avg_monthly_outflow),
  avgBalance: Number(r.avg_balance),
  minBalance: Number(r.min_balance),
  bounceCount: r.bounce_count,
  inflowCv: Number(r.inflow_cv),
  fetchedAt: r.fetched_at.toISOString(),
});
