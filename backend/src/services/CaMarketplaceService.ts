/**
 * ApnaKhata — Chartered-accountant marketplace
 * --------------------------------------------
 * A directory of CAs a shop can engage for GST filing, ITR, audit, or notice
 * response — the human layer on top of auto-accounting and GST-notice handling.
 * Engagements are tracked so the whole compliance workflow lives in one place.
 */

import { Pool } from 'pg';

export interface CaProfessional {
  id: string;
  name: string;
  firm: string | null;
  membershipNo: string | null;
  city: string | null;
  specializations: string[];
  rating: number;
  minFee: number;
  maxFee: number;
  languages: string[];
}

export type EngagementStatus = 'REQUESTED' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface CaEngagement {
  id: string;
  caId: string;
  caName?: string;
  serviceType: string;
  status: EngagementStatus;
  feeQuoted: number | null;
  notes: string | null;
  noticeId: string | null;
  createdAt: string;
}

export class CaMarketplaceService {
  constructor(private readonly db: Pool) {}

  async listCas(filter: { specialization?: string; city?: string } = {}): Promise<CaProfessional[]> {
    const { rows } = await this.db.query<CaRow>(
      `
      SELECT * FROM ca_professionals
      WHERE is_active
        AND ($1::text IS NULL OR $1 = ANY(specializations))
        AND ($2::text IS NULL OR city ILIKE $2)
      ORDER BY rating DESC, name
      `,
      [filter.specialization ?? null, filter.city ?? null],
    );
    return rows.map(mapCa);
  }

  async engage(
    ownerId: string,
    caId: string,
    input: { serviceType: string; notes?: string; noticeId?: string },
  ): Promise<CaEngagement> {
    const { rows: ca } = await this.db.query<{ min_fee: string; max_fee: string }>(
      `SELECT min_fee, max_fee FROM ca_professionals WHERE id = $1 AND is_active`,
      [caId],
    );
    if (ca.length === 0) throw new Error('CA not found or inactive');
    const feeQuoted = Math.round((Number(ca[0].min_fee) + Number(ca[0].max_fee)) / 2);

    const { rows } = await this.db.query<EngagementRow & { ca_name: string }>(
      `
      WITH ins AS (
        INSERT INTO ca_engagements (owner_id, ca_id, service_type, fee_quoted, notes, notice_id)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
      )
      SELECT ins.*, (SELECT name FROM ca_professionals WHERE id = ins.ca_id) AS ca_name FROM ins
      `,
      [ownerId, caId, input.serviceType, feeQuoted, input.notes ?? null, input.noticeId ?? null],
    );
    return mapEngagement(rows[0]);
  }

  async listEngagements(ownerId: string): Promise<CaEngagement[]> {
    const { rows } = await this.db.query<EngagementRow & { ca_name: string }>(
      `
      SELECT e.*, c.name AS ca_name
      FROM ca_engagements e JOIN ca_professionals c ON c.id = e.ca_id
      WHERE e.owner_id = $1 ORDER BY e.created_at DESC
      `,
      [ownerId],
    );
    return rows.map(mapEngagement);
  }

  async updateStatus(ownerId: string, engagementId: string, status: EngagementStatus): Promise<CaEngagement> {
    const { rows } = await this.db.query<EngagementRow & { ca_name: string }>(
      `
      WITH upd AS (
        UPDATE ca_engagements SET status = $3 WHERE id = $1 AND owner_id = $2 RETURNING *
      )
      SELECT upd.*, (SELECT name FROM ca_professionals WHERE id = upd.ca_id) AS ca_name FROM upd
      `,
      [engagementId, ownerId, status],
    );
    if (rows.length === 0) throw new Error('engagement not found');
    return mapEngagement(rows[0]);
  }
}

interface CaRow {
  id: string; name: string; firm: string | null; membership_no: string | null; city: string | null;
  specializations: string[]; rating: string; min_fee: string; max_fee: string; languages: string[];
}
interface EngagementRow {
  id: string; ca_id: string; service_type: string; status: EngagementStatus;
  fee_quoted: string | null; notes: string | null; notice_id: string | null; created_at: Date;
}

const mapCa = (r: CaRow): CaProfessional => ({
  id: r.id,
  name: r.name,
  firm: r.firm,
  membershipNo: r.membership_no,
  city: r.city,
  specializations: r.specializations,
  rating: Number(r.rating),
  minFee: Number(r.min_fee),
  maxFee: Number(r.max_fee),
  languages: r.languages,
});

const mapEngagement = (r: EngagementRow & { ca_name?: string }): CaEngagement => ({
  id: r.id,
  caId: r.ca_id,
  caName: r.ca_name,
  serviceType: r.service_type,
  status: r.status,
  feeQuoted: r.fee_quoted === null ? null : Number(r.fee_quoted),
  notes: r.notes,
  noticeId: r.notice_id,
  createdAt: r.created_at.toISOString(),
});
