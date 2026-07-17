/**
 * Dashboard — web port of mobile/src/screens/DashboardScreen.tsx.
 * Fetches the live dashboard from the API when VITE_API_URL is configured
 * (the docker-compose stack); otherwise renders demo data so the standalone
 * Vercel preview works with no backend. A LIVE/DEMO badge shows which.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  Dashboard as DashboardData,
  fetchDashboard,
  isLiveConfigured,
  reorderFromForecast,
} from '../api';

type RiskTier = 'PRIME' | 'SUBPRIME' | 'HIGH_RISK';
type OrderState = 'idle' | 'pending' | 'ordered';

interface StockAlert {
  id: string;
  inventoryId?: string;
  productName: string;
  currentStock: number;
  unit: string;
  daysUntilStockout: number | null;
  recommendedOrderQty: number;
  distributorName: string;
  trend: number[];
}

interface Credit {
  score: number;
  tier: RiskTier;
  preApprovedLimit: number;
  partnerBank: string;
}

interface CashFlow {
  receivables: number;
  payables: number;
  todayCollections: number;
}

interface ViewModel {
  businessName: string;
  credit: Credit | null;
  cashFlow: CashFlow;
  stockAlerts: StockAlert[];
}

const DEMO: ViewModel = {
  businessName: 'Gupta General Store',
  credit: { score: 782, tier: 'PRIME', preApprovedLimit: 250000, partnerBank: 'HDFC Bank' },
  cashFlow: { receivables: 184250, payables: 96400, todayCollections: 12750 },
  stockAlerts: [
    { id: '1', productName: 'Tata Salt 1kg', currentStock: 14, unit: 'PCS', daysUntilStockout: 2, recommendedOrderQty: 96, distributorName: 'Sharma Distributors', trend: [6, 8, 7, 9, 6, 11, 8, 10, 9, 12, 10, 13, 11, 12] },
    { id: '2', productName: 'Fortune Sunflower Oil 1L', currentStock: 22, unit: 'PCS', daysUntilStockout: 5, recommendedOrderQty: 48, distributorName: 'Agarwal Trading Co.', trend: [3, 4, 4, 5, 3, 6, 4, 5, 5, 4, 6, 5, 4, 5] },
    { id: '3', productName: 'Parle-G 800g Family Pack', currentStock: 35, unit: 'PCS', daysUntilStockout: 9, recommendedOrderQty: 60, distributorName: 'Sharma Distributors', trend: [4, 3, 5, 4, 4, 5, 3, 4, 5, 4, 3, 4, 5, 4] },
  ],
};

// A gently varied sparkline seed so live alerts (no historical trend yet) still
// render a line rather than a flat bar.
const PLACEHOLDER_TREND = [5, 6, 5, 7, 6, 8, 6, 7, 8, 7, 9, 8, 7, 9];

function toViewModel(d: DashboardData): ViewModel {
  return {
    businessName: d.businessName,
    credit: d.credit
      ? {
          score: d.credit.score,
          tier: d.credit.tier,
          preApprovedLimit: d.credit.preApprovedLimit,
          partnerBank: d.credit.partnerBank,
        }
      : null,
    cashFlow: d.cashFlow,
    stockAlerts: d.stockAlerts.map((a) => ({
      id: a.inventoryId,
      inventoryId: a.inventoryId,
      productName: a.productName,
      currentStock: a.currentStock,
      unit: a.unit,
      daysUntilStockout: a.daysUntilStockout,
      recommendedOrderQty: a.recommendedOrderQty,
      distributorName: a.distributorName,
      trend: PLACEHOLDER_TREND,
    })),
  };
}

const inr = (value: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);

const urgencyColor = (days: number | null): string =>
  days === null ? 'var(--slate)' : days <= 3 ? 'var(--danger)' : days <= 7 ? 'var(--gold-bright)' : 'var(--slate)';

const depletionText = (days: number | null): string =>
  days === null ? 'Below reorder threshold' : `Depletes in ${days} ${days === 1 ? 'day' : 'days'}`;

/** 240° gold gauge, identical geometry to the mobile ScoreArc. */
function ScoreArc({ score }: { score: number }) {
  const size = 168;
  const strokeWidth = 7;
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const startAngle = 150;
  const sweep = 240;
  const progress = Math.min(Math.max((score - 300) / 600, 0), 1);

  const polar = (deg: number) => {
    const rad = (Math.PI / 180) * deg;
    return { x: center + radius * Math.cos(rad), y: center + radius * Math.sin(rad) };
  };
  const arcPath = (from: number, to: number) => {
    const a = polar(from);
    const b = polar(to);
    const large = to - from > 180 ? 1 : 0;
    return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${large} 1 ${b.x} ${b.y}`;
  };
  const dot = polar(startAngle + sweep * progress);

  return (
    <svg width={size} height={size}>
      <path
        d={arcPath(startAngle, startAngle + sweep)}
        stroke="#2a3542"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
      />
      <path
        d={arcPath(startAngle, startAngle + Math.max(sweep * progress, 1))}
        stroke="var(--gold)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
      />
      <circle cx={dot.x} cy={dot.y} r={strokeWidth} fill="var(--gold-bright)" />
    </svg>
  );
}

function Sparkline({ data, width = 72, height = 24 }: { data: number[]; width?: number; height?: number }) {
  const points = useMemo(() => {
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const span = max - min || 1;
    const stepX = width / (data.length - 1 || 1);
    return data
      .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
      .join(' ');
  }, [data, width, height]);

  return (
    <svg width={width} height={height}>
      <polyline points={points} fill="none" stroke="var(--slate)" strokeWidth={1.5} strokeOpacity={0.7} />
    </svg>
  );
}

export default function Dashboard() {
  const [vm, setVm] = useState<ViewModel>(DEMO);
  const [mode, setMode] = useState<'demo' | 'live' | 'loading'>(isLiveConfigured() ? 'loading' : 'demo');
  const [orderStates, setOrderStates] = useState<Record<string, OrderState>>({});

  useEffect(() => {
    if (!isLiveConfigured()) return;
    const ctrl = new AbortController();
    fetchDashboard(ctrl.signal)
      .then((d) => {
        setVm(toViewModel(d));
        setMode('live');
      })
      .catch(() => setMode('demo')); // API unreachable → keep demo data
    return () => ctrl.abort();
  }, []);

  const handleReorder = (item: StockAlert) => {
    setOrderStates((prev) => ({ ...prev, [item.id]: 'pending' }));
    if (mode === 'live' && item.inventoryId) {
      reorderFromForecast(item.inventoryId)
        .then(() => setOrderStates((prev) => ({ ...prev, [item.id]: 'ordered' })))
        .catch(() => setOrderStates((prev) => ({ ...prev, [item.id]: 'idle' })));
    } else {
      window.setTimeout(() => setOrderStates((prev) => ({ ...prev, [item.id]: 'ordered' })), 900);
    }
  };

  const { credit, cashFlow, stockAlerts } = vm;

  return (
    <>
      <header className="header">
        <span className="wordmark">ApnaKhata</span>
        <span className="header-context">
          {vm.businessName}
          <span className={`mode-badge ${mode}`}>{mode === 'live' ? 'LIVE' : mode === 'loading' ? '…' : 'DEMO'}</span>
        </span>
      </header>

      <section className="card">
        <div className="passport-head">
          <span className="card-label">ApnaKhata Credit Passport</span>
          {credit && <span className="tier-chip">{credit.tier}</span>}
        </div>
        {credit ? (
          <div className="passport-body">
            <div className="arc-wrap">
              <ScoreArc score={credit.score} />
              <div className="arc-score">
                <span className="value">{credit.score}</span>
                <span className="of">OF 900</span>
              </div>
            </div>
            <div className="loan-col">
              <span className="stat-label">Working capital</span>
              <div className="amount">{inr(credit.preApprovedLimit)}</div>
              <div className="status">
                {credit.tier === 'PRIME' ? 'Pre-approved' : credit.tier === 'SUBPRIME' ? 'Under review' : 'Building eligibility'} · {credit.partnerBank}
              </div>
              <button type="button" className="btn-outline">
                EXPORT PASSPORT
              </button>
            </div>
          </div>
        ) : (
          <div className="status" style={{ padding: '18px 0' }}>
            No credit score yet — trade activity builds your passport.
          </div>
        )}
      </section>

      <section className="card">
        <span className="card-label">Cash Flow</span>
        <div className="cash-grid">
          <div>
            <span className="stat-label">To Receive</span>
            <div className="stat-value gold">{inr(cashFlow.receivables)}</div>
          </div>
          <div>
            <span className="stat-label">To Pay</span>
            <div className="stat-value">{inr(cashFlow.payables)}</div>
          </div>
        </div>
        <div className="cash-foot">
          <span className="stat-label">Collected today</span>
          <div className="stat-value">{inr(cashFlow.todayCollections)}</div>
        </div>
      </section>

      <div className="section-head">
        <span className="card-label">Stock Alerts</span>
        <span className="section-note">Forecast · next 45 days</span>
      </div>

      {stockAlerts.length === 0 && <div className="cart-empty">No stock alerts — inventory looks healthy.</div>}

      {stockAlerts.map((item) => {
        const state = orderStates[item.id] ?? 'idle';
        return (
          <article key={item.id} className="alert-card">
            <div className="alert-top">
              <div style={{ minWidth: 0 }}>
                <div className="alert-name">{item.productName}</div>
                <div className="alert-meta">
                  {item.currentStock} {item.unit} left · {item.distributorName}
                </div>
              </div>
              <Sparkline data={item.trend} />
            </div>
            <div className="alert-bottom">
              <span className="urgency" style={{ color: urgencyColor(item.daysUntilStockout) }}>
                <span className="dot" style={{ background: urgencyColor(item.daysUntilStockout) }} />
                {state === 'ordered' ? `PO sent to ${item.distributorName}` : depletionText(item.daysUntilStockout)}
              </span>
              <button
                type="button"
                className={`btn-order ${state}`}
                disabled={state !== 'idle'}
                onClick={() => handleReorder(item)}
              >
                {state === 'pending'
                  ? 'PLACING…'
                  : state === 'ordered'
                    ? 'ORDERED ✓'
                    : `ORDER ${item.recommendedOrderQty}`}
              </button>
            </div>
          </article>
        );
      })}
    </>
  );
}
