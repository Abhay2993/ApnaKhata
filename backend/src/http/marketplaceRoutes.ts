/**
 * ApnaKhata — Marketplace & Integrations routes
 * ---------------------------------------------
 * Dealer discovery + catalog + ordering, plus billing-system integration
 * management and the live-inventory feed. The external sale webhook itself is
 * NOT here — it authenticates with its own integration key + HMAC (not the
 * service key), so it is mounted separately in server.ts.
 */

import { RequestHandler, Router } from 'express';

import { DealerDirectoryService } from '../services/DealerDirectoryService';
import { IntegrationService } from '../services/IntegrationService';
import { PurchaseOrderService } from '../services/PurchaseOrderService';
import { SchemeService } from '../services/SchemeService';
import { inventoryEvents } from '../events/InventoryEvents';
import { requireUser, wrap } from './middleware';

/**
 * Server-Sent Events stream of live inventory updates. Mounted OUTSIDE the /v1
 * service-key guard (see server.ts) because EventSource can't send headers —
 * it authenticates via `?apiKey=&userId=` query params (or headers for native
 * clients). Each client only receives its own owner's updates.
 */
export function liveInventoryStreamHandler(serviceApiKey: string): RequestHandler {
  return (req, res) => {
    const apiKey = req.header('x-api-key') ?? (req.query.apiKey as string | undefined);
    const userId = req.header('x-user-id') ?? (req.query.userId as string | undefined);
    if (apiKey !== serviceApiKey) {
      res.status(401).json({ message: 'invalid or missing api key' });
      return;
    }
    if (!userId) {
      res.status(401).json({ message: 'missing user id' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: ready\ndata: {"ownerId":"${userId}"}\n\n`);

    const unsubscribe = inventoryEvents.subscribe((update) => {
      if (update.ownerId === userId) {
        res.write(`event: inventory\ndata: ${JSON.stringify(update)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  };
}

export interface MarketplaceServices {
  dealers: DealerDirectoryService;
  purchaseOrders: PurchaseOrderService;
  integrations: IntegrationService;
  schemes: SchemeService;
}

export function marketplaceRoutes(s: MarketplaceServices): Router {
  const r = Router();

  // --- Dealer discovery (shopkeeper) --------------------------------------
  r.get(
    '/dealers/search',
    requireUser,
    wrap(async (req, res) => {
      res.json(
        await s.dealers.searchDealers({
          query: req.query.q ? String(req.query.q) : undefined,
          category: req.query.category ? String(req.query.category) : undefined,
          city: req.query.city ? String(req.query.city) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        }),
      );
    }),
  );

  r.get(
    '/dealers/categories',
    requireUser,
    wrap(async (_req, res) => {
      res.json(await s.dealers.listCategories());
    }),
  );

  r.get(
    '/dealers/:id/catalog',
    requireUser,
    wrap(async (req, res) => {
      res.json(
        await s.dealers.getCatalog(req.params.id, {
          category: req.query.category ? String(req.query.category) : undefined,
          query: req.query.q ? String(req.query.q) : undefined,
        }),
      );
    }),
  );

  // --- Catalog management (dealer) ----------------------------------------
  r.put(
    '/dealers/catalog',
    requireUser,
    wrap(async (req, res) => {
      const item = await s.dealers.upsertCatalogItem(req.userId as string, req.body);
      res.status(200).json(item);
    }),
  );

  r.put(
    '/dealers/catalog/bulk',
    requireUser,
    wrap(async (req, res) => {
      const count = await s.dealers.bulkUpsertCatalog(req.userId as string, req.body?.items ?? []);
      res.json({ upserted: count });
    }),
  );

  // --- Scheme-applied price quote (shopkeeper) ----------------------------
  r.post(
    '/dealers/:id/quote',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.schemes.applyToCart(req.params.id, req.body?.lines ?? []));
    }),
  );

  // --- Order from a dealer's catalog, with schemes applied (shopkeeper) ----
  r.post(
    '/purchase-orders/from-catalog',
    requireUser,
    wrap(async (req, res) => {
      const { dealerId, lines } = req.body;
      const quote = await s.schemes.applyToCart(dealerId, lines ?? []);
      const notes =
        quote.totalDiscount > 0
          ? `Schemes applied: saved ${quote.totalDiscount}${quote.totalFreeUnits ? `, ${quote.totalFreeUnits} free units` : ''}`
          : undefined;
      const order = await s.purchaseOrders.createOrder({
        buyerId: req.userId as string,
        supplierId: dealerId,
        submit: true,
        notes,
        items: quote.lines.map((l) => ({
          sku: l.sku,
          productName: l.productName,
          unit: l.unit,
          quantity: l.totalQty,
          unitPrice: l.effectiveUnitPrice,
          source: 'MANUAL' as const,
        })),
      });
      res.status(201).json({ ...order, schemeSummary: quote });
    }),
  );

  // --- Trade schemes (dealer) ---------------------------------------------
  r.post(
    '/dealers/schemes',
    requireUser,
    wrap(async (req, res) => {
      res.status(201).json(await s.schemes.createScheme(req.userId as string, req.body));
    }),
  );

  r.get(
    '/dealers/schemes',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.schemes.listSchemes(req.userId as string));
    }),
  );

  r.post(
    '/dealers/schemes/:id/deactivate',
    requireUser,
    wrap(async (req, res) => {
      await s.schemes.deactivate(req.userId as string, req.params.id);
      res.status(204).end();
    }),
  );

  // --- Billing integrations (shopkeeper) ----------------------------------
  r.post(
    '/integrations',
    requireUser,
    wrap(async (req, res) => {
      const { name, source } = req.body;
      // Secret is returned exactly once, here.
      res.status(201).json(await s.integrations.register(req.userId as string, name, source));
    }),
  );

  r.get(
    '/integrations',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.integrations.list(req.userId as string));
    }),
  );

  // --- Live inventory (poll) ----------------------------------------------
  r.get(
    '/inventory/live',
    requireUser,
    wrap(async (req, res) => {
      res.json(await s.integrations.getLiveInventory(req.userId as string));
    }),
  );

  // NOTE: the live SSE stream (/v1/inventory/live/stream) is mounted separately
  // in server.ts, before the service-key guard — see liveInventoryStreamHandler.

  return r;
}
