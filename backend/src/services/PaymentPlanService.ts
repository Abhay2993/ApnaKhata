/**
 * ApnaKhata — Payment Plan (EMI) Service
 * --------------------------------------
 * Lets a distributor restructure a large invoice into a schedule of
 * installments. The plan hangs off the parent invoice; each installment is a
 * child row. Installment payments are booked through the ledger (payment +
 * allocation to the parent invoice) so the receivable stays accurate.
 */

import { Pool, PoolClient } from 'pg';

export interface CreatePlanInput {
  invoiceId: string;
  installmentCount: number;
  frequencyDays?: number; // default 30
  interestRatePct?: number; // flat interest on principal, default 0
  startDate?: string; // ISO date; default today
}

export interface Installment {
  id: string;
  sequence: number;
  dueDate: string;
  amountDue: number;
  amountPaid: number;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';
  paidAt: string | null;
}

export interface PaymentPlan {
  id: string;
  invoiceId: string;
  debtorId: string;
  creditorId: string;
  principal: number;
  installmentCount: number;
  frequencyDays: number;
  interestRatePct: number;
  startDate: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'DEFAULTED';
  installments: Installment[];
}

export class PaymentPlanService {
  constructor(private readonly db: Pool) {}

  /**
   * Create a plan for an invoice and generate its amortised schedule in one
   * transaction. Principal is the invoice's current outstanding balance.
   */
  async createPlan(input: CreatePlanInput): Promise<PaymentPlan> {
    if (input.installmentCount < 1) throw new Error('installmentCount must be >= 1');

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows: invRows } = await client.query<{
        balance_remaining: string;
        sender_id: string;
        receiver_id: string;
        payment_status: string;
      }>(
        `SELECT balance_remaining, sender_id, receiver_id, payment_status
           FROM transactions_ledger WHERE id = $1 AND kind = 'B2B_INVOICE' FOR UPDATE`,
        [input.invoiceId],
      );
      const invoice = invRows[0];
      if (!invoice) throw new Error('invoice not found or not a B2B invoice');
      if (invoice.payment_status === 'PAID') throw new Error('invoice is already settled');

      const principal = Number(invoice.balance_remaining);

      const { rows: planRows } = await client.query<{ id: string }>(
        `
        INSERT INTO payment_plans (
          invoice_id, debtor_id, creditor_id, principal,
          installment_count, frequency_days, interest_rate_pct, start_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE))
        RETURNING id
        `,
        [
          input.invoiceId,
          invoice.receiver_id,
          invoice.sender_id,
          principal,
          input.installmentCount,
          input.frequencyDays ?? 30,
          input.interestRatePct ?? 0,
          input.startDate ?? null,
        ],
      );
      const planId = planRows[0].id;

      await client.query(`SELECT generate_installment_schedule($1)`, [planId]);

      await client.query('COMMIT');
      return this.getPlan(planId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Record a payment against a specific installment. Delegates to the DB
   * function that books the payment, allocates it to the parent invoice, and
   * completes the plan when the last installment clears.
   */
  async recordInstallmentPayment(
    installmentId: string,
    amount: number,
    method = 'UPI',
    reference?: string,
  ): Promise<{ paymentId: string; plan: PaymentPlan }> {
    if (amount <= 0) throw new Error('amount must be positive');

    const { rows } = await this.db.query<{ record_plan_installment_payment: string }>(
      `SELECT record_plan_installment_payment($1, $2, $3, $4)`,
      [installmentId, amount, method, reference ?? null],
    );
    const paymentId = rows[0].record_plan_installment_payment;

    const { rows: planRows } = await this.db.query<{ plan_id: string }>(
      `SELECT plan_id FROM payment_plan_installments WHERE id = $1`,
      [installmentId],
    );
    return { paymentId, plan: await this.getPlan(planRows[0].plan_id) };
  }

  /** Fetch a plan with its full installment schedule. */
  async getPlan(planId: string, client: PoolClient | Pool = this.db): Promise<PaymentPlan> {
    const { rows } = await client.query<{
      id: string;
      invoice_id: string;
      debtor_id: string;
      creditor_id: string;
      principal: string;
      installment_count: number;
      frequency_days: number;
      interest_rate_pct: string;
      start_date: Date;
      status: PaymentPlan['status'];
    }>(`SELECT * FROM payment_plans WHERE id = $1`, [planId]);
    const plan = rows[0];
    if (!plan) throw new Error('plan not found');

    const { rows: instRows } = await client.query<{
      id: string;
      sequence: number;
      due_date: Date;
      amount_due: string;
      amount_paid: string;
      status: Installment['status'];
      paid_at: Date | null;
    }>(
      `SELECT id, sequence, due_date, amount_due, amount_paid, status, paid_at
         FROM payment_plan_installments WHERE plan_id = $1 ORDER BY sequence`,
      [planId],
    );

    return {
      id: plan.id,
      invoiceId: plan.invoice_id,
      debtorId: plan.debtor_id,
      creditorId: plan.creditor_id,
      principal: Number(plan.principal),
      installmentCount: plan.installment_count,
      frequencyDays: plan.frequency_days,
      interestRatePct: Number(plan.interest_rate_pct),
      startDate: plan.start_date.toISOString().slice(0, 10),
      status: plan.status,
      installments: instRows.map((r) => ({
        id: r.id,
        sequence: r.sequence,
        dueDate: r.due_date.toISOString().slice(0, 10),
        amountDue: Number(r.amount_due),
        amountPaid: Number(r.amount_paid),
        status: r.status,
        paidAt: r.paid_at ? r.paid_at.toISOString() : null,
      })),
    };
  }
}
