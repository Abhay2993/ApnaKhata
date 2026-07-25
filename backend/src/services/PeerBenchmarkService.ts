/**
 * ApnaKhata — Peer benchmarking / consortium intelligence
 * -------------------------------------------------------
 * The pure-data moat: "shops like yours sell 20% more Parle-G; your margin is
 * below peers; stock these fast-movers you don't carry." Anonymised
 * cross-network comparison is impossible for a new entrant without scale — it
 * only works because many shops' inventory and sales already flow through here.
 *
 * A shop is compared against a cohort of peers (same state, fallback all
 * shopkeepers). Everything returned is an aggregate — no peer is ever named.
 * Read-only over `inventory` + `stock_movements`.
 */

import { Pool } from 'pg';

const WINDOW_DAYS = 28;
const WEEKS = WINDOW_DAYS / 7;

export interface MarginBenchmark {
  yoursPct: number;
  peerMedianPct: number;
  percentile: number; // share of peers you beat, 0..100
  verdict: 'above' | 'below' | 'inline';
}

export interface VelocityLag {
  sku: string;
  productName: string;
  yourWeeklyUnits: number;
  peerMedianWeeklyUnits: number;
  gapPct: number; // how far below the peer median, %
}

export interface AssortmentGap {
  sku: string;
  productName: string;
  category: string;
  peerCarryingPct: number; // % of peers stocking it
  peerMedianWeeklyUnits: number; // typical demand at a peer
}

export interface Benchmarks {
  cohort: { size: number; basis: string };
  margin: MarginBenchmark | null;
  laggingProducts: VelocityLag[];
  assortmentGaps: AssortmentGap[];
  insights: string[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export class PeerBenchmarkService {
  constructor(private readonly db: Pool) {}

  async getBenchmarks(ownerId: string): Promise<Benchmarks> {
    const { cohort, basis } = await this.resolveCohort(ownerId);
    if (cohort.length === 0) {
      return { cohort: { size: 0, basis }, margin: null, laggingProducts: [], assortmentGaps: [], insights: ['Not enough peers on the network yet to benchmark against.'] };
    }

    const [margin, laggingProducts, assortmentGaps] = await Promise.all([
      this.marginBenchmark(ownerId, cohort),
      this.velocityLags(ownerId, cohort),
      this.assortmentGaps(ownerId, cohort),
    ]);

    const insights: string[] = [];
    if (margin && margin.verdict === 'below') {
      insights.push(`Your gross margin (${margin.yoursPct}%) is ${round1(margin.peerMedianPct - margin.yoursPct)} pts below the peer median — review pricing on low-margin lines.`);
    } else if (margin && margin.verdict === 'above') {
      insights.push(`Your gross margin (${margin.yoursPct}%) beats ${Math.round(margin.percentile)}% of peers — strong pricing discipline.`);
    }
    if (laggingProducts[0]) {
      const l = laggingProducts[0];
      insights.push(`Peers sell ${l.gapPct}% more ${l.productName} than you — worth a shelf-position or stock review.`);
    }
    if (assortmentGaps[0]) {
      const names = assortmentGaps.slice(0, 3).map((g) => g.productName).join(', ');
      insights.push(`${assortmentGaps.length} fast-mover${assortmentGaps.length > 1 ? 's' : ''} peers carry that you don't — top: ${names}.`);
    }

    return { cohort: { size: cohort.length, basis }, margin, laggingProducts, assortmentGaps, insights };
  }

  /** Peers = active shopkeepers in the same state; fall back to all if sparse. */
  private async resolveCohort(ownerId: string): Promise<{ cohort: string[]; basis: string }> {
    const { rows: me } = await this.db.query<{ state_code: string | null; city: string | null }>(
      `SELECT state_code, city FROM users WHERE id = $1`,
      [ownerId],
    );
    const state = me[0]?.state_code ?? null;
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'SHOPKEEPER' AND is_active AND id <> $1 AND ($2::text IS NULL OR state_code = $2)`,
      [ownerId, state],
    );
    if (rows.length >= 2) return { cohort: rows.map((r) => r.id), basis: state ? `shops in state ${state}` : 'shops like yours' };

    const { rows: all } = await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'SHOPKEEPER' AND is_active AND id <> $1`,
      [ownerId],
    );
    return { cohort: all.map((r) => r.id), basis: 'all shops on the network' };
  }

  private async marginBenchmark(ownerId: string, cohort: string[]): Promise<MarginBenchmark | null> {
    // Sales-weighted gross margin per shop over the window.
    const { rows } = await this.db.query<{ owner_id: string; margin_pct: string | null }>(
      `
      WITH sales AS (
        SELECT owner_id, inventory_id, SUM(-delta) AS units
        FROM stock_movements
        WHERE reason = 'SALE' AND delta < 0 AND time >= now() - ($2 || ' days')::interval
        GROUP BY owner_id, inventory_id
      )
      SELECT i.owner_id,
             SUM((i.retail_price - i.wholesale_price) * s.units)
               / NULLIF(SUM(i.retail_price * s.units), 0) * 100 AS margin_pct
      FROM sales s JOIN inventory i ON i.id = s.inventory_id
      WHERE i.owner_id = ANY($1::uuid[])
      GROUP BY i.owner_id
      `,
      [[ownerId, ...cohort], String(WINDOW_DAYS)],
    );
    const byOwner = new Map(rows.map((r) => [r.owner_id, r.margin_pct === null ? null : Number(r.margin_pct)]));
    const yours = byOwner.get(ownerId);
    if (yours == null) return null;
    const peerMargins = cohort.map((id) => byOwner.get(id)).filter((m): m is number => m != null);
    if (peerMargins.length === 0) return null;

    const peerMedian = median(peerMargins);
    const beaten = peerMargins.filter((m) => m < yours).length;
    const percentile = (beaten / peerMargins.length) * 100;
    const verdict = yours > peerMedian + 0.5 ? 'above' : yours < peerMedian - 0.5 ? 'below' : 'inline';
    return { yoursPct: round1(yours), peerMedianPct: round1(peerMedian), percentile: Math.round(percentile), verdict };
  }

  private async velocityLags(ownerId: string, cohort: string[]): Promise<VelocityLag[]> {
    const { rows } = await this.db.query<{ sku: string; product_name: string; owner_id: string; weekly: string }>(
      `
      SELECT i.sku, i.product_name, i.owner_id, SUM(-sm.delta) / $3::numeric AS weekly
      FROM inventory i
      JOIN stock_movements sm ON sm.inventory_id = i.id
      WHERE i.owner_id = ANY($1::uuid[]) AND sm.reason = 'SALE' AND sm.delta < 0
        AND sm.time >= now() - ($2 || ' days')::interval
      GROUP BY i.sku, i.product_name, i.owner_id
      `,
      [[ownerId, ...cohort], String(WINDOW_DAYS), String(WEEKS)],
    );

    const yoursBySku = new Map<string, { name: string; weekly: number }>();
    const peersBySku = new Map<string, number[]>();
    for (const r of rows) {
      const weekly = Number(r.weekly);
      if (r.owner_id === ownerId) yoursBySku.set(r.sku, { name: r.product_name, weekly });
      else (peersBySku.get(r.sku) ?? peersBySku.set(r.sku, []).get(r.sku)!).push(weekly);
    }

    const lags: VelocityLag[] = [];
    for (const [sku, mine] of yoursBySku) {
      const peers = peersBySku.get(sku);
      if (!peers || peers.length === 0) continue;
      const peerMedian = median(peers);
      if (mine.weekly < peerMedian * 0.9) {
        lags.push({
          sku,
          productName: mine.name,
          yourWeeklyUnits: round1(mine.weekly),
          peerMedianWeeklyUnits: round1(peerMedian),
          gapPct: Math.round(((peerMedian - mine.weekly) / peerMedian) * 100),
        });
      }
    }
    return lags.sort((a, b) => b.gapPct - a.gapPct);
  }

  private async assortmentGaps(ownerId: string, cohort: string[]): Promise<AssortmentGap[]> {
    const { rows } = await this.db.query<{
      sku: string; product_name: string; category: string; carriers: string; weekly_median: string | null;
    }>(
      `
      WITH your_skus AS (SELECT sku FROM inventory WHERE owner_id = $1),
      peer_weekly AS (
        SELECT i.sku, i.owner_id, SUM(-sm.delta) / $4::numeric AS weekly
        FROM inventory i
        JOIN stock_movements sm ON sm.inventory_id = i.id
        WHERE i.owner_id = ANY($2::uuid[]) AND sm.reason = 'SALE' AND sm.delta < 0
          AND sm.time >= now() - ($3 || ' days')::interval
        GROUP BY i.sku, i.owner_id
      )
      SELECT i.sku, MAX(i.product_name) AS product_name, MAX(i.category) AS category,
             COUNT(DISTINCT i.owner_id) AS carriers,
             (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pw.weekly) FROM peer_weekly pw WHERE pw.sku = i.sku) AS weekly_median
      FROM inventory i
      WHERE i.owner_id = ANY($2::uuid[]) AND i.sku NOT IN (SELECT sku FROM your_skus)
      GROUP BY i.sku
      HAVING COUNT(DISTINCT i.owner_id)::float / $5 >= 0.5
      ORDER BY carriers DESC, weekly_median DESC NULLS LAST
      LIMIT 6
      `,
      [ownerId, cohort, String(WINDOW_DAYS), String(WEEKS), cohort.length],
    );

    return rows.map((r) => ({
      sku: r.sku,
      productName: r.product_name,
      category: r.category,
      peerCarryingPct: Math.round((Number(r.carriers) / cohort.length) * 100),
      peerMedianWeeklyUnits: r.weekly_median === null ? 0 : round1(Number(r.weekly_median)),
    }));
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
