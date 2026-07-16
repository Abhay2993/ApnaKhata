/**
 * ApnaKhata — UPI Collection Service
 * ----------------------------------
 * Generates dynamic UPI intent/QR deep links per invoice and reconciles the
 * matching UTR webhook straight into the FIFO settlement engine, so a paid
 * collection needs zero manual ledger entry.
 *
 * Flow:
 *   1. createCollectionRequest() → returns a `upi://pay?...` deep link + QR payload.
 *   2. Payer scans/taps, pays from any UPI app.
 *   3. PSP posts the UTR to handleUtrWebhook() → reconcile_upi_collection()
 *      creates the payment and runs apply_payment_fifo() atomically.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface CreateCollectionInput {
  payerId: string; // debtor
  payeeId: string; // creditor collecting the money
  amount: number; // INR
  payeeVpa: string; // collector UPI VPA, e.g. sharma@okhdfcbank
  payeeName: string;
  invoiceId?: string; // optional link to a specific invoice
  note?: string;
  expiresInMinutes?: number; // default 30
}

export interface CollectionRequest {
  id: string;
  transactionRef: string;
  upiIntentUrl: string; // feed to a QR renderer or an app intent
  amount: number;
  status: 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'FAILED';
  expiresAt: Date;
}

export interface UtrWebhookInput {
  transactionRef: string; // the tr= we generated
  utr: string; // bank UTR / RRN
  amount: number;
  status: 'SUCCESS' | 'FAILURE';
}

export interface ReconciliationResult {
  status: 'RECONCILED' | 'ALREADY_DONE' | 'REJECTED';
  paymentId?: string;
  reason?: string;
}

export class UpiCollectionService {
  constructor(private readonly db: Pool) {}

  /** Build a spec-compliant UPI deep link and persist the pending request. */
  async createCollectionRequest(input: CreateCollectionInput): Promise<CollectionRequest> {
    if (input.amount <= 0) throw new Error('amount must be positive');

    const transactionRef = this.buildTransactionRef();
    const expiresInMinutes = input.expiresInMinutes ?? 30;
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000);
    const upiIntentUrl = this.buildUpiIntentUrl({
      vpa: input.payeeVpa,
      name: input.payeeName,
      amount: input.amount,
      transactionRef,
      note: input.note ?? 'ApnaKhata invoice payment',
    });

    const { rows } = await this.db.query<{ id: string }>(
      `
      INSERT INTO upi_collection_requests (
        invoice_id, payer_id, payee_id, amount, payee_vpa, payee_name,
        transaction_ref, upi_intent_url, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
      `,
      [
        input.invoiceId ?? null,
        input.payerId,
        input.payeeId,
        input.amount,
        input.payeeVpa,
        input.payeeName,
        transactionRef,
        upiIntentUrl,
        expiresAt,
      ],
    );

    return {
      id: rows[0].id,
      transactionRef,
      upiIntentUrl,
      amount: input.amount,
      status: 'PENDING',
      expiresAt,
    };
  }

  /**
   * Reconcile an inbound UTR webhook. Verifies the reference and amount, then
   * delegates the atomic payment + FIFO settlement to the DB function.
   * Idempotent: a replayed webhook for a completed request is a no-op.
   */
  async handleUtrWebhook(input: UtrWebhookInput): Promise<ReconciliationResult> {
    const { rows } = await this.db.query<{
      id: string;
      amount: string;
      status: string;
      payment_id: string | null;
      expires_at: Date | null;
    }>(
      `SELECT id, amount, status, payment_id, expires_at
         FROM upi_collection_requests WHERE transaction_ref = $1`,
      [input.transactionRef],
    );

    const request = rows[0];
    if (!request) return { status: 'REJECTED', reason: 'unknown transaction reference' };
    if (request.status === 'COMPLETED') {
      return { status: 'ALREADY_DONE', paymentId: request.payment_id ?? undefined };
    }
    if (input.status !== 'SUCCESS') {
      await this.db.query(`UPDATE upi_collection_requests SET status = 'FAILED' WHERE id = $1`, [request.id]);
      return { status: 'REJECTED', reason: 'PSP reported failure' };
    }
    if (Number(request.amount) !== input.amount) {
      return { status: 'REJECTED', reason: 'amount mismatch' };
    }

    const { rows: result } = await this.db.query<{ reconcile_upi_collection: string }>(
      `SELECT reconcile_upi_collection($1, $2)`,
      [request.id, input.utr],
    );

    return { status: 'RECONCILED', paymentId: result[0].reconcile_upi_collection };
  }

  /** `upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>` */
  private buildUpiIntentUrl(p: {
    vpa: string;
    name: string;
    amount: number;
    transactionRef: string;
    note: string;
  }): string {
    const params = new URLSearchParams({
      pa: p.vpa,
      pn: p.name,
      am: p.amount.toFixed(2),
      cu: 'INR',
      tn: p.note,
      tr: p.transactionRef,
    });
    return `upi://pay?${params.toString()}`;
  }

  /** UPI reference: <=35 chars, alphanumeric. */
  private buildTransactionRef(): string {
    return `AK${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
  }
}
