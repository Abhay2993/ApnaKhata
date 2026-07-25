/**
 * ApnaKhata — Supply-chain finance routes
 * ---------------------------------------
 * Account Aggregator consent + cash-flow pull, and the OCEN-style loan flow:
 * anchor relationship → underwrite → apply (collect competing offers) → accept
 * (disburse, settling the anchor's dues via FIFO).
 */

import { Router } from 'express';

import { AccountAggregatorService } from '../services/AccountAggregatorService';
import { CreditLineService } from '../services/CreditLineService';
import { SupplyChainFinanceService } from '../services/SupplyChainFinanceService';
import { requireUser, wrap } from './middleware';

export interface FinanceServices {
  aa: AccountAggregatorService;
  scf: SupplyChainFinanceService;
  creditLine: CreditLineService;
}

export function financeRoutes(s: FinanceServices): Router {
  const r = Router();

  // --- Account Aggregator --------------------------------------------------
  r.post(
    '/aa/consents',
    requireUser,
    wrap(async (req, res) => {
      const months = req.body?.months !== undefined ? Number(req.body.months) : undefined;
      res.status(201).json(await s.aa.createConsent(req.userId as string, months));
    }),
  );

  r.post(
    '/aa/consents/:id/approve',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.aa.approveConsent(req.userId as string, req.params.id));
    }),
  );

  r.post(
    '/aa/consents/:id/fetch',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.aa.fetchFinancials(req.userId as string, req.params.id));
    }),
  );

  r.get(
    '/aa/consents',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.aa.listConsents(req.userId as string));
    }),
  );

  r.get(
    '/aa/summary',
    requireUser,
    wrap(async (req, res) => {
      res.json((await s.aa.latestSummary(req.userId as string)) ?? { status: 'NONE' });
    }),
  );

  // --- Supply-chain finance (OCEN) -----------------------------------------
  r.get(
    '/scf/anchor/:anchorId',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.scf.getAnchorRelationship(req.userId as string, req.params.anchorId));
    }),
  );

  r.post(
    '/scf/underwrite',
    requireUser,
    wrap(async (req, res) => {
      const { anchorId, amountRequested, tenureDays } = req.body ?? {};
      res.json(
        await s.scf.underwrite(req.userId as string, {
          anchorId,
          amountRequested: Number(amountRequested),
          tenureDays: tenureDays ? Number(tenureDays) : 90,
        }),
      );
    }),
  );

  r.post(
    '/scf/applications',
    requireUser,
    wrap(async (req, res) => {
      const { anchorId, amountRequested, tenureDays, purpose, aaConsentId } = req.body ?? {};
      res.status(201).json(
        await s.scf.createApplication(req.userId as string, {
          anchorId,
          amountRequested: Number(amountRequested),
          tenureDays: tenureDays ? Number(tenureDays) : undefined,
          purpose,
          aaConsentId,
        }),
      );
    }),
  );

  r.get(
    '/scf/applications',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.scf.listApplications(req.userId as string));
    }),
  );

  r.get(
    '/scf/applications/:id',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.scf.getApplication(req.userId as string, req.params.id));
    }),
  );

  r.post(
    '/scf/applications/:id/accept',
    requireUser,
    wrap(async (req, res) => {
      const { offerId } = req.body ?? {};
      if (!offerId) throw new Error('offerId is required');
      res.status(201).json(await s.scf.acceptOffer(req.userId as string, req.params.id, offerId));
    }),
  );

  // --- Credit line on UPI --------------------------------------------------
  r.get(
    '/credit-line',
    requireUser,
    wrap(async (req, res) => {
      const line = await s.creditLine.getLine(req.userId as string);
      if (line) { res.json(line); return; }
      res.json({ status: 'NONE', eligibility: await s.creditLine.eligibility(req.userId as string) });
    }),
  );

  r.post(
    '/credit-line/issue',
    requireUser,
    wrap(async (req, res) => {
      const requested = req.body?.limit !== undefined ? Number(req.body.limit) : undefined;
      res.status(201).json(await s.creditLine.issue(req.userId as string, requested));
    }),
  );

  r.post(
    '/credit-line/pay',
    requireUser,
    wrap(async (req, res) => {
      const { payeeId, payeeName, amount, upiRef } = req.body ?? {};
      res.status(201).json(
        await s.creditLine.payViaUpi(req.userId as string, { payeeId, payeeName, amount: Number(amount), upiRef }),
      );
    }),
  );

  r.post(
    '/credit-line/repay',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.creditLine.repay(req.userId as string, Number(req.body?.amount)));
    }),
  );

  r.get(
    '/credit-line/transactions',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.creditLine.listTransactions(req.userId as string));
    }),
  );

  return r;
}
