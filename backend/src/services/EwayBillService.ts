/**
 * ApnaKhata — E-Way Bill Service
 * ------------------------------
 * Generates e-way bills for goods movement above the statutory threshold
 * (₹50,000 consignment value). Builds the payload from a GST invoice, registers
 * it through a pluggable EwbGateway, and stores the EWB number + validity in
 * eway_bills. Idempotent per invoice; cancellable within 24 hours.
 */

import { Pool } from 'pg';

import { EwbGateway, SandboxEwbGateway } from '../irp/EwbGateway';
import { GstInvoiceService } from './GstInvoiceService';

export const EWAY_THRESHOLD_INR = 50000;
const CANCEL_WINDOW_HOURS = 24;

export interface EwayBill {
  transactionId: string;
  ewbNo: string;
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  vehicleNo: string | null;
  transportMode: string;
  distanceKm: number;
  validUpto: string;
  createdAt: string;
}

export interface GenerateEwbInput {
  transactionId: string;
  distanceKm: number;
  transportMode?: string; // ROAD | RAIL | AIR | SHIP
  vehicleNo?: string;
}

export class EwayBillService {
  constructor(
    private readonly db: Pool,
    private readonly invoices: GstInvoiceService,
    private readonly gateway: EwbGateway = new SandboxEwbGateway(),
    private readonly thresholdInr: number = EWAY_THRESHOLD_INR,
  ) {}

  async isRequired(transactionId: string): Promise<{ required: boolean; consignmentValue: number; thresholdInr: number }> {
    const invoice = await this.invoices.getInvoice(transactionId);
    return { required: invoice.grandTotal >= this.thresholdInr, consignmentValue: invoice.grandTotal, thresholdInr: this.thresholdInr };
  }

  /** Generate (or return the existing) e-way bill for an invoice. */
  async generate(input: GenerateEwbInput): Promise<EwayBill> {
    if (input.distanceKm <= 0) throw new Error('distanceKm must be positive');
    const existing = await this.get(input.transactionId);
    if (existing) return existing;

    const invoice = await this.invoices.getInvoice(input.transactionId);
    if (invoice.grandTotal < this.thresholdInr) {
      throw new Error(`e-way bill not required below ${this.thresholdInr}; consignment value is ${invoice.grandTotal}`);
    }

    const { rows: parties } = await this.db.query<{ from_gstin: string | null; to_gstin: string | null }>(
      `SELECT su.gstin AS from_gstin, ru.gstin AS to_gstin
         FROM transactions_ledger tl
         JOIN users su ON su.id = tl.sender_id
         LEFT JOIN users ru ON ru.id = tl.receiver_id
        WHERE tl.id = $1`,
      [input.transactionId],
    );
    const p = parties[0];
    if (!p?.from_gstin) throw new Error('supplier is not GST registered; cannot generate an e-way bill');

    const [y, m, d] = invoice.invoiceDate.split('-');
    const result = await this.gateway.generate({
      docNo: invoice.invoiceNumber,
      docDate: `${d}/${m}/${y}`,
      fromGstin: p.from_gstin,
      toGstin: p.to_gstin,
      totalValue: invoice.grandTotal,
      transMode: input.transportMode ?? 'ROAD',
      vehicleNo: input.vehicleNo,
      distanceKm: input.distanceKm,
    });

    await this.db.query(
      `
      INSERT INTO eway_bills (transaction_id, ewb_no, vehicle_no, transport_mode, distance_km, valid_upto, generated_response)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (transaction_id) DO NOTHING
      `,
      [
        input.transactionId, result.ewbNo, input.vehicleNo ?? null, input.transportMode ?? 'ROAD',
        input.distanceKm, result.validUpto, JSON.stringify(result.raw),
      ],
    );

    const stored = await this.get(input.transactionId);
    if (!stored) throw new Error('failed to persist e-way bill');
    return stored;
  }

  /** Cancel an e-way bill within the 24-hour window. */
  async cancel(transactionId: string, reason: string): Promise<EwayBill> {
    const ewb = await this.get(transactionId);
    if (!ewb) throw new Error('no e-way bill on record for this invoice');
    if (ewb.status === 'CANCELLED') return ewb;

    const ageHours = (Date.now() - new Date(ewb.createdAt).getTime()) / 3_600_000;
    if (ageHours > CANCEL_WINDOW_HOURS) {
      throw new Error(`e-way bill cannot be cancelled after ${CANCEL_WINDOW_HOURS} hours`);
    }

    const { cancelDate } = await this.gateway.cancel(ewb.ewbNo, reason);
    await this.db.query(
      `UPDATE eway_bills SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = $3 WHERE transaction_id = $1`,
      [transactionId, reason, cancelDate],
    );
    return (await this.get(transactionId))!;
  }

  async get(transactionId: string): Promise<EwayBill | null> {
    const { rows } = await this.db.query<{
      transaction_id: string;
      ewb_no: string;
      status: EwayBill['status'];
      vehicle_no: string | null;
      transport_mode: string;
      distance_km: number;
      valid_upto: Date;
      created_at: Date;
    }>(`SELECT * FROM eway_bills WHERE transaction_id = $1`, [transactionId]);
    const r = rows[0];
    if (!r) return null;
    return {
      transactionId: r.transaction_id,
      ewbNo: r.ewb_no,
      status: r.status,
      vehicleNo: r.vehicle_no,
      transportMode: r.transport_mode,
      distanceKm: r.distance_km,
      validUpto: r.valid_upto.toISOString(),
      createdAt: r.created_at.toISOString(),
    };
  }
}
