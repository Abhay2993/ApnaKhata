/**
 * Compliance — GST filing summary (GSTR-1 / 3B), e-invoicing status,
 * GSTR-2B input-tax-credit reconciliation, and e-way bills.
 */

import { useEffect, useState } from 'react';

import { apiGet, isLiveConfigured } from '../api';
import { Card, Header, inr, Row, SectionHead, Tag } from '../components';
import { demo } from '../demo';

function period(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function periodMMYYYY(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
}

export default function Compliance() {
  const [live, setLive] = useState<'demo' | 'live'>('demo');
  const [gstr3b, setGstr3b] = useState(demo.compliance.gstr3b);
  const [itc, setItc] = useState(demo.compliance.itc);

  useEffect(() => {
    if (!isLiveConfigured()) return;
    Promise.all([
      apiGet<typeof demo.compliance.gstr3b>(`/v1/gst/gstr3b?period=${period()}`),
      apiGet<typeof demo.compliance.itc>(`/v1/gst/gstr2b/reconcile?period=${periodMMYYYY()}`),
    ]).then(([g, i]) => {
      let got = false;
      if (g) { setGstr3b(g); got = true; }
      if (i) { setItc(i); got = true; }
      if (got) setLive('live');
    });
  }, []);

  return (
    <>
      <Header title="GST & Compliance" badge={live === 'live' ? 'LIVE' : 'DEMO'} />

      <Card label="This month's GST">
        <div className="cash-grid">
          <div><span className="stat-label">Outward taxable</span><div className="stat-value">{inr(gstr3b.outward_taxable_value)}</div></div>
          <div><span className="stat-label">Total tax</span><div className="stat-value gold">{inr(gstr3b.total_tax)}</div></div>
        </div>
        <div className="metric-grid" style={{ marginTop: 10 }}>
          <div><span className="stat-label">CGST</span><div className="mval">{inr(gstr3b.cgst)}</div></div>
          <div><span className="stat-label">SGST</span><div className="mval">{inr(gstr3b.sgst)}</div></div>
          <div><span className="stat-label">IGST</span><div className="mval">{inr(gstr3b.igst)}</div></div>
        </div>
        <div className="fee-row" style={{ marginTop: 12 }}>
          <button type="button" className="btn-outline" style={{ marginTop: 0 }}>GSTR-1 JSON</button>
          <button type="button" className="btn-outline" style={{ marginTop: 0 }}>GSTR-3B JSON</button>
        </div>
      </Card>

      <Card label="Input tax credit (GSTR-2B match)">
        <div className="frow">
          <div><span className="stat-label">Eligible ITC to claim</span><div className="stat-value gold">{inr(itc.itc.eligible)}</div></div>
          <div style={{ textAlign: 'right' }}><span className="stat-label">At risk</span><div className="stat-value" style={{ color: 'var(--danger)' }}>{inr(itc.itc.atRisk)}</div></div>
        </div>
        <div className="itc-grid">
          <div className="itc-cell"><b className="gold">{itc.counts.MATCHED}</b><span>matched</span></div>
          <div className="itc-cell"><b>{itc.counts.MISMATCH}</b><span>mismatch</span></div>
          <div className="itc-cell"><b style={{ color: 'var(--danger)' }}>{itc.counts.MISSING_IN_2B}</b><span>not filed</span></div>
          <div className="itc-cell"><b>{itc.counts.MISSING_IN_BOOKS}</b><span>unrecorded</span></div>
        </div>
        {itc.itc.atRisk > 0 && <div className="advice">▸ {inr(itc.itc.atRisk)} of ITC is at risk — suppliers haven't filed these invoices. Follow up before you file.</div>}
      </Card>

      <Card label="E-invoicing">
        <Row
          left="IRN generation"
          sub={demo.compliance.einvoice.required ? 'Mandatory (turnover > ₹5cr)' : 'Optional at your turnover'}
          right={<Tag tone={demo.compliance.einvoice.required ? 'gold' : 'slate'}>{demo.compliance.einvoice.required ? 'REQUIRED' : 'OPTIONAL'}</Tag>}
        />
      </Card>

      <SectionHead label="E-way bills" />
      {demo.compliance.eway.map((e, i) => (
        <div key={i} className="alert-card">
          <Row
            left={`EWB ${e.ewbNo}`}
            sub={`${e.invoice} · ${inr(e.value)} · valid to ${e.validUpto}`}
            right={<Tag tone="green">{e.status}</Tag>}
          />
        </div>
      ))}
    </>
  );
}
