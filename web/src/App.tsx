/**
 * ApnaKhata — Web preview shell.
 * Six primary tabs (Home, Khata, Credit, Market, GST, More); More holds
 * Analytics, Ledger, Live Inventory, and Scan & Bill. A language switcher drives
 * the vernacular UI. Every screen runs live against the API when VITE_API_URL is
 * set, else on demo data.
 */

import { useState } from 'react';

import Compliance from './screens/Compliance';
import Credit from './screens/Credit';
import Dashboard from './screens/Dashboard';
import Khata from './screens/Khata';
import Marketplace from './screens/Marketplace';
import More from './screens/More';
import { LANGS, useI18n } from './i18n';

type Tab = 'HOME' | 'KHATA' | 'CREDIT' | 'MARKET' | 'GST' | 'MORE';

const TABS: { key: Tab; labelKey: Parameters<ReturnType<typeof useI18n>['t']>[0] }[] = [
  { key: 'HOME', labelKey: 'tab.home' },
  { key: 'KHATA', labelKey: 'tab.khata' },
  { key: 'CREDIT', labelKey: 'tab.credit' },
  { key: 'MARKET', labelKey: 'tab.market' },
  { key: 'GST', labelKey: 'tab.gst' },
  { key: 'MORE', labelKey: 'tab.more' },
];

function LanguageSwitcher() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t('lang.label')}>
      <span className="lang-globe" aria-hidden>🌐</span>
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          className={l.code === lang ? 'active' : ''}
          onClick={() => setLang(l.code)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('HOME');
  const { t } = useI18n();

  return (
    <div className="stage">
      <p className="stage-caption">ApnaKhata · {t('app.preview')}</p>
      <LanguageSwitcher />
      <div className="phone">
        <div className="screen">
          {tab === 'HOME' && <Dashboard />}
          {tab === 'KHATA' && <Khata />}
          {tab === 'CREDIT' && <Credit />}
          {tab === 'MARKET' && <Marketplace />}
          {tab === 'GST' && <Compliance />}
          {tab === 'MORE' && <More />}
        </div>
        <nav className="tabbar">
          {TABS.map(({ key, labelKey }) => (
            <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
              <span className="bar" />
              {t(labelKey)}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
