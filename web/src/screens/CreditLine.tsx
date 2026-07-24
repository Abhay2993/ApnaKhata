/**
 * Credit Line — RuPay credit line on UPI.
 * A pre-sanctioned revolving line spent over UPI: pay a distributor by scanning
 * their QR, funded by the line (not a bank balance). Draws settle the payee's
 * dues via FIFO and reduce the available limit; repayments free it back up.
 * Live against /v1/credit-line; a canned flow drives the standalone demo.
 */

import { useEffect, useState } from 'react';

import {
  CreditLine as CreditLineT,
  CreditLineState,
  CreditLineTxn,
  getCreditLine,
  isLiveConfigured,
  issueCreditLine,
  listCreditLineTxns,
  payViaCreditLine,
  repayCreditLine,
} from '../api';
import { Card, Header, inr, Meter, Row, SectionHead } from '../components';

const DEMO_LINE: CreditLineT = {
  id: 'demo', lenderName: 'ApnaKhata Credit', sanctionedLimit: 64000, availableLimit: 64000, utilised: 0,
  interestRatePct: 22, status: 'ACTIVE', card: { last4: '3495', network: 'RUPAY', expiry: '07/30' },
  upiHandle: 'guptageneral.2222@apnakhata',
};
const DEMO_ELIG: NonNullable<CreditLineState['eligibility']> = {
  eligible: true, score: 731, tier: 'SUBPRIME', offeredLimit: 64000, interestRatePct: 22,
  reason: 'Pre-approved from your Credit Passport (SUBPRIME, score 731).',
};

export default function CreditLine() {
  const live = isLiveConfigured();
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [state, setState] = useState<CreditLineState>({ line: null, eligibility: DEMO_ELIG });
  const [txns, setTxns] = useState<CreditLineTxn[]>([]);
  const [amount, setAmount] = useState('10000');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refreshTxns = () => { if (live) listCreditLineTxns().then((t) => t && setTxns(t)); };

  useEffect(() => {
    if (!live) return;
    getCreditLine().then((s) => { if (s) { setState(s); setMode('live'); refreshTxns(); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const issue = async () => {
    setBusy('issue');
    if (mode === 'live') {
      const line = await issueCreditLine();
      if (line) setState({ line });
    } else {
      await pause();
      setState({ line: DEMO_LINE });
    }
    setBusy(null);
    setNote('Credit line activated — pay any distributor over UPI.');
  };

  const pay = async () => {
    const amt = Number(amount);
    if (!(amt > 0)) { setNote('Enter an amount'); return; }
    setBusy('pay');
    if (mode === 'live') {
      const res = await payViaCreditLine({ payeeId: DIST_ID, amount: amt });
      if (res) { setState({ line: res.line }); refreshTxns(); setNote(`Paid ${inr(amt)} to Sharma Distributors · ${res.txn.upiRef}`); }
      else setNote('Payment failed — amount within limit?');
    } else {
      await pause();
      setState((s) => (s.line ? { line: { ...s.line, availableLimit: Math.max(s.line.availableLimit - amt, 0), utilised: s.line.utilised + amt } } : s));
      setTxns((t) => [{ id: `d${Date.now()}`, direction: 'DRAW', amount: amt, counterpartyName: 'Sharma Distributors', upiRef: `CLU${Date.now().toString().slice(-9)}`, createdAt: new Date().toISOString() }, ...t]);
      setNote(`Paid ${inr(amt)} to Sharma Distributors over UPI credit line`);
    }
    setBusy(null);
  };

  const repay = async () => {
    const amt = Number(amount);
    setBusy('repay');
    if (mode === 'live') {
      const res = await repayCreditLine(amt);
      if (res) { setState({ line: res.line }); refreshTxns(); }
      else setNote('Nothing to repay');
    } else {
      await pause();
      setState((s) => (s.line ? { line: { ...s.line, availableLimit: Math.min(s.line.availableLimit + Math.min(amt, s.line.utilised), s.line.sanctionedLimit), utilised: Math.max(s.line.utilised - amt, 0) } } : s));
      setTxns((t) => [{ id: `r${Date.now()}`, direction: 'REPAYMENT', amount: amt, counterpartyName: 'Line repayment', upiRef: `CLR${Date.now().toString().slice(-9)}`, createdAt: new Date().toISOString() }, ...t]);
    }
    setBusy(null);
    setNote('Repaid — available limit restored');
  };

  const { line, eligibility } = state;

  return (
    <>
      <Header title="Credit Line" badge={mode === 'live' ? 'LIVE' : 'DEMO'} />

      {!line ? (
        <Card label="RuPay credit line on UPI">
          <p className="voice-subtitle" style={{ marginTop: 2 }}>
            {eligibility?.reason ?? 'Pay distributors over UPI from a sanctioned line, not your bank balance.'}
          </p>
          {eligibility?.eligible ? (
            <>
              <div className="cash-grid" style={{ marginTop: 6 }}>
                <div><span className="stat-label">Pre-approved</span><div className="stat-value gold">{inr(eligibility.offeredLimit)}</div></div>
                <div><span className="stat-label">Rate</span><div className="stat-value">{eligibility.interestRatePct}% p.a.</div></div>
              </div>
              <button type="button" className="voice-btn" style={{ marginTop: 14 }} disabled={busy === 'issue'} onClick={issue}>
                {busy === 'issue' ? 'ACTIVATING…' : '💳 Activate credit line'}
              </button>
            </>
          ) : (
            <div className="advice" style={{ marginTop: 10 }}>▸ {eligibility?.reason}</div>
          )}
        </Card>
      ) : (
        <>
          {/* Virtual RuPay card */}
          <div className="rupay-card">
            <div className="rupay-top">
              <span className="rupay-issuer">{line.lenderName}</span>
              <span className="rupay-network">{line.card.network}</span>
            </div>
            <div className="rupay-number">•••• •••• •••• {line.card.last4}</div>
            <div className="rupay-bottom">
              <div>
                <div className="rupay-label">UPI</div>
                <div className="rupay-value">{line.upiHandle}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="rupay-label">VALID THRU</div>
                <div className="rupay-value">{line.card.expiry}</div>
              </div>
            </div>
          </div>

          <Card label="Credit line">
            <Row
              left={<b>{inr(line.availableLimit)} available</b>}
              sub={`of ${inr(line.sanctionedLimit)} · ${line.interestRatePct}% p.a.`}
              right={<span className="pill pill-gold">{Math.round((line.utilised / line.sanctionedLimit) * 100)}% used</span>}
            />
            <div style={{ marginTop: 10 }}>
              <Meter value={line.utilised / line.sanctionedLimit} tone={line.utilised / line.sanctionedLimit > 0.85 ? 'red' : 'gold'} />
            </div>
          </Card>

          <Card label="Pay a distributor over UPI">
            <p className="voice-subtitle" style={{ marginTop: 0 }}>Scan Sharma Distributors' QR — funded by your credit line, settled instantly.</p>
            <div className="voice-text-row">
              <input className="voice-input" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (₹)" />
              <button type="button" className="voice-record" disabled={busy === 'pay'} onClick={pay}>{busy === 'pay' ? '…' : 'SCAN & PAY'}</button>
              <button type="button" className="voice-record" disabled={busy === 'repay'} onClick={repay}>REPAY</button>
            </div>
          </Card>

          {txns.length > 0 && (
            <>
              <SectionHead label="Recent activity" />
              {txns.slice(0, 6).map((t) => (
                <div key={t.id} className="alert-card">
                  <Row
                    left={t.direction === 'DRAW' ? (t.counterpartyName ?? 'UPI payment') : 'Line repayment'}
                    sub={t.upiRef}
                    right={<b style={{ color: t.direction === 'DRAW' ? 'var(--danger)' : '#6fcf97' }}>{t.direction === 'DRAW' ? '−' : '+'}{inr(t.amount)}</b>}
                  />
                </div>
              ))}
            </>
          )}
        </>
      )}

      {note && <p className="status-line">{note}</p>}
    </>
  );
}

const DIST_ID = '11111111-1111-1111-1111-111111111111';
const pause = () => new Promise<void>((r) => setTimeout(r, 550));
