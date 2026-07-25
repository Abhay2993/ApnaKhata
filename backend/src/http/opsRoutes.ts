/**
 * ApnaKhata — Daily-operations routes
 * -----------------------------------
 * The quick-win features that ride on existing data: cash-drawer
 * reconciliation, UPI AutoPay mandates, liquidity-timed reminder suggestions,
 * and the festival demand planner.
 */

import { Router } from 'express';

import { CashDrawerService } from '../services/CashDrawerService';
import { FestivalPlannerService } from '../services/FestivalPlannerService';
import { SmartReminderService } from '../services/SmartReminderService';
import { UpiMandateService } from '../services/UpiMandateService';
import { requireUser, wrap } from './middleware';

export interface OpsServices {
  cashDrawer: CashDrawerService;
  mandates: UpiMandateService;
  smartReminders: SmartReminderService;
  festivals: FestivalPlannerService;
}

export function opsRoutes(s: OpsServices): Router {
  const r = Router();

  // --- Cash drawer ---------------------------------------------------------
  r.post(
    '/cash-drawer/open',
    requireUser,
    wrap(async (req, res) => {
      const { openingBalance, date } = req.body ?? {};
      res.status(201).json(await s.cashDrawer.open(req.userId as string, Number(openingBalance ?? 0), date));
    }),
  );

  r.post(
    '/cash-drawer/movements',
    requireUser,
    wrap(async (req, res) => {
      const { direction, amount, reason, note, date } = req.body ?? {};
      if (direction !== 'IN' && direction !== 'OUT') throw new Error('direction must be IN or OUT');
      res.status(201).json(
        await s.cashDrawer.addMovement(req.userId as string, { direction, amount: Number(amount), reason, note, date }),
      );
    }),
  );

  r.post(
    '/cash-drawer/close',
    requireUser,
    wrap(async (req, res) => {
      const { countedClosing, date } = req.body ?? {};
      res.json(await s.cashDrawer.close(req.userId as string, Number(countedClosing), date));
    }),
  );

  r.get(
    '/cash-drawer/today',
    requireUser,
    wrap(async (req, res) => {
      const summary = await s.cashDrawer.getToday(req.userId as string, req.query.date ? String(req.query.date) : undefined);
      res.json(summary ?? { status: 'NOT_OPENED' });
    }),
  );

  // --- UPI AutoPay mandates ------------------------------------------------
  r.post(
    '/mandates',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.mandates.create(req.userId as string, req.body ?? {}));
    }),
  );

  r.post(
    '/mandates/:id/authorize',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.mandates.authorize(req.userId as string, req.params.id));
    }),
  );

  r.post(
    '/mandates/:id/status',
    requireUser,
    wrap(async (req, res) => {
      const { status } = req.body ?? {};
      if (status !== 'PAUSED' && status !== 'ACTIVE' && status !== 'REVOKED') {
        throw new Error('status must be PAUSED, ACTIVE or REVOKED');
      }
      res.json(await s.mandates.setStatus(req.userId as string, req.params.id, status));
    }),
  );

  r.post(
    '/mandates/:id/execute',
    requireUser,
    wrap(async (req, res) => {
      const amount = req.body?.amount !== undefined ? Number(req.body.amount) : undefined;
      res.status(201).json(await s.mandates.execute(req.userId as string, req.params.id, amount));
    }),
  );

  r.get(
    '/mandates',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.mandates.list(req.userId as string));
    }),
  );

  r.get(
    '/mandates/:id/executions',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.mandates.executions(req.userId as string, req.params.id));
    }),
  );

  // --- Liquidity-timed reminder suggestions (distributor) ------------------
  r.get(
    '/reminders/suggestions',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.smartReminders.getSuggestions(req.userId as string));
    }),
  );

  // --- Festival demand planner ---------------------------------------------
  r.get(
    '/festivals/plan',
    requireUser,
    wrap(async (req, res) => {
      const horizon = req.query.horizonDays ? Number(req.query.horizonDays) : undefined;
      res.json(await s.festivals.getPlan(req.userId as string, new Date(), horizon));
    }),
  );

  return r;
}
