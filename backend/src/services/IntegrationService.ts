/**
 * ApnaKhata — Integration Service
 * -------------------------------
 * Connects external billing/POS/ERP systems (Tally, Vyapar, Marg, or any
 * custom counter software) to ApnaKhata so a consumer sale rung up there
 * decrements ApnaKhata inventory in real time — giving the shopkeeper a single
 * live stock view across every till.
 *
 * Security contract (per ARCHITECTURE §2.2): each integration has a public
 * api_key and a secret. Every webhook must carry:
 *   X-Integration-Key   the api_key
 *   X-Signature         hex HMAC-SHA256(secret, raw body)
 *   X-Timestamp         unix seconds, within ±5 min (replay window)
 *   X-Idempotency-Key   unique per event (exact-once processing)
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Pool } from 'pg';

import { inventoryEvents } from '../events/InventoryEvents';

const REPLAY_WINDOW_SECONDS = 300;

export interface IntegrationCredentials {
  id: string;
  name: string;
  source: string;
  apiKey: string;
  secret: string; // returned only at creation
}

export interface SaleLine {
  sku?: string;
  barcode?: string;
  quantity: number;
}

export interface SalePayload {
  lines: SaleLine[];
  externalRef?: string;
  soldAt?: string;
}

export interface WebhookHeaders {
  apiKey?: string;
  signature?: string;
  timestamp?: string;
  idempotencyKey?: string;
}

export interface IngestResult {
  status: 'PROCESSED' | 'DUPLICATE';
  applied: { sku: string; requested: number; consumed: number; shortBy: number; newStock: number }[];
}

export interface LiveInventoryRow {
  inventoryId: string;
  sku: string;
  productName: string;
  currentStock: number;
  unit: string;
  minimumThreshold: number;
  lastMovementAt: string | null;
  lastMovementDelta: number | null;
}

export class IntegrationService {
  constructor(private readonly db: Pool) {}

  /** Register a billing integration; the secret is returned once, here only. */
  async register(ownerId: string, name: string, source = 'CUSTOM'): Promise<IntegrationCredentials> {
    const apiKey = `ak_int_${randomBytes(12).toString('hex')}`;
    const secret = randomBytes(24).toString('hex');
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO api_integrations (owner_id, name, source, api_key, secret) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ownerId, name, source, apiKey, secret],
    );
    return { id: rows[0].id, name, source, apiKey, secret };
  }

  async list(ownerId: string): Promise<Omit<IntegrationCredentials, 'secret'>[]> {
    const { rows } = await this.db.query<{ id: string; name: string; source: string; api_key: string }>(
      `SELECT id, name, source, api_key FROM api_integrations WHERE owner_id = $1 ORDER BY created_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, source: r.source, apiKey: r.api_key }));
  }

  /**
   * Authenticate and process a sale webhook. Verifies the HMAC over the exact
   * raw body, enforces the replay window, dedupes on the idempotency key, then
   * consumes stock FEFO per line (never rejecting a real sale — if our stock is
   * behind it consumes down to zero and reports the shortfall).
   */
  async ingestSale(headers: WebhookHeaders, rawBody: Buffer, payload: SalePayload): Promise<IngestResult> {
    const integration = await this.authenticate(headers, rawBody);
    if (!headers.idempotencyKey) throw new Error('missing X-Idempotency-Key');

    // Reserve the idempotency key first; a duplicate short-circuits.
    const reserve = await this.db.query(
      `INSERT INTO integration_events (integration_id, idempotency_key, event_type, payload)
       VALUES ($1,$2,'SALE',$3) ON CONFLICT (integration_id, idempotency_key) DO NOTHING RETURNING id`,
      [integration.id, headers.idempotencyKey, JSON.stringify(payload)],
    );
    if (reserve.rowCount === 0) return { status: 'DUPLICATE', applied: [] };

    if (!payload.lines?.length) throw new Error('sale has no lines');
    const applied: IngestResult['applied'] = [];

    for (const line of payload.lines) {
      if (line.quantity <= 0) throw new Error('line quantity must be positive');
      const item = await this.resolveItem(integration.owner_id, line);
      if (!item) throw new Error(`no inventory for ${line.sku ?? line.barcode} under this owner`);

      const toConsume = Math.min(line.quantity, item.current_stock);
      if (toConsume > 0) {
        await this.db.query(`SELECT consume_stock_fefo($1, $2, 'SALE')`, [item.id, toConsume]);
      }
      const newStock = item.current_stock - toConsume;

      applied.push({
        sku: item.sku,
        requested: line.quantity,
        consumed: toConsume,
        shortBy: line.quantity - toConsume,
        newStock,
      });

      inventoryEvents.publish({
        ownerId: integration.owner_id,
        inventoryId: item.id,
        sku: item.sku,
        productName: item.product_name,
        newStock,
        delta: -toConsume,
        source: integration.source,
        at: new Date().toISOString(),
      });
    }

    await this.db.query(`UPDATE api_integrations SET last_event_at = now() WHERE id = $1`, [integration.id]);
    return { status: 'PROCESSED', applied };
  }

  /** Current stock + last movement per item — poll this to live-track inventory. */
  async getLiveInventory(ownerId: string): Promise<LiveInventoryRow[]> {
    const { rows } = await this.db.query<{
      inventory_id: string;
      sku: string;
      product_name: string;
      current_stock: string;
      unit: string;
      minimum_threshold: string;
      last_movement_at: Date | null;
      last_movement_delta: string | null;
    }>(
      `
      SELECT i.id AS inventory_id, i.sku, i.product_name, i.current_stock, i.unit, i.minimum_threshold,
             m.time AS last_movement_at, m.delta AS last_movement_delta
      FROM inventory i
      LEFT JOIN LATERAL (
        SELECT time, delta FROM stock_movements sm WHERE sm.inventory_id = i.id ORDER BY time DESC LIMIT 1
      ) m ON TRUE
      WHERE i.owner_id = $1 AND i.is_active
      ORDER BY i.product_name
      `,
      [ownerId],
    );

    return rows.map((r) => ({
      inventoryId: r.inventory_id,
      sku: r.sku,
      productName: r.product_name,
      currentStock: Number(r.current_stock),
      unit: r.unit,
      minimumThreshold: Number(r.minimum_threshold),
      lastMovementAt: r.last_movement_at ? r.last_movement_at.toISOString() : null,
      lastMovementDelta: r.last_movement_delta === null ? null : Number(r.last_movement_delta),
    }));
  }

  private async authenticate(
    headers: WebhookHeaders,
    rawBody: Buffer,
  ): Promise<{ id: string; owner_id: string; source: string }> {
    if (!headers.apiKey || !headers.signature || !headers.timestamp) {
      throw new Error('invalid webhook signature'); // missing auth headers
    }
    const skew = Math.abs(Date.now() / 1000 - Number(headers.timestamp));
    if (!Number.isFinite(skew) || skew > REPLAY_WINDOW_SECONDS) {
      throw new Error('webhook timestamp outside the allowed window');
    }

    const { rows } = await this.db.query<{ id: string; owner_id: string; source: string; secret: string }>(
      `SELECT id, owner_id, source, secret FROM api_integrations WHERE api_key = $1 AND enabled`,
      [headers.apiKey],
    );
    const integration = rows[0];
    if (!integration) throw new Error('invalid webhook signature'); // unknown key: don't leak which

    const expected = createHmac('sha256', integration.secret).update(rawBody).digest('hex');
    const given = headers.signature;
    const ok =
      expected.length === given.length &&
      timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
    if (!ok) throw new Error('invalid webhook signature');

    return { id: integration.id, owner_id: integration.owner_id, source: integration.source };
  }

  private async resolveItem(
    ownerId: string,
    line: SaleLine,
  ): Promise<{ id: string; sku: string; product_name: string; current_stock: number } | null> {
    const { rows } = await this.db.query<{
      id: string;
      sku: string;
      product_name: string;
      current_stock: string;
    }>(
      `
      SELECT id, sku, product_name, current_stock FROM inventory
      WHERE owner_id = $1 AND is_active AND (
        ($2::text IS NOT NULL AND sku = $2) OR ($3::text IS NOT NULL AND barcode = $3)
      )
      LIMIT 1
      `,
      [ownerId, line.sku ?? null, line.barcode ?? null],
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      sku: rows[0].sku,
      product_name: rows[0].product_name,
      current_stock: Number(rows[0].current_stock),
    };
  }
}
