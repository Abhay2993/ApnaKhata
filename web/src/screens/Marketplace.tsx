/**
 * Marketplace — shopkeeper discovers wholesalers and places an order.
 * Live against /v1/dealers + /v1/purchase-orders/from-catalog when the API is
 * configured; demo data otherwise so the standalone preview still shows the flow.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  CatalogItem,
  DealerResult,
  getCatalog,
  isLiveConfigured,
  orderFromCatalog,
  searchDealers,
} from '../api';

const DEMO_DEALERS: DealerResult[] = [
  {
    dealerId: 'demo-sharma',
    businessName: 'Sharma Distributors',
    city: 'Pune',
    productCount: 4,
    minLeadTimeDays: 2,
    sampleProducts: [
      { sku: 'TATA-SALT-1KG', productName: 'Tata Salt 1kg', wholesalePrice: 22, moq: 24, unit: 'PCS' },
      { sku: 'FORT-OIL-1L', productName: 'Fortune Sunflower Oil 1L', wholesalePrice: 150, moq: 12, unit: 'PCS' },
    ],
  },
];

const DEMO_CATALOG: CatalogItem[] = [
  { sku: 'TATA-SALT-1KG', productName: 'Tata Salt 1kg', category: 'Grocery', wholesalePrice: 22, mrp: 28, moq: 24, unit: 'PCS', leadTimeDays: 2 },
  { sku: 'FORT-OIL-1L', productName: 'Fortune Sunflower Oil 1L', category: 'Grocery', wholesalePrice: 150, mrp: 165, moq: 12, unit: 'PCS', leadTimeDays: 3 },
  { sku: 'AASHIRVAAD-ATTA-5KG', productName: 'Aashirvaad Atta 5kg', category: 'Grocery', wholesalePrice: 240, mrp: 290, moq: 10, unit: 'BAG', leadTimeDays: 3 },
  { sku: 'PARLE-G-800', productName: 'Parle-G 800g Family Pack', category: 'Biscuits', wholesalePrice: 84, mrp: 98, moq: 20, unit: 'PCS', leadTimeDays: 2 },
];

const inr = (n: number): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

export default function Marketplace() {
  const live = isLiveConfigured();
  const [query, setQuery] = useState('');
  const [dealers, setDealers] = useState<DealerResult[]>([]);
  const [selected, setSelected] = useState<DealerResult | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [status, setStatus] = useState('Search a product to find wholesalers');

  const runSearch = async (q: string) => {
    setSelected(null);
    try {
      const results = live
        ? await searchDealers(q)
        : DEMO_DEALERS.filter((d) => !q || d.sampleProducts.some((p) => p.productName.toLowerCase().includes(q.toLowerCase())));
      setDealers(results);
      setStatus(results.length ? `${results.length} dealer(s) found` : 'No dealers found');
    } catch {
      setStatus('Search failed — is the API running?');
    }
  };

  useEffect(() => {
    void runSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDealer = async (dealer: DealerResult) => {
    setSelected(dealer);
    setQty({});
    try {
      setCatalog(live ? await getCatalog(dealer.dealerId) : DEMO_CATALOG);
    } catch {
      setStatus('Could not load catalog');
    }
  };

  const orderTotal = useMemo(
    () => catalog.reduce((sum, item) => sum + (qty[item.sku] ?? 0) * item.wholesalePrice, 0),
    [catalog, qty],
  );

  const placeOrder = async () => {
    if (!selected) return;
    const lines = catalog
      .filter((item) => (qty[item.sku] ?? 0) > 0)
      .map((item) => ({ sku: item.sku, quantity: qty[item.sku] }));
    if (lines.length === 0) {
      setStatus('Add a quantity to at least one item');
      return;
    }
    try {
      if (live) {
        const po = await orderFromCatalog(selected.dealerId, lines);
        setStatus(`Order placed → ${po.poNumber} (${inr(po.totalAmount)})`);
      } else {
        setStatus(`Order placed → PO-DEMO (${inr(orderTotal)})`);
      }
      setQty({});
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Order failed');
    }
  };

  return (
    <>
      <header className="header">
        <span className="wordmark">ApnaKhata</span>
        <span className="header-context">
          Marketplace
          <span className={`mode-badge ${live ? 'live' : 'demo'}`}>{live ? 'LIVE' : 'DEMO'}</span>
        </span>
      </header>

      <div className="mkt-search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch(query)}
          placeholder="Search product or dealer (e.g. oil, atta)"
        />
        <button type="button" className="btn-charge" onClick={() => runSearch(query)}>
          SEARCH
        </button>
      </div>

      <p className="status-line">{status}</p>

      {!selected &&
        dealers.map((d) => (
          <article key={d.dealerId} className="alert-card" style={{ cursor: 'pointer' }} onClick={() => openDealer(d)}>
            <div className="alert-top">
              <div style={{ minWidth: 0 }}>
                <div className="alert-name">{d.businessName}</div>
                <div className="alert-meta">
                  {d.city ?? '—'} · {d.productCount} products · lead {d.minLeadTimeDays ?? '—'}d
                </div>
              </div>
              <span className="section-note">View →</span>
            </div>
            <div className="alert-meta" style={{ marginTop: 8 }}>
              {d.sampleProducts.map((p) => p.productName).join(' · ')}
            </div>
          </article>
        ))}

      {selected && (
        <>
          <div className="section-head">
            <span className="card-label">{selected.businessName}</span>
            <span className="section-note" style={{ cursor: 'pointer' }} onClick={() => setSelected(null)}>
              ← dealers
            </span>
          </div>
          {catalog.map((item) => (
            <div key={item.sku} className="cart-row">
              <div style={{ minWidth: 0 }}>
                <div className="alert-name">{item.productName}</div>
                <div className="qty">
                  {inr(item.wholesalePrice)}/{item.unit} · MOQ {item.moq}
                </div>
              </div>
              <input
                className="mkt-qty"
                type="number"
                min={0}
                placeholder="0"
                value={qty[item.sku] ?? ''}
                onChange={(e) => setQty((p) => ({ ...p, [item.sku]: Number(e.target.value) }))}
              />
            </div>
          ))}
          <div className="checkout-bar">
            <div>
              <span className="stat-label">Order total</span>
              <div className="total">{inr(orderTotal)}</div>
            </div>
            <button type="button" className="btn-charge" disabled={orderTotal === 0} onClick={placeOrder}>
              PLACE ORDER
            </button>
          </div>
        </>
      )}
    </>
  );
}
