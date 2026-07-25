/**
 * ApnaKhata — Analytics routes
 * ----------------------------
 * Profit/margin intelligence and the business-health score.
 */

import { Router } from 'express';

import { AnalyticsService } from '../services/AnalyticsService';
import { PeerBenchmarkService } from '../services/PeerBenchmarkService';
import { requireUser, wrap } from './middleware';

export function analyticsRoutes(analytics: AnalyticsService, benchmarks: PeerBenchmarkService): Router {
  const r = Router();

  r.get(
    '/analytics/benchmarks',
    requireUser,
    wrap(async (req, res) => {
      res.json(await benchmarks.getBenchmarks(req.userId as string));
    }),
  );

  r.get(
    '/analytics/profit',
    requireUser,
    wrap(async (req, res) => {
      const windowDays = req.query.windowDays ? Number(req.query.windowDays) : undefined;
      res.json(await analytics.getProfitAnalytics(req.userId as string, windowDays));
    }),
  );

  r.get(
    '/analytics/health',
    requireUser,
    wrap(async (req, res) => {
      res.json(await analytics.getBusinessHealth(req.userId as string));
    }),
  );

  return r;
}
