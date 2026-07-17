/**
 * ApnaKhata — Inventory event bus
 * -------------------------------
 * In-process pub/sub for live inventory updates (feeds the SSE stream). Single
 * API instance only; for a multi-instance deployment back this with Redis
 * pub/sub (already in the architecture stack) — the publish/subscribe surface
 * stays identical.
 */

import { EventEmitter } from 'events';

export interface InventoryUpdate {
  ownerId: string;
  inventoryId: string;
  sku: string;
  productName: string;
  newStock: number;
  delta: number;
  source: string; // e.g. 'POS', 'TALLY', 'SALE'
  at: string; // ISO
}

class InventoryEventBus extends EventEmitter {
  publish(update: InventoryUpdate): void {
    this.emit('update', update);
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: (update: InventoryUpdate) => void): () => void {
    this.on('update', listener);
    return () => this.off('update', listener);
  }
}

export const inventoryEvents = new InventoryEventBus();
inventoryEvents.setMaxListeners(0); // many concurrent SSE clients
