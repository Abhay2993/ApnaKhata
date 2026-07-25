/**
 * ApnaKhata — GST-notice handling
 * -------------------------------
 * A GST notice is stressful precisely because the shopkeeper doesn't know how
 * to respond. Because ApnaKhata already holds the GST data, it can auto-draft a
 * response grounded in the shop's own reconciled numbers, then hand it to a CA
 * from the marketplace. Notices move OPEN → DRAFTED → RESPONDED → RESOLVED.
 */

import { Pool } from 'pg';

import { CaMarketplaceService } from './CaMarketplaceService';
import { Gstr2bReconciliationService } from './Gstr2bReconciliationService';

export type GstNoticeType = 'ITC_MISMATCH' | 'GSTR3B_LATE' | 'GSTR1_3B_MISMATCH' | 'DRC_01' | 'OTHER';
export type GstNoticeStatus = 'OPEN' | 'DRAFTED' | 'RESPONDED' | 'RESOLVED';

export interface GstNotice {
  id: string;
  noticeType: GstNoticeType;
  referenceNo: string | null;
  period: string | null;
  amountInvolved: number;
  dueDate: string | null;
  status: GstNoticeStatus;
  description: string | null;
  responseDraft: string | null;
  assignedCaId: string | null;
  createdAt: string;
}

export class GstNoticeService {
  constructor(
    private readonly db: Pool,
    private readonly recon: Gstr2bReconciliationService = new Gstr2bReconciliationService(db),
    private readonly cas: CaMarketplaceService = new CaMarketplaceService(db),
  ) {}

  async createNotice(
    ownerId: string,
    input: { noticeType: GstNoticeType; referenceNo?: string; period?: string; amountInvolved?: number; dueDate?: string; description?: string },
  ): Promise<GstNotice> {
    const { rows } = await this.db.query<NoticeRow>(
      `
      INSERT INTO gst_notices (owner_id, notice_type, reference_no, period, amount_involved, due_date, description)
      VALUES ($1,$2,$3,$4,COALESCE($5,0),$6,$7) RETURNING *
      `,
      [ownerId, input.noticeType, input.referenceNo ?? null, input.period ?? null, input.amountInvolved ?? null, input.dueDate ?? null, input.description ?? null],
    );
    return mapNotice(rows[0]);
  }

  async listNotices(ownerId: string): Promise<GstNotice[]> {
    const { rows } = await this.db.query<NoticeRow>(
      `SELECT * FROM gst_notices WHERE owner_id = $1 ORDER BY (status IN ('OPEN','DRAFTED')) DESC, due_date NULLS LAST, created_at DESC`,
      [ownerId],
    );
    return rows.map(mapNotice);
  }

  /** Auto-draft a response grounded in the shop's own GST numbers. */
  async draftResponse(ownerId: string, noticeId: string): Promise<GstNotice> {
    const { rows } = await this.db.query<NoticeRow & { gstin: string | null; business_name: string }>(
      `SELECT n.*, u.gstin, u.business_name FROM gst_notices n JOIN users u ON u.id = n.owner_id
        WHERE n.id = $1 AND n.owner_id = $2`,
      [noticeId, ownerId],
    );
    const notice = rows[0];
    if (!notice) throw new Error('notice not found');

    const draft = await this.buildDraft(ownerId, notice);
    const { rows: upd } = await this.db.query<NoticeRow>(
      `UPDATE gst_notices SET response_draft = $2, status = CASE WHEN status = 'OPEN' THEN 'DRAFTED' ELSE status END
       WHERE id = $1 RETURNING *`,
      [noticeId, draft],
    );
    return mapNotice(upd[0]);
  }

  private async buildDraft(ownerId: string, notice: NoticeRow & { gstin: string | null; business_name: string }): Promise<string> {
    const gstin = notice.gstin ?? '—';
    const ref = notice.reference_no ?? '(reference)';
    const period = notice.period ?? '(period)';
    const head =
      `To,\nThe Proper Officer, GST Department\n\nSubject: Reply to notice ${ref} for tax period ${period}\n` +
      `GSTIN: ${gstin} (${notice.business_name})\n\nSir/Madam,\n`;
    const foot = `\n\nWe request you to kindly consider the above and drop the proceedings. Supporting records are available for verification.\n\nYours faithfully,\nFor ${notice.business_name}`;

    switch (notice.notice_type) {
      case 'ITC_MISMATCH': {
        let numbers = '';
        try {
          const rec = await this.recon.reconcile(ownerId, (notice.period ?? '').replace('-', ''));
          numbers = ` Our reconciliation for ${period} shows eligible ITC of ₹${rec.itc.eligible.toLocaleString('en-IN')} fully supported by GSTR-2B, and ₹${rec.itc.atRisk.toLocaleString('en-IN')} relating to suppliers who have not yet filed, which we have not claimed / will reverse as required.`;
        } catch {
          numbers = ' We have reconciled our purchase register with GSTR-2B and claimed ITC only on matched, supplier-filed invoices.';
        }
        return `${head}With reference to the notice regarding input tax credit mismatch,${numbers} The difference is on account of timing of supplier filing and does not represent ineligible credit.${foot}`;
      }
      case 'GSTR3B_LATE':
        return `${head}The GSTR-3B for ${period} was filed with a delay owing to unavoidable operational reasons. The applicable late fee and interest have been / will be duly discharged. We request a waiver of any further penalty as this is not a habitual default.${foot}`;
      case 'GSTR1_3B_MISMATCH':
        return `${head}The variance between GSTR-1 and GSTR-3B for ${period} is a timing difference in reporting of certain invoices and has been reconciled in the subsequent period. Net tax liability has been correctly discharged.${foot}`;
      case 'DRC_01':
        return `${head}With reference to the show-cause notice in Form DRC-01 for ₹${Number(notice.amount_involved).toLocaleString('en-IN')}, we submit that the demand is not sustainable as our returns and tax payments for ${period} are in order, as detailed in the enclosed reconciliation.${foot}`;
      default:
        return `${head}We acknowledge receipt of the notice and submit that our GST returns for ${period} have been filed correctly and tax duly paid. We enclose the relevant reconciliation for your kind consideration.${foot}`;
    }
  }

  /** Assign the notice to a CA and open a NOTICE_RESPONSE engagement. */
  async assignToCa(ownerId: string, noticeId: string, caId: string): Promise<{ notice: GstNotice; engagementId: string }> {
    const { rows } = await this.db.query<NoticeRow>(
      `UPDATE gst_notices SET assigned_ca_id = $3 WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [noticeId, ownerId, caId],
    );
    if (rows.length === 0) throw new Error('notice not found');
    const engagement = await this.cas.engage(ownerId, caId, {
      serviceType: 'NOTICE_RESPONSE',
      notes: `Respond to GST notice ${rows[0].reference_no ?? noticeId}`,
      noticeId,
    });
    return { notice: mapNotice(rows[0]), engagementId: engagement.id };
  }

  async setStatus(ownerId: string, noticeId: string, status: GstNoticeStatus): Promise<GstNotice> {
    const { rows } = await this.db.query<NoticeRow>(
      `UPDATE gst_notices SET status = $3 WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [noticeId, ownerId, status],
    );
    if (rows.length === 0) throw new Error('notice not found');
    return mapNotice(rows[0]);
  }
}

interface NoticeRow {
  id: string; notice_type: GstNoticeType; reference_no: string | null; period: string | null;
  amount_involved: string; due_date: Date | null; status: GstNoticeStatus; description: string | null;
  response_draft: string | null; assigned_ca_id: string | null; created_at: Date;
}

const mapNotice = (r: NoticeRow): GstNotice => ({
  id: r.id,
  noticeType: r.notice_type,
  referenceNo: r.reference_no,
  period: r.period,
  amountInvolved: Number(r.amount_involved),
  dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
  status: r.status,
  description: r.description,
  responseDraft: r.response_draft,
  assignedCaId: r.assigned_ca_id,
  createdAt: r.created_at.toISOString(),
});
