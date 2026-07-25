/**
 * Benchmarks — peer / consortium intelligence.
 * Anonymised comparison against "shops like yours": margin percentile, products
 * where you lag peers, and fast-movers peers carry that you don't. Impossible
 * without network scale — the pure-data moat. Live against
 * /v1/analytics/benchmarks; canned data drives the standalone demo.
 */

import { useEffect, useState } from 'react';

import { Benchmarks as BenchmarksT, fetchBenchmarks, isLiveConfigured } from '../api';
import { Card, Header, Meter, Row, SectionHead, Tag } from '../components';

const DEMO: BenchmarksT = {
  cohort: { size: 4, basis: 'shops in state 27' },
  margin: { yoursPct: 14.9, peerMedianPct: 14.2, percentile: 75, verdict: 'above' },
  laggingProducts: [
    { sku: 'PARLE-G-800', productName: 'Parle-G 800g Family Pack', yourWeeklyUnits: 13.5, peerMedianWeeklyUnits: 33.8, gapPct: 60 },
    { sku: 'FORT-OIL-1L', productName: 'Fortune Sunflower Oil 1L', yourWeeklyUnits: 7, peerMedianWeeklyUnits: 14, gapPct: 50 },
  ],
  assortmentGaps: [
    { sku: 'MAGGI-2MIN-12', productName: 'Maggi 2-Minute Noodles 12x70g', category: 'Grocery', peerCarryingPct: 75, peerMedianWeeklyUnits: 20.3 },
    { sku: 'AMUL-BUTTER-500', productName: 'Amul Butter 500g', category: 'Dairy', peerCarryingPct: 75, peerMedianWeeklyUnits: 13.5 },
    { sku: 'COLGATE-100G', productName: 'Colgate MaxFresh 100g', category: 'Personal Care', peerCarryingPct: 75, peerMedianWeeklyUnits: 13.5 },
    { sku: 'SURF-EXCEL-1KG', productName: 'Surf Excel 1kg', category: 'Home Care', peerCarryingPct: 75, peerMedianWeeklyUnits: 13.5 },
  ],
  insights: [
    'Your gross margin (14.9%) beats 75% of peers — strong pricing discipline.',
    'Peers sell 60% more Parle-G 800g Family Pack than you — worth a shelf-position or stock review.',
    '5 fast-movers peers carry that you don’t — top: Maggi 2-Minute Noodles 12x70g, Amul Butter 500g, Colgate MaxFresh 100g.',
  ],
};

export default function Benchmarks() {
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [b, setB] = useState<BenchmarksT>(DEMO);

  useEffect(() => {
    if (!isLiveConfigured()) return;
    fetchBenchmarks().then((res) => { if (res && res.cohort.size > 0) { setB(res); setMode('live'); } });
  }, []);

  const m = b.margin;
  const verdictTone = m?.verdict === 'above' ? 'green' : m?.verdict === 'below' ? 'red' : 'gold';

  return (
    <>
      <Header title="Benchmarks" badge={mode === 'live' ? 'LIVE' : 'DEMO'} />
      <p className="status-line" style={{ marginTop: 2 }}>
        Anonymised vs {b.cohort.size} {b.cohort.basis} — no individual shop is ever named.
      </p>

      {b.insights.map((i, idx) => (
        <div key={idx} className="advice" style={{ marginTop: idx === 0 ? 8 : 6 }}>▸ {i}</div>
      ))}

      {m && (
        <Card label="Gross margin vs peers">
          <div className="cash-grid" style={{ marginTop: 4 }}>
            <div><span className="stat-label">You</span><div className="stat-value gold">{m.yoursPct}%</div></div>
            <div><span className="stat-label">Peer median</span><div className="stat-value">{m.peerMedianPct}%</div></div>
          </div>
          <div className="frow" style={{ marginTop: 10 }}>
            <span className="frow-sub">You beat {m.percentile}% of peers</span>
            <Tag tone={verdictTone}>{m.verdict.toUpperCase()}</Tag>
          </div>
          <div style={{ marginTop: 8 }}><Meter value={m.percentile / 100} tone={verdictTone === 'red' ? 'red' : 'gold'} /></div>
        </Card>
      )}

      {b.laggingProducts.length > 0 && (
        <>
          <SectionHead label="You sell less than peers" note="weekly units" />
          {b.laggingProducts.map((l) => (
            <div key={l.sku} className="alert-card">
              <Row
                left={l.productName}
                sub={`You ${l.yourWeeklyUnits}/wk · peers ${l.peerMedianWeeklyUnits}/wk`}
                right={<Tag tone="red">−{l.gapPct}%</Tag>}
              />
            </div>
          ))}
        </>
      )}

      {b.assortmentGaps.length > 0 && (
        <>
          <SectionHead label="Stock these — peers do, you don't" note={`${b.assortmentGaps.length} gaps`} />
          {b.assortmentGaps.map((g) => (
            <div key={g.sku} className="alert-card">
              <Row
                left={g.productName}
                sub={`${g.category} · ${g.peerCarryingPct}% of peers carry it`}
                right={<div style={{ textAlign: 'right' }}><b className="gold">~{g.peerMedianWeeklyUnits}/wk</b><div className="frow-sub">peer demand</div></div>}
              />
            </div>
          ))}
        </>
      )}
    </>
  );
}
