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

export interface DealerReliability {
  rating: number;
  band: 'EXCELLENT' | 'RELIABLE' | 'MIXED' | 'POOR' | 'NEW';
  onTimeRate: number | null;
  completionRate: number | null;
  disputeRate: number | null;
  observations: number;
}

export interface DealerResult {
  dealerId: string;
  businessName: string;
  city: string | null;
  productCount: number;
  minLeadTimeDays: number | null;
  sampleProducts: DealerSampleProduct[];
  reliability?: DealerReliability | null;
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

// --- Offline-first sync ---
export interface SyncOperation {
  opId: string;
  type: 'CUSTOMER_LEDGER_ENTRY';
  clientTs?: string;
  payload: {
    customerName: string;
    entryType: 'CREDIT' | 'PAYMENT';
    amount: number;
    source?: 'VOICE' | 'MANUAL' | 'WHATSAPP';
    transcript?: string;
  };
}

export interface SyncPushResult {
  results: { opId: string; status: 'APPLIED' | 'DUPLICATE' | 'REJECTED'; ref?: string; reason?: string }[];
  cursor: number;
}

export async function syncPush(deviceId: string, operations: SyncOperation[]): Promise<SyncPushResult | null> {
  return apiPost<SyncPushResult>('/v1/sync/push', { deviceId, operations });
}

// --- Cash drawer ---
export interface DrawerSummary {
  id: string;
  businessDate: string;
  status: 'OPEN' | 'CLOSED';
  openingBalance: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number | null;
  variance: number | null;
  movementCount: number;
}

export const getDrawerToday = () => apiGet<DrawerSummary | { status: 'NOT_OPENED' }>('/v1/cash-drawer/today');
export const openDrawer = (openingBalance: number) => apiPost<DrawerSummary>('/v1/cash-drawer/open', { openingBalance });
export const addDrawerMovement = (direction: 'IN' | 'OUT', amount: number, reason?: string) =>
  apiPost<DrawerSummary>('/v1/cash-drawer/movements', { direction, amount, reason });
export const closeDrawer = (countedClosing: number) => apiPost<DrawerSummary>('/v1/cash-drawer/close', { countedClosing });

// --- Festival planner ---
export interface FestivalPlan {
  festival: { name: string; date: string; daysAway: number; uplift: number; windowDays: number };
  items: {
    sku: string;
    productName: string;
    currentStock: number;
    unit: string;
    suggestedOrderQty: number;
    orderByDate: string;
    distributorName: string | null;
  }[];
  advice: string;
}

export const fetchFestivalPlan = () => apiGet<FestivalPlan[]>('/v1/festivals/plan');

// --- UPI AutoPay mandates ---
export interface Mandate {
  id: string;
  maxAmount: number;
  frequency: 'WEEKLY' | 'MONTHLY';
  umn: string | null;
  status: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'REVOKED';
  nextDebitDate: string | null;
}

export const listMandates = () => apiGet<Mandate[]>('/v1/mandates');

// --- Anchor-led supply-chain finance (OCEN + Account Aggregator) ---
export interface AnchorRelationship {
  anchorId: string;
  anchorName: string;
  invoiceCount: number;
  totalTrade: number;
  outstanding: number;
  tenureMonths: number;
  onTimeRate: number | null;
  strength: number;
}

export interface AaSummary {
  avgMonthlyInflow: number;
  avgMonthlyOutflow: number;
  avgBalance: number;
  minBalance: number;
  bounceCount: number;
  months: number;
}

export interface LoanOffer {
  id: string;
  lenderKey: string;
  lenderName: string;
  sanctionedAmount: number;
  interestRatePct: number;
  tenureDays: number;
  processingFee: number;
  emiAmount: number;
  totalRepayable: number;
  status: string;
}

export interface LoanApplication {
  id: string;
  status: string;
  riskGrade: string | null;
  recommendedLimit: number | null;
  anchorStrength: number | null;
  creditScore: number | null;
  underwriting: { usedAccountAggregator: boolean; rationale: string[] } | null;
  offers?: LoanOffer[];
}

export interface DisbursedLoan {
  id: string;
  lenderName: string;
  principal: number;
  interestRatePct: number;
  disbursedToAnchor: number;
}

/** The demo anchor: Sharma Distributors (the shopkeeper's preferred supplier). */
export const ANCHOR_ID = '11111111-1111-1111-1111-111111111111';

export const getAnchorRelationship = (anchorId: string) =>
  apiGet<AnchorRelationship>(`/v1/scf/anchor/${anchorId}`);

/** Run the whole AA handshake (create → approve → fetch) and return the summary. */
export async function connectBankViaAA(): Promise<AaSummary | null> {
  const consent = await apiPost<{ id: string }>('/v1/aa/consents', { months: 6 });
  if (!consent) return null;
  await apiPost(`/v1/aa/consents/${consent.id}/approve`, {});
  return apiPost<AaSummary>(`/v1/aa/consents/${consent.id}/fetch`, {});
}

export const createLoanApplication = (body: { anchorId: string; amountRequested: number; tenureDays?: number }) =>
  apiPost<LoanApplication>('/v1/scf/applications', body);

export const acceptLoanOffer = (applicationId: string, offerId: string) =>
  apiPost<{ loan: DisbursedLoan; application: LoanApplication }>(`/v1/scf/applications/${applicationId}/accept`, { offerId });
