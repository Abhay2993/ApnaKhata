/**
 * ApnaKhata — Fraud & trust graph
 * -------------------------------
 * The transaction ledger is a directed graph (sender → receiver of B2B
 * invoices). Fraud shows up as structure in that graph — circular trading
 * (A→B→C→A round-tripping to inflate turnover / manufacture fake ITC),
 * structuring just under the e-way-bill threshold, duplicate invoices, and
 * ITC claimed against suppliers who never filed. This service walks the graph,
 * surfaces those patterns with reasons, and distills a 0–100 trust score that
 * complements the Credit Passport — a signal lenders and the marketplace can
 * both consume. Detection is read-only; `fraud_cases` records triage.
 */

import { Pool } from 'pg';

export type FraudSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FraudFlag {
  type: 'CIRCULAR_TRADE' | 'STRUCTURING' | 'DUPLICATE_BILLING' | 'ITC_RISK' | 'DISPUTE_RATIO';
  severity: FraudSeverity;
  label: string;
  detail: string;
  scoreImpact: number; // points deducted from trust
}

export interface TradeRing {
  members: { id: string; name: string }[];
  edges: { from: string; to: string; total: number; invoices: number }[];
  totalValue: number;
  circularity: number; // 0..1 — how balanced the round-trip is (1 = perfect loop)
  suspicion: FraudSeverity;
}

export interface TrustReport {
  entityId: string;
  entityName: string;
  trustScore: number; // 0..100
  band: 'TRUSTED' | 'MONITOR' | 'ELEVATED' | 'HIGH_RISK';
  flags: FraudFlag[];
}

interface Edge { from: string; to: string; total: number; invoices: number }

const EWB_THRESHOLD = 50000;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const bandFor = (s: number): TrustReport['band'] =>
  s >= 80 ? 'TRUSTED' : s >= 60 ? 'MONITOR' : s >= 40 ? 'ELEVATED' : 'HIGH_RISK';

export class FraudGraphService {
  constructor(private readonly db: Pool) {}

  /** Trust report for the calling shop (its own exposure). */
  async scan(ownerId: string): Promise<TrustReport & { rings: TradeRing[] }> {
    const report = await this.entityTrust(ownerId);
    const rings = (await this.detectRings()).filter((r) => r.members.some((m) => m.id === ownerId));
    return { ...report, rings };
  }

  /** Trust report for ANY entity — the lender-facing signal. */
  async entityTrust(entityId: string): Promise<TrustReport> {
    const [name, flags] = await Promise.all([this.entityName(entityId), this.entityFlags(entityId)]);
    const trustScore = clamp(100 - flags.reduce((s, f) => s + f.scoreImpact, 0), 0, 100);
    return { entityId, entityName: name, trustScore, band: bandFor(trustScore), flags };
  }

  /** Network-wide circular-trading rings (the headline detector). */
  async detectRings(maxLen = 4): Promise<TradeRing[]> {
    const { rows } = await this.db.query<{ sender_id: string; receiver_id: string; total: string; n: string }>(
      `
      SELECT sender_id, receiver_id, SUM(amount) AS total, COUNT(*) AS n
      FROM transactions_ledger
      WHERE kind = 'B2B_INVOICE' AND receiver_id IS NOT NULL
      GROUP BY sender_id, receiver_id
      `,
    );
    const edges: Edge[] = rows.map((r) => ({ from: r.sender_id, to: r.receiver_id, total: Number(r.total), invoices: Number(r.n) }));
    const adj = new Map<string, Edge[]>();
    const nodes = new Set<string>();
    for (const e of edges) {
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);
      nodes.add(e.from);
      nodes.add(e.to);
    }

    // Enumerate simple cycles, each counted once from its smallest member id.
    const rawCycles: Edge[][] = [];
    const sorted = [...nodes].sort();
    for (const start of sorted) {
      const path: Edge[] = [];
      const onPath = new Set<string>([start]);
      const dfs = (node: string) => {
        for (const e of adj.get(node) ?? []) {
          if (e.to === start && path.length >= 1) {
            rawCycles.push([...path, e]); // closed the loop back to start
            continue;
          }
          if (e.to < start || onPath.has(e.to)) continue; // keep start smallest; simple path
          if (path.length + 1 >= maxLen) continue;
          path.push(e);
          onPath.add(e.to);
          dfs(e.to);
          path.pop();
          onPath.delete(e.to);
        }
      };
      dfs(start);
    }

    const names = await this.namesFor([...nodes]);
    const seen = new Set<string>();
    const rings: TradeRing[] = [];
    for (const cyc of rawCycles) {
      if (cyc.length < 2) continue; // need a real loop (2-cycle = mutual round-trip)
      const memberIds = cyc.map((e) => e.from);
      const key = [...memberIds].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      const totals = cyc.map((e) => e.total);
      const circularity = Math.min(...totals) / Math.max(...totals); // balanced loop → ~1
      // A 2-node mutual loop is only suspicious if it's a balanced round-trip.
      if (cyc.length === 2 && circularity < 0.7) continue;
      const totalValue = Math.round(totals.reduce((a, b) => a + b, 0) * 100) / 100;
      const suspicion: FraudSeverity = cyc.length >= 3 && circularity >= 0.8 ? 'HIGH' : circularity >= 0.6 ? 'MEDIUM' : 'LOW';

      rings.push({
        members: memberIds.map((id) => ({ id, name: names.get(id) ?? 'Unknown' })),
        edges: cyc.map((e) => ({ from: names.get(e.from) ?? 'Unknown', to: names.get(e.to) ?? 'Unknown', total: e.total, invoices: e.invoices })),
        totalValue,
        circularity: Math.round(circularity * 100) / 100,
        suspicion,
      });
    }
    return rings.sort((a, b) => severityRank(b.suspicion) - severityRank(a.suspicion) || b.totalValue - a.totalValue);
  }

  /** Rings + high-risk entities across the network — the alerts feed. */
  async networkAlerts(): Promise<{ rings: TradeRing[]; riskyEntities: TrustReport[] }> {
    const rings = await this.detectRings();
    const suspectIds = new Set<string>();
    for (const r of rings) for (const m of r.members) suspectIds.add(m.id);
    const riskyEntities: TrustReport[] = [];
    for (const id of suspectIds) {
      const rep = await this.entityTrust(id);
      if (rep.band === 'ELEVATED' || rep.band === 'HIGH_RISK') riskyEntities.push(rep);
    }
    riskyEntities.sort((a, b) => a.trustScore - b.trustScore);
    return { rings, riskyEntities };
  }

  private async entityFlags(entityId: string): Promise<FraudFlag[]> {
    const flags: FraudFlag[] = [];

    // Structuring: repeated invoices just under the e-way-bill threshold.
    const { rows: str } = await this.db.query<{ n: string }>(
      `
      SELECT COUNT(*) AS n FROM transactions_ledger
      WHERE kind = 'B2B_INVOICE' AND (sender_id = $1 OR receiver_id = $1)
        AND amount BETWEEN $2 AND $3
      `,
      [entityId, EWB_THRESHOLD * 0.9, EWB_THRESHOLD - 1],
    );
    if (Number(str[0].n) >= 2) {
      flags.push({
        type: 'STRUCTURING', severity: 'HIGH',
        label: `${str[0].n} invoices just under ₹${EWB_THRESHOLD.toLocaleString('en-IN')}`,
        detail: 'Repeated billing just below the e-way-bill threshold suggests structuring to avoid documentation.',
        scoreImpact: 22,
      });
    }

    // Templated billing: the same counterparty invoiced for the identical
    // amount three or more times (a hallmark of fabricated, non-goods invoices).
    const { rows: dup } = await this.db.query<{ amount: string; n: string }>(
      `
      SELECT amount, COUNT(*) AS n FROM transactions_ledger
      WHERE kind = 'B2B_INVOICE' AND sender_id = $1
      GROUP BY receiver_id, amount HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC LIMIT 1
      `,
      [entityId],
    );
    if (dup.length > 0) {
      flags.push({
        type: 'DUPLICATE_BILLING', severity: 'HIGH',
        label: `${dup[0].n} invoices of an identical amount`,
        detail: `Billed ₹${Number(dup[0].amount).toLocaleString('en-IN')} to the same party ${dup[0].n} times — templated invoicing that often masks fake, no-goods supply.`,
        scoreImpact: 24,
      });
    }

    // High dispute ratio on invoices this entity issued.
    const { rows: disp } = await this.db.query<{ invoices: string; disputes: string }>(
      `
      SELECT COUNT(DISTINCT tl.id) AS invoices, COUNT(DISTINCT d.id) AS disputes
      FROM transactions_ledger tl
      LEFT JOIN invoice_disputes d ON d.invoice_id = tl.id
      WHERE tl.sender_id = $1 AND tl.kind = 'B2B_INVOICE'
      `,
      [entityId],
    );
    const invoices = Number(disp[0].invoices);
    const disputes = Number(disp[0].disputes);
    if (invoices >= 4 && disputes / invoices > 0.25) {
      flags.push({
        type: 'DISPUTE_RATIO', severity: 'MEDIUM',
        label: `${Math.round((disputes / invoices) * 100)}% of invoices disputed`,
        detail: 'An unusually high dispute rate points to quality or billing-integrity issues.',
        scoreImpact: 15,
      });
    }

    // Circular-trade participation.
    const rings = await this.detectRings();
    const inRing = rings.find((r) => r.members.some((m) => m.id === entityId));
    if (inRing) {
      flags.push({
        type: 'CIRCULAR_TRADE', severity: inRing.suspicion,
        label: `part of a ${inRing.members.length}-party trading loop`,
        detail: `Round-tripping ${'₹' + inRing.totalValue.toLocaleString('en-IN')} through ${inRing.members.map((m) => m.name).join(' → ')} → back. Circularity ${(inRing.circularity * 100).toFixed(0)}%.`,
        scoreImpact: inRing.suspicion === 'HIGH' ? 38 : inRing.suspicion === 'MEDIUM' ? 22 : 10,
      });
    }

    return flags;
  }

  // --- triage workflow -----------------------------------------------------
  async raiseCase(
    ownerId: string,
    input: { caseType: string; severity?: FraudSeverity; subjectLabel: string; detail?: Record<string, unknown> },
  ): Promise<FraudCase> {
    const { rows } = await this.db.query<CaseRow>(
      `INSERT INTO fraud_cases (owner_id, case_type, severity, subject_label, detail)
       VALUES ($1,$2,COALESCE($3::fraud_severity,'MEDIUM'),$4,$5) RETURNING *`,
      [ownerId, input.caseType, input.severity ?? null, input.subjectLabel, input.detail ? JSON.stringify(input.detail) : null],
    );
    return mapCase(rows[0]);
  }

  async listCases(ownerId: string): Promise<FraudCase[]> {
    const { rows } = await this.db.query<CaseRow>(
      `SELECT * FROM fraud_cases WHERE owner_id = $1 ORDER BY (status IN ('OPEN','REVIEWING')) DESC, created_at DESC`,
      [ownerId],
    );
    return rows.map(mapCase);
  }

  async resolveCase(ownerId: string, caseId: string, status: 'REVIEWING' | 'CONFIRMED' | 'DISMISSED'): Promise<FraudCase> {
    const { rows } = await this.db.query<CaseRow>(
      `UPDATE fraud_cases SET status = $3::fraud_case_status,
              resolved_at = CASE WHEN $3::text IN ('CONFIRMED','DISMISSED') THEN now() ELSE resolved_at END
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [caseId, ownerId, status],
    );
    if (rows.length === 0) throw new Error('fraud case not found');
    return mapCase(rows[0]);
  }

  private async entityName(id: string): Promise<string> {
    const { rows } = await this.db.query<{ business_name: string }>(`SELECT business_name FROM users WHERE id = $1`, [id]);
    return rows[0]?.business_name ?? 'Unknown';
  }

  private async namesFor(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.db.query<{ id: string; business_name: string }>(
      `SELECT id, business_name FROM users WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r.business_name]));
  }
}

export interface FraudCase {
  id: string;
  caseType: string;
  severity: FraudSeverity;
  subjectLabel: string;
  detail: Record<string, unknown> | null;
  status: string;
  createdAt: string;
}

interface CaseRow {
  id: string; case_type: string; severity: FraudSeverity; subject_label: string;
  detail: Record<string, unknown> | null; status: string; created_at: Date;
}

const severityRank = (s: FraudSeverity): number => (s === 'HIGH' ? 3 : s === 'MEDIUM' ? 2 : 1);

const mapCase = (r: CaseRow): FraudCase => ({
  id: r.id,
  caseType: r.case_type,
  severity: r.severity,
  subjectLabel: r.subject_label,
  detail: r.detail,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});
