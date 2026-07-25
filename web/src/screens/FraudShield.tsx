/**
 * Fraud Shield — the fraud & trust graph.
 * Your own lender-facing trust score, plus network alerts detected across the
 * transaction graph: circular-trading rings, structuring, and templated
 * billing. Raise a case on any alert and work it to resolution. Live against
 * /v1/fraud; canned data drives the standalone demo.
 */

import { useEffect, useState } from 'react';

import {
  FraudCase,
  fetchFraudCases,
  fetchFraudScan,
  fetchNetworkAlerts,
  isLiveConfigured,
  NetworkAlerts,
  raiseFraudCase,
  resolveFraudCase,
  TradeRing,
  TrustReport,
} from '../api';
import { Card, Header, inr, Row, SectionHead, Tag } from '../components';

const DEMO_SCAN: TrustReport = {
  entityId: 'me', entityName: 'Gupta General Store', trustScore: 100, band: 'TRUSTED', flags: [], rings: [],
};
const DEMO_ALERTS: NetworkAlerts = {
  rings: [{
    members: [{ id: 'a', name: 'Alpha Traders' }, { id: 'b', name: 'Beta Enterprises' }, { id: 'c', name: 'Gamma Trading' }],
    edges: [
      { from: 'Alpha Traders', to: 'Beta Enterprises', total: 92000, invoices: 1 },
      { from: 'Beta Enterprises', to: 'Gamma Trading', total: 94500, invoices: 1 },
      { from: 'Gamma Trading', to: 'Alpha Traders', total: 93000, invoices: 1 },
    ],
    totalValue: 279500, circularity: 0.97, suspicion: 'HIGH',
  }],
  riskyEntities: [
    { entityId: 'c', entityName: 'Gamma Trading', trustScore: 38, band: 'HIGH_RISK', flags: [
      { type: 'CIRCULAR_TRADE', severity: 'HIGH', label: 'part of a 3-party trading loop', detail: '' },
      { type: 'DUPLICATE_BILLING', severity: 'HIGH', label: '3 invoices of an identical amount', detail: '' }] },
    { entityId: 'a', entityName: 'Alpha Traders', trustScore: 40, band: 'ELEVATED', flags: [
      { type: 'STRUCTURING', severity: 'HIGH', label: '3 invoices just under ₹50,000', detail: '' },
      { type: 'CIRCULAR_TRADE', severity: 'HIGH', label: 'part of a 3-party trading loop', detail: '' }] },
    { entityId: 'b', entityName: 'Beta Enterprises', trustScore: 40, band: 'ELEVATED', flags: [
      { type: 'STRUCTURING', severity: 'HIGH', label: '3 invoices just under ₹50,000', detail: '' },
      { type: 'CIRCULAR_TRADE', severity: 'HIGH', label: 'part of a 3-party trading loop', detail: '' }] },
  ],
};

const bandTone = (b: string) => (b === 'TRUSTED' ? 'green' : b === 'MONITOR' ? 'gold' : 'red');
const flagLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase();

export default function FraudShield() {
  const live = isLiveConfigured();
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [scan, setScan] = useState<TrustReport>(DEMO_SCAN);
  const [alerts, setAlerts] = useState<NetworkAlerts>(DEMO_ALERTS);
  const [cases, setCases] = useState<FraudCase[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refreshCases = () => { if (live) fetchFraudCases().then((c) => c && setCases(c)); };
  useEffect(() => {
    if (!live) return;
    Promise.all([fetchFraudScan(), fetchNetworkAlerts()]).then(([s, a]) => {
      setMode('live');
      if (s) setScan(s); if (a) setAlerts(a);
    });
    refreshCases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const raise = async (ring: TradeRing) => {
    setBusy('raise');
    const label = ring.members.map((m) => m.name).join(' → ');
    if (mode === 'live') {
      const c = await raiseFraudCase({ caseType: 'CIRCULAR_TRADE', severity: ring.suspicion, subjectLabel: label });
      if (c) setCases((prev) => [c, ...prev]);
    } else {
      await pause();
      setCases((prev) => [{ id: `d${Date.now()}`, caseType: 'CIRCULAR_TRADE', severity: ring.suspicion, subjectLabel: label, status: 'OPEN', createdAt: new Date().toISOString() }, ...prev]);
    }
    setBusy(null);
    setNote('Case opened — flagged for review.');
  };

  const resolve = async (c: FraudCase, status: string) => {
    setBusy(c.id);
    if (mode === 'live') { const r = await resolveFraudCase(c.id, status); if (r) setCases((prev) => prev.map((x) => (x.id === c.id ? r : x))); }
    else { await pause(); setCases((prev) => prev.map((x) => (x.id === c.id ? { ...x, status } : x))); }
    setBusy(null);
  };

  return (
    <>
      <Header title="Fraud Shield" badge={mode === 'live' ? 'LIVE' : 'DEMO'} />

      {/* Your trust score */}
      <Card label="Your trust score">
        <div className="frow">
          <div>
            <div className="stat-value gold" style={{ fontSize: 40 }}>{scan.trustScore}<span style={{ fontSize: 14, color: 'var(--slate)' }}>/100</span></div>
            <Tag tone={bandTone(scan.band)}>{scan.band}</Tag>
          </div>
          <div style={{ textAlign: 'right', maxWidth: '55%' }}>
            <div className="frow-sub">A graph-derived integrity score — the signal lenders and the marketplace see alongside your Credit Passport.</div>
          </div>
        </div>
        {scan.flags.length === 0
          ? <div className="advice" style={{ marginTop: 12 }}>▸ No fraud signals on your account — clean transaction graph.</div>
          : scan.flags.map((f, i) => <div key={i} className="advice" style={{ marginTop: 8, color: 'var(--danger)' }}>▸ {f.label}</div>)}
      </Card>

      {/* Network ring alerts */}
      <SectionHead label="Circular-trade rings" note={`${alerts.rings.length} detected`} />
      {alerts.rings.length === 0 && <div className="cart-empty">No trading loops detected on the network.</div>}
      {alerts.rings.map((ring, i) => (
        <article key={i} className="alert-card" style={{ borderColor: 'rgba(180,84,75,0.4)' }}>
          <div className="alert-top">
            <div style={{ minWidth: 0 }}>
              <div className="alert-name">{ring.members.map((m) => m.name.split(' ')[0]).join(' → ')} → back</div>
              <div className="alert-meta">{ring.members.length}-party loop · round-trips {inr(ring.totalValue)} · {Math.round(ring.circularity * 100)}% balanced</div>
            </div>
            <Tag tone="red">{ring.suspicion}</Tag>
          </div>
          <div className="alert-bottom">
            <span className="urgency" style={{ color: 'var(--danger)' }}><span className="dot" style={{ background: 'var(--danger)' }} />Circular trading — likely fake turnover / ITC</span>
            <button type="button" className="btn-order idle" disabled={busy === 'raise'} onClick={() => raise(ring)}>
              {busy === 'raise' ? 'OPENING…' : 'RAISE CASE'}
            </button>
          </div>
        </article>
      ))}

      {/* Risky entities */}
      <SectionHead label="High-risk entities" note={`${alerts.riskyEntities.length}`} />
      {alerts.riskyEntities.map((e) => (
        <div key={e.entityId} className="alert-card">
          <Row
            left={e.entityName}
            sub={e.flags.map((f) => flagLabel(f.type)).join(' · ')}
            right={<div style={{ textAlign: 'right' }}><b style={{ color: 'var(--danger)' }}>{e.trustScore}<span style={{ fontSize: 11, color: 'var(--slate)' }}>/100</span></b><div className="frow-sub"><Tag tone="red">{e.band}</Tag></div></div>}
          />
        </div>
      ))}

      {/* Cases */}
      {cases.length > 0 && (
        <>
          <SectionHead label="Cases" note={`${cases.length}`} />
          {cases.map((c) => (
            <div key={c.id} className="alert-card">
              <Row
                left={c.subjectLabel}
                sub={`${c.caseType.replace(/_/g, ' ')} · ${c.severity}`}
                right={
                  c.status === 'OPEN'
                    ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="voice-record" disabled={busy === c.id} onClick={() => resolve(c, 'CONFIRMED')}>CONFIRM</button>
                        <button type="button" className="voice-record" disabled={busy === c.id} onClick={() => resolve(c, 'DISMISSED')}>DISMISS</button>
                      </div>
                    )
                    : <Tag tone={c.status === 'CONFIRMED' ? 'red' : 'slate'}>{c.status}</Tag>
                }
              />
            </div>
          ))}
        </>
      )}

      {note && <p className="status-line">{note}</p>}
    </>
  );
}

const pause = () => new Promise<void>((r) => setTimeout(r, 450));
