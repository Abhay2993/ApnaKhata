/**
 * ApnaKhata — Fraud & trust graph routes
 * --------------------------------------
 * Trust score + fraud scan for the caller, network-wide ring detection, the
 * lender-facing per-entity trust lookup, and the case-triage workflow.
 */

import { Router } from 'express';

import { FraudGraphService } from '../services/FraudGraphService';
import { requireUser, wrap } from './middleware';

export function fraudRoutes(fraud: FraudGraphService): Router {
  const r = Router();

  r.get(
    '/fraud/scan',
    requireUser,
    wrap(async (req, res) => {
      res.json(await fraud.scan(req.userId as string));
    }),
  );

  r.get(
    '/fraud/rings',
    requireUser,
    wrap(async (_req, res) => {
      res.json(await fraud.detectRings());
    }),
  );

  r.get(
    '/fraud/alerts',
    requireUser,
    wrap(async (_req, res) => {
      res.json(await fraud.networkAlerts());
    }),
  );

  r.get(
    '/fraud/entity/:id',
    requireUser,
    wrap(async (req, res) => {
      res.json(await fraud.entityTrust(req.params.id));
    }),
  );

  r.get(
    '/fraud/cases',
    requireUser,
    wrap(async (req, res) => {
      res.json(await fraud.listCases(req.userId as string));
    }),
  );

  r.post(
    '/fraud/cases',
    requireUser,
    wrap(async (req, res) => {
      const { caseType, severity, subjectLabel, detail } = req.body ?? {};
      if (!caseType || !subjectLabel) throw new Error('caseType and subjectLabel are required');
      res.status(201).json(await fraud.raiseCase(req.userId as string, { caseType, severity, subjectLabel, detail }));
    }),
  );

  r.post(
    '/fraud/cases/:id/status',
    requireUser,
    wrap(async (req, res) => {
      const { status } = req.body ?? {};
      if (!['REVIEWING', 'CONFIRMED', 'DISMISSED'].includes(status)) throw new Error('status must be REVIEWING, CONFIRMED or DISMISSED');
      res.json(await fraud.resolveCase(req.userId as string, req.params.id, status));
    }),
  );

  return r;
}
