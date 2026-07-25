/**
 * Books — auto-accounting + CA marketplace + GST-notice handling.
 * ApnaKhata as the system of record: a P&L and balance sheet generated from the
 * data already captured, a directory of CAs to engage, and GST notices that
 * auto-draft a response from the shop's own numbers. Live against
 * /v1/accounting, /v1/cas, /v1/gst-notices; canned data drives the demo.
 */

import { useEffect, useState } from 'react';

import {
  assignNotice,
  BalanceSheet,
  CaProfessional,
  draftNoticeResponse,
  engageCa,
  fetchBalanceSheet,
  fetchCas,
  fetchGstNotices,
  fetchPnl,
  GstNotice,
  isLiveConfigured,
  ProfitAndLoss,
} from '../api';
import { Card, Header, inr, Row, SectionHead, Tag } from '../components';

const DEMO_PNL: ProfitAndLoss = {
  period: { from: '2026-04-24', to: '2026-07-24' }, revenue: 20720, unitsSold: 453, costOfGoodsSold: 17270,
  grossProfit: 3450, grossMarginPct: 16.65, expenses: { cashExpenses: 800, financingCost: 0, total: 800 }, netProfit: 2650,
};
const DEMO_BS: BalanceSheet = {
  asOf: '2026-07-24', assets: { cash: 7332, inventory: 6102, receivables: 1230, total: 14664 },
  liabilities: { payables: 18500, creditLineDrawn: 0, loans: 0, total: 18500 }, equity: -3836,
};
const DEMO_CAS: CaProfessional[] = [
  { id: 'c1', name: 'CA Anjali Verma', firm: 'Verma & Co', city: 'Mumbai', specializations: ['NOTICE', 'GST', 'ITR'], rating: 4.9, minFee: 3500, maxFee: 15000, languages: ['English', 'Hindi'] },
  { id: 'c2', name: 'CA Meera Iyer', firm: 'Iyer & Associates', city: 'Pune', specializations: ['GST', 'NOTICE', 'ITR'], rating: 4.8, minFee: 2500, maxFee: 8000, languages: ['English', 'Hindi', 'Marathi'] },
  { id: 'c3', name: 'CA Rohan Shah', firm: 'Shah Fintax LLP', city: 'Pune', specializations: ['GST', 'AUDIT'], rating: 4.6, minFee: 3000, maxFee: 12000, languages: ['English', 'Gujarati', 'Hindi'] },
];
const DEMO_NOTICE: GstNotice = {
  id: 'n1', noticeType: 'ITC_MISMATCH', referenceNo: 'ZA2707240012345', period: '2026-05', amountInvolved: 18400,
  dueDate: '2026-08-05', status: 'OPEN', description: 'ITC claimed in GSTR-3B exceeds auto-populated GSTR-2B for the period — reconcile and respond.',
  responseDraft: null, assignedCaId: null,
};
const DEMO_DRAFT = `To,\nThe Proper Officer, GST Department\n\nSubject: Reply to notice ZA2707240012345 for tax period 2026-05\nGSTIN: 27PQRSX6789K1Z2 (Gupta General Store)\n\nSir/Madam,\nWith reference to the notice regarding input tax credit mismatch, our reconciliation for 2026-05 shows eligible ITC fully supported by GSTR-2B, and the balance relating to suppliers who have not yet filed, which we have not claimed / will reverse as required. The difference is on account of timing of supplier filing and does not represent ineligible credit.\n\nWe request you to kindly consider the above and drop the proceedings.\n\nYours faithfully,\nFor Gupta General Store`;

export default function Books() {
  const live = isLiveConfigured();
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [pnl, setPnl] = useState<ProfitAndLoss>(DEMO_PNL);
  const [bs, setBs] = useState<BalanceSheet>(DEMO_BS);
  const [cas, setCas] = useState<CaProfessional[]>(DEMO_CAS);
  const [notices, setNotices] = useState<GstNotice[]>([DEMO_NOTICE]);
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    Promise.all([fetchPnl(), fetchBalanceSheet(), fetchCas(), fetchGstNotices()]).then(([p, b, c, n]) => {
      setMode('live');
      if (p) setPnl(p); if (b) setBs(b); if (c && c.length) setCas(c); if (n) setNotices(n);
    });
  }, [live]);

  const draft = async (n: GstNotice) => {
    setBusy(`draft-${n.id}`);
    if (mode === 'live') {
      const res = await draftNoticeResponse(n.id);
      if (res) { setNotices((prev) => prev.map((x) => (x.id === n.id ? res : x))); setOpenDraft(res.responseDraft); }
    } else {
      await pause();
      setNotices((prev) => prev.map((x) => (x.id === n.id ? { ...x, status: 'DRAFTED', responseDraft: DEMO_DRAFT } : x)));
      setOpenDraft(DEMO_DRAFT);
    }
    setBusy(null);
  };

  const assign = async (n: GstNotice, ca: CaProfessional) => {
    setBusy(`assign-${n.id}`);
    if (mode === 'live') await assignNotice(n.id, ca.id);
    else await pause();
    setNotices((prev) => prev.map((x) => (x.id === n.id ? { ...x, assignedCaId: ca.id } : x)));
    setBusy(null);
    setNote(`Notice assigned to ${ca.name} — engagement opened.`);
  };

  const engage = async (ca: CaProfessional) => {
    setBusy(`eng-${ca.id}`);
    if (mode === 'live') await engageCa(ca.id, 'GST_FILING');
    else await pause();
    setBusy(null);
    setNote(`Requested ${ca.name} for GST filing (~${inr(Math.round((ca.minFee + ca.maxFee) / 2))}).`);
  };

  const noticeSpecialist = cas.find((c) => c.specializations.includes('NOTICE')) ?? cas[0];

  return (
    <>
      <Header title="Books & CA" badge={mode === 'live' ? 'LIVE' : 'DEMO'} />

      {/* Auto P&L */}
      <Card label="Profit & Loss (last 90 days)">
        <div className="cash-grid">
          <div><span className="stat-label">Revenue</span><div className="stat-value gold">{inr(pnl.revenue)}</div></div>
          <div><span className="stat-label">Net profit</span><div className={`stat-value ${pnl.netProfit >= 0 ? 'gold' : ''}`} style={pnl.netProfit < 0 ? { color: 'var(--danger)' } : undefined}>{inr(pnl.netProfit)}</div></div>
        </div>
        <div className="metric-grid" style={{ marginTop: 10 }}>
          <div><span className="stat-label">COGS</span><div className="mval">{inr(pnl.costOfGoodsSold)}</div></div>
          <div><span className="stat-label">Gross profit</span><div className="mval gold">{inr(pnl.grossProfit)}</div></div>
          <div><span className="stat-label">Gross margin</span><div className="mval">{pnl.grossMarginPct}%</div></div>
          <div><span className="stat-label">Expenses</span><div className="mval">{inr(pnl.expenses.total)}</div></div>
        </div>
        <div className="advice" style={{ marginTop: 10 }}>▸ Auto-generated from your sales, stock movements and cash drawer — no bookkeeping.</div>
      </Card>

      {/* Auto balance sheet */}
      <Card label={`Balance sheet · as of ${bs.asOf}`}>
        <div className="cash-grid">
          <div><span className="stat-label">Assets</span><div className="stat-value gold">{inr(bs.assets.total)}</div></div>
          <div><span className="stat-label">Liabilities</span><div className="stat-value">{inr(bs.liabilities.total)}</div></div>
        </div>
        <div className="metric-grid" style={{ marginTop: 10 }}>
          <div><span className="stat-label">Inventory</span><div className="mval">{inr(bs.assets.inventory)}</div></div>
          <div><span className="stat-label">Receivables</span><div className="mval">{inr(bs.assets.receivables)}</div></div>
          <div><span className="stat-label">Payables</span><div className="mval">{inr(bs.liabilities.payables)}</div></div>
          <div><span className="stat-label">Net worth</span><div className="mval" style={bs.equity < 0 ? { color: 'var(--danger)' } : { color: 'var(--gold-bright)' }}>{inr(bs.equity)}</div></div>
        </div>
      </Card>

      {/* GST notices */}
      <SectionHead label="GST notices" note={`${notices.length}`} />
      {notices.length === 0 && <div className="cart-empty">No open GST notices — you're compliant.</div>}
      {notices.map((n) => (
        <article key={n.id} className="alert-card">
          <div className="alert-top">
            <div style={{ minWidth: 0 }}>
              <div className="alert-name">{n.noticeType.replace(/_/g, ' ')}</div>
              <div className="alert-meta">{n.referenceNo} · {n.period} · due {n.dueDate ?? '—'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <b style={{ color: 'var(--danger)' }}>{inr(n.amountInvolved)}</b>
              <div className="frow-sub"><Tag tone={n.status === 'RESOLVED' ? 'green' : n.status === 'OPEN' ? 'red' : 'gold'}>{n.status}</Tag></div>
            </div>
          </div>
          {n.description && <div className="alert-meta" style={{ marginTop: 6 }}>{n.description}</div>}
          <div className="voice-text-row" style={{ marginTop: 10 }}>
            <button type="button" className="voice-record" disabled={busy === `draft-${n.id}`} onClick={() => draft(n)}>
              {busy === `draft-${n.id}` ? '…' : n.responseDraft ? 'VIEW DRAFT' : '✍️ AUTO-DRAFT REPLY'}
            </button>
            <button type="button" className="voice-record" disabled={!!n.assignedCaId || busy === `assign-${n.id}`} onClick={() => assign(n, noticeSpecialist)}>
              {n.assignedCaId ? 'ASSIGNED ✓' : `ASSIGN CA`}
            </button>
          </div>
          {openDraft && n.responseDraft === openDraft && (
            <pre className="notice-draft">{openDraft}</pre>
          )}
        </article>
      ))}

      {/* CA marketplace */}
      <SectionHead label="Find a chartered accountant" note={`${cas.length}`} />
      {cas.map((ca) => (
        <article key={ca.id} className="alert-card">
          <div className="alert-top">
            <div style={{ minWidth: 0 }}>
              <div className="alert-name">{ca.name} <span className="pill pill-gold" style={{ marginLeft: 6 }}>★ {ca.rating}</span></div>
              <div className="alert-meta">{ca.firm} · {ca.city} · {ca.specializations.join(', ')}</div>
              <div className="frow-sub" style={{ marginTop: 2 }}>{ca.languages.join(' · ')}</div>
            </div>
          </div>
          <div className="alert-bottom">
            <span className="urgency" style={{ color: 'var(--slate)' }}>{inr(ca.minFee)}–{inr(ca.maxFee)}</span>
            <button type="button" className="btn-order idle" disabled={busy === `eng-${ca.id}`} onClick={() => engage(ca)}>
              {busy === `eng-${ca.id}` ? 'REQUESTING…' : 'ENGAGE'}
            </button>
          </div>
        </article>
      ))}

      {note && <p className="status-line">{note}</p>}
    </>
  );
}

const pause = () => new Promise<void>((r) => setTimeout(r, 500));
