/**
 * ApnaKhata — ONDC storefront
 * ---------------------------
 * Publishes the kirana's live inventory to the Open Network for Digital
 * Commerce and lands consumer orders back as retail sales that draw down stock.
 * An order from a known customer (matched by phone) also earns loyalty points —
 * tying the ONDC channel into the consumer graph. A new India-specific network
 * no khata competitor touches.
 */

import { Pool } from 'pg';
import { randomBytes } from 'crypto';

import { LoyaltyService } from './LoyaltyService';
import { OndcCatalogItem, OndcGateway, SandboxOndcGateway } from '../finance/OndcGateway';

export interface Listing {
  sku: string;
  productName: string;
  price: number;
  currentStock: number;
  ondcItemId: string;
}

export interface OndcOrder {
  id: string;
  ondcOrderId: string;
  buyerName: string | null;
  buyerPincode: string | null;
  items: { sku: string; name: string; qty: number; price: number }[];
  total: number;
  status: string;
  loyaltyAwarded?: number;
  createdAt: string;
}

export interface PublishResult {
  published: number;
  storefrontHandle: string;
  networkListingId: string;
  listings: Listing[];
}

export class OndcService {
  private readonly loyalty: LoyaltyService;

  constructor(
    private readonly db: Pool,
    private readonly gateway: OndcGateway = new SandboxOndcGateway(),
    loyalty?: LoyaltyService,
  ) {
    this.loyalty = loyalty ?? new LoyaltyService(db);
  }

  /** Publish every in-stock, available SKU to ONDC (idempotent upsert). */
  async publishCatalog(ownerId: string): Promise<PublishResult> {
    const { rows: store } = await this.db.query<{ business_name: string }>(`SELECT business_name FROM users WHERE id = $1`, [ownerId]);
    const storeName = store[0]?.business_name ?? 'Store';

    const { rows: inv } = await this.db.query<{ sku: string; product_name: string; category: string; unit: string; retail_price: string; current_stock: string }>(
      `SELECT sku, product_name, category, unit, retail_price, current_stock
         FROM inventory WHERE owner_id = $1 AND is_active AND current_stock > 0
         ORDER BY product_name`,
      [ownerId],
    );
    if (inv.length === 0) throw new Error('no in-stock inventory to publish');

    const items: OndcCatalogItem[] = inv.map((i) => ({
      sku: i.sku, name: i.product_name, price: Number(i.retail_price), category: i.category, unit: i.unit,
    }));
    const result = await this.gateway.publish(ownerId, storeName, items);

    const listings: Listing[] = [];
    for (const i of inv) {
      const ondcItemId = `${result.networkListingId}-${i.sku}`;
      await this.db.query(
        `
        INSERT INTO ondc_listings (owner_id, sku, ondc_item_id, price)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (owner_id, sku) DO UPDATE SET price = EXCLUDED.price, ondc_item_id = EXCLUDED.ondc_item_id, listed_at = now()
        `,
        [ownerId, i.sku, ondcItemId, Number(i.retail_price)],
      );
      listings.push({ sku: i.sku, productName: i.product_name, price: Number(i.retail_price), currentStock: Number(i.current_stock), ondcItemId });
    }

    return { published: result.published, storefrontHandle: result.storefrontHandle, networkListingId: result.networkListingId, listings };
  }

  async getListings(ownerId: string): Promise<Listing[]> {
    const { rows } = await this.db.query<{ sku: string; product_name: string; price: string; current_stock: string; ondc_item_id: string }>(
      `
      SELECT l.sku, i.product_name, l.price, i.current_stock, l.ondc_item_id
      FROM ondc_listings l JOIN inventory i ON i.owner_id = l.owner_id AND i.sku = l.sku
      WHERE l.owner_id = $1 ORDER BY i.product_name
      `,
      [ownerId],
    );
    return rows.map((r) => ({ sku: r.sku, productName: r.product_name, price: Number(r.price), currentStock: Number(r.current_stock), ondcItemId: r.ondc_item_id }));
  }

  /**
   * Land a consumer ONDC order: validate against listings + stock, book the
   * retail sale on the ledger, draw down stock, and award loyalty if the buyer
   * is a known customer. Atomic.
   */
  async receiveOrder(
    ownerId: string,
    order: { ondcOrderId?: string; buyerName?: string; buyerPhone?: string; buyerPincode?: string; items: { sku: string; qty: number }[] },
  ): Promise<OndcOrder> {
    if (!order.items?.length) throw new Error('order has no items');
    const ondcOrderId = order.ondcOrderId ?? `ORD-${randomBytes(5).toString('hex').toUpperCase()}`;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const lines: { sku: string; name: string; qty: number; price: number }[] = [];
      let total = 0;
      for (const line of order.items) {
        if (!(line.qty > 0)) throw new Error(`quantity must be positive for ${line.sku}`);
        const { rows } = await client.query<{ id: string; product_name: string; current_stock: string; price: string }>(
          `
          SELECT i.id, i.product_name, i.current_stock, l.price
          FROM ondc_listings l JOIN inventory i ON i.owner_id = l.owner_id AND i.sku = l.sku
          WHERE l.owner_id = $1 AND l.sku = $2 FOR UPDATE OF i
          `,
          [ownerId, line.sku],
        );
        const item = rows[0];
        if (!item) throw new Error(`sku ${line.sku} is not listed on ONDC`);
        if (Number(item.current_stock) < line.qty) throw new Error(`insufficient stock for ${line.sku}`);

        const price = Number(item.price);
        total += price * line.qty;
        lines.push({ sku: line.sku, name: item.product_name, qty: line.qty, price });

        await client.query(`UPDATE inventory SET current_stock = current_stock - $2 WHERE id = $1`, [item.id, line.qty]);
        await client.query(
          `INSERT INTO stock_movements (inventory_id, owner_id, delta, reason, stock_after)
           VALUES ($1, $2, $3, 'SALE', (SELECT current_stock FROM inventory WHERE id = $1))`,
          [item.id, ownerId, -line.qty],
        );
      }
      total = Math.round(total * 100) / 100;

      const { rows: ledgerRows } = await client.query<{ id: string }>(
        `
        INSERT INTO transactions_ledger
          (kind, sender_id, retail_customer, invoice_number, amount, balance_remaining, payment_status)
        VALUES ('RETAIL_SALE', $1, $2, $3, $4, 0, 'PAID')
        RETURNING id
        `,
        [ownerId, order.buyerName ?? 'ONDC customer', `ONDC-${ondcOrderId}`, total],
      );
      const ledgerId = ledgerRows[0].id;

      const { rows: orderRows } = await client.query<{ id: string; created_at: Date }>(
        `
        INSERT INTO ondc_orders (owner_id, ondc_order_id, buyer_name, buyer_phone, buyer_pincode, items, total, ledger_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id, created_at
        `,
        [ownerId, ondcOrderId, order.buyerName ?? null, order.buyerPhone ?? null, order.buyerPincode ?? null, JSON.stringify(lines), total, ledgerId],
      );

      await client.query('COMMIT');

      // Award loyalty outside the sale txn (best-effort) if the buyer is known.
      let loyaltyAwarded: number | undefined;
      if (order.buyerPhone) {
        const { rows: cust } = await this.db.query<{ id: string }>(
          `SELECT id FROM customers WHERE owner_id = $1 AND right(regexp_replace(phone,'[^0-9]','','g'),10) = right(regexp_replace($2,'[^0-9]','','g'),10) LIMIT 1`,
          [ownerId, order.buyerPhone],
        );
        if (cust[0]) {
          const acct = await this.loyalty.earnForPurchase(ownerId, cust[0].id, total, ondcOrderId);
          loyaltyAwarded = acct ? Math.floor(total / 50) : 0;
        }
      }

      return {
        id: orderRows[0].id,
        ondcOrderId,
        buyerName: order.buyerName ?? null,
        buyerPincode: order.buyerPincode ?? null,
        items: lines,
        total,
        status: 'RECEIVED',
        loyaltyAwarded,
        createdAt: orderRows[0].created_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Demo helper: a synthetic consumer order for a couple of listed items. */
  async simulateOrder(ownerId: string): Promise<OndcOrder> {
    const listings = (await this.getListings(ownerId)).filter((l) => l.currentStock > 0).slice(0, 2);
    if (listings.length === 0) throw new Error('publish your catalog first');
    return this.receiveOrder(ownerId, {
      buyerName: 'Priya (ONDC)',
      buyerPhone: '+919812345678', // matches demo customer Ramesh's phone → loyalty
      buyerPincode: '411001',
      items: listings.map((l) => ({ sku: l.sku, qty: Math.min(2, l.currentStock) })),
    });
  }

  async listOrders(ownerId: string, limit = 20): Promise<OndcOrder[]> {
    const { rows } = await this.db.query<{
      id: string; ondc_order_id: string; buyer_name: string | null; buyer_pincode: string | null;
      items: { sku: string; name: string; qty: number; price: number }[]; total: string; status: string; created_at: Date;
    }>(
      `SELECT id, ondc_order_id, buyer_name, buyer_pincode, items, total, status, created_at
         FROM ondc_orders WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ownerId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((r) => ({
      id: r.id,
      ondcOrderId: r.ondc_order_id,
      buyerName: r.buyer_name,
      buyerPincode: r.buyer_pincode,
      items: r.items,
      total: Number(r.total),
      status: r.status,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
