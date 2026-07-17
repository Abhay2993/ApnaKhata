/**
 * ApnaKhata — GST Invoice Service
 * -------------------------------
 * Creates GST-compliant invoices (header on transactions_ledger + HSN-coded
 * line items with the correct tax split) and produces filing-ready GSTR
 * exports from the migration-004 views.
 *
 * Tax split rule: supplier state == place of supply → intra-state, tax halves
 * into CGST + SGST (each rounded independently, per convention); otherwise
 * inter-state → IGST. Created invoices are ordinary ledger rows, so they flow
 * through FIFO settlement, reminders, and credit scoring unchanged.
 *
 * Stock note: stock movements are handled by the scan/checkout and PO-receipt
 * flows; this service is the tax/document layer only.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface GstLineInput {
  sku?: string;
  description: string;
  hsnCode: string;
  quantity: number;
  unit?: string;
  unitPrice: number; // pre-tax
  gstRate: number; // percent: 0, 5, 12, 18, 28
}

export interface CreateGstInvoiceInput {
  sellerId: string;
  buyerId?: string; // omit for retail sale
  retailCustomer?: string; // name/phone for retail
  invoiceNumber?: string;
  invoiceDate?: string; // ISO date, default today
  dueDate?: string;
  lines: GstLineInput[];
}

export interface GstInvoiceLine extends Required<Omit<GstLineInput, 'sku'>> {
  sku: string | null;
  lineNo: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  lineTotal: number;
}

export interface GstInvoice {
  transactionId: string;
  invoiceNumber: string;
  invoiceDate: string;
  kind: 'B2B_INVOICE' | 'RETAIL_SALE';
  sellerId: string;
  buyerId: string | null;
  retailCustomer: string | null;
  placeOfSupply: string;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  grandTotal: number;
  lines: GstInvoiceLine[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class GstInvoiceService {
  constructor(private readonly db: Pool) {}

  async createInvoice(input: CreateGstInvoiceInput): Promise<GstInvoice> {
    if (input.lines.length === 0) throw new Error('an invoice needs at least one line');
    if (!input.buyerId && !input.retailCustomer) {
      throw new Error('either buyerId (B2B) or retailCustomer (retail) is required');
    }

    const seller = await this.loadParty(input.sellerId);
    if (!seller.gstin) throw new Error('seller is not GST registered; cannot issue a GST invoice');
    if (!seller.state_code) throw new Error('seller has no GST state code on record');

    let buyerState: string | null = null;
    if (input.buyerId) {
      const buyer = await this.loadParty(input.buyerId);
      buyerState = buyer.state_code;
    }
    // Retail (or buyer without a state on file) is treated as over-the-counter
    // supply at the seller's location → intra-state.
    const placeOfSupply = buyerState ?? seller.state_code;
    const intraState = placeOfSupply === seller.state_code;

    const lines: GstInvoiceLine[] = input.lines.map((l, i) => {
      if (l.quantity <= 0) throw new Error(`quantity must be positive on line ${i + 1}`);
      if (l.unitPrice < 0) throw new Error(`unit price cannot be negative on line ${i + 1}`);
      if (l.gstRate < 0 || l.gstRate > 28) throw new Error(`invalid GST rate on line ${i + 1}`);

      const taxableValue = round2(l.quantity * l.unitPrice);
      const cgstAmount = intraState ? round2((taxableValue * l.gstRate) / 200) : 0;
      const sgstAmount = intraState ? round2((taxableValue * l.gstRate) / 200) : 0;
      const igstAmount = intraState ? 0 : round2((taxableValue * l.gstRate) / 100);
      return {
        lineNo: i + 1,
        sku: l.sku ?? null,
        description: l.description,
        hsnCode: l.hsnCode,
        quantity: l.quantity,
        unit: l.unit ?? 'PCS',
        unitPrice: l.unitPrice,
        gstRate: l.gstRate,
        taxableValue,
        cgstAmount,
        sgstAmount,
        igstAmount,
        lineTotal: round2(taxableValue + cgstAmount + sgstAmount + igstAmount),
      };
    });

    const grandTotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const kind = input.buyerId ? 'B2B_INVOICE' : 'RETAIL_SALE';
    const invoiceNumber =
      input.invoiceNumber ??
      `${kind === 'B2B_INVOICE' ? 'GST' : 'POS'}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const invoiceDate = input.invoiceDate ?? new Date().toISOString().slice(0, 10);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ id: string }>(
        `
        INSERT INTO transactions_ledger (
          kind, sender_id, receiver_id, retail_customer, invoice_number,
          amount, balance_remaining, payment_status, due_date, invoice_date, place_of_supply
        ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'DUE', $7, $8, $9)
        RETURNING id
        `,
        [
          kind,
          input.sellerId,
          input.buyerId ?? null,
          input.retailCustomer ?? null,
          invoiceNumber,
          grandTotal,
          input.dueDate ?? null,
          invoiceDate,
          placeOfSupply,
        ],
      );
      const transactionId = rows[0].id;

      for (const l of lines) {
        await client.query(
          `
          INSERT INTO invoice_line_items (
            transaction_id, line_no, sku, description, hsn_code, quantity, unit,
            unit_price, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          `,
          [
            transactionId,
            l.lineNo,
            l.sku,
            l.description,
            l.hsnCode,
            l.quantity,
            l.unit,
            l.unitPrice,
            l.taxableValue,
            l.gstRate,
            l.cgstAmount,
            l.sgstAmount,
            l.igstAmount,
            l.lineTotal,
          ],
        );
      }

      await client.query('COMMIT');

      return {
        transactionId,
        invoiceNumber,
        invoiceDate,
        kind,
        sellerId: input.sellerId,
        buyerId: input.buyerId ?? null,
        retailCustomer: input.retailCustomer ?? null,
        placeOfSupply,
        supplyType: intraState ? 'INTRA_STATE' : 'INTER_STATE',
        taxableTotal: round2(lines.reduce((s, l) => s + l.taxableValue, 0)),
        cgstTotal: round2(lines.reduce((s, l) => s + l.cgstAmount, 0)),
        sgstTotal: round2(lines.reduce((s, l) => s + l.sgstAmount, 0)),
        igstTotal: round2(lines.reduce((s, l) => s + l.igstAmount, 0)),
        grandTotal,
        lines,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getInvoice(transactionId: string): Promise<GstInvoice> {
    const { rows } = await this.db.query<{
      id: string;
      kind: 'B2B_INVOICE' | 'RETAIL_SALE';
      sender_id: string;
      receiver_id: string | null;
      retail_customer: string | null;
      invoice_number: string;
      invoice_date: Date | null;
      created_at: Date;
      place_of_supply: string | null;
      sender_state: string | null;
    }>(
      `
      SELECT tl.*, su.state_code AS sender_state
      FROM transactions_ledger tl JOIN users su ON su.id = tl.sender_id
      WHERE tl.id = $1
      `,
      [transactionId],
    );
    const header = rows[0];
    if (!header) throw new Error('invoice not found');

    const { rows: lineRows } = await this.db.query<{
      line_no: number;
      sku: string | null;
      description: string;
      hsn_code: string;
      quantity: string;
      unit: string;
      unit_price: string;
      taxable_value: string;
      gst_rate: string;
      cgst_amount: string;
      sgst_amount: string;
      igst_amount: string;
      line_total: string;
    }>(`SELECT * FROM invoice_line_items WHERE transaction_id = $1 ORDER BY line_no`, [transactionId]);
    if (lineRows.length === 0) throw new Error('invoice has no GST line items (created outside the GST flow)');

    const lines: GstInvoiceLine[] = lineRows.map((r) => ({
      lineNo: r.line_no,
      sku: r.sku,
      description: r.description,
      hsnCode: r.hsn_code,
      quantity: Number(r.quantity),
      unit: r.unit,
      unitPrice: Number(r.unit_price),
      gstRate: Number(r.gst_rate),
      taxableValue: Number(r.taxable_value),
      cgstAmount: Number(r.cgst_amount),
      sgstAmount: Number(r.sgst_amount),
      igstAmount: Number(r.igst_amount),
      lineTotal: Number(r.line_total),
    }));

    const placeOfSupply = header.place_of_supply ?? header.sender_state ?? '';
    const igstTotal = round2(lines.reduce((s, l) => s + l.igstAmount, 0));
    return {
      transactionId: header.id,
      invoiceNumber: header.invoice_number,
      invoiceDate: (header.invoice_date ?? header.created_at).toISOString().slice(0, 10),
      kind: header.kind,
      sellerId: header.sender_id,
      buyerId: header.receiver_id,
      retailCustomer: header.retail_customer,
      placeOfSupply,
      supplyType: igstTotal > 0 ? 'INTER_STATE' : 'INTRA_STATE',
      taxableTotal: round2(lines.reduce((s, l) => s + l.taxableValue, 0)),
      cgstTotal: round2(lines.reduce((s, l) => s + l.cgstAmount, 0)),
      sgstTotal: round2(lines.reduce((s, l) => s + l.sgstAmount, 0)),
      igstTotal,
      grandTotal: round2(lines.reduce((s, l) => s + l.lineTotal, 0)),
      lines,
    };
  }

  /**
   * Filing-ready GSTR-1 JSON for a month ('YYYY-MM'): B2B section grouped by
   * counterparty GSTIN with rate-wise items, B2CS rate-wise retail aggregate,
   * and the HSN summary (table 12). Field names follow the GSTN schema.
   */
  async gstr1Export(supplierId: string, period: string): Promise<Record<string, unknown>> {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period must be YYYY-MM');
    const monthStart = `${period}-01`;
    const fp = `${period.slice(5, 7)}${period.slice(0, 4)}`; // MMYYYY

    const { rows: seller } = await this.db.query<{ gstin: string | null }>(
      `SELECT gstin FROM users WHERE id = $1`,
      [supplierId],
    );
    if (!seller[0]?.gstin) throw new Error('supplier is not GST registered');

    const { rows: b2bRows } = await this.db.query<{
      buyer_gstin: string | null;
      buyer_name: string | null;
      invoice_number: string;
      invoice_date: Date;
      invoice_value: string;
      place_of_supply: string | null;
      gst_rate: string;
      taxable_value: string;
      cgst: string;
      sgst: string;
      igst: string;
    }>(
      `SELECT * FROM v_gstr1_b2b WHERE supplier_id = $1 AND period_month = $2::date
       ORDER BY buyer_gstin, invoice_number, gst_rate`,
      [supplierId, monthStart],
    );

    // Group: counterparty GSTIN → invoices → rate-wise items.
    const byCtin = new Map<string, { ctin: string; trade_name: string; inv: Map<string, Record<string, unknown>> }>();
    for (const r of b2bRows) {
      const ctin = r.buyer_gstin ?? 'UNREGISTERED';
      if (!byCtin.has(ctin)) byCtin.set(ctin, { ctin, trade_name: r.buyer_name ?? '', inv: new Map() });
      const group = byCtin.get(ctin)!;
      if (!group.inv.has(r.invoice_number)) {
        group.inv.set(r.invoice_number, {
          inum: r.invoice_number,
          idt: r.invoice_date.toISOString().slice(0, 10),
          val: Number(r.invoice_value),
          pos: r.place_of_supply ?? '',
          itms: [] as Record<string, number>[],
        });
      }
      (group.inv.get(r.invoice_number)!.itms as Record<string, number>[]).push({
        rt: Number(r.gst_rate),
        txval: Number(r.taxable_value),
        camt: Number(r.cgst),
        samt: Number(r.sgst),
        iamt: Number(r.igst),
      });
    }

    // B2CS: retail sales aggregated rate-wise for the month.
    const { rows: b2csRows } = await this.db.query<{
      gst_rate: string;
      taxable_value: string;
      cgst: string;
      sgst: string;
      igst: string;
    }>(
      `
      SELECT li.gst_rate, SUM(li.taxable_value) AS taxable_value,
             SUM(li.cgst_amount) AS cgst, SUM(li.sgst_amount) AS sgst, SUM(li.igst_amount) AS igst
      FROM transactions_ledger tl
      JOIN invoice_line_items li ON li.transaction_id = tl.id
      WHERE tl.sender_id = $1 AND tl.kind = 'RETAIL_SALE'
        AND date_trunc('month', COALESCE(tl.invoice_date, tl.created_at::date))::date = $2::date
      GROUP BY li.gst_rate ORDER BY li.gst_rate
      `,
      [supplierId, monthStart],
    );

    const { rows: hsnRows } = await this.db.query<{
      hsn_code: string;
      uqc: string;
      gst_rate: string;
      total_quantity: string;
      taxable_value: string;
      cgst: string;
      sgst: string;
      igst: string;
    }>(
      `SELECT * FROM v_gstr1_hsn WHERE supplier_id = $1 AND period_month = $2::date ORDER BY hsn_code, gst_rate`,
      [supplierId, monthStart],
    );

    const totals = [...b2bRows, ...b2csRows].reduce(
      (acc, r) => ({
        taxable: round2(acc.taxable + Number(r.taxable_value)),
        cgst: round2(acc.cgst + Number(r.cgst)),
        sgst: round2(acc.sgst + Number(r.sgst)),
        igst: round2(acc.igst + Number(r.igst)),
      }),
      { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
    );

    return {
      gstin: seller[0].gstin,
      fp,
      b2b: [...byCtin.values()].map((g) => ({
        ctin: g.ctin,
        trade_name: g.trade_name,
        inv: [...g.inv.values()],
      })),
      b2cs: b2csRows.map((r) => ({
        sply_ty: Number(r.igst) > 0 ? 'INTER' : 'INTRA',
        rt: Number(r.gst_rate),
        txval: Number(r.taxable_value),
        camt: Number(r.cgst),
        samt: Number(r.sgst),
        iamt: Number(r.igst),
      })),
      hsn: {
        data: hsnRows.map((r, i) => ({
          num: i + 1,
          hsn_sc: r.hsn_code,
          uqc: r.uqc,
          rt: Number(r.gst_rate),
          qty: Number(r.total_quantity),
          txval: Number(r.taxable_value),
          camt: Number(r.cgst),
          samt: Number(r.sgst),
          iamt: Number(r.igst),
        })),
      },
      summary: {
        total_taxable_value: totals.taxable,
        total_cgst: totals.cgst,
        total_sgst: totals.sgst,
        total_igst: totals.igst,
        total_tax: round2(totals.cgst + totals.sgst + totals.igst),
      },
    };
  }

  /** GSTR-3B table 3.1(a) summary: outward taxable supplies for the month. */
  async gstr3bSummary(supplierId: string, period: string): Promise<Record<string, number>> {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period must be YYYY-MM');
    const { rows } = await this.db.query<{
      taxable: string | null;
      cgst: string | null;
      sgst: string | null;
      igst: string | null;
    }>(
      `
      SELECT SUM(li.taxable_value) AS taxable, SUM(li.cgst_amount) AS cgst,
             SUM(li.sgst_amount) AS sgst, SUM(li.igst_amount) AS igst
      FROM transactions_ledger tl
      JOIN invoice_line_items li ON li.transaction_id = tl.id
      WHERE tl.sender_id = $1 AND tl.kind IN ('B2B_INVOICE', 'RETAIL_SALE')
        AND date_trunc('month', COALESCE(tl.invoice_date, tl.created_at::date))::date = ($2 || '-01')::date
      `,
      [supplierId, period],
    );
    const r = rows[0];
    return {
      outward_taxable_value: Number(r?.taxable ?? 0),
      cgst: Number(r?.cgst ?? 0),
      sgst: Number(r?.sgst ?? 0),
      igst: Number(r?.igst ?? 0),
      total_tax: round2(Number(r?.cgst ?? 0) + Number(r?.sgst ?? 0) + Number(r?.igst ?? 0)),
    };
  }

  private async loadParty(userId: string): Promise<{ gstin: string | null; state_code: string | null }> {
    const { rows } = await this.db.query<{ gstin: string | null; state_code: string | null }>(
      `SELECT gstin, state_code FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows[0]) throw new Error('party not found');
    return rows[0];
  }
}
