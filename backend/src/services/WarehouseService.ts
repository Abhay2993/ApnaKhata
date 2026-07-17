/**
 * ApnaKhata — Warehouse / Multi-Location Service
 * ----------------------------------------------
 * Distributors run a shop floor plus godowns; this service manages those
 * locations, moves stock between them FEFO (batch identity preserved by
 * `transfer_stock()`), and reports per-location holdings. Owner-level
 * aggregate stock never changes on a transfer — batches carry the detail.
 */

import { Pool } from 'pg';

export type LocationKind = 'STORE' | 'GODOWN';

export interface StockLocation {
  id: string;
  ownerId: string;
  name: string;
  kind: LocationKind;
  address: string | null;
  isDefault: boolean;
}

export interface LocationStock {
  locationId: string | null; // null = batches with no location assigned
  locationName: string;
  inventoryId: string;
  sku: string;
  productName: string;
  qtyOnHand: number;
}

export class WarehouseService {
  constructor(private readonly db: Pool) {}

  async createLocation(input: {
    ownerId: string;
    name: string;
    kind?: LocationKind;
    address?: string;
    isDefault?: boolean;
  }): Promise<StockLocation> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      if (input.isDefault) {
        // The partial unique index allows one default; demote any existing one.
        await client.query(
          `UPDATE stock_locations SET is_default = FALSE WHERE owner_id = $1 AND is_default`,
          [input.ownerId],
        );
      }

      const { rows } = await client.query<{ id: string }>(
        `
        INSERT INTO stock_locations (owner_id, name, kind, address, is_default)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `,
        [input.ownerId, input.name.trim(), input.kind ?? 'STORE', input.address ?? null, input.isDefault ?? false],
      );

      await client.query('COMMIT');
      return {
        id: rows[0].id,
        ownerId: input.ownerId,
        name: input.name.trim(),
        kind: input.kind ?? 'STORE',
        address: input.address ?? null,
        isDefault: input.isDefault ?? false,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listLocations(ownerId: string): Promise<StockLocation[]> {
    const { rows } = await this.db.query<{
      id: string;
      owner_id: string;
      name: string;
      kind: LocationKind;
      address: string | null;
      is_default: boolean;
    }>(
      `SELECT * FROM stock_locations WHERE owner_id = $1 ORDER BY is_default DESC, name`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      kind: r.kind,
      address: r.address,
      isDefault: r.is_default,
    }));
  }

  /** Move stock between two locations, earliest-expiry batches first. */
  async transferStock(input: {
    inventoryId: string;
    fromLocationId: string;
    toLocationId: string;
    quantity: number;
  }): Promise<{ transferred: number }> {
    if (input.quantity <= 0) throw new Error('quantity must be positive');

    const { rows } = await this.db.query<{ transfer_stock: string }>(
      `SELECT transfer_stock($1, $2, $3, $4)`,
      [input.inventoryId, input.fromLocationId, input.toLocationId, input.quantity],
    );
    return { transferred: Number(rows[0].transfer_stock) };
  }

  /** Per-location holdings for the owner (batch-level stock, aggregated). */
  async stockByLocation(ownerId: string): Promise<LocationStock[]> {
    const { rows } = await this.db.query<{
      location_id: string | null;
      location_name: string | null;
      inventory_id: string;
      sku: string;
      product_name: string;
      qty_on_hand: string;
    }>(
      `
      SELECT b.location_id, l.name AS location_name, i.id AS inventory_id,
             i.sku, i.product_name, SUM(b.qty_remaining) AS qty_on_hand
      FROM inventory_batches b
      JOIN inventory i ON i.id = b.inventory_id
      LEFT JOIN stock_locations l ON l.id = b.location_id
      WHERE i.owner_id = $1 AND b.qty_remaining > 0
      GROUP BY b.location_id, l.name, i.id, i.sku, i.product_name
      ORDER BY l.name NULLS LAST, i.sku
      `,
      [ownerId],
    );

    return rows.map((r) => ({
      locationId: r.location_id,
      locationName: r.location_name ?? 'Unassigned',
      inventoryId: r.inventory_id,
      sku: r.sku,
      productName: r.product_name,
      qtyOnHand: Number(r.qty_on_hand),
    }));
  }
}
