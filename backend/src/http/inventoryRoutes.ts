/**
 * ApnaKhata — Inventory & Forecasting routes
 * ------------------------------------------
 * Purchase orders (incl. the mobile one-tap reorder), barcode scan flows,
 * batch/expiry operations, and multi-location stock — thin wrappers over the
 * services from migration 002. The paths under /purchase-orders, /inventory,
 * and /billing are exactly what mobile/src/api/client.ts targets.
 */

import { Router } from 'express';

import { BarcodeInventoryService } from '../services/BarcodeInventoryService';
import { BatchExpiryService } from '../services/BatchExpiryService';
import { PurchaseOrderService } from '../services/PurchaseOrderService';
import { WarehouseService } from '../services/WarehouseService';
import { requireUser, wrap } from './middleware';

export interface InventoryServices {
  purchaseOrders: PurchaseOrderService;
  barcodes: BarcodeInventoryService;
  expiry: BatchExpiryService;
  warehouse: WarehouseService;
}

export function inventoryRoutes(s: InventoryServices): Router {
  const r = Router();

  // --- Purchase orders -----------------------------------------------------
  r.post(
    '/purchase-orders/from-forecast',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.purchaseOrders.createFromForecast(req.body.inventoryId));
    }),
  );

  r.post(
    '/purchase-orders',
    requireUser,
    wrap(async (req, res) => {
      const { supplierId, items, notes, expectedDeliveryDate, submit } = req.body;
      const order = await s.purchaseOrders.createOrder({
        buyerId: req.userId as string,
        supplierId,
        items,
        notes,
        expectedDeliveryDate,
        submit,
      });
      res.status(201).json(order);
    }),
  );

  r.get(
    '/purchase-orders/:id',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.purchaseOrders.getOrder(req.params.id));
    }),
  );

  r.post(
    '/purchase-orders/:id/transition',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.purchaseOrders.transition(req.params.id, req.body.to));
    }),
  );

  r.post(
    '/purchase-orders/:id/receive',
    requireUser,
    wrap(async (req, res) => {
      const { locationId, dueDays } = req.body ?? {};
      res.json(await s.purchaseOrders.receive(req.params.id, locationId, dueDays));
    }),
  );

  // --- Barcode scan flows (mobile ScanScreen) ------------------------------
  r.get(
    '/inventory/barcode/:code',
    requireUser,
    wrap(async (req, res) => {
      const product = await s.barcodes.lookup(req.userId as string, req.params.code);
      res.json(product); // null body = unknown code; client shows "add it first"
    }),
  );

  r.post(
    '/inventory/barcode/assign',
    requireUser,
    wrap(async (req, res) => {
      await s.barcodes.assignBarcode(req.body.inventoryId, req.body.barcode);
      res.status(204).end();
    }),
  );

  r.post(
    '/inventory/stock-in',
    requireUser,
    wrap(async (req, res) => {
      const { barcode, quantity, batchNumber, expiryDate, locationId, unitCost } = req.body;
      const result = await s.barcodes.stockIn({
        ownerId: req.userId as string,
        barcode,
        quantity: Number(quantity),
        batchNumber,
        expiryDate,
        locationId,
        unitCost,
      });
      res.status(201).json(result);
    }),
  );

  r.post(
    '/billing/checkout',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.barcodes.sell(req.userId as string, req.body.lines));
    }),
  );

  // --- Batch & expiry ------------------------------------------------------
  r.get(
    '/inventory/expiry-alerts',
    requireUser,
    wrap(async (req, res) => {
      const withinDays = req.query.withinDays ? Number(req.query.withinDays) : undefined;
      res.json(await s.expiry.nearExpiry(req.userId as string, withinDays));
    }),
  );

  r.post(
    '/jobs/expiry-writeoff',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.expiry.writeOffExpired(req.userId as string, req.body?.asOf));
    }),
  );

  r.get(
    '/inventory/:id/batches',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.expiry.getBatchesForForecast(req.params.id));
    }),
  );

  // --- Locations & transfers -----------------------------------------------
  r.post(
    '/locations',
    requireUser,
    wrap(async (req, res) => {
      const { name, kind, address, isDefault } = req.body;
      const location = await s.warehouse.createLocation({
        ownerId: req.userId as string,
        name,
        kind,
        address,
        isDefault,
      });
      res.status(201).json(location);
    }),
  );

  r.get(
    '/locations',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.warehouse.listLocations(req.userId as string));
    }),
  );

  r.post(
    '/stock/transfer',
    requireUser,
    wrap(async (req, res) => {
      const { inventoryId, fromLocationId, toLocationId, quantity } = req.body;
      res.json(
        await s.warehouse.transferStock({
          inventoryId,
          fromLocationId,
          toLocationId,
          quantity: Number(quantity),
        }),
      );
    }),
  );

  r.get(
    '/stock/by-location',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.warehouse.stockByLocation(req.userId as string));
    }),
  );

  return r;
}
