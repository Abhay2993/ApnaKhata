/**
 * Ledger — receivables/payables, outstanding bills with reminders, EMI plans,
 * and disputes/credit notes.
 */

import { useEffect, useState } from 'react';

import { apiGet, isLiveConfigured } from '../api';
import { Card, Header, inr, Row, SectionHead, Tag } from '../components';
import { demo } from '../demo';

export default function Ledger() {
  const [live, setLive] = useState<'demo' | 'live'>('demo');
  const [cash, setCash] = useState({ receivables: demo.ledger.receivables, payables: demo.ledger.payables });

  useEffect(() => {
    if (!isLiveConfigured()) return;
    apiGet<{ cashFlow: { receivables: number; payables: number } }>('/v1/dashboard').then((d) => {
      if (d) { setCash(d.cashFlow); setLive('live'); }
    });
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
      </Card>

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
