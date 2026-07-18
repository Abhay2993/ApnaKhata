/**
 * More — hub for the secondary feature screens.
 */

import { useState } from 'react';

import { Header } from '../components';
import Analytics from './Analytics';
import Ledger from './Ledger';
import LiveInventory from './LiveInventory';
import Scan from './Scan';

type Sub = 'analytics' | 'ledger' | 'live' | 'scan';

const TILES: { key: Sub; title: string; sub: string; icon: string }[] = [
  { key: 'analytics', title: 'Analytics', sub: 'Profit, margins, health', icon: '📈' },
  { key: 'ledger', title: 'Ledger', sub: 'Bills, reminders, EMI, disputes', icon: '📒' },
  { key: 'live', title: 'Live Inventory', sub: 'Real-time stock from billing', icon: '📦' },
  { key: 'scan', title: 'Scan & Bill', sub: 'Barcode billing & stock-in', icon: '📷' },
];

export default function More() {
  const [open, setOpen] = useState<Sub | null>(null);

  if (open) {
    return (
      <>
        <button type="button" className="back-bar" onClick={() => setOpen(null)}>← More</button>
        {open === 'analytics' && <Analytics />}
        {open === 'ledger' && <Ledger />}
        {open === 'live' && <LiveInventory />}
        {open === 'scan' && <Scan />}
      </>
    );
  }

  return (
    <>
      <Header title="More" />
      <div className="tile-grid">
        {TILES.map((t) => (
          <button key={t.key} type="button" className="tile" onClick={() => setOpen(t.key)}>
            <span className="tile-icon">{t.icon}</span>
            <span className="tile-title">{t.title}</span>
            <span className="tile-sub">{t.sub}</span>
          </button>
        ))}
      </div>
      <p className="status-line" style={{ marginTop: 16, textAlign: 'center' }}>
        Every ApnaKhata module — ledger, forecasting, credit, compliance, marketplace — on one rail.
      </p>
    </>
  );
}
