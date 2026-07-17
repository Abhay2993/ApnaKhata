/**
 * ApnaKhata — Billing & Compliance routes
 * ---------------------------------------
 * GST invoicing + GSTR exports, e-invoicing (IRN), and receipt artifacts
 * (ESC/POS bytes, PDF bill, WhatsApp share link).
 */

import { Router } from 'express';

import { EInvoiceService } from '../services/EInvoiceService';
import { GstInvoiceService } from '../services/GstInvoiceService';
import { PaperWidth, ReceiptService } from '../services/ReceiptService';
import { requireUser, wrap } from './middleware';

export interface ComplianceServices {
  gst: GstInvoiceService;
  einvoice: EInvoiceService;
  receipts: ReceiptService;
}

export function complianceRoutes(s: ComplianceServices): Router {
  const r = Router();

  // --- GST invoicing -------------------------------------------------------
  r.post(
    '/gst/invoices',
    requireUser,
    wrap(async (req, res) => {
      const { buyerId, retailCustomer, invoiceNumber, invoiceDate, dueDate, lines } = req.body;
      const invoice = await s.gst.createInvoice({
        sellerId: req.userId as string,
        buyerId,
        retailCustomer,
        invoiceNumber,
        invoiceDate,
        dueDate,
        lines,
      });
      res.status(201).json(invoice);
    }),
  );

  r.get(
    '/gst/invoices/:id',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.gst.getInvoice(req.params.id));
    }),
  );

  // --- GSTR exports --------------------------------------------------------
  r.get(
    '/gst/gstr1',
    requireUser,
    wrap(async (req, res) => {
      const period = String(req.query.period ?? '');
      res.json(await s.gst.gstr1Export(req.userId as string, period));
    }),
  );

  r.get(
    '/gst/gstr3b',
    requireUser,
    wrap(async (req, res) => {
      const period = String(req.query.period ?? '');
      res.json(await s.gst.gstr3bSummary(req.userId as string, period));
    }),
  );

  // --- E-invoicing / IRN ---------------------------------------------------
  r.get(
    '/gst/einvoice/required',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.einvoice.isRequired(req.userId as string));
    }),
  );

  r.post(
    '/gst/invoices/:id/irn',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.einvoice.generateIrn(req.params.id));
    }),
  );

  r.post(
    '/gst/invoices/:id/irn/cancel',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.einvoice.cancelIrn(req.params.id, String(req.body?.reason ?? '')));
    }),
  );

  // --- Receipts ------------------------------------------------------------
  r.get(
    '/bills/:id/escpos',
    requireUser,
    wrap(async (req, res) => {
      const width = (Number(req.query.width) === 48 ? 48 : 32) as PaperWidth;
      const bytes = await s.receipts.renderEscPos(req.params.id, width);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="bill-${req.params.id}.escpos"`);
      res.end(bytes);
    }),
  );

  r.get(
    '/bills/:id/pdf',
    wrap(async (req, res) => {
      // Publicly fetchable (service key only) so WhatsApp recipients can open it.
      const pdf = await s.receipts.renderPdfBill(req.params.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="bill-${req.params.id}.pdf"`);
      res.end(pdf);
    }),
  );

  r.get(
    '/bills/:id/whatsapp-link',
    requireUser,
    wrap(async (req, res) => {
      const phone = req.query.phone ? String(req.query.phone) : undefined;
      res.json(await s.receipts.whatsappShareLink(req.params.id, phone));
    }),
  );

  return r;
}
