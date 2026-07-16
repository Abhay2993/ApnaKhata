/**
 * ApnaKhata — Dispute & Credit-Note Service
 * -----------------------------------------
 * Full lifecycle behind the transactions_ledger.is_disputed flag and the
 * CREDIT_NOTE ledger kind:
 *
 *   raise → (under review) → resolve with credit note   (buyer upheld)
 *                          → reject                      (invoice stands)
 *                          → withdraw                    (raiser backs out)
 *
 * Upholding a dispute issues a CREDIT_NOTE ledger row and reduces the disputed
 * invoice's balance atomically via the DB function.
 */

import { Pool } from 'pg';

export type DisputeStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'RESOLVED_UPHELD'
  | 'RESOLVED_REJECTED'
  | 'WITHDRAWN';

export interface RaiseDisputeInput {
  invoiceId: string;
  raisedBy: string;
  reason: string;
  disputedAmount: number;
}

export interface Dispute {
  id: string;
  invoiceId: string;
  raisedBy: string;
  reason: string;
  disputedAmount: number;
  status: DisputeStatus;
  resolutionNote: string | null;
  creditNoteId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export class DisputeService {
  constructor(private readonly db: Pool) {}

  /** Raise a dispute and flag the invoice as disputed. */
  async raiseDispute(input: RaiseDisputeInput): Promise<Dispute> {
    if (input.disputedAmount <= 0) throw new Error('disputedAmount must be positive');

    const { rows } = await this.db.query<{ raise_dispute: string }>(
      `SELECT raise_dispute($1, $2, $3, $4)`,
      [input.invoiceId, input.raisedBy, input.reason, input.disputedAmount],
    );
    return this.getDispute(rows[0].raise_dispute);
  }

  /** Move an open dispute into UNDER_REVIEW. */
  async markUnderReview(disputeId: string): Promise<Dispute> {
    await this.db.query(
      `UPDATE invoice_disputes SET status = 'UNDER_REVIEW' WHERE id = $1 AND status = 'OPEN'`,
      [disputeId],
    );
    return this.getDispute(disputeId);
  }

  /**
   * Resolve in the buyer's favour: issue a credit note and reduce the invoice
   * balance. Returns the updated dispute (with credit_note_id populated).
   */
  async resolveWithCreditNote(disputeId: string, creditAmount: number, note?: string): Promise<Dispute> {
    if (creditAmount <= 0) throw new Error('creditAmount must be positive');

    await this.db.query(`SELECT resolve_dispute_with_credit_note($1, $2, $3)`, [
      disputeId,
      creditAmount,
      note ?? null,
    ]);
    return this.getDispute(disputeId);
  }

  /** Reject the dispute; the invoice stands and the flag is cleared. */
  async rejectDispute(disputeId: string, note?: string): Promise<Dispute> {
    await this.db.query(`SELECT reject_dispute($1, $2)`, [disputeId, note ?? null]);
    return this.getDispute(disputeId);
  }

  /** Raiser withdraws; clears the flag if no other open dispute remains. */
  async withdrawDispute(disputeId: string): Promise<Dispute> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE invoice_disputes SET status = 'WITHDRAWN', resolved_at = now()
           WHERE id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')`,
        [disputeId],
      );
      await client.query(
        `
        UPDATE transactions_ledger tl SET is_disputed = FALSE
        FROM invoice_disputes d
        WHERE d.id = $1 AND tl.id = d.invoice_id
          AND NOT EXISTS (
            SELECT 1 FROM invoice_disputes o
            WHERE o.invoice_id = d.invoice_id AND o.id <> d.id
              AND o.status IN ('OPEN', 'UNDER_REVIEW')
          )
        `,
        [disputeId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.getDispute(disputeId);
  }

  /** List disputes for an invoice, newest first. */
  async listForInvoice(invoiceId: string): Promise<Dispute[]> {
    const { rows } = await this.db.query<DisputeRow>(
      `SELECT * FROM invoice_disputes WHERE invoice_id = $1 ORDER BY created_at DESC`,
      [invoiceId],
    );
    return rows.map(mapDispute);
  }

  async getDispute(disputeId: string): Promise<Dispute> {
    const { rows } = await this.db.query<DisputeRow>(`SELECT * FROM invoice_disputes WHERE id = $1`, [
      disputeId,
    ]);
    if (!rows[0]) throw new Error('dispute not found');
    return mapDispute(rows[0]);
  }
}

interface DisputeRow {
  id: string;
  invoice_id: string;
  raised_by: string;
  reason: string;
  disputed_amount: string;
  status: DisputeStatus;
  resolution_note: string | null;
  credit_note_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function mapDispute(r: DisputeRow): Dispute {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    raisedBy: r.raised_by,
    reason: r.reason,
    disputedAmount: Number(r.disputed_amount),
    status: r.status,
    resolutionNote: r.resolution_note,
    creditNoteId: r.credit_note_id,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}
