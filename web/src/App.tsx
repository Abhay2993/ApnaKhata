/**
 * ApnaKhata — Web preview shell
 * -----------------------------
 * Browser rendering of the mobile app for Vercel: the two shipped screens
 * inside a phone frame, mirroring mobile/App.tsx's tab shell. Runs on demo
 * data (no backend); interactions are simulated client-side.
 */

import { useState } from 'react';

import Dashboard from './screens/Dashboard';
import Marketplace from './screens/Marketplace';
import Scan from './screens/Scan';

type Tab = 'DASHBOARD' | 'MARKET' | 'SCAN';

const TABS: { key: Tab; label: string }[] = [
  { key: 'DASHBOARD', label: 'HOME' },
  { key: 'MARKET', label: 'MARKET' },
  { key: 'SCAN', label: 'SCAN' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('DASHBOARD');

  return (
    <div className="stage">
      <p className="stage-caption">ApnaKhata · Mobile App Preview</p>
      <div className="phone">
        <div className="screen">
          {tab === 'DASHBOARD' ? <Dashboard /> : tab === 'MARKET' ? <Marketplace /> : <Scan />}
        </div>
        <nav className="tabbar">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              <span className="bar" />
              {label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
