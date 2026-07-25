/**
 * Ledger — receivables/payables, outstanding bills with reminders, EMI plans,
 * and disputes/credit notes.
 */

import { useEffect, useState } from 'react';

import { apiGet, isLiveConfigured, listMandates, Mandate } from '../api';
import { Card, Header, inr, Row, SectionHead, Tag } from '../components';
import { demo } from '../demo';

const DEMO_MANDATES: Mandate[] = [
  { id: 'demo-m1', maxAmount: 5000, frequency: 'MONTHLY', umn: 'UMN9AF483D6266D4687', status: 'ACTIVE', nextDebitDate: '2026-08-18' },
];

export default function Ledger() {
  const [live, setLive] = useState<'demo' | 'live'>('demo');
  const [cash, setCash] = useState({ receivables: demo.ledger.receivables, payables: demo.ledger.payables });
  const [mandates, setMandates] = useState<Mandate[]>(DEMO_MANDATES);

  useEffect(() => {
    if (!isLiveConfigured()) return;
    apiGet<{ cashFlow: { receivables: number; payables: number } }>('/v1/dashboard').then((d) => {
      if (d) { setCash(d.cashFlow); setLive('live'); }
    });
    listMandates().then((m) => { if (m) setMandates(m); });
  }, []);

  return (
    <>
      <Header title="Ledger (Khata)" badge={live === 'live' ? 'LIVE' : 'DEMO'} />

      <Card label="Cash position">
        <div className="cash-grid">
          <div><span className="stat-label">To receive</span><div className="stat-value gold">{inr(cash.receivables)}</div></div>
          <div><span className="stat-label">To pay</span><div className="stat-value">{inr(cash.payables)}</div></div>
        </div>
      </Card>

      <SectionHead label="Outstanding bills" note="FIFO auto-settled" />
      {demo.ledger.invoices.map((inv, i) => (
        <div key={i} className="alert-card">
          <Row
            left={inv.party}
            sub={`${inv.invoiceNumber} · due ${inv.dueDate}`}
            right={<div style={{ textAlign: 'right' }}><b>{inr(inv.balance)}</b><div className="frow-sub"><Tag tone={inv.overdue ? 'red' : inv.status === 'PARTIAL' ? 'gold' : 'slate'}>{inv.overdue ? 'OVERDUE' : inv.status}</Tag></div></div>}
          />
        </div>
      ))}

      <Card label="Payment reminders">
        <Row
          left="Auto WhatsApp/SMS nudges"
          sub={`${demo.ledger.reminders.sent} sent today · escalates by aging bucket`}
          right={<Tag tone="green">ON</Tag>}
        />
        <Row
          left="Liquidity-timed"
          sub="Nudges land just before each buyer's usual pay-day, learned from their payment history"
          right={<Tag tone="gold">SMART</Tag>}
        />
      </Card>

      <SectionHead label="UPI AutoPay (e-mandate)" note="recurring distributor payments" />
      {mandates.length === 0 && <div className="cart-empty">No mandates yet — set one up with your distributor.</div>}
      {mandates.map((m) => (
        <div key={m.id} className="alert-card">
          <Row
            left={`Up to ${inr(m.maxAmount)} · ${m.frequency === 'MONTHLY' ? 'monthly' : 'weekly'}`}
            sub={m.umn ? `UMN ${m.umn} · next debit ${m.nextDebitDate ?? '—'} · settles FIFO` : 'awaiting UPI-app approval'}
            right={<Tag tone={m.status === 'ACTIVE' ? 'green' : m.status === 'PENDING' ? 'gold' : 'slate'}>{m.status}</Tag>}
          />
        </div>
      ))}

      <SectionHead label="EMI plans" />
      {demo.ledger.plans.map((p, i) => (
        <div key={i} className="alert-card">
          <Row
            left={`${p.invoice} — ${p.installmentCount} installments`}
            sub={`${p.paid}/${p.installmentCount} paid · next ${p.nextDue}`}
            right={<b className="gold">{inr(p.amountDue)}</b>}
          />
        </div>
      ))}

      <SectionHead label="Disputes & credit notes" />
      {demo.ledger.disputes.map((d, i) => (
        <div key={i} className="alert-card">
          <Row
            left={d.invoiceNumber}
            sub={d.reason}
            right={<div style={{ textAlign: 'right' }}><Tag tone="green">{d.status.replace('RESOLVED_', '')}</Tag><div className="frow-sub">{inr(d.disputedAmount)}</div></div>}
          />
        </div>
      ))}
    </>
  );
}
