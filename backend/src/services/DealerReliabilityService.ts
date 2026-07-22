/**
 * ApnaKhata — Dealer reliability rating
 * -------------------------------------
 * Trust is the marketplace's network-effect flywheel, and the signal already
 * exists in the ledger: disputes raised against a dealer's invoices, whether
 * purchase orders arrive on time, and how many orders complete vs get
 * cancelled. This service folds those into a 0–5 star rating — read-only over
 * existing data, no new writes.
 *
 *   rating = 5 × (0.40·(1 − disputeRate) + 0.35·onTimeRate + 0.25·completionRate)
 *
 * Thin-file damping: with few observations the rating is pulled toward a
 * neutral 3.5 so one early hiccup (or one lucky order) doesn't define a dealer.
 */

import { Pool } from 'pg';

export interface DealerReliability {
  dealerId: string;
  rating: number; // 0..5, one decimal
  band: 'EXCELLENT' | 'RELIABLE' | 'MIXED' | 'POOR' | 'NEW';
  totalOrders: number;
  completedOrders: number;
  onTimeRate: number | null; // of completed orders with a delivery signal
  disputeRate: number | null; // disputes per invoice
  completionRate: number | null; // received / (received + cancelled)
  observations: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export class DealerReliabilityService {
  constructor(private readonly db: Pool) {}

  async getRating(dealerId: string): Promise<DealerReliability> {
    const map = await this.ratingsFor([dealerId]);
    return map.get(dealerId) ?? emptyRating(dealerId);
  }

  /** Batch ratings, one query pass — used to enrich marketplace search results. */
  async ratingsFor(dealerIds: string[]): Promise<Map<string, DealerReliability>> {
    const out = new Map<string, DealerReliability>();
    if (dealerIds.length === 0) return out;

    const { rows } = await this.db.query<{
      dealer_id: string;
      total_orders: string;
      received_orders: string;
      cancelled_orders: string;
      on_time_orders: string;
      timed_orders: string;
      invoices: string;
      disputes: string;
    }>(
      `
      WITH po AS (
        SELECT supplier_id AS dealer_id,
               COUNT(*)                                          AS total_orders,
               COUNT(*) FILTER (WHERE status = 'RECEIVED')       AS received_orders,
               COUNT(*) FILTER (WHERE status = 'CANCELLED')      AS cancelled_orders,
               -- On-time: beat the promised date, or (no promise) received within 7 days.
               COUNT(*) FILTER (WHERE status = 'RECEIVED' AND received_at IS NOT NULL AND (
                 (expected_delivery_date IS NOT NULL AND received_at::date <= expected_delivery_date)
                 OR (expected_delivery_date IS NULL AND received_at <= created_at + interval '7 days')
               ))                                                AS on_time_orders,
               COUNT(*) FILTER (WHERE status = 'RECEIVED' AND received_at IS NOT NULL) AS timed_orders
        FROM purchase_orders
        WHERE supplier_id = ANY($1::uuid[])
        GROUP BY supplier_id
      ),
      inv AS (
        SELECT tl.sender_id AS dealer_id,
               COUNT(*)     AS invoices,
               COUNT(d.id)  AS disputes
        FROM transactions_ledger tl
        LEFT JOIN invoice_disputes d ON d.invoice_id = tl.id
        WHERE tl.sender_id = ANY($1::uuid[]) AND tl.kind = 'B2B_INVOICE'
        GROUP BY tl.sender_id
      )
      SELECT COALESCE(po.dealer_id, inv.dealer_id) AS dealer_id,
             COALESCE(po.total_orders, 0)     AS total_orders,
             COALESCE(po.received_orders, 0)  AS received_orders,
             COALESCE(po.cancelled_orders, 0) AS cancelled_orders,
             COALESCE(po.on_time_orders, 0)   AS on_time_orders,
             COALESCE(po.timed_orders, 0)     AS timed_orders,
             COALESCE(inv.invoices, 0)        AS invoices,
             COALESCE(inv.disputes, 0)        AS disputes
      FROM po FULL OUTER JOIN inv ON inv.dealer_id = po.dealer_id
      `,
      [dealerIds],
    );

    for (const r of rows) {
      const received = Number(r.received_orders);
      const cancelled = Number(r.cancelled_orders);
      const timed = Number(r.timed_orders);
      const onTime = Number(r.on_time_orders);
      const invoices = Number(r.invoices);
      const disputes = Number(r.disputes);

      const completionBase = received + cancelled;
      const completionRate = completionBase > 0 ? received / completionBase : null;
      const onTimeRate = timed > 0 ? onTime / timed : null;
      const disputeRate = invoices > 0 ? disputes / invoices : null;

      // Weighted score over the components that have data, re-normalised.
      let weight = 0;
      let score = 0;
      if (disputeRate !== null) { score += 0.4 * (1 - Math.min(disputeRate, 1)); weight += 0.4; }
      if (onTimeRate !== null) { score += 0.35 * onTimeRate; weight += 0.35; }
      if (completionRate !== null) { score += 0.25 * completionRate; weight += 0.25; }

      const observations = completionBase + invoices;
      let rating: number;
      let band: DealerReliability['band'];
      if (weight === 0 || observations === 0) {
        rating = 0;
        band = 'NEW';
      } else {
        const raw = 5 * (score / weight);
        // Thin-file damping toward neutral 3.5 until ~10 observations.
        const n = Math.min(observations, 10);
        rating = round1((raw * n + 3.5 * (10 - n)) / 10);
        band = rating >= 4.5 ? 'EXCELLENT' : rating >= 3.8 ? 'RELIABLE' : rating >= 3 ? 'MIXED' : 'POOR';
      }

      out.set(r.dealer_id, {
        dealerId: r.dealer_id,
        rating,
        band,
        totalOrders: Number(r.total_orders),
        completedOrders: received,
        onTimeRate: onTimeRate === null ? null : round1(onTimeRate * 100) / 100,
        disputeRate: disputeRate === null ? null : Math.round(disputeRate * 1000) / 1000,
        completionRate: completionRate === null ? null : round1(completionRate * 100) / 100,
        observations,
      });
    }

    for (const id of dealerIds) if (!out.has(id)) out.set(id, emptyRating(id));
    return out;
  }
}

const emptyRating = (dealerId: string): DealerReliability => ({
  dealerId,
  rating: 0,
  band: 'NEW',
  totalOrders: 0,
  completedOrders: 0,
  onTimeRate: null,
  disputeRate: null,
  completionRate: null,
  observations: 0,
});
