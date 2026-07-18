/**
 * Credit & Loans — passport score, what-if simulator, score trend, BNPL
 * financing, and partner-bank pre-approvals.
 */

import { useEffect, useState } from 'react';

import { apiGet, isLiveConfigured } from '../api';
import { Card, Header, inr, Meter, ScoreArc, SectionHead, Sparkline, Tag } from '../components';
import { demo } from '../demo';

type Tier = 'PRIME' | 'SUBPRIME' | 'HIGH_RISK';

export default function Credit() {
  const [live, setLive] = useState<'demo' | 'live'>('demo');
  const [score, setScore] = useState(demo.credit.score);
  const [tier, setTier] = useState<Tier>(demo.credit.tier);
  const [pillars, setPillars] = useState(demo.credit.pillars);
  const [history, setHistory] = useState<number[]>(demo.credit.history);
  const [suggestions, setSuggestions] = useState(demo.credit.suggestions);
  const [bnpl, setBnpl] = useState(demo.credit.bnpl);
  const [lenders, setLenders] = useState(demo.credit.lenders);

  useEffect(() => {
    if (!isLiveConfigured()) return;
    let got = false;
    Promise.all([
      apiGet<{ score: number; tier: Tier; pillars: typeof demo.credit.pillars }>('/v1/credit/score'),
      apiGet<{ points: { score: number }[] }>('/v1/credit/history'),
      apiGet<{ suggestions: { label: string; scoreDelta: number }[] }>('/v1/credit/suggestions'),
      apiGet<typeof demo.credit.bnpl>('/v1/credit/bnpl/offer'),
      apiGet<typeof demo.credit.lenders>('/v1/credit/lender-submissions'),
    ]).then(([sc, hist, sug, offer, lend]) => {
      if (sc) { setScore(sc.score); setTier(sc.tier); setPillars(sc.pillars); got = true; }
      if (hist && hist.points.length) { setHistory(hist.points.map((p) => p.score)); got = true; }
      if (sug && sug.suggestions.length) { setSuggestions(sug.suggestions); got = true; }
      if (offer) { setBnpl(offer); got = true; }
      if (lend && Array.isArray(lend)) { setLenders(lend); got = true; }
      if (got) setLive('live');
    });
  }, []);

  const loanStatus = tier === 'PRIME' ? 'Pre-approved' : tier === 'SUBPRIME' ? 'Under review' : 'Building eligibility';

  return (
    <>
      <Header title="Credit & Loans" badge={live === 'live' ? 'LIVE' : 'DEMO'} />

      <Card>
        <div className="passport-head">
          <span className="card-label">ApnaKhata Credit Passport</span>
          <Tag tone={tier === 'PRIME' ? 'green' : tier === 'SUBPRIME' ? 'gold' : 'red'}>{tier}</Tag>
        </div>
        <div className="passport-body">
          <div className="arc-wrap" style={{ width: 150, height: 150 }}>
            <ScoreArc score={score} size={150} />
            <div className="arc-score"><span className="value">{score}</span><span className="of">OF 900</span></div>
          </div>
          <div className="loan-col">
            <span className="stat-label">Working capital</span>
            <div className="amount">{inr(bnpl.approvedLimit)}</div>
            <div className="status">{loanStatus} · {demo.credit.partnerBank}</div>
            <button type="button" className="btn-outline">EXPORT PASSPORT PDF</button>
          </div>
        </div>
        <div className="pillars">
          {[['Repayment', pillars.repaymentVelocity], ['Consistency', pillars.transactionConsistency], ['Retention', pillars.supplierRetention], ['Inventory', pillars.inventoryTurn]].map(([k, v]) => (
            <div key={k as string} className="pillar">
              <div className="pillar-top"><span>{k}</span><span className="gold">{v}</span></div>
              <Meter value={(v as number) / 100} />
            </div>
          ))}
        </div>
      </Card>

      <Card label="Score trend">
        <div className="frow">
          <div>
            <div className="stat-value gold">{history[history.length - 1]}</div>
            <span className="stat-label">+{history[history.length - 1] - history[0]} over {history.length} snapshots</span>
          </div>
          <Sparkline data={history} width={120} height={38} />
        </div>
      </Card>

      <Card label="What-if — improve your score">
        {suggestions.map((s) => (
          <div key={s.label} className="frow">
            <span className="frow-left">{s.label}</span>
            <Tag tone="green">+{s.scoreDelta} pts</Tag>
          </div>
        ))}
      </Card>

      <Card label="BNPL — finance a bill">
        <div className="cash-grid" style={{ marginTop: 8 }}>
          <div><span className="stat-label">Available</span><div className="stat-value gold">{inr(bnpl.availableLimit)}</div></div>
          <div><span className="stat-label">In use</span><div className="stat-value">{inr(bnpl.outstanding)}</div></div>
        </div>
        <div className="fee-row">
          {bnpl.feeSchedule.map((f) => (
            <div key={f.tenureDays} className="fee-chip"><b>{f.tenureDays}d</b> · {f.feeRatePct}% fee</div>
          ))}
        </div>
        <button type="button" className="btn-charge" style={{ marginTop: 12, width: '100%' }}>FINANCE A DISTRIBUTOR BILL</button>
      </Card>

      <SectionHead label="Bank pre-approvals" />
      {lenders.map((l, i) => (
        <div key={i} className="alert-card">
          <div className="frow">
            <div>
              <div className="frow-left">{l.lender}</div>
              <div className="frow-sub">requested {inr(l.requestedAmount)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <Tag tone={l.status === 'PRE_APPROVED' ? 'green' : 'gold'}>{l.status.replace('_', ' ')}</Tag>
              {l.approvedAmount != null && <div className="frow-sub">{inr(l.approvedAmount)} @ {l.interestRatePct}%</div>}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
