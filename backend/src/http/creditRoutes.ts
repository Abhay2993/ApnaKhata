/**
 * ApnaKhata — Credit & Demand routes
 * ----------------------------------
 * Credit score evaluation and the distributor-side demand rollup.
 */

import { Router } from 'express';

import { BnplService, Tenure } from '../services/BnplService';
import { CreditHistoryService } from '../services/CreditHistoryService';
import { CreditPassportService } from '../services/CreditPassportService';
import { CreditScoreEvaluator } from '../services/CreditScoreEvaluator';
import { CreditSimulatorService } from '../services/CreditSimulatorService';
import { DashboardService } from '../services/DashboardService';
import { DistributorDemandService } from '../services/DistributorDemandService';
import { LenderSubmissionService } from '../services/LenderSubmissionService';
import { requireUser, wrap } from './middleware';

export interface CreditServices {
  creditScore: CreditScoreEvaluator;
  demand: DistributorDemandService;
  passports: CreditPassportService;
  simulator: CreditSimulatorService;
  history: CreditHistoryService;
  lenders: LenderSubmissionService;
  dashboard: DashboardService;
  bnpl: BnplService;
}

export function creditRoutes(s: CreditServices): Router {
  const r = Router();

  // --- Dashboard read model (one call for the home screen) ----------------
  r.get(
    '/dashboard',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.dashboard.getDashboard(req.userId as string));
    }),
  );

  /** Recompute and return the caller's credit profile. */
  r.get(
    '/credit/score',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.creditScore.evaluate(req.userId as string));
    }),
  );

  /** Record a forecast run for one inventory item (called after forecast.py). */
  r.post(
    '/demand/forecasts',
    requireUser,
    wrap(async (req, res) => {
      const {
        inventoryId,
        sku,
        dailyDemandMean,
        safetyStock,
        recommendedOrderQty,
        predictedStockoutDate,
        modelUsed,
      } = req.body;
      await s.demand.recordForecast({
        inventoryId,
        ownerId: req.userId as string,
        sku,
        dailyDemandMean: Number(dailyDemandMean),
        safetyStock: Number(safetyStock),
        recommendedOrderQty: Number(recommendedOrderQty),
        predictedStockoutDate: predictedStockoutDate ?? null,
        modelUsed,
      });
      res.status(204).end();
    }),
  );

  /** Distributor procurement view: aggregated retailer demand per SKU. */
  r.get(
    '/demand/aggregate',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.demand.getAggregatedDemand(req.userId as string));
    }),
  );

  r.get(
    '/demand/aggregate/:sku/retailers',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.demand.getRetailerBreakdown(req.userId as string, req.params.sku));
    }),
  );

  // --- Score history & trend ----------------------------------------------
  r.get(
    '/credit/history',
    requireUser,
    wrap(async (req, res) => {
      const days = req.query.days ? Number(req.query.days) : undefined;
      res.json(await s.history.getTrend(req.userId as string, days));
    }),
  );

  // --- What-if simulator --------------------------------------------------
  r.post(
    '/credit/simulate',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.simulator.simulate(req.userId as string, req.body ?? {}));
    }),
  );

  r.get(
    '/credit/suggestions',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.simulator.suggestions(req.userId as string));
    }),
  );

  // --- Signed Credit Passport ---------------------------------------------
  r.post(
    '/credit/passports',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.passports.issue(req.userId as string));
    }),
  );

  // Public verification: banks call this with no user identity, service key only.
  r.get(
    '/credit/passports/:id/verify',
    wrap(async (req, res) => {
      res.json(await s.passports.verify(req.params.id));
    }),
  );

  r.get(
    '/credit/passports/:id/pdf',
    wrap(async (req, res) => {
      const pdf = await s.passports.renderPdf(req.params.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="apnakhata-passport-${req.params.id}.pdf"`);
      res.end(pdf);
    }),
  );

  // Published platform public key for offline verification.
  r.get(
    '/credit/passports/public-key',
    wrap(async (_req, res) => {
      res.json(s.passports.getPublicKey());
    }),
  );

  // --- Direct lender submission -------------------------------------------
  r.post(
    '/credit/lender-submissions',
    requireUser,
    wrap(async (req, res) => {
      const { lender, requestedAmount, passportId } = req.body;
      const submission = await s.lenders.submit({
        userId: req.userId as string,
        lender,
        requestedAmount: Number(requestedAmount),
        passportId,
      });
      res.status(201).json(submission);
    }),
  );

  r.get(
    '/credit/lender-submissions',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.lenders.listForUser(req.userId as string));
    }),
  );

  // --- BNPL / working-capital financing -----------------------------------
  r.get(
    '/credit/bnpl/offer',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.bnpl.getOffer(req.userId as string));
    }),
  );

  r.post(
    '/credit/bnpl/quote',
    requireUser,
    wrap(async (req, res) => {
      const { invoiceId, tenureDays } = req.body;
      res.json(await s.bnpl.quoteInvoice(req.userId as string, invoiceId, Number(tenureDays) as Tenure));
    }),
  );

  r.post(
    '/credit/bnpl/finance',
    requireUser,
    wrap(async (req, res) => {
      const { invoiceId, tenureDays } = req.body;
      res.status(201).json(await s.bnpl.financeInvoice(req.userId as string, invoiceId, Number(tenureDays) as Tenure));
    }),
  );

  r.post(
    '/credit/bnpl/:id/repay',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.bnpl.repay(req.params.id, Number(req.body?.amount)));
    }),
  );

  r.get(
    '/credit/bnpl',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.bnpl.list(req.userId as string));
    }),
  );

  return r;
}
