/**
 * Storefront — the three-sided consumer graph.
 * ONDC storefront (publish live inventory to the Open Network, receive consumer
 * orders that draw down stock) + a loyalty program on the customer khata. The
 * kirana's consumer relationships now live in ApnaKhata. Live against
 * /v1/ondc + /v1/loyalty; canned data drives the standalone demo.
 */

import { useEffect, useState } from 'react';

import {
  fetchLoyalty,
  getOndcListings,
  isLiveConfigured,
  listOndcOrders,
  LoyaltyMember,
  OndcListing,
  OndcOrder,
  publishToOndc,
  simulateOndcOrder,
} from '../api';
import { Card, Header, inr, Row, SectionHead, Tag } from '../components';

const DEMO_LOYALTY: LoyaltyMember[] = [
  { customerId: 'd1', customerName: 'Ramesh Kumar', pointsBalance: 1240, lifetimePoints: 1240, tier: 'PLATINUM' },
  { customerId: 'd2', customerName: 'Suresh Yadav', pointsBalance: 360, lifetimePoints: 360, tier: 'GOLD' },
  { customerId: 'd3', customerName: 'Anita Sharma', pointsBalance: 90, lifetimePoints: 90, tier: 'SILVER' },
];
const DEMO_LISTINGS: OndcListing[] = [
  { sku: 'TATA-SALT-1KG', productName: 'Tata Salt 1kg', price: 28, currentStock: 14 },
  { sku: 'FORT-OIL-1L', productName: 'Fortune Sunflower Oil 1L', price: 165, currentStock: 22 },
  { sku: 'PARLE-G-800', productName: 'Parle-G 800g Family Pack', price: 98, currentStock: 35 },
];
const DEMO_HANDLE = 'gupta-general-store.ondc.apnakhata.in';

const tierTone = (t: string) => (t === 'PLATINUM' ? 'gold' : t === 'GOLD' ? 'green' : 'slate');

export default function Storefront() {
  const live = isLiveConfigured();
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [published, setPublished] = useState(false);
  const [handle, setHandle] = useState(DEMO_HANDLE);
  const [listings, setListings] = useState<OndcListing[]>(DEMO_LISTINGS);
  const [orders, setOrders] = useState<OndcOrder[]>([]);
  const [members, setMembers] = useState<LoyaltyMember[]>(DEMO_LOYALTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    Promise.all([getOndcListings(), listOndcOrders(), fetchLoyalty()]).then(([l, o, m]) => {
      setMode('live');
      if (l && l.length) { setListings(l); setPublished(true); }
      if (o) setOrders(o);
      if (m) setMembers(m);
    });
  }, [live]);

  const publish = async () => {
    setBusy('publish');
    if (mode === 'live') {
      const res = await publishToOndc();
      if (res) { setPublished(true); setHandle(res.storefrontHandle); setListings(res.listings); }
    } else {
      await pause();
      setPublished(true);
    }
    setBusy(null);
    setNote('Catalog live on ONDC — consumers across the network can now order.');
  };

  const simulate = async () => {
    setBusy('order');
    if (mode === 'live') {
      const o = await simulateOndcOrder();
      if (o) { setOrders((prev) => [o, ...prev]); getOndcListings().then((l) => l && setListings(l)); fetchLoyalty().then((m) => m && setMembers(m)); }
    } else {
      await pause();
      const items = DEMO_LISTINGS.slice(0, 2).map((l) => ({ sku: l.sku, name: l.productName, qty: 2, price: l.price }));
      const total = items.reduce((s, i) => s + i.qty * i.price, 0);
      setOrders((prev) => [{ id: `d${Date.now()}`, ondcOrderId: `ORD-${Date.now().toString().slice(-6)}`, buyerName: 'Priya (ONDC)', buyerPincode: '411001', items, total, status: 'RECEIVED', loyaltyAwarded: Math.floor(total / 50), createdAt: new Date().toISOString() }, ...prev]);
      setListings((prev) => prev.map((l) => (items.some((i) => i.sku === l.sku) ? { ...l, currentStock: l.currentStock - 2 } : l)));
    }
    setBusy(null);
    setNote('Consumer order received — stock drawn down, loyalty points awarded.');
  };

  return (
    <>
      <Header title="Storefront" badge={mode === 'live' ? 'LIVE' : 'DEMO'} />

      {/* ONDC */}
      <Card label="ONDC storefront">
        {!published ? (
          <>
            <p className="voice-subtitle" style={{ marginTop: 2 }}>
              Publish your live inventory to the Open Network for Digital Commerce — sell to any consumer on the network, not just walk-ins.
            </p>
            <button type="button" className="voice-btn" disabled={busy === 'publish'} onClick={publish}>
              {busy === 'publish' ? 'PUBLISHING…' : '🛒 Publish to ONDC'}
            </button>
          </>
        ) : (
          <>
            <div className="frow">
              <div style={{ minWidth: 0 }}>
                <div className="frow-sub">Live storefront</div>
                <div className="rupay-value" style={{ fontSize: 13, color: 'var(--gold-bright)' }}>{handle}</div>
              </div>
              <Tag tone="green">{listings.length} LISTED</Tag>
            </div>
            <button type="button" className="voice-record" style={{ marginTop: 12, width: '100%' }} disabled={busy === 'order'} onClick={simulate}>
              {busy === 'order' ? 'RECEIVING…' : 'Simulate a consumer order'}
            </button>
          </>
        )}
      </Card>

      {orders.length > 0 && (
        <>
          <SectionHead label="ONDC orders" note={`${orders.length}`} />
          {orders.slice(0, 5).map((o) => (
            <div key={o.id} className="alert-card">
              <Row
                left={`${o.buyerName ?? 'Consumer'} · ${o.buyerPincode ?? ''}`}
                sub={`${o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')} · ${o.ondcOrderId}`}
                right={<div style={{ textAlign: 'right' }}><b className="gold">{inr(o.total)}</b>{o.loyaltyAwarded ? <div className="frow-sub">+{o.loyaltyAwarded} pts</div> : null}</div>}
              />
            </div>
          ))}
        </>
      )}

      {/* Loyalty */}
      <SectionHead label="Loyalty members" note="1 pt / ₹50 · redeem 1 pt = ₹1" />
      {members.length === 0 && <div className="cart-empty">No loyalty members yet — credit purchases enrol customers automatically.</div>}
      {members.map((m) => (
        <div key={m.customerId} className="alert-card">
          <Row
            left={m.customerName ?? 'Customer'}
            sub={`${m.lifetimePoints} lifetime pts`}
            right={<div style={{ textAlign: 'right' }}><b className="gold">{m.pointsBalance} pts</b><div className="frow-sub"><Tag tone={tierTone(m.tier)}>{m.tier}</Tag></div></div>}
          />
        </div>
      ))}

      {note && <p className="status-line">{note}</p>}
    </>
  );
}

const pause = () => new Promise<void>((r) => setTimeout(r, 550));
