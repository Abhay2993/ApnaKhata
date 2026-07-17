/**
 * ApnaKhata — Mobile API client
 * -----------------------------
 * Thin typed fetch wrapper over the NestJS gateway. Auth token injection and
 * base URL come from app config; every method returns parsed JSON or throws
 * an ApiError with the server's message.
 */

const BASE_URL = 'https://api.apnakhata.in'; // overridden per environment at build time

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let authToken: string | null = null;
export const setAuthToken = (token: string | null): void => {
  authToken = token;
};

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const parsed = (await response.json()) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Contracts (mirrors backend service return shapes)
// ---------------------------------------------------------------------------
export interface PurchaseOrderSummary {
  id: string;
  poNumber: string;
  status: 'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';
  totalAmount: number;
}

export interface ScannedProduct {
  inventoryId: string;
  sku: string;
  productName: string;
  unit: string;
  barcode: string;
  currentStock: number;
  retailPrice: number;
  nearestExpiry: string | null;
}

export interface SaleReceipt {
  lines: { sku: string; quantity: number; lineTotal: number }[];
  total: number;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
export const api = {
  /** One-tap reorder: forecast recommendation → SUBMITTED purchase order. */
  createPurchaseOrderFromForecast: (inventoryId: string) =>
    request<PurchaseOrderSummary>('POST', '/v1/purchase-orders/from-forecast', { inventoryId }),

  /** Resolve a scanned barcode/QR to the signed-in owner's product. */
  lookupBarcode: (code: string) =>
    request<ScannedProduct | null>('GET', `/v1/inventory/barcode/${encodeURIComponent(code)}`),

  /** Scan-driven goods inward with optional batch + expiry. */
  stockInByBarcode: (input: {
    barcode: string;
    quantity: number;
    batchNumber?: string;
    expiryDate?: string;
  }) => request<{ batchId: string; newStock: number }>('POST', '/v1/inventory/stock-in', input),

  /** Scan-driven billing: sells FEFO and returns the priced receipt. */
  checkout: (lines: { barcode: string; quantity: number }[]) =>
    request<SaleReceipt>('POST', '/v1/billing/checkout', { lines }),
};
