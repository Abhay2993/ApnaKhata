/**
 * Cash Drawer — daily cash vs digital reconciliation.
 * Open with a float, log cash in/out through the day, count and close: the
 * variance (counted − expected) is the number the shopkeeper cares about.
 * Live against /v1/cash-drawer when the API is configured; a local demo drawer
 * otherwise.
 */

import { useEffect, useState } from 'react';

import {
  addDrawerMovement,
  closeDrawer,
  DrawerSummary,
  getDrawerToday,
  isLiveConfigured,
  openDrawer,
} from '../api';
import { Card, Header, inr, StatRow } from '../components';

const DEMO_DRAWER: DrawerSummary = {
  id: 'demo',
  businessDate: new Date().toISOString().slice(0, 10),
  status: 'OPEN',
  openingBalance: 2000,
  cashIn: 6650,
  cashOut: 800,
  expectedClosing: 7850,
  countedClosing: null,
  variance: null,
  movementCount: 3,
};

export default function CashDrawer() {
  const live = isLiveConfigured();
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [drawer, setDrawer] = useState<DrawerSummary | null>(DEMO_DRAWER);
  const [amount, setAmount] = useState('');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    if (!live) return;
    const d = await getDrawerToday();
    if (d) {
      setMode('live');
      setDrawer('id' in d ? (d as DrawerSummary) : null);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyDemo = (fn: (d: DrawerSummary) => DrawerSummary) =>
    setDrawer((d) => (d ? fn({ ...d }) : d));

  const doOpen = async () => {
    if (mode === 'live') {
      const d = await openDrawer(2000);
      if (d) setDrawer(d);
    } else {
      setDrawer({ ...DEMO_DRAWER, cashIn: 0, cashOut: 0, expectedClosing: 2000, movementCount: 0, status: 'OPEN', countedClosing: null, variance: null });
    }
    setNote('Drawer opened with ₹2,000 float');
  };

  const move = async (direction: 'IN' | 'OUT') => {
    const amt = Number(amount);
    if (!(amt > 0)) { setNote('Enter a positive amount'); return; }
    setAmount('');
    if (mode === 'live') {
      const d = await addDrawerMovement(direction, amt, direction === 'IN' ? 'CASH_SALE' : 'EXPENSE');
      if (d) setDrawer(d);
      else setNote('Could not record — drawer open?');
    } else {
      applyDemo((d) => {
        if (direction === 'IN') d.cashIn += amt; else d.cashOut += amt;
        d.expectedClosing = d.openingBalance + d.cashIn - d.cashOut;
        d.movementCount += 1;
        return d;
      });
    }
    setNote(`Cash ${direction === 'IN' ? 'in' : 'out'} ${inr(amt)} recorded`);
  };

  const doClose = async () => {
    const amt = Number(counted);
    if (!(amt >= 0)) { setNote('Enter the counted cash amount'); return; }
    if (mode === 'live') {
      const d = await closeDrawer(amt);
      if (d) setDrawer(d);
      else { setNote('Close failed — already closed?'); return; }
    } else {
      applyDemo((d) => {
        d.countedClosing = amt;
        d.variance = Math.round((amt - d.expectedClosing) * 100) / 100;
        d.status = 'CLOSED';
        return d;
      });
    }
    setNote('Drawer closed');
  };

  const varianceTone = (v: number | null) => (v === null || v === 0 ? 'var(--slate)' : v > 0 ? '#6fcf97' : 'var(--danger)');

  return (
    <>
      <Header title="Cash Drawer" badge={mode === 'live' ? 'LIVE' : 'DEMO'} />

      {!drawer && (
        <Card label="Today">
          <div className="status" style={{ padding: '12px 0' }}>Drawer not opened yet.</div>
          <button type="button" className="btn-charge" onClick={doOpen}>OPEN DRAWER · ₹2,000 FLOAT</button>
        </Card>
      )}

      {drawer && (
        <>
          <Card label={`Today · ${drawer.businessDate}`}>
            <StatRow
              items={[
                { label: 'Opening float', value: inr(drawer.openingBalance) },
                { label: 'Expected in drawer', value: inr(drawer.expectedClosing), gold: true },
              ]}
            />
            <div className="cash-grid" style={{ marginTop: 10 }}>
              <div>
                <span className="stat-label">Cash in</span>
                <div className="stat-value" style={{ color: '#6fcf97' }}>{inr(drawer.cashIn)}</div>
              </div>
              <div>
                <span className="stat-label">Cash out</span>
                <div className="stat-value" style={{ color: 'var(--danger)' }}>{inr(drawer.cashOut)}</div>
              </div>
            </div>
            <div className="alert-meta" style={{ marginTop: 8 }}>
              {drawer.movementCount} movements · {drawer.status === 'OPEN' ? 'drawer open' : 'closed'}
            </div>
          </Card>

          {drawer.status === 'OPEN' && (
            <Card label="Record cash">
              <div className="voice-text-row" style={{ marginTop: 4 }}>
                <input
                  className="voice-input"
                  type="number"
                  min="1"
                  value={amount}
                  placeholder="Amount (₹)"
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button type="button" className="voice-record" onClick={() => move('IN')}>+ IN</button>
                <button type="button" className="voice-record" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => move('OUT')}>− OUT</button>
              </div>
            </Card>
          )}

          {drawer.status === 'OPEN' ? (
            <Card label="Close drawer — count the cash">
              <div className="voice-text-row" style={{ marginTop: 4 }}>
                <input
                  className="voice-input"
                  type="number"
                  min="0"
                  value={counted}
                  placeholder={`Counted cash (expected ${inr(drawer.expectedClosing)})`}
                  onChange={(e) => setCounted(e.target.value)}
                />
                <button type="button" className="voice-record" onClick={doClose}>CLOSE</button>
              </div>
            </Card>
          ) : (
            <Card label="Reconciliation">
              <StatRow
                items={[
                  { label: 'Counted', value: inr(drawer.countedClosing ?? 0) },
                  { label: 'Expected', value: inr(drawer.expectedClosing) },
                ]}
              />
              <div className="frow" style={{ marginTop: 12 }}>
                <span className="frow-sub">Variance</span>
                <b style={{ color: varianceTone(drawer.variance), fontSize: 18 }}>
                  {drawer.variance === null ? '—' : drawer.variance === 0 ? 'Tallies ✓' : inr(drawer.variance)}
                </b>
              </div>
              {drawer.variance !== null && drawer.variance !== 0 && (
                <div className="advice" style={{ marginTop: 8 }}>
                  ▸ {drawer.variance < 0 ? 'Drawer is short — check change given and unlogged payouts.' : 'Drawer is over — a sale may not have been billed.'}
                </div>
              )}
            </Card>
          )}
        </>
      )}

      {note && <p className="status-line">{note}</p>}
    </>
  );
}
