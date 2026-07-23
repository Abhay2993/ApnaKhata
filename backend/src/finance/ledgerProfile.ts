/**
 * ApnaKhata — Ledger-derived borrower profile
 * -------------------------------------------
 * The proprietary signal no competitor holds: throughput and repayment
 * behaviour observed directly in the B2B ledger. Feeds both the AA sandbox
 * (to synthesise a coherent cash-flow view) and the underwriting engine.
 */

import { Pool, PoolClient } from 'pg';

import { LedgerProfile } from './AccountAggregatorGateway';

/** Trailing-12-month trade throughput + average settlement delay for a borrower. */
export async function computeLedgerProfile(db: Pool | PoolClient, borrowerId: string): Promise<LedgerProfile> {
  const { rows } = await db.query<{ annual_trade: string; avg_delay: string | null }>(
    `
    WITH annual AS (
      SELECT COALESCE(SUM(amount), 0) AS annual_trade
      FROM transactions_ledger
      WHERE receiver_id = $1 AND kind = 'B2B_INVOICE' AND created_at >= now() - interval '365 days'
    ),
    settled AS (
      SELECT tl.due_date, MAX(p.paid_at) AS settled_at
      FROM transactions_ledger tl
      JOIN payment_allocations pa ON pa.transaction_id = tl.id
      JOIN payments p ON p.id = pa.payment_id
      WHERE tl.receiver_id = $1 AND tl.payment_status = 'PAID' AND tl.due_date IS NOT NULL
      GROUP BY tl.id, tl.due_date
    )
    SELECT annual.annual_trade,
           (SELECT AVG(EXTRACT(EPOCH FROM (settled_at - due_date)) / 86400) FROM settled) AS avg_delay
    FROM annual
    `,
    [borrowerId],
  );
  return {
    annualTradeValue: Number(rows[0]?.annual_trade ?? 0),
    averageDelayDays: rows[0]?.avg_delay != null ? Number(rows[0].avg_delay) : 0,
  };
}
