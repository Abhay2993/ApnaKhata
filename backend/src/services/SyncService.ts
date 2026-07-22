/**
 * ApnaKhata — Offline-first sync engine
 * -------------------------------------
 * The customer khata is an append-only log, so offline reconciliation is a
 * grow-only-set CRDT: every entry is an immutable fact keyed by a
 * client-generated `opId`. Merging two devices is a set-union — idempotent,
 * commutative, associative — and the balance is a fold over the merged set. No
 * last-writer-wins, no vector clocks, no conflicts.
 *
 *   push  — a device flushes its outbox (a batch of ops). Each op is applied at
 *           most once: replaying an opId returns the original result. Safe under
 *           an at-least-once client that retries after a dropped response.
 *   pull  — a device asks for everything newer than its cursor (a global
 *           server_seq). It returns the customers and entries to merge locally,
 *           plus the new cursor.
 */

import { Pool } from 'pg';

import { CustomerLedgerService } from './CustomerLedgerService';

export type OpType = 'CUSTOMER_LEDGER_ENTRY';

export interface SyncOperation {
  opId: string; // client-generated UUID — the dedup key
  type: OpType;
  clientTs?: string;
  payload: {
    customerName?: string;
    customerId?: string;
    customerPhone?: string;
    entryType: 'CREDIT' | 'PAYMENT';
    amount: number;
    note?: string;
    source?: 'VOICE' | 'MANUAL' | 'WHATSAPP';
    transcript?: string;
  };
}

export interface OpResult {
  opId: string;
  status: 'APPLIED' | 'DUPLICATE' | 'REJECTED';
  ref?: string; // id of the created entry
  reason?: string;
}

export interface PushResult {
  results: OpResult[];
  cursor: number; // latest server_seq after applying — the device's new pull cursor
}

export interface PullResult {
  cursor: number;
  customers: { id: string; name: string; phone: string | null; serverSeq: number }[];
  entries: {
    id: string;
    customerId: string;
    entryType: 'CREDIT' | 'PAYMENT';
    amount: number;
    note: string | null;
    source: string;
    createdAt: string;
    serverSeq: number;
  }[];
}

export class SyncService {
  private readonly customers: CustomerLedgerService;

  constructor(private readonly db: Pool, customers?: CustomerLedgerService) {
    this.customers = customers ?? new CustomerLedgerService(db);
  }

  /** Apply a batch of client operations, each at most once. */
  async push(ownerId: string, deviceId: string, operations: SyncOperation[]): Promise<PushResult> {
    const results: OpResult[] = [];
    for (const op of operations) {
      results.push(await this.applyOne(ownerId, deviceId, op));
    }
    return { results, cursor: await this.currentCursor() };
  }

  private async applyOne(ownerId: string, deviceId: string, op: SyncOperation): Promise<OpResult> {
    if (!op.opId) return { opId: op.opId, status: 'REJECTED', reason: 'missing opId' };
    if (op.type !== 'CUSTOMER_LEDGER_ENTRY') {
      return { opId: op.opId, status: 'REJECTED', reason: `unknown op type ${op.type}` };
    }
    const p = op.payload;
    if (!(p?.amount > 0)) return { opId: op.opId, status: 'REJECTED', reason: 'amount must be positive' };
    if (p.entryType !== 'CREDIT' && p.entryType !== 'PAYMENT') {
      return { opId: op.opId, status: 'REJECTED', reason: 'entryType must be CREDIT or PAYMENT' };
    }
    if (!p.customerId && !p.customerName) {
      return { opId: op.opId, status: 'REJECTED', reason: 'customerId or customerName required' };
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Claim the op id. If it's already there, this is a replay — return the
      // original result and touch nothing.
      const claim = await client.query<{ op_id: string }>(
        `
        INSERT INTO client_operations (op_id, owner_id, device_id, op_type, client_ts)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (op_id) DO NOTHING
        RETURNING op_id
        `,
        [op.opId, ownerId, deviceId, op.type, op.clientTs ?? null],
      );
      if (claim.rows.length === 0) {
        await client.query('COMMIT');
        const prior = await this.db.query<{ result_ref: string | null }>(
          `SELECT result_ref FROM client_operations WHERE op_id = $1`,
          [op.opId],
        );
        return { opId: op.opId, status: 'DUPLICATE', ref: prior.rows[0]?.result_ref ?? undefined };
      }

      let customerId = p.customerId;
      if (!customerId) {
        const customer = await this.customers.ensureCustomer(ownerId, p.customerName as string, p.customerPhone, client);
        customerId = customer.id;
      }

      const { rows } = await client.query<{ id: string }>(
        `
        INSERT INTO customer_ledger_entries
          (customer_id, owner_id, entry_type, amount, note, source, transcript)
        SELECT $1, $2, $3, $4, $5, $6, $7
        WHERE EXISTS (SELECT 1 FROM customers WHERE id = $1 AND owner_id = $2)
        RETURNING id
        `,
        [customerId, ownerId, p.entryType, Math.round(p.amount * 100) / 100, p.note ?? null, p.source ?? 'MANUAL', p.transcript ?? null],
      );
      if (rows.length === 0) throw new Error('customer not found for this owner');

      await client.query(`UPDATE client_operations SET result_ref = $2 WHERE op_id = $1`, [op.opId, rows[0].id]);
      await client.query('COMMIT');
      return { opId: op.opId, status: 'APPLIED', ref: rows[0].id };
    } catch (err) {
      await client.query('ROLLBACK');
      return { opId: op.opId, status: 'REJECTED', reason: err instanceof Error ? err.message : 'apply failed' };
    } finally {
      client.release();
    }
  }

  /** Everything the owner's other devices haven't seen yet. */
  async pull(ownerId: string, since = 0): Promise<PullResult> {
    const { rows: customers } = await this.db.query<{ id: string; name: string; phone: string | null; server_seq: string }>(
      `SELECT id, name, phone, server_seq FROM customers
        WHERE owner_id = $1 AND server_seq > $2 ORDER BY server_seq`,
      [ownerId, since],
    );
    const { rows: entries } = await this.db.query<{
      id: string; customer_id: string; entry_type: 'CREDIT' | 'PAYMENT'; amount: string;
      note: string | null; source: string; created_at: Date; server_seq: string;
    }>(
      `SELECT id, customer_id, entry_type, amount, note, source, created_at, server_seq
         FROM customer_ledger_entries
        WHERE owner_id = $1 AND server_seq > $2 ORDER BY server_seq`,
      [ownerId, since],
    );

    const seqs = [
      ...customers.map((c) => Number(c.server_seq)),
      ...entries.map((e) => Number(e.server_seq)),
      since,
    ];
    return {
      cursor: Math.max(...seqs),
      customers: customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone, serverSeq: Number(c.server_seq) })),
      entries: entries.map((e) => ({
        id: e.id,
        customerId: e.customer_id,
        entryType: e.entry_type,
        amount: Number(e.amount),
        note: e.note,
        source: e.source,
        createdAt: e.created_at.toISOString(),
        serverSeq: Number(e.server_seq),
      })),
    };
  }

  private async currentCursor(): Promise<number> {
    const { rows } = await this.db.query<{ last: string | null }>(`SELECT last_value AS last FROM sync_seq`);
    return rows[0]?.last ? Number(rows[0].last) : 0;
  }
}
