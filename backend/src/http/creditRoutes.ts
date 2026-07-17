/**
 * ApnaKhata — Credit & Demand routes
 * ----------------------------------
 * Credit score evaluation and the distributor-side demand rollup.
 */

import { Router } from 'express';

import { CreditScoreEvaluator } from '../services/CreditScoreEvaluator';
import { DistributorDemandService } from '../services/DistributorDemandService';
import { requireUser, wrap } from './middleware';

export interface CreditServices {
  creditScore: CreditScoreEvaluator;
  demand: DistributorDemandService;
}

export function creditRoutes(s: CreditServices): Router {
  const r = Router();

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

  return r;
}
