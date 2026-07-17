/**
 * ApnaKhata — E-Invoice Service
 * -----------------------------
 * IRN generation for businesses above the e-invoicing turnover threshold.
 * Builds the INV-01 style payload from a GST invoice's header + line items,
 * registers it through an IrpGateway, and stores the IRN / acknowledgement /
 * signed QR in einvoice_records. Idempotent per invoice; cancellation honours
 * the IRP's 24-hour window.
 *
 * Turnover check: the statutory trigger is aggregate annual turnover above
 * ₹5 crore. AATO of the *previous* FY is the legal test; as a pragmatic proxy
 * we measure trailing-12-month outward supplies from the ledger and flag when
 * the mandate applies (threshold configurable for future notification changes).
 */

import { Pool } from 'pg';

import { financialYearOf, IrpGateway, IrpInvoicePayload, SandboxIrpGateway } from '../irp/IrpGateway';
import { GstInvoiceService } from './GstInvoiceService';

export const EINVOICE_TURNOVER_THRESHOLD_INR = 5_00_00_000; // ₹5 crore
const CANCEL_WINDOW_HOURS = 24;

export interface EInvoiceRecord {
  transactionId: string;
  irn: string;
  ackNo: string;
  ackDate: string;
  status: 'GENERATED' | 'CANCELLED';
  signedQr: string;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export class EInvoiceService {
  constructor(
    private readonly db: Pool,
    private readonly invoices: GstInvoiceService,
    private readonly gateway: IrpGateway = new SandboxIrpGateway(),
    private readonly thresholdInr: number = EINVOICE_TURNOVER_THRESHOLD_INR,
  ) {}

  /** Is this seller obliged to e-invoice? (trailing-12m outward supplies vs threshold) */
  async isRequired(sellerId: string): Promise<{ required: boolean; trailing12mTurnover: number; thresholdInr: number }> {
    const { rows } = await this.db.query<{ turnover: string | null }>(
      `
      SELECT SUM(amount) AS turnover
      FROM transactions_ledger
      WHERE sender_id = $1 AND kind IN ('B2B_INVOICE', 'RETAIL_SALE')
        AND created_at >= now() - interval '12 months'
      `,
      [sellerId],
    );
    const turnover = Number(rows[0]?.turnover ?? 0);
    return { required: turnover >= this.thresholdInr, trailing12mTurnover: turnover, thresholdInr: this.thresholdInr };
  }

  /**
   * Register a GST invoice with the IRP and persist the IRN. Idempotent:
   * calling again for the same invoice returns the stored record.
   */
  async generateIrn(transactionId: string): Promise<EInvoiceRecord> {
    const existing = await this.getRecord(transactionId);
    if (existing) return existing;

    const invoice = await this.invoices.getInvoice(transactionId);
    if (invoice.kind !== 'B2B_INVOICE') {
      throw new Error('e-invoicing applies to B2B invoices, not retail sales');
    }

    const { rows: parties } = await this.db.query<{
      seller_gstin: string | null;
      seller_name: string;
      seller_state: string | null;
      buyer_gstin: string | null;
      buyer_name: string | null;
    }>(
      `
      SELECT su.gstin AS seller_gstin, su.business_name AS seller_name, su.state_code AS seller_state,
             ru.gstin AS buyer_gstin, ru.business_name AS buyer_name
      FROM transactions_ledger tl
      JOIN users su ON su.id = tl.sender_id
      LEFT JOIN users ru ON ru.id = tl.receiver_id
      WHERE tl.id = $1
      `,
      [transactionId],
    );
    const p = parties[0];
    if (!p?.seller_gstin) throw new Error('seller is not GST registered; cannot generate IRN');

    const [y, m, d] = invoice.invoiceDate.split('-');
    const payload: IrpInvoicePayload = {
      version: '1.1',
      docDtls: { typ: 'INV', no: invoice.invoiceNumber, dt: `${d}/${m}/${y}` },
      sellerDtls: { gstin: p.seller_gstin, lglNm: p.seller_name, stcd: p.seller_state ?? '' },
      buyerDtls: { gstin: p.buyer_gstin, lglNm: p.buyer_name ?? '', pos: invoice.placeOfSupply },
      itemList: invoice.lines.map((l) => ({
        slNo: l.lineNo,
        hsnCd: l.hsnCode,
        qty: l.quantity,
        unitPrice: l.unitPrice,
        assAmt: l.taxableValue,
        gstRt: l.gstRate,
        cgstAmt: l.cgstAmount,
        sgstAmt: l.sgstAmount,
        igstAmt: l.igstAmount,
        totItemVal: l.lineTotal,
      })),
      valDtls: {
        assVal: invoice.taxableTotal,
        cgstVal: invoice.cgstTotal,
        sgstVal: invoice.sgstTotal,
        igstVal: invoice.igstTotal,
        totInvVal: invoice.grandTotal,
      },
    };

    const fy = financialYearOf(new Date(`${invoice.invoiceDate}T00:00:00Z`));
    const result = await this.gateway.register(payload, fy);

    await this.db.query(
      `
      INSERT INTO einvoice_records (transaction_id, irn, ack_no, ack_date, signed_qr, irp_response)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (transaction_id) DO NOTHING
      `,
      [transactionId, result.irn, result.ackNo, result.ackDate, result.signedQr, JSON.stringify(result.raw)],
    );

    // Re-read to stay correct under a concurrent duplicate registration.
    const stored = await this.getRecord(transactionId);
    if (!stored) throw new Error('failed to persist e-invoice record');
    return stored;
  }

  /** Cancel an IRN inside the IRP's 24-hour window. */
  async cancelIrn(transactionId: string, reason: string): Promise<EInvoiceRecord> {
    const record = await this.getRecord(transactionId);
    if (!record) throw new Error('no e-invoice on record for this invoice');
    if (record.status === 'CANCELLED') return record;

    const ageHours = (Date.now() - new Date(record.ackDate).getTime()) / 3_600_000;
    if (ageHours > CANCEL_WINDOW_HOURS) {
      throw new Error(`IRN cannot be cancelled after ${CANCEL_WINDOW_HOURS} hours; issue a credit note instead`);
    }

    const { cancelDate } = await this.gateway.cancel(record.irn, reason);
    await this.db.query(
      `UPDATE einvoice_records SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = $3
       WHERE transaction_id = $1`,
      [transactionId, reason, cancelDate],
    );
    return (await this.getRecord(transactionId))!;
  }

  async getRecord(transactionId: string): Promise<EInvoiceRecord | null> {
    const { rows } = await this.db.query<{
      transaction_id: string;
      irn: string;
      ack_no: string;
      ack_date: Date;
      status: 'GENERATED' | 'CANCELLED';
      signed_qr: string;
      cancelled_at: Date | null;
      cancel_reason: string | null;
    }>(`SELECT * FROM einvoice_records WHERE transaction_id = $1`, [transactionId]);
    const r = rows[0];
    if (!r) return null;
    return {
      transactionId: r.transaction_id,
      irn: r.irn,
      ackNo: r.ack_no,
      ackDate: r.ack_date.toISOString(),
      status: r.status,
      signedQr: r.signed_qr,
      cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
      cancelReason: r.cancel_reason,
    };
  }
}
