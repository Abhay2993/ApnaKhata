/**
 * Analytics — profit/margin, fastest movers, dead stock, and the
 * business-health score (DIO/DSO/DPO, cash-conversion cycle, runway).
 */

import { useEffect, useState } from 'react';

import { apiGet, isLiveConfigured } from '../api';
import { Card, Header, inr, Meter, Row, SectionHead, Tag } from '../components';
import { demo } from '../demo';

export default function Analytics() {
  const [live, setLive] = useState<'demo' | 'live'>('demo');
  const [profit, setProfit] = useState(demo.analytics.profit);
  const [health, setHealth] = useState(demo.analytics.health);

  useEffect(() => {
    if (!isLiveConfigured()) return;
    Promise.all([
      apiGet<typeof demo.analytics.profit>('/v1/analytics/profit'),
      apiGet<typeof demo.analytics.health>('/v1/analytics/health'),
    ]).then(([p, h]) => {
      let got = false;
      if (p) { setProfit(p); got = true; }
      if (h) { setHealth(h); got = true; }
      if (got) setLive('live');
    });
  }, []);

  const ratingTone = health.rating === 'STRONG' ? 'green' : health.rating === 'AT_RISK' ? 'red' : 'gold';

  return (
    <>
      <Header title="Analytics" badge={live === 'live' ? 'LIVE' : 'DEMO'} />

      <Card label="Business health">
        <div className="frow">
          <div>
            <div className="stat-value gold" style={{ fontSize: 30 }}>{health.healthScore}<span style={{ fontSize: 13, color: 'var(--slate)' }}>/100</span></div>
            <Tag tone={ratingTone}>{health.rating}</Tag>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="frow-sub">Cash-conversion cycle</div>
            <div className="stat-value">{health.cashConversionCycleDays ?? '—'} days</div>
          </div>
        </div>
        <div className="metric-grid">
          <div><span className="stat-label">Days inventory</span><div className="mval">{health.daysInventoryOutstanding ?? '—'}</div></div>
          <div><span className="stat-label">Days to collect</span><div className="mval">{health.daysSalesOutstanding ?? '—'}</div></div>
          <div><span className="stat-label">Days to pay</span><div className="mval">{health.daysPayableOutstanding ?? '—'}</div></div>
          <div><span className="stat-label">Daily profit</span><div className="mval gold">{inr(health.dailyGrossProfit)}</div></div>
        </div>
        {health.advice.map((a, i) => (
          <div key={i} className="advice">▸ {a}</div>
        ))}
      </Card>

      <Card label="Profit (last 90 days)">
        <div className="cash-grid">
          <div><span className="stat-label">Revenue</span><div className="stat-value">{inr(profit.summary.totalRevenue)}</div></div>
          <div><span className="stat-label">Gross profit</span><div className="stat-value gold">{inr(profit.summary.grossProfit)}</div></div>
        </div>
        <div className="frow" style={{ marginTop: 10 }}>
          <span className="frow-sub">Gross margin</span>
          <b className="gold">{profit.summary.grossMarginPct}%</b>
        </div>
        <Meter value={profit.summary.grossMarginPct / 30} />
      </Card>

      <SectionHead label="Fastest movers" />
      {profit.fastestMovers.map((p, i) => (
        <div key={i} className="alert-card">
          <Row
            left={p.productName}
            sub={`${p.unitsSold} sold · ${p.marginPct}% margin`}
            right={<b className="gold">{inr(p.grossProfit)}</b>}
          />
        </div>
      ))}

      <SectionHead label="Dead stock — capital tied up" note={inr(profit.summary.deadStockValue)} />
      {profit.deadStock.map((p, i) => (
        <div key={i} className="alert-card">
          <Row left={p.productName} sub="no sales in 90 days" right={<b style={{ color: 'var(--danger)' }}>{inr(p.stockValue)}</b>} />
        </div>
      ))}
    </>
  );
}
