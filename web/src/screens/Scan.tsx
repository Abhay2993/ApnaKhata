/**
 * Scan & Bill — web port of mobile/src/screens/ScanScreen.tsx.
 * The browser preview has no camera pipeline, so scanning is simulated with
 * demo product chips; cart, checkout, and stock-in flows mirror the mobile
 * screen's behaviour.
 */

import { useMemo, useState } from 'react';

type ScanMode = 'BILLING' | 'STOCK_IN';

interface DemoProduct {
  barcode: string;
  productName: string;
  retailPrice: number;
  currentStock: number;
  unit: string;
}

interface CartLine extends DemoProduct {
  quantity: number;
}

const demoProducts: DemoProduct[] = [
  { barcode: '8901030731234', productName: 'Tata Salt 1kg', retailPrice: 28, currentStock: 14, unit: 'PCS' },
  { barcode: '8901063014324', productName: 'Parle-G 800g Family Pack', retailPrice: 98, currentStock: 35, unit: 'PCS' },
  { barcode: '8902102163072', productName: 'Fortune Sunflower Oil 1L', retailPrice: 165, currentStock: 22, unit: 'PCS' },
];

const inr = (value: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value);

export default function Scan() {
  const [mode, setMode] = useState<ScanMode>('BILLING');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [statusLine, setStatusLine] = useState('Tap a demo product below to simulate a scan');
  const [selected, setSelected] = useState<DemoProduct | null>(null);
  const [qty, setQty] = useState('1');
  const [batchNumber, setBatchNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');

  const cartTotal = useMemo(() => cart.reduce((sum, l) => sum + l.retailPrice * l.quantity, 0), [cart]);

  const simulateScan = (product: DemoProduct) => {
    if (mode === 'BILLING') {
      setCart((prev) => {
        const existing = prev.find((l) => l.barcode === product.barcode);
        if (existing) {
          return prev.map((l) => (l.barcode === product.barcode ? { ...l, quantity: l.quantity + 1 } : l));
        }
        return [...prev, { ...product, quantity: 1 }];
      });
      setStatusLine(`Added ${product.productName}`);
    } else {
      setSelected(product);
      setStatusLine(`Scanned ${product.barcode}`);
    }
  };

  const submitStockIn = () => {
    if (!selected) return;
    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setStatusLine('Enter a valid quantity');
      return;
    }
    // Demo mode: the live app calls POST /v1/inventory/stock-in here.
    setStatusLine(
      `${selected.productName}: stock now ${selected.currentStock + quantity}` +
        (expiryDate ? ` · batch expires ${expiryDate}` : ''),
    );
    setSelected(null);
    setQty('1');
    setBatchNumber('');
    setExpiryDate('');
  };

  const checkout = () => {
    if (cart.length === 0) return;
    // Demo mode: the live app calls POST /v1/billing/checkout (FEFO) here.
    setStatusLine(`Billed ${inr(cartTotal)} — sold FEFO, oldest batches first`);
    setCart([]);
  };

  return (
    <>
      <header className="header">
        <span className="wordmark">ApnaKhata</span>
        <span className="header-context">Scan &amp; Bill</span>
      </header>

      <div className="mode-toggle">
        {(['BILLING', 'STOCK_IN'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? 'active' : ''}
            onClick={() => {
              setMode(m);
              setSelected(null);
              setStatusLine('Tap a demo product below to simulate a scan');
            }}
          >
            {m === 'BILLING' ? 'BILLING' : 'STOCK IN'}
          </button>
        ))}
      </div>

      <div className="viewfinder">
        <span className="corner tl" />
        <span className="corner tr" />
        <span className="corner bl" />
        <span className="corner br" />
        <svg width="150" height="56" aria-hidden="true">
          {[0, 6, 10, 18, 24, 30, 40, 44, 52, 60, 68, 72, 80, 88, 94, 102, 110, 116, 124, 132, 140].map(
            (x, i) => (
              <rect key={x} x={x} y={0} width={i % 3 === 0 ? 5 : 2} height={44} fill="#F5F5F7" />
            ),
          )}
          <line x1="0" y1="22" x2="150" y2="22" stroke="var(--gold-bright)" strokeWidth="1.5" />
        </svg>
        <span className="hint">Camera scanning runs in the mobile app — this preview simulates it</span>
      </div>

      <div className="demo-row">
        {demoProducts.map((p) => (
          <button key={p.barcode} type="button" className="chip-btn" onClick={() => simulateScan(p)}>
            Scan {p.productName.split(' ')[0]} {p.productName.split(' ')[1] ?? ''}
          </button>
        ))}
      </div>

      <p className="status-line">{statusLine}</p>

      {mode === 'STOCK_IN' && selected && (
        <section className="card">
          <div className="alert-name">{selected.productName}</div>
          <div className="alert-meta">
            {selected.barcode} · current stock {selected.currentStock} {selected.unit}
          </div>
          <div className="form-grid">
            <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" inputMode="numeric" />
            <input
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
              placeholder="Batch no. (optional)"
            />
            <input
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              placeholder="Expiry YYYY-MM-DD (optional)"
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
            <button type="button" className="btn-outline" style={{ marginTop: 0 }} onClick={() => setSelected(null)}>
              CANCEL
            </button>
            <button type="button" className="btn-charge" onClick={submitStockIn}>
              ADD STOCK
            </button>
          </div>
        </section>
      )}

      {mode === 'BILLING' && (
        <>
          {cart.length === 0 ? (
            <p className="cart-empty">Scan items to start a bill</p>
          ) : (
            cart.map((line) => (
              <div key={line.barcode} className="cart-row">
                <div style={{ minWidth: 0 }}>
                  <div className="alert-name">{line.productName}</div>
                  <div className="qty">
                    {line.quantity} × {inr(line.retailPrice)}
                  </div>
                </div>
                <strong>{inr(line.quantity * line.retailPrice)}</strong>
              </div>
            ))
          )}
          <div className="checkout-bar">
            <div>
              <span className="stat-label">Total</span>
              <div className="total">{inr(cartTotal)}</div>
            </div>
            <button type="button" className="btn-charge" disabled={cart.length === 0} onClick={checkout}>
              CHARGE
            </button>
          </div>
        </>
      )}
    </>
  );
}
