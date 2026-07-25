/**
 * ApnaKhata — ONDC network gateway
 * --------------------------------
 * The Open Network for Digital Commerce lets any seller list on a shared,
 * interoperable network instead of a single marketplace. ApnaKhata acts as the
 * seller app: it publishes the kirana's catalogue to ONDC and receives orders
 * back. This interface keeps the service network-agnostic; the sandbox stands
 * in for a real ONDC seller-node adapter (Beckn protocol over the registry).
 */

import { randomBytes } from 'crypto';

export interface OndcCatalogItem {
  sku: string;
  name: string;
  price: number;
  category: string;
  unit: string;
}

export interface OndcPublishResult {
  networkListingId: string;
  published: number;
  storefrontHandle: string;
}

export interface OndcGateway {
  publish(sellerId: string, storeName: string, items: OndcCatalogItem[]): Promise<OndcPublishResult>;
}

export class SandboxOndcGateway implements OndcGateway {
  async publish(sellerId: string, storeName: string, items: OndcCatalogItem[]): Promise<OndcPublishResult> {
    const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'store';
    return {
      networkListingId: `ONDC-${randomBytes(5).toString('hex').toUpperCase()}`,
      published: items.length,
      storefrontHandle: `${slug}.ondc.apnakhata.in`,
    };
  }
}
