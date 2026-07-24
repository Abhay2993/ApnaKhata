/**
 * ApnaKhata — Credit-line-on-UPI + embedded RuPay card
 * ----------------------------------------------------
 * A sanctioned revolving line the shopkeeper spends over UPI. Paying a
 * distributor by scanning their UPI QR draws from the line (not a bank
 * balance): the draw creates a real ledger payment settled through the FIFO
 * engine, reduces the available limit, and is repayable to free the limit back
 * up. ApnaKhata is the issuer of record; the virtual RuPay card is the token
 * for card-rail acceptance.
 *
 * Eligibility reuses the Credit Passport: the sanctioned limit is sized off the
 * score (thin/weak files get a smaller line, PRIME files a larger one).
 */

import { Pool } from 'pg';
import { randomInt } from 'crypto';

import { CreditScoreEvaluator } from './CreditScoreEvaluator';

export type CreditLineStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface CreditLine {
  id: string;
  borrowerId: string;
  lenderName: string;
  sanctionedLimit: number;
  availableLimit: number;
  utilised: number;
  interestRatePct: number;
  status: CreditLineStatus;
  card: { last4: string; network: string; expiry: string };
  upiHandle: string | null;
  createdAt: string;
}

export interface CreditLineTxn {
  id: string;
  direction: 'DRAW' | 'REPAYMENT';
  amount: number;
  counterpartyName: string | null;
  upiRef: string;
  createdAt: string;
}

export interface Eligibility {
  eligible: boolean;
  score: number;
  tier: string;
  offeredLimit: number;
  interestRatePct: number;
  reason: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const TIER_CEILING: Record<string, number> = { PRIME: 200000, SUBPRIME: 75000, HIGH_RISK: 0 };
const TIER_RATE: Record<string, number> = { PRIME: 16, SUBPRIME: 22, HIGH_RISK: 26 };

export class CreditLineService {
  private readonly evaluator: CreditScoreEvaluator;

  constructor(private readonly db: Pool, evaluator?: CreditScoreEvaluator) {
    this.evaluator = evaluator ?? new CreditScoreEvaluator(db);
  }

  /** Passport-based eligibility: a line sized off the score, capped by tier. */
  async eligibility(borrowerId: string): Promise<Eligibility> {
    const ev = await this.evaluator.evaluate(borrowerId);
    const ceiling = TIER_CEILING[ev.tier] ?? 0;
    // Scale within the tier band by where the score sits.
    const offeredLimit = Math.round((ceiling * (0.5 + 0.5 * ((ev.score - 300) / 600))) / 1000) * 1000;
    return {
      eligible: offeredLimit >= 10000,
      score: ev.score,
      tier: ev.tier,
      offeredLimit: Math.max(offeredLimit, ev.tier === 'HIGH_RISK' ? 0 : 10000),
      interestRatePct: TIER_RATE[ev.tier] ?? 24,
      reason:
        ev.tier === 'HIGH_RISK'
          ? 'Build a few months of on-time payments to unlock a credit line.'
          : `Pre-approved from your Credit Passport (${ev.tier}, score ${ev.score}).`,
    };
  }

  /** Issue (or return) the borrower's revolving line + virtual RuPay card. */
  async issue(borrowerId: string, requestedLimit?: number): Promise<CreditLine> {
    const existing = await this.getLine(borrowerId);
    if (existing) return existing;

    const elig = await this.eligibility(borrowerId);
    if (!elig.eligible) throw new Error('not eligible for a credit line yet');
    const limit = Math.min(requestedLimit ?? elig.offeredLimit, elig.offeredLimit);
    if (limit < 10000) throw new Error('credit line must be at least 10000');

    const last4 = String(randomInt(1000, 9999));
    const expiry = this.cardExpiry();
    const handle = await this.buildUpiHandle(borrowerId);

    const { rows } = await this.db.query<CreditLineRow>(
      `
      INSERT INTO credit_lines
        (borrower_id, sanctioned_limit, available_limit, interest_rate_pct, card_last4, card_expiry, upi_handle)
      VALUES ($1, $2, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [borrowerId, limit, elig.interestRatePct, last4, expiry, handle],
    );
    return mapLine(rows[0]);
  }

  async getLine(borrowerId: string): Promise<CreditLine | null> {
    const { rows } = await this.db.query<CreditLineRow>(
      `SELECT * FROM credit_lines WHERE borrower_id = $1`,
      [borrowerId],
    );
    return rows.length ? mapLine(rows[0]) : null;
  }

  /**
   * Credit-line-on-UPI payment: pay a distributor by scanning their UPI QR,
   * funded by the line. Atomically debits the available limit, creates the
   * ledger payment, and settles the payee's dues via FIFO.
   */
  async payViaUpi(
    borrowerId: string,
    input: { payeeId?: string; payeeName?: string; amount: number; upiRef?: string },
  ): Promise<{ line: CreditLine; txn: CreditLineTxn }> {
    if (!(input.amount > 0)) throw new Error('amount must be positive');

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows: lineRows } = await client.query<CreditLineRow>(
        `SELECT * FROM credit_lines WHERE borrower_id = $1 FOR UPDATE`,
        [borrowerId],
      );
      const line = lineRows[0];
      if (!line) throw new Error('no credit line — issue one first');
      if (line.status !== 'ACTIVE') throw new Error('credit line is not active');
      const amount = round2(input.amount);
      if (amount > Number(line.available_limit)) throw new Error('amount exceeds available credit limit');

      const upiRef = input.upiRef ?? `CLU${Date.now().toString().slice(-9)}${randomInt(100, 999)}`;

      // A draw to a known distributor settles their dues on the ledger.
      let paymentId: string | null = null;
      let counterpartyName = input.payeeName ?? null;
      if (input.payeeId) {
        const { rows: payRows } = await client.query<{ id: string }>(
          `INSERT INTO payments (payer_id, payee_id, amount, method, reference)
           VALUES ($1, $2, $3, 'UPI_CREDIT', $4) RETURNING id`,
          [borrowerId, input.payeeId, amount, upiRef],
        );
        paymentId = payRows[0].id;
        await client.query(`SELECT apply_payment_fifo($1)`, [paymentId]);
        if (!counterpartyName) {
          const { rows: u } = await client.query<{ business_name: string }>(
            `SELECT business_name FROM users WHERE id = $1`,
            [input.payeeId],
          );
          counterpartyName = u[0]?.business_name ?? null;
        }
      }

      await client.query(
        `UPDATE credit_lines SET available_limit = available_limit - $2 WHERE id = $1`,
        [line.id, amount],
      );
      const { rows: txnRows } = await client.query<TxnRow>(
        `INSERT INTO credit_line_txns (credit_line_id, direction, amount, counterparty_id, counterparty_name, upi_ref, payment_id)
         VALUES ($1, 'DRAW', $2, $3, $4, $5, $6) RETURNING *`,
        [line.id, amount, input.payeeId ?? null, counterpartyName, upiRef, paymentId],
      );

      await client.query('COMMIT');
      return { line: (await this.getLine(borrowerId))!, txn: mapTxn(txnRows[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Repay the line (revolving): frees the available limit back up. */
  async repay(borrowerId: string, amount: number): Promise<{ line: CreditLine; txn: CreditLineTxn }> {
    if (!(amount > 0)) throw new Error('amount must be positive');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows: lineRows } = await client.query<CreditLineRow>(
        `SELECT * FROM credit_lines WHERE borrower_id = $1 FOR UPDATE`,
        [borrowerId],
      );
      const line = lineRows[0];
      if (!line) throw new Error('no credit line to repay');
      const utilised = Number(line.sanctioned_limit) - Number(line.available_limit);
      const repay = round2(Math.min(amount, utilised));
      if (repay <= 0) throw new Error('nothing outstanding to repay');

      await client.query(`UPDATE credit_lines SET available_limit = available_limit + $2 WHERE id = $1`, [line.id, repay]);
      const upiRef = `CLR${Date.now().toString().slice(-9)}${randomInt(100, 999)}`;
      const { rows: txnRows } = await client.query<TxnRow>(
        `INSERT INTO credit_line_txns (credit_line_id, direction, amount, counterparty_name, upi_ref)
         VALUES ($1, 'REPAYMENT', $2, 'Line repayment', $3) RETURNING *`,
        [line.id, repay, upiRef],
      );
      await client.query('COMMIT');
      return { line: (await this.getLine(borrowerId))!, txn: mapTxn(txnRows[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listTransactions(borrowerId: string, limit = 20): Promise<CreditLineTxn[]> {
    const { rows } = await this.db.query<TxnRow>(
      `
      SELECT t.* FROM credit_line_txns t
      JOIN credit_lines c ON c.id = t.credit_line_id
      WHERE c.borrower_id = $1
      ORDER BY t.created_at DESC LIMIT $2
      `,
      [borrowerId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map(mapTxn);
  }

  private cardExpiry(): string {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 4);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
  }

  private async buildUpiHandle(borrowerId: string): Promise<string> {
    const { rows } = await this.db.query<{ business_name: string }>(`SELECT business_name FROM users WHERE id = $1`, [borrowerId]);
    const slug = (rows[0]?.business_name ?? 'shop').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'shop';
    return `${slug}.${borrowerId.slice(0, 4)}@apnakhata`;
  }
}

interface CreditLineRow {
  id: string; borrower_id: string; lender_name: string; sanctioned_limit: string; available_limit: string;
  interest_rate_pct: string; status: CreditLineStatus; card_last4: string; card_network: string;
  card_expiry: string; upi_handle: string | null; created_at: Date;
}
interface TxnRow {
  id: string; direction: 'DRAW' | 'REPAYMENT'; amount: string; counterparty_name: string | null;
  upi_ref: string; created_at: Date;
}

function mapLine(r: CreditLineRow): CreditLine {
  const sanctioned = Number(r.sanctioned_limit);
  const available = Number(r.available_limit);
  return {
    id: r.id,
    borrowerId: r.borrower_id,
    lenderName: r.lender_name,
    sanctionedLimit: sanctioned,
    availableLimit: available,
    utilised: round2(sanctioned - available),
    interestRatePct: Number(r.interest_rate_pct),
    status: r.status,
    card: { last4: r.card_last4, network: r.card_network, expiry: r.card_expiry },
    upiHandle: r.upi_handle,
    createdAt: r.created_at.toISOString(),
  };
}

const mapTxn = (r: TxnRow): CreditLineTxn => ({
  id: r.id,
  direction: r.direction,
  amount: Number(r.amount),
  counterpartyName: r.counterparty_name,
  upiRef: r.upi_ref,
  createdAt: r.created_at.toISOString(),
});
