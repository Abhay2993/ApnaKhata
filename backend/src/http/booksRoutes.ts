/**
 * ApnaKhata — Books & compliance routes
 * -------------------------------------
 * Auto-accounting (P&L, balance sheet), the CA marketplace, and GST-notice
 * handling — the "system of record" surface.
 */

import { Router } from 'express';

import { AccountingService } from '../services/AccountingService';
import { CaMarketplaceService } from '../services/CaMarketplaceService';
import { GstNoticeService } from '../services/GstNoticeService';
import { requireUser, wrap } from './middleware';

export interface BooksServices {
  accounting: AccountingService;
  cas: CaMarketplaceService;
  notices: GstNoticeService;
}

export function booksRoutes(s: BooksServices): Router {
  const r = Router();

  // --- Auto-accounting -----------------------------------------------------
  r.get(
    '/accounting/pnl',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.accounting.profitAndLoss(req.userId as string, req.query.from as string, req.query.to as string));
    }),
  );

  r.get(
    '/accounting/balance-sheet',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.accounting.balanceSheet(req.userId as string, req.query.asOf as string));
    }),
  );

  // --- CA marketplace ------------------------------------------------------
  r.get(
    '/cas',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.cas.listCas({ specialization: req.query.specialization as string, city: req.query.city as string }));
    }),
  );

  r.post(
    '/cas/:id/engage',
    requireUser,
    wrap(async (req, res) => {
      const { serviceType, notes, noticeId } = req.body ?? {};
      if (!serviceType) throw new Error('serviceType is required');
      res.status(201).json(await s.cas.engage(req.userId as string, req.params.id, { serviceType, notes, noticeId }));
    }),
  );

  r.get(
    '/cas/engagements',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.cas.listEngagements(req.userId as string));
    }),
  );

  // --- GST notices ---------------------------------------------------------
  r.post(
    '/gst-notices',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.notices.createNotice(req.userId as string, req.body ?? {}));
    }),
  );

  r.get(
    '/gst-notices',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.notices.listNotices(req.userId as string));
    }),
  );

  r.post(
    '/gst-notices/:id/draft',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.notices.draftResponse(req.userId as string, req.params.id));
    }),
  );

  r.post(
    '/gst-notices/:id/assign',
    requireUser,
    wrap(async (req, res) => {
      const { caId } = req.body ?? {};
      if (!caId) throw new Error('caId is required');
      res.status(201).json(await s.notices.assignToCa(req.userId as string, req.params.id, caId));
    }),
  );

  r.post(
    '/gst-notices/:id/status',
    requireUser,
    wrap(async (req, res) => {
      const { status } = req.body ?? {};
      res.json(await s.notices.setStatus(req.userId as string, req.params.id, status));
    }),
  );

  return r;
}
