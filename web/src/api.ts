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

function headers(): HeadersInit {
  return { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'x-user-id': USER_ID };
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
