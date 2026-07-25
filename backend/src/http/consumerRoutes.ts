/**
 * ApnaKhata — Consumer graph routes (loyalty + ONDC storefront)
 * -------------------------------------------------------------
 * The third side of the network: the end consumer. Loyalty points on the
 * customer khata, and the kirana's inventory published to ONDC with orders
 * landing back as retail sales.
 */

import { Router } from 'express';

import { LoyaltyService } from '../services/LoyaltyService';
import { OndcService } from '../services/OndcService';
import { requireUser, wrap } from './middleware';

export interface ConsumerServices {
  loyalty: LoyaltyService;
  ondc: OndcService;
}

export function consumerRoutes(s: ConsumerServices): Router {
  const r = Router();

  // --- Loyalty -------------------------------------------------------------
  r.get(
    '/loyalty',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.loyalty.listForOwner(req.userId as string));
    }),
  );

  r.get(
    '/loyalty/:customerId',
    requireUser,
    wrap(async (req, res) => {
      res.json((await s.loyalty.getAccount(req.userId as string, req.params.customerId)) ?? { status: 'NONE' });
    }),
  );

  r.post(
    '/loyalty/:customerId/redeem',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.loyalty.redeem(req.userId as string, req.params.customerId, Number(req.body?.points)));
    }),
  );

  // --- ONDC storefront -----------------------------------------------------
  r.post(
    '/ondc/publish',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.ondc.publishCatalog(req.userId as string));
    }),
  );

  r.get(
    '/ondc/listings',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.ondc.getListings(req.userId as string));
    }),
  );

  r.post(
    '/ondc/orders',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.ondc.receiveOrder(req.userId as string, req.body ?? {}));
    }),
  );

  r.post(
    '/ondc/orders/simulate',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.ondc.simulateOrder(req.userId as string));
    }),
  );

  r.get(
    '/ondc/orders',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.ondc.listOrders(req.userId as string));
    }),
  );

  return r;
}
