/**
 * Live Inventory — current stock across every till, updated as consumer sales
 * are pushed by the connected billing system. Polls /v1/inventory/live.
 */

import { useEffect, useState } from 'react';

import { apiGet, isLiveConfigured } from '../api';
import { Header, Row, SectionHead, Tag } from '../components';
import { demo } from '../demo';

interface LiveRow {
  sku: string;
  productName: string;
  currentStock: number;
  unit: string;
  minimumThreshold: number;
  lastMovementDelta: number | null;
}

export default function LiveInventory() {
  const [live, setLive] = useState<'demo' | 'live'>('demo');
  const [rows, setRows] = useState<LiveRow[]>(demo.liveInventory);

  useEffect(() => {
    if (!isLiveConfigured()) return;
    const poll = () =>
      apiGet<LiveRow[]>('/v1/inventory/live').then((r) => {
        if (r) { setRows(r); setLive('live'); }
      });
    poll();
    const t = setInterval(poll, 4000); // live-track via polling
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <Header title="Live Inventory" badge={live === 'live' ? 'LIVE' : 'DEMO'} />
      <p className="status-line">Stock updates in real time as your billing system rings up sales.</p>
      <SectionHead label="Current stock" note={`${rows.length} SKUs`} />
      {rows.map((r) => {
        const low = r.currentStock <= r.minimumThreshold;
        return (
          <div key={r.sku} className="alert-card">
            <Row
              left={r.productName}
              sub={`${r.sku}${r.lastMovementDelta != null ? ` · last ${r.lastMovementDelta > 0 ? '+' : ''}${r.lastMovementDelta}` : ''}`}
              right={
                <div style={{ textAlign: 'right' }}>
                  <b style={{ color: low ? 'var(--danger)' : 'var(--alabaster)' }}>{r.currentStock} {r.unit}</b>
                  {low && <div className="frow-sub"><Tag tone="red">LOW</Tag></div>}
                </div>
              }
            />
          </div>
        );
      })}
    </>
  );
}
