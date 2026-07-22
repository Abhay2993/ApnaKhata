/**
 * ApnaKhata — Offline-first sync routes
 * -------------------------------------
 * The device outbox lands here. `push` applies a batch of client-generated
 * operations idempotently (replays return DUPLICATE with the original ref);
 * `pull` returns everything newer than the device's cursor. See
 * services/SyncService for the CRDT reasoning.
 */

import { Router } from 'express';

import { SyncService } from '../services/SyncService';
import { requireUser, wrap } from './middleware';

export function syncRoutes(sync: SyncService): Router {
  const r = Router();

  r.post(
    '/sync/push',
    requireUser,
    wrap(async (req, res) => {
      const { deviceId, operations } = req.body ?? {};
      if (!deviceId || typeof deviceId !== 'string') throw new Error('deviceId is required');
      if (!Array.isArray(operations) || operations.length === 0) throw new Error('operations must be a non-empty array');
      if (operations.length > 500) throw new Error('operations batch cannot exceed 500');
      res.json(await sync.push(req.userId as string, deviceId, operations));
    }),
  );

  r.get(
    '/sync/pull',
    requireUser,
    wrap(async (req, res) => {
      const since = req.query.since ? Number(req.query.since) : 0;
      if (Number.isNaN(since) || since < 0) throw new Error('since must be a non-negative number');
      res.json(await sync.pull(req.userId as string, since));
    }),
  );

  return r;
}
