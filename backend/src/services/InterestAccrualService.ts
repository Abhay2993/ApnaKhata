/**
 * ApnaKhata — Interest / Late-Fee Accrual Service
 * -----------------------------------------------
 * Distributors configure a grace period and a daily interest rate; a scheduled
 * job calls accrueForDate() once per day to book late-fee interest on every
 * eligible overdue invoice. Interest is stored separately from principal (in
 * interest_accruals) so the audit trail stays clean and the original invoice
 * amount is never mutated.
 */

import { Pool } from 'pg';

export interface CreditTermsInput {
  distributorId: string;
  gracePeriodDays: number;
  dailyInterestRatePct: number; // percent per day on outstanding balance
  maxInterestPct?: number | null; // cap as % of invoice amount; null = uncapped
  enabled?: boolean;
}

export interface InvoiceBalance {
  invoiceId: string;
  principalOutstanding: number;
  accruedInterest: number;
  totalDue: number;
}

export class InterestAccrualService {
  constructor(private readonly db: Pool) {}

  /** Set (or update) a distributor's late-fee terms. */
  async setCreditTerms(terms: CreditTermsInput): Promise<void> {
    if (terms.gracePeriodDays < 0) throw new Error('gracePeriodDays must be >= 0');
    if (terms.dailyInterestRatePct < 0) throw new Error('dailyInterestRatePct must be >= 0');

    await this.db.query(
      `
      INSERT INTO distributor_credit_terms
        (distributor_id, grace_period_days, daily_interest_rate_pct, max_interest_pct, enabled, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (distributor_id) DO UPDATE SET
        grace_period_days       = EXCLUDED.grace_period_days,
        daily_interest_rate_pct = EXCLUDED.daily_interest_rate_pct,
        max_interest_pct        = EXCLUDED.max_interest_pct,
        enabled                 = EXCLUDED.enabled,
        updated_at              = now()
      `,
      [
        terms.distributorId,
        terms.gracePeriodDays,
        terms.dailyInterestRatePct,
        terms.maxInterestPct ?? null,
        terms.enabled ?? true,
      ],
    );
  }

  /**
   * Book one day of interest across all eligible invoices. Idempotent per day:
   * re-running for the same date inserts nothing new. Returns the number of
   * invoices accrued.
   */
  async accrueForDate(asOf?: string): Promise<{ accruedCount: number; asOf: string }> {
    const { rows } = await this.db.query<{ accrue_interest: number }>(
      `SELECT accrue_interest(COALESCE($1::date, CURRENT_DATE))`,
      [asOf ?? null],
    );
    return {
      accruedCount: rows[0].accrue_interest,
      asOf: asOf ?? new Date().toISOString().slice(0, 10),
    };
  }

  /** Principal + accrued interest for a single invoice. */
  async getInvoiceBalance(invoiceId: string): Promise<InvoiceBalance> {
    const { rows } = await this.db.query<{
      principal_outstanding: string;
      accrued_interest: string;
      total_due: string;
    }>(
      `SELECT principal_outstanding, accrued_interest, total_due
         FROM v_invoice_balance_with_interest WHERE invoice_id = $1`,
      [invoiceId],
    );
    const row = rows[0];
    if (!row) {
      // Settled or unknown invoice: no outstanding principal, no interest.
      return { invoiceId, principalOutstanding: 0, accruedInterest: 0, totalDue: 0 };
    }
    return {
      invoiceId,
      principalOutstanding: Number(row.principal_outstanding),
      accruedInterest: Number(row.accrued_interest),
      totalDue: Number(row.total_due),
    };
  }
}
