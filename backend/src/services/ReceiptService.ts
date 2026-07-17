/**
 * ApnaKhata — Receipt Service
 * ---------------------------
 * Turns a GST invoice into customer-facing artifacts:
 *
 *   renderEscPos()      — raw ESC/POS bytes for 58mm/80mm Bluetooth thermal
 *                         printers (init, alignment, bold, GST tax block,
 *                         native QR code with a UPI payment link, feed + cut).
 *   renderPdfBill()     — A4 PDF bill via the dependency-free SimplePdf writer.
 *   whatsappShareLink() — wa.me deep link with a prefilled bill summary; the
 *                         mobile app opens it to share the bill in one tap.
 */

import { Pool } from 'pg';

import { PdfLine, renderPdf } from '../pdf/SimplePdf';
import { GstInvoice, GstInvoiceService } from './GstInvoiceService';

export type PaperWidth = 32 | 48; // chars: 58mm ≈ 32, 80mm ≈ 48

// ESC/POS control sequences
const ESC = 0x1b;
const GS = 0x1d;
const INIT = [ESC, 0x40];
const ALIGN_LEFT = [ESC, 0x61, 0x00];
const ALIGN_CENTER = [ESC, 0x61, 0x01];
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
const DOUBLE_SIZE = [GS, 0x21, 0x11];
const NORMAL_SIZE = [GS, 0x21, 0x00];
const FEED_3 = [ESC, 0x64, 0x03];
const CUT = [GS, 0x56, 0x42, 0x00]; // partial cut with feed

const money = (n: number): string => `Rs ${n.toFixed(2)}`;

export class ReceiptService {
  constructor(
    private readonly db: Pool,
    private readonly invoices: GstInvoiceService,
    /** Public base URL used in shared links (e.g. https://api.apnakhata.in). */
    private readonly publicBaseUrl = process.env.APNAKHATA_PUBLIC_URL ?? 'https://api.apnakhata.in',
  ) {}

  /** Raw ESC/POS byte stream for a thermal printer. */
  async renderEscPos(transactionId: string, width: PaperWidth = 32): Promise<Buffer> {
    const invoice = await this.invoices.getInvoice(transactionId);
    const seller = await this.loadSeller(invoice.sellerId);
    const chunks: Buffer[] = [];
    const raw = (bytes: number[]) => chunks.push(Buffer.from(bytes));
    // Thermal firmwares expect single-byte encodings; strip anything wider.
    const text = (s: string) => chunks.push(Buffer.from(s.replace(/[^\x20-\x7E]/g, '?') + '\n', 'ascii'));
    const rule = () => text('-'.repeat(width));
    const row = (left: string, right: string) => {
      const space = Math.max(width - left.length - right.length, 1);
      text(left.slice(0, width - right.length - 1) + ' '.repeat(space) + right);
    };

    raw(INIT);
    raw(ALIGN_CENTER);
    raw(DOUBLE_SIZE);
    text(seller.business_name);
    raw(NORMAL_SIZE);
    if (seller.gstin) text(`GSTIN: ${seller.gstin}`);
    text(`${invoice.kind === 'RETAIL_SALE' ? 'Retail Bill' : 'Tax Invoice'}  ${invoice.invoiceNumber}`);
    text(invoice.invoiceDate);
    raw(ALIGN_LEFT);
    rule();

    for (const l of invoice.lines) {
      text(l.description.slice(0, width));
      row(`  ${l.quantity} ${l.unit} x ${l.unitPrice.toFixed(2)}`, money(l.taxableValue));
    }
    rule();

    row('Taxable', money(invoice.taxableTotal));
    if (invoice.cgstTotal > 0) row('CGST', money(invoice.cgstTotal));
    if (invoice.sgstTotal > 0) row('SGST', money(invoice.sgstTotal));
    if (invoice.igstTotal > 0) row('IGST', money(invoice.igstTotal));
    raw(BOLD_ON);
    row('TOTAL', money(invoice.grandTotal));
    raw(BOLD_OFF);
    rule();

    // UPI payment QR (native ESC/POS QR: model, size, EC level, store, print).
    const upiLink = this.upiLink(seller, invoice);
    if (upiLink) {
      raw(ALIGN_CENTER);
      text('Scan to pay via UPI');
      this.appendQr(chunks, upiLink);
    }

    raw(ALIGN_CENTER);
    text('Powered by ApnaKhata');
    raw(FEED_3);
    raw(CUT);
    return Buffer.concat(chunks);
  }

  /** A4 PDF bill (shareable / printable). */
  async renderPdfBill(transactionId: string): Promise<Buffer> {
    const invoice = await this.invoices.getInvoice(transactionId);
    const seller = await this.loadSeller(invoice.sellerId);
    const irn = await this.loadIrn(transactionId);
    const gold: [number, number, number] = [0.773, 0.627, 0.349];
    const slate: [number, number, number] = [0.42, 0.42, 0.42];
    const inr = (n: number) => `INR ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(n)}`;

    const lines: PdfLine[] = [
      { text: seller.business_name, size: 18, bold: true, color: gold },
      { text: seller.gstin ? `GSTIN: ${seller.gstin}` : 'Unregistered dealer', size: 10, color: slate },
      {
        text: `${invoice.kind === 'RETAIL_SALE' ? 'Retail Bill' : 'Tax Invoice'} ${invoice.invoiceNumber} · ${invoice.invoiceDate}`,
        size: 12,
        bold: true,
        gap: 10,
      },
      {
        text: `Billed to: ${invoice.retailCustomer ?? invoice.buyerId ?? ''} · Place of supply: ${invoice.placeOfSupply} (${invoice.supplyType.replace('_', '-').toLowerCase()})`,
        size: 10,
        color: slate,
      },
      { text: 'Items', size: 12, bold: true, gap: 12 },
    ];

    for (const l of invoice.lines) {
      lines.push({
        text: `${l.lineNo}. ${l.description}  [HSN ${l.hsnCode}]`,
        size: 10,
        gap: 4,
      });
      lines.push({
        text: `    ${l.quantity} ${l.unit} x ${inr(l.unitPrice)}  @ GST ${l.gstRate}%  =  ${inr(l.lineTotal)}`,
        size: 10,
        color: slate,
      });
    }

    lines.push({ text: 'Tax summary', size: 12, bold: true, gap: 12 });
    lines.push({ text: `Taxable value: ${inr(invoice.taxableTotal)}`, size: 10, gap: 2 });
    if (invoice.cgstTotal > 0) lines.push({ text: `CGST: ${inr(invoice.cgstTotal)}`, size: 10 });
    if (invoice.sgstTotal > 0) lines.push({ text: `SGST: ${inr(invoice.sgstTotal)}`, size: 10 });
    if (invoice.igstTotal > 0) lines.push({ text: `IGST: ${inr(invoice.igstTotal)}`, size: 10 });
    lines.push({ text: `Grand total: ${inr(invoice.grandTotal)}`, size: 13, bold: true, gap: 4 });

    if (irn) {
      lines.push({ text: 'E-invoice', size: 12, bold: true, gap: 12 });
      lines.push({ text: `IRN: ${irn.irn}`, size: 8, color: slate, gap: 2 });
      lines.push({ text: `Ack ${irn.ack_no} · ${irn.ack_date.toISOString()}`, size: 8, color: slate });
    }

    lines.push({ text: 'Generated by ApnaKhata', size: 8, color: slate, gap: 14 });
    return renderPdf(lines);
  }

  /**
   * wa.me deep link with a prefilled bill summary + PDF URL. Pass the
   * customer's phone (E.164 or 10-digit) or omit it to let the sender pick a
   * chat in WhatsApp.
   */
  async whatsappShareLink(transactionId: string, customerPhone?: string): Promise<{ url: string; message: string }> {
    const invoice = await this.invoices.getInvoice(transactionId);
    const seller = await this.loadSeller(invoice.sellerId);
    const inr = (n: number) =>
      new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);

    const message =
      `*${seller.business_name}*\n` +
      `${invoice.kind === 'RETAIL_SALE' ? 'Bill' : 'Tax Invoice'} ${invoice.invoiceNumber} (${invoice.invoiceDate})\n` +
      invoice.lines.map((l) => `• ${l.description} — ${l.quantity} ${l.unit} = ${inr(l.lineTotal)}`).join('\n') +
      `\nTotal: *${inr(invoice.grandTotal)}*\n` +
      `PDF: ${this.publicBaseUrl}/v1/bills/${transactionId}/pdf`;

    const digits = customerPhone?.replace(/[^\d]/g, '') ?? '';
    const phonePart = digits ? (digits.length === 10 ? `91${digits}` : digits) : '';
    return { url: `https://wa.me/${phonePart}?text=${encodeURIComponent(message)}`, message };
  }

  /** Native ESC/POS QR: model 2, module size 6, EC level M, store, print. */
  private appendQr(chunks: Buffer[], data: string): void {
    const payload = Buffer.from(data, 'ascii');
    const len = payload.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    chunks.push(Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00])); // model 2
    chunks.push(Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06])); // size 6
    chunks.push(Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31])); // EC level M
    chunks.push(Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30])); // store...
    chunks.push(payload);
    chunks.push(Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])); // ...print
    chunks.push(Buffer.from('\n', 'ascii'));
  }

  private upiLink(seller: SellerRow, invoice: GstInvoice): string | null {
    // VPA convention mirrors UpiCollectionService; sellers without a VPA on
    // file simply get no payment QR on the receipt.
    if (!seller.phone) return null;
    const params = new URLSearchParams({
      pa: `${seller.phone.replace(/[^\d]/g, '')}@upi`,
      pn: seller.business_name,
      am: invoice.grandTotal.toFixed(2),
      cu: 'INR',
      tn: `Bill ${invoice.invoiceNumber}`,
    });
    return `upi://pay?${params.toString()}`;
  }

  private async loadSeller(sellerId: string): Promise<SellerRow> {
    const { rows } = await this.db.query<SellerRow>(
      `SELECT business_name, gstin, phone, state_code FROM users WHERE id = $1`,
      [sellerId],
    );
    if (!rows[0]) throw new Error('seller not found');
    return rows[0];
  }

  private async loadIrn(
    transactionId: string,
  ): Promise<{ irn: string; ack_no: string; ack_date: Date } | null> {
    const { rows } = await this.db.query<{ irn: string; ack_no: string; ack_date: Date }>(
      `SELECT irn, ack_no, ack_date FROM einvoice_records WHERE transaction_id = $1 AND status = 'GENERATED'`,
      [transactionId],
    );
    return rows[0] ?? null;
  }
}

interface SellerRow {
  business_name: string;
  gstin: string | null;
  phone: string | null;
  state_code: string | null;
}
