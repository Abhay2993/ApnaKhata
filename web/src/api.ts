/**
 * ApnaKhata web — API client
 * --------------------------
 * When VITE_API_URL is configured (the full docker-compose stack), the app
 * fetches the live dashboard from the gateway. Otherwise it falls back to demo
 * data so the standalone Vercel preview still works with zero backend.
 */

export interface DashboardCredit {
  score: number;
  tier: 'PRIME' | 'SUBPRIME' | 'HIGH_RISK';
  loanStatus: 'PRE_APPROVED' | 'UNDER_REVIEW' | 'NOT_ELIGIBLE';
  preApprovedLimit: number;
  partnerBank: string;
}

export interface DashboardCashFlow {
  receivables: number;
  payables: number;
  todayCollections: number;
}

export interface DashboardStockAlert {
  inventoryId: string;
  productName: string;
  sku: string;
  currentStock: number;
  unit: string;
  daysUntilStockout: number | null;
  recommendedOrderQty: number;
  distributorName: string;
}

export interface Dashboard {
  businessName: string;
  credit: DashboardCredit | null;
  cashFlow: DashboardCashFlow;
  stockAlerts: DashboardStockAlert[];
}

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
const API_KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? 'demo-key';
const USER_ID =
  (import.meta.env.VITE_DEMO_USER_ID as string | undefined) ?? '22222222-2222-2222-2222-222222222222';

export const isLiveConfigured = (): boolean => Boolean(API_URL);
export const demoUserId = (): string => USER_ID;

function headers(): HeadersInit {
  return { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'x-user-id': USER_ID };
}

/** Generic GET; returns null (rather than throwing) so screens can fall back to demo. */
export async function apiGet<T>(path: string): Promise<T | null> {
  if (!API_URL) return null;
  try {
    const res = await fetch(`${API_URL}${path}`, { headers: headers() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  if (!API_URL) return null;
  try {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchDashboard(signal?: AbortSignal): Promise<Dashboard> {
  if (!API_URL) throw new Error('no API configured');
  const res = await fetch(`${API_URL}/v1/dashboard`, { headers: headers(), signal });
  if (!res.ok) throw new Error(`dashboard request failed: ${res.status}`);
  return (await res.json()) as Dashboard;
}

export async function reorderFromForecast(inventoryId: string): Promise<{ poNumber: string }> {
  if (!API_URL) throw new Error('no API configured');
  const res = await fetch(`${API_URL}/v1/purchase-orders/from-forecast`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ inventoryId }),
  });
  if (!res.ok) throw new Error(`reorder failed: ${res.status}`);
  return (await res.json()) as { poNumber: string };
}

// --- Marketplace ---
export interface DealerSampleProduct {
  sku: string;
  productName: string;
  wholesalePrice: number;
  moq: number;
  unit: string;
}

export interface DealerResult {
  dealerId: string;
  businessName: string;
  city: string | null;
  productCount: number;
  minLeadTimeDays: number | null;
  sampleProducts: DealerSampleProduct[];
}

export interface CatalogItem {
  sku: string;
  productName: string;
  category: string;
  wholesalePrice: number;
  mrp: number | null;
  moq: number;
  unit: string;
  leadTimeDays: number;
}

export async function searchDealers(query: string): Promise<DealerResult[]> {
  if (!API_URL) throw new Error('no API configured');
  const res = await fetch(`${API_URL}/v1/dealers/search?q=${encodeURIComponent(query)}`, { headers: headers() });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return (await res.json()) as DealerResult[];
}

export async function getCatalog(dealerId: string): Promise<CatalogItem[]> {
  if (!API_URL) throw new Error('no API configured');
  const res = await fetch(`${API_URL}/v1/dealers/${dealerId}/catalog`, { headers: headers() });
  if (!res.ok) throw new Error(`catalog failed: ${res.status}`);
  return (await res.json()) as CatalogItem[];
}

export async function orderFromCatalog(
  dealerId: string,
  lines: { sku: string; quantity: number }[],
): Promise<{ poNumber: string; totalAmount: number }> {
  if (!API_URL) throw new Error('no API configured');
  const res = await fetch(`${API_URL}/v1/purchase-orders/from-catalog`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ dealerId, lines }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(err.message ?? `order failed: ${res.status}`);
  }
  return (await res.json()) as { poNumber: string; totalAmount: number };
}

// --- Customer khata (voice + vernacular) ---
export interface CustomerBalance {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  lastActivity: string | null;
}

export interface VoiceResult {
  command: {
    intent: 'RECORD_CREDIT' | 'RECORD_PAYMENT' | 'UNKNOWN';
    party: string | null;
    amount: number | null;
    confidence: 'high' | 'medium' | 'low';
    transcript: string;
  };
  posted: boolean;
  reason?: string;
  result?: { customer: CustomerBalance; entry: { entryType: 'CREDIT' | 'PAYMENT'; amount: number } };
}

export async function listCustomers(): Promise<CustomerBalance[] | null> {
  return apiGet<CustomerBalance[]>('/v1/customers');
}

export async function recordVoiceLedger(transcript: string): Promise<VoiceResult | null> {
  return apiPost<VoiceResult>('/v1/voice/ledger', { transcript });
}
