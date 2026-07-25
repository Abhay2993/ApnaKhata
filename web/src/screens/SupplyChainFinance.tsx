/**
 * Working Capital — anchor-led supply-chain finance (OCEN + Account Aggregator).
 * The flagship credit moat: underwrite from the Credit Passport + consented bank
 * cash-flow + the verified anchor (distributor) relationship, then collect
 * competing lender offers and disburse — settling the distributor's dues.
 * Live against /v1/scf + /v1/aa; a canned flow drives the standalone demo.
 */

import { useEffect, useState } from 'react';

import {
  AaSummary,
  acceptLoanOffer,
  ANCHOR_ID,
  AnchorRelationship,
  connectBankViaAA,
  createLoanApplication,
  DisbursedLoan,
  getAnchorRelationship,
  isLiveConfigured,
  LoanApplication,
  LoanOffer,
} from '../api';
import { Card, Header, inr, Meter, Row, SectionHead, Tag } from '../components';

const DEMO_ANCHOR: AnchorRelationship = {
  anchorId: ANCHOR_ID,
  anchorName: 'Sharma Distributors',
  invoiceCount: 7,
  totalTrade: 114500,
  outstanding: 18500,
  tenureMonths: 6,
  onTimeRate: 1,
  strength: 0.68,
};
const DEMO_AA: AaSummary = { avgMonthlyInflow: 19927, avgMonthlyOutflow: 16340, avgBalance: 8967, minBalance: 2242, bounceCount: 0, months: 6 };
const DEMO_OFFERS: LoanOffer[] = [
  { id: 'o1', lenderKey: 'SIDBI', lenderName: 'SIDBI (development bank)', sanctionedAmount: 40000, interestRatePct: 13.32, tenureDays: 90, processingFee: 200, emiAmount: 13771, totalRepayable: 41513, status: 'OFFERED' },
  { id: 'o2', lenderKey: 'HDFC', lenderName: 'HDFC Bank', sanctionedAmount: 40000, interestRatePct: 14.99, tenureDays: 90, processingFee: 400, emiAmount: 13826, totalRepayable: 41879, status: 'OFFERED' },
  { id: 'o3', lenderKey: 'ABCAPITAL', lenderName: 'Aditya Birla Capital NBFC', sanctionedAmount: 40000, interestRatePct: 17.66, tenureDays: 90, processingFee: 600, emiAmount: 13914, totalRepayable: 42342, status: 'OFFERED' },
  { id: 'o4', lenderKey: 'FLEXI', lenderName: 'FlexiLoan (fintech NBFC)', sanctionedAmount: 40000, interestRatePct: 21.16, tenureDays: 90, processingFee: 800, emiAmount: 14029, totalRepayable: 42887, status: 'OFFERED' },
];
const DEMO_APP: LoanApplication = {
  id: 'demo-app', status: 'OFFERED', riskGrade: 'B', recommendedLimit: 41000, anchorStrength: 0.68, creditScore: 731,
  underwriting: { usedAccountAggregator: true, rationale: [] }, offers: DEMO_OFFERS,
};

const gradeTone = (g: string | null) => (g === 'A' ? 'green' : g === 'D' ? 'red' : 'gold');

export default function SupplyChainFinance() {
  const live = isLiveConfigured();
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [anchor, setAnchor] = useState<AnchorRelationship | null>(DEMO_ANCHOR);
  const [aa, setAa] = useState<AaSummary | null>(null);
  const [amount, setAmount] = useState('40000');
  const [app, setApp] = useState<LoanApplication | null>(null);
  const [loan, setLoan] = useState<DisbursedLoan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    getAnchorRelationship(ANCHOR_ID).then((a) => {
      if (a) { setAnchor(a); setMode('live'); }
    });
  }, [live]);

  const connectBank = async () => {
    setBusy('bank');
    setNote(null);
    if (mode === 'live') {
      const s = await connectBankViaAA();
      if (s) setAa(s); else setNote('Could not reach the Account Aggregator.');
    } else {
      await pause();
      setAa(DEMO_AA);
    }
    setBusy(null);
  };

  const getOffers = async () => {
    const amt = Number(amount);
    if (!(amt > 0)) { setNote('Enter an amount'); return; }
    setBusy('offers');
    setLoan(null);
    if (mode === 'live') {
      const a = await createLoanApplication({ anchorId: ANCHOR_ID, amountRequested: amt, tenureDays: 90 });
      if (a) setApp(a); else setNote('Could not create the application.');
    } else {
      await pause();
      setApp({ ...DEMO_APP, offers: DEMO_OFFERS.map((o) => ({ ...o, sanctionedAmount: Math.min(amt, 41000), status: 'OFFERED' })) });
    }
    setBusy(null);
  };

  const accept = async (offer: LoanOffer) => {
    setBusy(offer.id);
    if (mode === 'live' && app) {
      const res = await acceptLoanOffer(app.id, offer.id);
      if (res) { setLoan(res.loan); setApp(res.application); }
      else setNote('Could not accept the offer.');
    } else {
      await pause();
      const settle = Math.min(offer.sanctionedAmount, anchor?.outstanding ?? 0);
      setLoan({ id: 'demo-loan', lenderName: offer.lenderName, principal: offer.sanctionedAmount, interestRatePct: offer.interestRatePct, disbursedToAnchor: settle });
      setApp((p) => (p ? { ...p, status: 'DISBURSED', offers: p.offers?.map((o) => ({ ...o, status: o.id === offer.id ? 'ACCEPTED' : 'DECLINED' })) } : p));
    }
    setBusy(null);
  };

  const bestId = app?.offers?.[0]?.id;

  return (
    <>
      <Header title="Working Capital" badge={mode === 'live' ? 'LIVE' : 'DEMO'} />

      <p className="status-line" style={{ marginTop: 2 }}>
        Anchor-led financing — your verified trade record earns better terms than a cold credit score.
      </p>

      {/* 1. Anchor relationship */}
      {anchor && (
        <Card label="Anchor · distributor relationship">
          <Row
            left={<b>{anchor.anchorName}</b>}
            sub={`${anchor.invoiceCount} invoices · ${inr(anchor.totalTrade)} traded · ${anchor.tenureMonths} mo`}
            right={<Tag tone="gold">{Math.round(anchor.strength * 100)}% strength</Tag>}
          />
          <div style={{ marginTop: 10 }}>
            <Meter value={anchor.strength} />
          </div>
          <div className="cash-grid" style={{ marginTop: 12 }}>
            <div><span className="stat-label">On-time payments</span><div className="stat-value gold">{anchor.onTimeRate != null ? `${Math.round(anchor.onTimeRate * 100)}%` : '—'}</div></div>
            <div><span className="stat-label">Owed to distributor</span><div className="stat-value">{inr(anchor.outstanding)}</div></div>
          </div>
        </Card>
      )}

      {/* 2. Account Aggregator */}
      <Card label="Bank cash-flow · Account Aggregator">
        {aa ? (
          <>
            <div className="frow">
              <span className="frow-sub">Statement pulled with your consent ({aa.months} months)</span>
              <Tag tone="green">VERIFIED</Tag>
            </div>
            <div className="cash-grid" style={{ marginTop: 10 }}>
              <div><span className="stat-label">Avg inflow / mo</span><div className="stat-value gold">{inr(aa.avgMonthlyInflow)}</div></div>
              <div><span className="stat-label">Lowest balance</span><div className="stat-value">{inr(aa.minBalance)}</div></div>
            </div>
            <div className="alert-meta" style={{ marginTop: 8 }}>{aa.bounceCount} cheque bounce(s) in {aa.months} months · cash-flow underwriting unlocked</div>
          </>
        ) : (
          <>
            <p className="voice-subtitle" style={{ marginTop: 2 }}>
              Connect your bank via the Account Aggregator (Sahamati) — consented, read-only. It lifts your limit and rate.
            </p>
            <button type="button" className="voice-btn" disabled={busy === 'bank'} onClick={connectBank}>
              {busy === 'bank' ? 'CONNECTING…' : '🔗 Connect bank (Account Aggregator)'}
            </button>
          </>
        )}
      </Card>

      {/* 3. Request working capital */}
      <Card label="Request working capital">
        <div className="voice-text-row" style={{ marginTop: 4 }}>
          <input className="voice-input" type="number" min="1" value={amount} placeholder="Amount (₹)" onChange={(e) => setAmount(e.target.value)} />
          <button type="button" className="voice-record" disabled={busy === 'offers'} onClick={getOffers}>
            {busy === 'offers' ? '…' : 'GET OFFERS'}
          </button>
        </div>
        <div className="alert-meta" style={{ marginTop: 8 }}>90-day tenure · offers backed by your passport, cash-flow and anchor relationship</div>
      </Card>

      {/* 4. Competing lender offers */}
      {app && app.offers && app.offers.length > 0 && !loan && (
        <>
          <SectionHead label="Competing lender offers" note={`Grade ${app.riskGrade} · limit ${inr(app.recommendedLimit ?? 0)}`} />
          {app.offers.map((o) => (
            <article key={o.id} className={`alert-card ${o.id === bestId ? 'best-offer' : ''}`}>
              <div className="alert-top">
                <div style={{ minWidth: 0 }}>
                  <div className="alert-name">{o.lenderName}{o.id === bestId && <span className="pill pill-green" style={{ marginLeft: 8 }}>BEST RATE</span>}</div>
                  <div className="alert-meta">{inr(o.sanctionedAmount)} · fee {inr(o.processingFee)} · EMI {inr(o.emiAmount)}/mo</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="stat-value gold" style={{ fontSize: 20 }}>{o.interestRatePct}%</div>
                  <div className="alert-meta">p.a.</div>
                </div>
              </div>
              <div className="alert-bottom">
                <span className="urgency" style={{ color: 'var(--slate)' }}>Total repayable {inr(o.totalRepayable)}</span>
                <button type="button" className="btn-order idle" disabled={busy === o.id} onClick={() => accept(o)}>
                  {busy === o.id ? 'ACCEPTING…' : 'ACCEPT'}
                </button>
              </div>
            </article>
          ))}
        </>
      )}

      {app && app.offers && app.offers.length === 0 && !loan && (
        <div className="cart-empty">No lender offers at this amount — try a smaller amount or connect your bank.</div>
      )}

      {/* 5. Disbursed */}
      {loan && (
        <Card label="Disbursed ✓">
          <div className="frow">
            <div>
              <div className="stat-value gold" style={{ fontSize: 26 }}>{inr(loan.principal)}</div>
              <Tag tone={gradeTone(app?.riskGrade ?? null)}>{loan.lenderName} · {loan.interestRatePct}%</Tag>
            </div>
          </div>
          {loan.disbursedToAnchor > 0 && (
            <div className="advice" style={{ marginTop: 12 }}>
              ▸ {inr(loan.disbursedToAnchor)} routed to {anchor?.anchorName} to clear your outstanding dues — you now repay {loan.lenderName}.
            </div>
          )}
        </Card>
      )}

      {note && <p className="status-line">{note}</p>}
    </>
  );
}

const pause = () => new Promise<void>((r) => setTimeout(r, 650));
