/**
 * ApnaKhata — UPI AutoPay / e-mandate
 * -----------------------------------
 * Recurring distributor payments on rails: a shopkeeper authorises an e-mandate
 * (UPI AutoPay) capped at a per-debit amount and a frequency. When a debit
 * executes it creates a real payment and settles it through the existing FIFO
 * engine (apply_payment_fifo), so AutoPay reconciles exactly like a manual UPI
 * collection. The NPCI authorisation step is stubbed (a generated UMN); wire a
 * PSP/NPCI adapter here in production.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

export type MandateStatus = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'REVOKED';
export type MandateFrequency = 'WEEKLY' | 'MONTHLY';

export interface Mandate {
  id: string;
  payerId: string;
  payeeId: string;
  maxAmount: number;
  frequency: MandateFrequency;
  umn: string | null;
  status: MandateStatus;
  nextDebitDate: string | null;
  createdAt: string;
}

export interface MandateExecution {
  id: string;
  mandateId: string;
  amount: number;
  paymentId: string | null;
  executedAt: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const addFreq = (from: Date, f: MandateFrequency): string => {
  const d = new Date(from);
  if (f === 'WEEKLY') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
};

export class UpiMandateService {
  constructor(private readonly db: Pool) {}

  /** Create a PENDING mandate (awaiting the payer's UPI-app authorisation). */
  async create(
    payerId: string,
    input: { payeeId: string; maxAmount: number; frequency?: MandateFrequency; payerVpa?: string; firstDebitDate?: string },
  ): Promise<Mandate> {
    if (!(input.maxAmount > 0)) throw new Error('max amount must be positive');
    if (input.payeeId === payerId) throw new Error('payer and payee must differ');
    const { rows } = await this.db.query<MandateRow>(
      `
      INSERT INTO upi_mandates (payer_id, payee_id, max_amount, frequency, payer_vpa, next_debit_date)
      VALUES ($1, $2, $3, COALESCE($4::mandate_frequency, 'MONTHLY'), $5, $6)
      RETURNING *
      `,
      [payerId, input.payeeId, input.maxAmount, input.frequency ?? null, input.payerVpa ?? null, input.firstDebitDate ?? null],
    );
    return mapMandate(rows[0]);
  }

  /** Payer approves in their UPI app → mandate goes ACTIVE with a UMN. */
  async authorize(payerId: string, mandateId: string): Promise<Mandate> {
    const umn = `UMN${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`;
    const { rows } = await this.db.query<MandateRow>(
      `
      UPDATE upi_mandates
         SET status = 'ACTIVE', umn = $3,
             next_debit_date = COALESCE(next_debit_date, CURRENT_DATE)
       WHERE id = $1 AND payer_id = $2 AND status = 'PENDING'
      RETURNING *
      `,
      [mandateId, payerId, umn],
    );
    if (rows.length === 0) throw new Error('mandate not found or not pending');
    return mapMandate(rows[0]);
  }

  async setStatus(payerId: string, mandateId: string, status: 'PAUSED' | 'ACTIVE' | 'REVOKED'): Promise<Mandate> {
    const { rows } = await this.db.query<MandateRow>(
      `UPDATE upi_mandates SET status = $3 WHERE id = $1 AND payer_id = $2 AND status <> 'REVOKED' RETURNING *`,
      [mandateId, payerId, status],
    );
    if (rows.length === 0) throw new Error('mandate not found or already revoked');
    return mapMandate(rows[0]);
  }

  /**
   * Execute one debit against an ACTIVE mandate: create a payment and settle it
   * FIFO against the payer's dues to the payee, then advance next_debit_date.
   */
  async execute(payerId: string, mandateId: string, amount?: number): Promise<{ mandate: Mandate; execution: MandateExecution }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows: mrows } = await client.query<MandateRow>(
        `SELECT * FROM upi_mandates WHERE id = $1 AND payer_id = $2 FOR UPDATE`,
        [mandateId, payerId],
      );
      const m = mrows[0];
      if (!m) throw new Error('mandate not found');
      if (m.status !== 'ACTIVE') throw new Error('mandate is not active');

      const debit = round2(amount ?? Number(m.max_amount));
      if (debit <= 0) throw new Error('debit amount must be positive');
      if (debit > Number(m.max_amount)) throw new Error('debit exceeds the mandate cap');

      const { rows: prows } = await client.query<{ id: string }>(
        `
        INSERT INTO payments (payer_id, payee_id, amount, method, reference)
        VALUES ($1, $2, $3, 'UPI_AUTOPAY', $4)
        RETURNING id
        `,
        [m.payer_id, m.payee_id, debit, m.umn],
      );
      const paymentId = prows[0].id;
      await client.query(`SELECT apply_payment_fifo($1)`, [paymentId]);

      const { rows: erows } = await client.query<ExecRow>(
        `INSERT INTO mandate_executions (mandate_id, amount, payment_id) VALUES ($1, $2, $3) RETURNING *`,
        [mandateId, debit, paymentId],
      );
      const { rows: urows } = await client.query<MandateRow>(
        `UPDATE upi_mandates SET next_debit_date = $2 WHERE id = $1 RETURNING *`,
        [mandateId, addFreq(new Date(), m.frequency)],
      );

      await client.query('COMMIT');
      return { mandate: mapMandate(urows[0]), execution: mapExec(erows[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Worker entry point: execute every ACTIVE mandate whose next_debit_date has
   * arrived. The debit is the lesser of the cap and the payer's actual
   * outstanding dues to the payee; with nothing due the mandate just rolls
   * forward to its next date (no zero-value debits).
   */
  async executeDue(today?: string): Promise<{ executed: number; skipped: number }> {
    const { rows: due } = await this.db.query<{ id: string; payer_id: string; payee_id: string; max_amount: string; frequency: MandateFrequency }>(
      `SELECT id, payer_id, payee_id, max_amount, frequency FROM upi_mandates
        WHERE status = 'ACTIVE' AND next_debit_date <= COALESCE($1::date, CURRENT_DATE)`,
      [today ?? null],
    );

    let executed = 0;
    let skipped = 0;
    for (const m of due) {
      const { rows: dues } = await this.db.query<{ outstanding: string }>(
        `SELECT COALESCE(SUM(balance_remaining), 0) AS outstanding
           FROM transactions_ledger
          WHERE receiver_id = $1 AND sender_id = $2 AND balance_remaining > 0 AND NOT is_disputed`,
        [m.payer_id, m.payee_id],
      );
      const outstanding = Number(dues[0].outstanding);
      if (outstanding <= 0) {
        await this.db.query(`UPDATE upi_mandates SET next_debit_date = $2 WHERE id = $1`, [
          m.id,
          addFreq(new Date(), m.frequency),
        ]);
        skipped += 1;
        continue;
      }
      const debit = Math.min(Number(m.max_amount), outstanding);
      await this.execute(m.payer_id, m.id, debit);
      executed += 1;
    }
    return { executed, skipped };
  }

  async list(payerId: string): Promise<Mandate[]> {
    const { rows } = await this.db.query<MandateRow>(
      `SELECT * FROM upi_mandates WHERE payer_id = $1 ORDER BY created_at DESC`,
      [payerId],
    );
    return rows.map(mapMandate);
  }

  async executions(payerId: string, mandateId: string): Promise<MandateExecution[]> {
    const { rows } = await this.db.query<ExecRow>(
      `
      SELECT e.* FROM mandate_executions e
      JOIN upi_mandates m ON m.id = e.mandate_id
      WHERE e.mandate_id = $1 AND m.payer_id = $2
      ORDER BY e.executed_at DESC
      `,
      [mandateId, payerId],
    );
    return rows.map(mapExec);
  }
}

interface MandateRow {
  id: string; payer_id: string; payee_id: string; max_amount: string; frequency: MandateFrequency;
  umn: string | null; status: MandateStatus; next_debit_date: Date | null; created_at: Date;
}
interface ExecRow {
  id: string; mandate_id: string; amount: string; payment_id: string | null; executed_at: Date;
}

const mapMandate = (r: MandateRow): Mandate => ({
  id: r.id,
  payerId: r.payer_id,
  payeeId: r.payee_id,
  maxAmount: Number(r.max_amount),
  frequency: r.frequency,
  umn: r.umn,
  status: r.status,
  nextDebitDate: r.next_debit_date ? r.next_debit_date.toISOString().slice(0, 10) : null,
  createdAt: r.created_at.toISOString(),
});

const mapExec = (r: ExecRow): MandateExecution => ({
  id: r.id,
  mandateId: r.mandate_id,
  amount: Number(r.amount),
  paymentId: r.payment_id,
  executedAt: r.executed_at.toISOString(),
});
