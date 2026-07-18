/**
 * ApnaKhata — GSTR-2B Input Tax Credit Reconciliation
 * ---------------------------------------------------
 * The biggest ITC leak for shopkeepers is a purchase invoice that doesn't match
 * what the supplier actually filed (or that the supplier never filed at all).
 * This matches the buyer's purchase book (their inward B2B invoices, with GST
 * from invoice_line_items) against GSTR-2B (as filed by suppliers, imported
 * from the GST portal / GSP into gstr2b_records) and classifies every line:
 *
 *   MATCHED           in both, amounts agree → claim ITC with confidence
 *   MISMATCH          in both, amounts differ → correct before claiming
 *   MISSING_IN_2B     in the book, not filed by supplier → ITC AT RISK
 *   MISSING_IN_BOOKS  filed by supplier, not in the book → unrecorded purchase
 *
 * Match key: (supplier GSTIN, invoice number). Amounts compared within ₹1 to
 * absorb rounding.
 */

import { Pool } from 'pg';

const TOLERANCE = 1.0;

export type MatchStatus = 'MATCHED' | 'MISMATCH' | 'MISSING_IN_2B' | 'MISSING_IN_BOOKS';

export interface Gstr2bImportRecord {
  supplierGstin: string;
  supplierName?: string;
  invoiceNumber: string;
  invoiceDate: string; // ISO
  taxableValue: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
}

export interface ReconLine {
  status: MatchStatus;
  supplierGstin: string;
  supplierName: string | null;
  invoiceNumber: string;
  booksTax: number | null;
  filedTax: number | null;
  taxDelta: number | null; // filed − books
}

export interface ReconciliationResult {
  period: string;
  buyerGstin: string;
  counts: Record<MatchStatus, number>;
  itc: {
    eligible: number; // tax on MATCHED (safe to claim)
    atRisk: number; // tax on MISSING_IN_2B (in book, supplier hasn't filed)
    availableUnrecorded: number; // tax on MISSING_IN_BOOKS (record to claim)
    mismatchDelta: number; // net filed − books on MISMATCH lines
  };
  lines: ReconLine[];
}

const tax = (c: number, s: number, i: number): number => Math.round((c + s + i) * 100) / 100;

export class Gstr2bReconciliationService {
  constructor(private readonly db: Pool) {}

  /** Import (upsert) GSTR-2B lines for a buyer + period ('MMYYYY'). */
  async importGstr2b(buyerGstin: string, period: string, records: Gstr2bImportRecord[]): Promise<number> {
    if (!/^\d{6}$/.test(period)) throw new Error('period must be MMYYYY');
    for (const rec of records) {
      await this.db.query(
        `
        INSERT INTO gstr2b_records (buyer_gstin, supplier_gstin, supplier_name, invoice_number,
                                    invoice_date, period, taxable_value, cgst, sgst, igst)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (buyer_gstin, supplier_gstin, invoice_number, period) DO UPDATE SET
          supplier_name = EXCLUDED.supplier_name, invoice_date = EXCLUDED.invoice_date,
          taxable_value = EXCLUDED.taxable_value, cgst = EXCLUDED.cgst,
          sgst = EXCLUDED.sgst, igst = EXCLUDED.igst, imported_at = now()
        `,
        [
          buyerGstin, rec.supplierGstin, rec.supplierName ?? null, rec.invoiceNumber, rec.invoiceDate,
          period, rec.taxableValue, rec.cgst ?? 0, rec.sgst ?? 0, rec.igst ?? 0,
        ],
      );
    }
    return records.length;
  }

  /** Reconcile a shopkeeper's purchases against GSTR-2B for a period ('MMYYYY'). */
  async reconcile(shopkeeperId: string, period: string): Promise<ReconciliationResult> {
    if (!/^\d{6}$/.test(period)) throw new Error('period must be MMYYYY');

    const { rows: userRows } = await this.db.query<{ gstin: string | null }>(
      `SELECT gstin FROM users WHERE id = $1`,
      [shopkeeperId],
    );
    const buyerGstin = userRows[0]?.gstin;
    if (!buyerGstin) throw new Error('shopkeeper is not GST registered');

    const monthStart = `${period.slice(2)}-${period.slice(0, 2)}-01`; // MMYYYY → YYYY-MM-01

    // Buyer's purchase book: inward B2B invoices with GST from line items.
    const { rows: books } = await this.db.query<{
      supplier_gstin: string | null;
      supplier_name: string;
      invoice_number: string;
      tax: string | null;
    }>(
      `
      SELECT su.gstin AS supplier_gstin, su.business_name AS supplier_name, tl.invoice_number,
             SUM(li.cgst_amount + li.sgst_amount + li.igst_amount) AS tax
      FROM transactions_ledger tl
      JOIN users su ON su.id = tl.sender_id
      JOIN invoice_line_items li ON li.transaction_id = tl.id
      WHERE tl.receiver_id = $1 AND tl.kind = 'B2B_INVOICE'
        AND date_trunc('month', COALESCE(tl.invoice_date, tl.created_at::date))::date = $2::date
      GROUP BY su.gstin, su.business_name, tl.invoice_number
      `,
      [shopkeeperId, monthStart],
    );

    const { rows: filed } = await this.db.query<{
      supplier_gstin: string;
      supplier_name: string | null;
      invoice_number: string;
      cgst: string;
      sgst: string;
      igst: string;
    }>(
      `SELECT supplier_gstin, supplier_name, invoice_number, cgst, sgst, igst
         FROM gstr2b_records WHERE buyer_gstin = $1 AND period = $2`,
      [buyerGstin, period],
    );

    const key = (g: string | null, n: string) => `${g ?? ''}::${n}`;
    const booksMap = new Map(books.map((b) => [key(b.supplier_gstin, b.invoice_number), b]));
    const filedMap = new Map(filed.map((f) => [key(f.supplier_gstin, f.invoice_number), f]));

    const lines: ReconLine[] = [];
    const counts: Record<MatchStatus, number> = { MATCHED: 0, MISMATCH: 0, MISSING_IN_2B: 0, MISSING_IN_BOOKS: 0 };
    const itc = { eligible: 0, atRisk: 0, availableUnrecorded: 0, mismatchDelta: 0 };

    // Walk the union of both sides.
    for (const k of new Set([...booksMap.keys(), ...filedMap.keys()])) {
      const b = booksMap.get(k);
      const f = filedMap.get(k);
      const booksTax = b ? Math.round(Number(b.tax ?? 0) * 100) / 100 : null;
      const filedTax = f ? tax(Number(f.cgst), Number(f.sgst), Number(f.igst)) : null;
      const supplierGstin = (b?.supplier_gstin ?? f?.supplier_gstin) as string;
      const supplierName = b?.supplier_name ?? f?.supplier_name ?? null;
      const invoiceNumber = b?.invoice_number ?? f?.invoice_number ?? '';

      let status: MatchStatus;
      if (b && f) {
        status = Math.abs((booksTax as number) - (filedTax as number)) <= TOLERANCE ? 'MATCHED' : 'MISMATCH';
        if (status === 'MATCHED') itc.eligible += filedTax as number;
        else itc.mismatchDelta += (filedTax as number) - (booksTax as number);
      } else if (b && !f) {
        status = 'MISSING_IN_2B';
        itc.atRisk += booksTax as number;
      } else {
        status = 'MISSING_IN_BOOKS';
        itc.availableUnrecorded += filedTax as number;
      }

      counts[status] += 1;
      lines.push({
        status,
        supplierGstin,
        supplierName,
        invoiceNumber,
        booksTax,
        filedTax,
        taxDelta: booksTax !== null && filedTax !== null ? Math.round((filedTax - booksTax) * 100) / 100 : null,
      });
    }

    lines.sort((a, b) => a.status.localeCompare(b.status) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      period,
      buyerGstin,
      counts,
      itc: {
        eligible: r2(itc.eligible),
        atRisk: r2(itc.atRisk),
        availableUnrecorded: r2(itc.availableUnrecorded),
        mismatchDelta: r2(itc.mismatchDelta),
      },
      lines,
    };
  }
}
