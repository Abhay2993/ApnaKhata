/**
 * ApnaKhata — Distributor Scheme / Trade-Discount Engine
 * ------------------------------------------------------
 * Distributors attach real trade schemes to their catalog and shopkeepers see
 * the discounted price (and free goods) at quote/order time. Three scheme types:
 *
 *   VOLUME_SLAB   config: { slabs: [{ minQty, unitPrice }, …] }  — cheaper per
 *                 unit above a quantity threshold (best applicable slab wins).
 *   BUY_X_GET_Y   config: { buyQty, freeQty }                    — e.g. buy 10
 *                 get 1 free; free units scale with multiples ordered.
 *   FLAT_PERCENT  config: { percent }                            — % off catalog,
 *                 typically seasonal (validity window).
 *
 * A scheme targets one SKU, a category, or all products; the best-benefit
 * applicable scheme is applied per line.
 */

import { Pool } from 'pg';

export type SchemeType = 'VOLUME_SLAB' | 'BUY_X_GET_Y' | 'FLAT_PERCENT';

export interface SchemeConfig {
  slabs?: { minQty: number; unitPrice: number }[];
  buyQty?: number;
  freeQty?: number;
  percent?: number;
}

export interface CreateSchemeInput {
  name: string;
  schemeType: SchemeType;
  sku?: string;
  category?: string;
  config: SchemeConfig;
  validFrom?: string;
  validTo?: string;
}

export interface Scheme {
  id: string;
  name: string;
  schemeType: SchemeType;
  sku: string | null;
  category: string | null;
  config: SchemeConfig;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

export interface PricedLine {
  sku: string;
  productName: string;
  unit: string;
  orderedQty: number;
  freeQty: number;
  totalQty: number; // ordered + free (what's received)
  catalogPrice: number;
  grossAmount: number; // orderedQty × catalogPrice
  discountValue: number; // cash saved + value of free goods
  netAmount: number; // what the shopkeeper pays
  effectiveUnitPrice: number; // netAmount / totalQty
  schemeApplied: string | null;
}

export interface CartQuote {
  lines: PricedLine[];
  grossTotal: number;
  totalDiscount: number;
  netTotal: number;
  totalFreeUnits: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class SchemeService {
  constructor(private readonly db: Pool) {}

  async createScheme(dealerId: string, input: CreateSchemeInput): Promise<Scheme> {
    this.validateConfig(input.schemeType, input.config);
    const { rows } = await this.db.query<SchemeRow>(
      `
      INSERT INTO dealer_schemes (dealer_id, name, scheme_type, sku, category, config, valid_from, valid_to)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
      `,
      [dealerId, input.name, input.schemeType, input.sku ?? null, input.category ?? null,
       JSON.stringify(input.config), input.validFrom ?? null, input.validTo ?? null],
    );
    return mapScheme(rows[0]);
  }

  async listSchemes(dealerId: string): Promise<Scheme[]> {
    const { rows } = await this.db.query<SchemeRow>(
      `SELECT * FROM dealer_schemes WHERE dealer_id = $1 ORDER BY is_active DESC, created_at DESC`,
      [dealerId],
    );
    return rows.map(mapScheme);
  }

  async deactivate(dealerId: string, schemeId: string): Promise<void> {
    await this.db.query(`UPDATE dealer_schemes SET is_active = FALSE WHERE id = $1 AND dealer_id = $2`, [
      schemeId,
      dealerId,
    ]);
  }

  /**
   * Price a cart against a dealer's catalog + active schemes. Validates
   * availability and MOQ, applies the best-benefit scheme per line, and returns
   * the full breakdown (free goods, discount, net) — the shopkeeper's quote and
   * the basis for the actual order.
   */
  async applyToCart(dealerId: string, lines: { sku: string; quantity: number }[]): Promise<CartQuote> {
    if (lines.length === 0) throw new Error('cart is empty');

    const skus = lines.map((l) => l.sku);
    const { rows: catalog } = await this.db.query<{
      sku: string;
      product_name: string;
      unit: string;
      wholesale_price: string;
      moq: number;
      category: string;
    }>(
      `SELECT sku, product_name, unit, wholesale_price, moq, category
         FROM dealer_products WHERE dealer_id = $1 AND is_active AND available AND sku = ANY($2::text[])`,
      [dealerId, skus],
    );
    const catMap = new Map(catalog.map((c) => [c.sku, c]));

    const { rows: schemeRows } = await this.db.query<SchemeRow>(
      `
      SELECT * FROM dealer_schemes
      WHERE dealer_id = $1 AND is_active
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to   IS NULL OR valid_to   >= CURRENT_DATE)
      `,
      [dealerId],
    );
    const schemes = schemeRows.map(mapScheme);

    const priced: PricedLine[] = lines.map((line) => {
      const product = catMap.get(line.sku);
      if (!product) throw new Error(`sku ${line.sku} is unavailable from this dealer`);
      if (line.quantity < product.moq) {
        throw new Error(`order quantity for ${line.sku} must be at least the MOQ of ${product.moq}`);
      }
      const catalogPrice = Number(product.wholesale_price);
      const grossAmount = round2(line.quantity * catalogPrice);

      const applicable = schemes.filter(
        (s) => s.sku === line.sku || (s.sku === null && s.category === product.category) || (s.sku === null && s.category === null),
      );
      let best: { outcome: SchemeOutcome; name: string } | null = null;
      for (const scheme of applicable) {
        const outcome = this.evaluate(scheme, line.quantity, catalogPrice);
        if (outcome.benefit > 0 && (!best || outcome.benefit > best.outcome.benefit)) {
          best = { outcome, name: scheme.name };
        }
      }

      const freeQty = best?.outcome.freeQty ?? 0;
      const netAmount = round2(best ? best.outcome.netAmount : grossAmount);
      const totalQty = line.quantity + freeQty;
      return {
        sku: line.sku,
        productName: product.product_name,
        unit: product.unit,
        orderedQty: line.quantity,
        freeQty,
        totalQty,
        catalogPrice,
        grossAmount,
        discountValue: round2(best?.outcome.benefit ?? 0),
        netAmount,
        effectiveUnitPrice: round2(netAmount / totalQty),
        schemeApplied: best?.name ?? null,
      };
    });

    return {
      lines: priced,
      grossTotal: round2(priced.reduce((s, l) => s + l.grossAmount, 0)),
      totalDiscount: round2(priced.reduce((s, l) => s + l.discountValue, 0)),
      netTotal: round2(priced.reduce((s, l) => s + l.netAmount, 0)),
      totalFreeUnits: priced.reduce((s, l) => s + l.freeQty, 0),
    };
  }

  /** Compute a scheme's effect on a line. `benefit` = cash saved + free-goods value. */
  private evaluate(scheme: Scheme, qty: number, catalogPrice: number): SchemeOutcome {
    const gross = qty * catalogPrice;
    switch (scheme.schemeType) {
      case 'VOLUME_SLAB': {
        const slabs = (scheme.config.slabs ?? []).filter((s) => qty >= s.minQty).sort((a, b) => b.minQty - a.minQty);
        if (slabs.length === 0) return { freeQty: 0, netAmount: gross, benefit: 0 };
        const net = qty * slabs[0].unitPrice;
        return { freeQty: 0, netAmount: net, benefit: round2(gross - net) };
      }
      case 'BUY_X_GET_Y': {
        const buyQty = scheme.config.buyQty ?? 0;
        const freePer = scheme.config.freeQty ?? 0;
        if (buyQty <= 0 || freePer <= 0) return { freeQty: 0, netAmount: gross, benefit: 0 };
        const freeQty = Math.floor(qty / buyQty) * freePer;
        return { freeQty, netAmount: gross, benefit: round2(freeQty * catalogPrice) };
      }
      case 'FLAT_PERCENT': {
        const pct = scheme.config.percent ?? 0;
        const discount = round2((gross * pct) / 100);
        return { freeQty: 0, netAmount: round2(gross - discount), benefit: discount };
      }
      default:
        return { freeQty: 0, netAmount: gross, benefit: 0 };
    }
  }

  private validateConfig(type: SchemeType, config: SchemeConfig): void {
    if (type === 'VOLUME_SLAB') {
      if (!config.slabs?.length) throw new Error('VOLUME_SLAB requires at least one slab');
      for (const s of config.slabs) if (s.minQty < 1 || s.unitPrice < 0) throw new Error('invalid slab');
    } else if (type === 'BUY_X_GET_Y') {
      if (!(config.buyQty && config.buyQty > 0) || !(config.freeQty && config.freeQty > 0)) {
        throw new Error('BUY_X_GET_Y requires positive buyQty and freeQty');
      }
    } else if (type === 'FLAT_PERCENT') {
      if (config.percent === undefined || config.percent <= 0 || config.percent >= 100) {
        throw new Error('FLAT_PERCENT requires percent in (0, 100)');
      }
    }
  }
}

interface SchemeOutcome {
  freeQty: number;
  netAmount: number;
  benefit: number;
}

interface SchemeRow {
  id: string;
  name: string;
  scheme_type: SchemeType;
  sku: string | null;
  category: string | null;
  config: SchemeConfig;
  valid_from: Date | null;
  valid_to: Date | null;
  is_active: boolean;
}

function mapScheme(r: SchemeRow): Scheme {
  return {
    id: r.id,
    name: r.name,
    schemeType: r.scheme_type,
    sku: r.sku,
    category: r.category,
    config: r.config,
    validFrom: r.valid_from ? r.valid_from.toISOString().slice(0, 10) : null,
    validTo: r.valid_to ? r.valid_to.toISOString().slice(0, 10) : null,
    isActive: r.is_active,
  };
}
