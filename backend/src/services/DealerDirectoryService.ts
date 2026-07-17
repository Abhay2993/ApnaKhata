/**
 * ApnaKhata — Dealer Directory Service
 * ------------------------------------
 * The marketplace: distributors publish a catalog (dealer_products); shopkeepers
 * search dealers by product/category/city and browse a dealer's catalog. Placing
 * an order reuses the existing purchase-order flow (see
 * PurchaseOrderService.createFromCatalog).
 */

import { Pool } from 'pg';

export interface CatalogItemInput {
  sku: string;
  productName: string;
  category?: string;
  brand?: string;
  hsnCode?: string;
  gstRate?: number;
  wholesalePrice: number;
  mrp?: number;
  moq?: number;
  packSize?: number;
  unit?: string;
  leadTimeDays?: number;
  available?: boolean;
}

export interface CatalogItem {
  id: string;
  sku: string;
  productName: string;
  category: string;
  brand: string | null;
  hsnCode: string | null;
  gstRate: number;
  wholesalePrice: number;
  mrp: number | null;
  moq: number;
  packSize: number;
  unit: string;
  leadTimeDays: number;
  available: boolean;
}

export interface DealerSearchResult {
  dealerId: string;
  businessName: string;
  city: string | null;
  stateCode: string | null;
  gstin: string | null;
  productCount: number;
  minLeadTimeDays: number | null;
  sampleProducts: { sku: string; productName: string; wholesalePrice: number; moq: number; unit: string }[];
}

export interface DealerSearchQuery {
  query?: string;
  category?: string;
  city?: string;
  limit?: number;
}

export class DealerDirectoryService {
  constructor(private readonly db: Pool) {}

  /** Dealer (distributor) upserts one catalog item. */
  async upsertCatalogItem(dealerId: string, item: CatalogItemInput): Promise<CatalogItem> {
    if (item.wholesalePrice < 0) throw new Error('wholesalePrice cannot be negative');
    if ((item.moq ?? 1) < 1) throw new Error('moq must be at least 1');

    const { rows } = await this.db.query<CatalogRow>(
      `
      INSERT INTO dealer_products (
        dealer_id, sku, product_name, category, brand, hsn_code, gst_rate,
        wholesale_price, mrp, moq, pack_size, unit, lead_time_days, available
      ) VALUES ($1,$2,$3,COALESCE($4,'GENERAL'),$5,$6,COALESCE($7,0),$8,$9,COALESCE($10,1),
                COALESCE($11,1),COALESCE($12,'PCS'),COALESCE($13,3),COALESCE($14,TRUE))
      ON CONFLICT (dealer_id, sku) DO UPDATE SET
        product_name = EXCLUDED.product_name, category = EXCLUDED.category, brand = EXCLUDED.brand,
        hsn_code = EXCLUDED.hsn_code, gst_rate = EXCLUDED.gst_rate, wholesale_price = EXCLUDED.wholesale_price,
        mrp = EXCLUDED.mrp, moq = EXCLUDED.moq, pack_size = EXCLUDED.pack_size, unit = EXCLUDED.unit,
        lead_time_days = EXCLUDED.lead_time_days, available = EXCLUDED.available, is_active = TRUE
      RETURNING *
      `,
      [
        dealerId, item.sku, item.productName, item.category ?? null, item.brand ?? null,
        item.hsnCode ?? null, item.gstRate ?? null, item.wholesalePrice, item.mrp ?? null,
        item.moq ?? null, item.packSize ?? null, item.unit ?? null, item.leadTimeDays ?? null,
        item.available ?? null,
      ],
    );
    return mapCatalog(rows[0]);
  }

  /** Bulk upsert (dealer onboarding / price-list import). */
  async bulkUpsertCatalog(dealerId: string, items: CatalogItemInput[]): Promise<number> {
    let n = 0;
    for (const item of items) {
      await this.upsertCatalogItem(dealerId, item);
      n += 1;
    }
    return n;
  }

  /** A dealer's live catalog, optionally filtered. */
  async getCatalog(dealerId: string, filter: { category?: string; query?: string } = {}): Promise<CatalogItem[]> {
    const { rows } = await this.db.query<CatalogRow>(
      `
      SELECT * FROM dealer_products
      WHERE dealer_id = $1 AND is_active AND available
        AND ($2::text IS NULL OR category = $2)
        AND ($3::text IS NULL OR product_name ILIKE '%' || $3 || '%')
      ORDER BY category, product_name
      `,
      [dealerId, filter.category ?? null, filter.query ?? null],
    );
    return rows.map(mapCatalog);
  }

  /** Distinct categories across all available catalog products (for filters). */
  async listCategories(): Promise<string[]> {
    const { rows } = await this.db.query<{ category: string }>(
      `SELECT DISTINCT category FROM dealer_products WHERE is_active AND available ORDER BY category`,
    );
    return rows.map((r) => r.category);
  }

  /**
   * Search dealers by product name / category / dealer name, optionally scoped
   * to a city. Each result carries a product count and up to five matching
   * sample products. Trigram-indexed on product_name for fuzzy matches.
   */
  async searchDealers(q: DealerSearchQuery): Promise<DealerSearchResult[]> {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
    const { rows } = await this.db.query<{
      dealer_id: string;
      business_name: string;
      city: string | null;
      state_code: string | null;
      gstin: string | null;
      product_count: string;
      min_lead_time: number | null;
      sample_products: { sku: string; productName: string; wholesalePrice: number; moq: number; unit: string }[] | null;
    }>(
      `
      SELECT u.id AS dealer_id, u.business_name, u.city, u.state_code, u.gstin,
             COUNT(dp.id)          AS product_count,
             MIN(dp.lead_time_days) AS min_lead_time,
             (
               SELECT json_agg(s) FROM (
                 SELECT d2.sku, d2.product_name AS "productName",
                        d2.wholesale_price::float8 AS "wholesalePrice", d2.moq, d2.unit
                 FROM dealer_products d2
                 WHERE d2.dealer_id = u.id AND d2.is_active AND d2.available
                   AND ($1::text IS NULL OR d2.product_name ILIKE '%' || $1 || '%' OR d2.category ILIKE '%' || $1 || '%')
                   AND ($2::text IS NULL OR d2.category = $2)
                 ORDER BY d2.product_name LIMIT 5
               ) s
             ) AS sample_products
      FROM users u
      JOIN dealer_products dp ON dp.dealer_id = u.id AND dp.is_active AND dp.available
      WHERE u.role = 'DISTRIBUTOR' AND u.is_active
        AND ($1::text IS NULL OR dp.product_name ILIKE '%' || $1 || '%'
             OR dp.category ILIKE '%' || $1 || '%' OR u.business_name ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR dp.category = $2)
        AND ($3::text IS NULL OR u.city ILIKE $3)
      GROUP BY u.id
      ORDER BY product_count DESC, u.business_name
      LIMIT $4
      `,
      [q.query ?? null, q.category ?? null, q.city ?? null, limit],
    );

    return rows.map((r) => ({
      dealerId: r.dealer_id,
      businessName: r.business_name,
      city: r.city,
      stateCode: r.state_code,
      gstin: r.gstin,
      productCount: Number(r.product_count),
      minLeadTimeDays: r.min_lead_time,
      sampleProducts: r.sample_products ?? [],
    }));
  }
}

interface CatalogRow {
  id: string;
  sku: string;
  product_name: string;
  category: string;
  brand: string | null;
  hsn_code: string | null;
  gst_rate: string;
  wholesale_price: string;
  mrp: string | null;
  moq: number;
  pack_size: number;
  unit: string;
  lead_time_days: number;
  available: boolean;
}

function mapCatalog(r: CatalogRow): CatalogItem {
  return {
    id: r.id,
    sku: r.sku,
    productName: r.product_name,
    category: r.category,
    brand: r.brand,
    hsnCode: r.hsn_code,
    gstRate: Number(r.gst_rate),
    wholesalePrice: Number(r.wholesale_price),
    mrp: r.mrp === null ? null : Number(r.mrp),
    moq: r.moq,
    packSize: r.pack_size,
    unit: r.unit,
    leadTimeDays: r.lead_time_days,
    available: r.available,
  };
}
