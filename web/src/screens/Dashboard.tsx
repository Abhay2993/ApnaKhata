/**
 * Dashboard — web port of mobile/src/screens/DashboardScreen.tsx.
 * Same design tokens, layout, and demo data; the one-tap reorder is
 * simulated client-side (pending → ordered) since the preview has no backend.
 */

import { useMemo, useState } from 'react';

type RiskTier = 'PRIME' | 'SUBPRIME' | 'HIGH_RISK';
type OrderState = 'idle' | 'pending' | 'ordered';

interface StockAlert {
  id: string;
  productName: string;
  currentStock: number;
  unit: string;
  daysUntilStockout: number;
  recommendedOrderQty: number;
  distributorName: string;
  trend: number[];
}

const credit = {
  score: 782,
  tier: 'PRIME' as RiskTier,
  preApprovedLimit: 250000,
  partnerBank: 'HDFC Bank',
};

const cashFlow = { receivables: 184250, payables: 96400, todayCollections: 12750 };

const stockAlerts: StockAlert[] = [
  {
    id: '1',
    productName: 'Tata Salt 1kg',
    currentStock: 14,
    unit: 'PCS',
    daysUntilStockout: 2,
    recommendedOrderQty: 96,
    distributorName: 'Sharma Distributors',
    trend: [6, 8, 7, 9, 6, 11, 8, 10, 9, 12, 10, 13, 11, 12],
  },
  {
    id: '2',
    productName: 'Fortune Sunflower Oil 1L',
    currentStock: 22,
    unit: 'PCS',
    daysUntilStockout: 5,
    recommendedOrderQty: 48,
    distributorName: 'Agarwal Trading Co.',
    trend: [3, 4, 4, 5, 3, 6, 4, 5, 5, 4, 6, 5, 4, 5],
  },
  {
    id: '3',
    productName: 'Parle-G 800g Family Pack',
    currentStock: 35,
    unit: 'PCS',
    daysUntilStockout: 9,
    recommendedOrderQty: 60,
    distributorName: 'Sharma Distributors',
    trend: [4, 3, 5, 4, 4, 5, 3, 4, 5, 4, 3, 4, 5, 4],
  },
];

const inr = (value: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);

const urgencyColor = (days: number): string =>
  days <= 3 ? 'var(--danger)' : days <= 7 ? 'var(--gold-bright)' : 'var(--slate)';

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
  const [orderStates, setOrderStates] = useState<Record<string, OrderState>>({});

  const handleReorder = (id: string) => {
    setOrderStates((prev) => ({ ...prev, [id]: 'pending' }));
    // Demo mode: the live app calls POST /v1/purchase-orders/from-forecast here.
    window.setTimeout(() => {
      setOrderStates((prev) => ({ ...prev, [id]: 'ordered' }));
    }, 900);
  };

  return (
    <>
      <header className="header">
        <span className="wordmark">ApnaKhata</span>
        <span className="header-context">Gupta General Store</span>
      </header>

      <section className="card">
        <div className="passport-head">
          <span className="card-label">ApnaKhata Credit Passport</span>
          <span className="tier-chip">{credit.tier}</span>
        </div>
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
              Pre-approved · {credit.partnerBank}
            </div>
            <button type="button" className="btn-outline">
              EXPORT PASSPORT
            </button>
          </div>
        </div>
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
                {state === 'ordered'
                  ? `PO sent to ${item.distributorName}`
                  : `Depletes in ${item.daysUntilStockout} ${item.daysUntilStockout === 1 ? 'day' : 'days'}`}
              </span>
              <button
                type="button"
                className={`btn-order ${state}`}
                disabled={state !== 'idle'}
                onClick={() => handleReorder(item.id)}
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
