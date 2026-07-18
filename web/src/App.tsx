/**
 * ApnaKhata — Web preview shell.
 * Five primary tabs (Home, Credit, Market, GST, More); More holds Analytics,
 * Ledger, Live Inventory, and Scan & Bill. Every screen runs live against the
 * API when VITE_API_URL is set, else on demo data.
 */

import { useState } from 'react';

import Compliance from './screens/Compliance';
import Credit from './screens/Credit';
import Dashboard from './screens/Dashboard';
import Marketplace from './screens/Marketplace';
import More from './screens/More';

type Tab = 'HOME' | 'CREDIT' | 'MARKET' | 'GST' | 'MORE';

const TABS: { key: Tab; label: string }[] = [
  { key: 'HOME', label: 'HOME' },
  { key: 'CREDIT', label: 'CREDIT' },
  { key: 'MARKET', label: 'MARKET' },
  { key: 'GST', label: 'GST' },
  { key: 'MORE', label: 'MORE' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('HOME');

  return (
    <div className="stage">
      <p className="stage-caption">ApnaKhata · Mobile App Preview</p>
      <div className="phone">
        <div className="screen">
          {tab === 'HOME' && <Dashboard />}
          {tab === 'CREDIT' && <Credit />}
          {tab === 'MARKET' && <Marketplace />}
          {tab === 'GST' && <Compliance />}
          {tab === 'MORE' && <More />}
        </div>
        <nav className="tabbar">
          {TABS.map(({ key, label }) => (
            <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
              <span className="bar" />
              {label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
