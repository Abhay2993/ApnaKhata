/**
 * ApnaKhata — Customer khata (consumer udhaar ledger)
 * ---------------------------------------------------
 * The retail-side ledger every kirana keeps by hand: who owes the shop and how
 * much. This is where voice ("Ramesh ko paanch sau udhaar") and WhatsApp
 * entries land, alongside manual ones. A positive balance means the customer
 * owes the shop.
 *
 * The parser (nlp/CommandParser) turns an utterance into a structured
 * LedgerCommand; this service resolves the customer (creating one on first
 * mention) and posts the entry, returning the new running balance.
 */

import { Pool, PoolClient } from 'pg';

import { LedgerCommand, parseLedgerCommand } from '../nlp/CommandParser';
import { LoyaltyService } from './LoyaltyService';

/** Either the pool or a checked-out client, so callers can run inside a txn. */
type Executor = Pool | PoolClient;

export type CustomerEntryType = 'CREDIT' | 'PAYMENT';
export type EntrySource = 'VOICE' | 'MANUAL' | 'WHATSAPP';

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

export interface CustomerBalance extends Customer {
  balance: number;
  lastActivity: string | null;
}

export interface LedgerEntry {
  id: string;
  customerId: string;
  entryType: CustomerEntryType;
  amount: number;
  note: string | null;
  source: EntrySource;
  transcript: string | null;
  createdAt: string;
}

export interface AddEntryInput {
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  entryType: CustomerEntryType;
  amount: number;
  note?: string;
  source?: EntrySource;
  transcript?: string;
}

export interface EntryResult {
  customer: CustomerBalance;
  entry: LedgerEntry;
}

/** Result of interpreting and posting a spoken/typed ledger command. */
export interface VoiceResult {
  command: LedgerCommand;
  posted: boolean;
  reason?: string; // why nothing was posted (low confidence, missing party/amount)
  result?: EntryResult;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class CustomerLedgerService {
  // Optional: award loyalty points when a customer buys on credit (three-sided
  // consumer graph). Injected so the ledger has no hard dependency on loyalty.
  constructor(private readonly db: Pool, private readonly loyalty?: LoyaltyService) {}

  /**
   * Resolve a customer for a spoken/typed name, creating one on first mention.
   * Matching is deliberately forgiving so "Ramesh" hits the stored "Ramesh
   * Kumar": exact (case-insensitive) wins, then a first-name / prefix match.
   * Only when nothing matches is a new customer created.
   */
  async ensureCustomer(ownerId: string, name: string, phone?: string | null, exec: Executor = this.db): Promise<Customer> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('customer name is required');

    const { rows: found } = await exec.query<CustomerRow>(
      `
      SELECT id, name, phone FROM customers
      WHERE owner_id = $1
        AND (
          lower(name) = lower($2)
          OR lower(name) LIKE lower($2) || ' %'          -- spoken first name → "First Last"
          OR lower(split_part(name, ' ', 1)) = lower($2)  -- stored "First Last", spoken "First"
        )
      ORDER BY (lower(name) = lower($2)) DESC, created_at
      LIMIT 1
      `,
      [ownerId, trimmed],
    );
    if (found.length) {
      const existing = found[0];
      if (phone && !existing.phone) {
        await exec.query(`UPDATE customers SET phone = $2 WHERE id = $1`, [existing.id, phone]);
        existing.phone = phone;
      }
      return mapCustomer(existing);
    }

    const { rows } = await exec.query<CustomerRow>(
      `
      INSERT INTO customers (owner_id, name, phone)
      VALUES ($1, $2, $3)
      ON CONFLICT (owner_id, name) DO UPDATE
        SET phone = COALESCE(customers.phone, EXCLUDED.phone)
      RETURNING id, name, phone
      `,
      [ownerId, trimmed, phone ?? null],
    );
    return mapCustomer(rows[0]);
  }

  /** Post a ledger entry, resolving the customer by id or name. */
  async addEntry(ownerId: string, input: AddEntryInput): Promise<EntryResult> {
    if (!(input.amount > 0)) throw new Error('amount must be positive');

    let customerId = input.customerId;
    if (!customerId) {
      if (!input.customerName) throw new Error('a customer id or name is required');
      const customer = await this.ensureCustomer(ownerId, input.customerName, input.customerPhone);
      customerId = customer.id;
    }

    const { rows } = await this.db.query<EntryRow>(
      `
      INSERT INTO customer_ledger_entries
        (customer_id, owner_id, entry_type, amount, note, source, transcript)
      SELECT $1, $2, $3, $4, $5, $6, $7
      WHERE EXISTS (SELECT 1 FROM customers WHERE id = $1 AND owner_id = $2)
      RETURNING id, customer_id, entry_type, amount, note, source, transcript, created_at
      `,
      [customerId, ownerId, input.entryType, round2(input.amount), input.note ?? null,
       input.source ?? 'MANUAL', input.transcript ?? null],
    );
    if (rows.length === 0) throw new Error('customer not found');

    // A credit purchase (goods taken) earns loyalty points — best-effort, never
    // fails the ledger entry.
    if (this.loyalty && input.entryType === 'CREDIT') {
      try {
        await this.loyalty.earnForPurchase(ownerId, customerId, round2(input.amount), rows[0].id);
      } catch {
        /* loyalty is non-critical to the ledger */
      }
    }

    const balance = await this.getBalance(ownerId, customerId);
    return { customer: balance, entry: mapEntry(rows[0]) };
  }

  /**
   * Interpret a spoken/typed utterance and post it. Only high/medium-confidence
   * commands with a party and amount are posted; anything else is returned
   * un-posted with a reason so the caller can ask the user to confirm.
   */
  async recordFromVoice(
    ownerId: string,
    transcript: string,
    source: EntrySource = 'VOICE',
  ): Promise<VoiceResult> {
    const command = parseLedgerCommand(transcript);
    return this.postCommand(ownerId, command, source);
  }

  /** Post an already-parsed command (shared by voice and the WhatsApp bot). */
  async postCommand(ownerId: string, command: LedgerCommand, source: EntrySource): Promise<VoiceResult> {
    if (command.intent === 'UNKNOWN') {
      return { command, posted: false, reason: 'Could not tell if this is credit or a payment.' };
    }
    if (!command.party) {
      return { command, posted: false, reason: 'Could not identify the customer name.' };
    }
    if (!command.amount || command.amount <= 0) {
      return { command, posted: false, reason: 'Could not identify an amount.' };
    }

    const entryType: CustomerEntryType = command.intent === 'RECORD_PAYMENT' ? 'PAYMENT' : 'CREDIT';
    const result = await this.addEntry(ownerId, {
      customerName: command.party,
      entryType,
      amount: command.amount,
      source,
      transcript: command.transcript,
    });
    return { command, posted: true, result };
  }

  /** All customers with their running balances, most recently active first. */
  async listCustomers(ownerId: string): Promise<CustomerBalance[]> {
    const { rows } = await this.db.query<BalanceRow>(
      `
      SELECT customer_id, name, phone, balance, last_activity
      FROM v_customer_balances
      WHERE owner_id = $1
      ORDER BY last_activity DESC NULLS LAST, name
      `,
      [ownerId],
    );
    return rows.map(mapBalance);
  }

  /** One customer's current balance. */
  async getBalance(ownerId: string, customerId: string): Promise<CustomerBalance> {
    const { rows } = await this.db.query<BalanceRow>(
      `SELECT customer_id, name, phone, balance, last_activity
         FROM v_customer_balances WHERE owner_id = $1 AND customer_id = $2`,
      [ownerId, customerId],
    );
    if (rows.length === 0) throw new Error('customer not found');
    return mapBalance(rows[0]);
  }

  /**
   * Resolve a customer of this shop by phone for WhatsApp balance lookups.
   * Compares the last 10 digits so stored "+91…" numbers match the bare number
   * WhatsApp delivers.
   */
  async getBalanceByPhone(ownerId: string, phone: string): Promise<CustomerBalance | null> {
    const last10 = phone.replace(/\D/g, '').slice(-10);
    const { rows } = await this.db.query<BalanceRow>(
      `SELECT customer_id, name, phone, balance, last_activity
         FROM v_customer_balances
         WHERE owner_id = $1 AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $2
         ORDER BY last_activity DESC NULLS LAST LIMIT 1`,
      [ownerId, last10],
    );
    return rows.length ? mapBalance(rows[0]) : null;
  }

  /** A customer's recent ledger entries (statement). */
  async getEntries(ownerId: string, customerId: string, limit = 50): Promise<LedgerEntry[]> {
    const { rows } = await this.db.query<EntryRow>(
      `
      SELECT id, customer_id, entry_type, amount, note, source, transcript, created_at
      FROM customer_ledger_entries
      WHERE owner_id = $1 AND customer_id = $2
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [ownerId, customerId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(mapEntry);
  }
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
}

interface BalanceRow {
  customer_id: string;
  name: string;
  phone: string | null;
  balance: string;
  last_activity: Date | null;
}

interface EntryRow {
  id: string;
  customer_id: string;
  entry_type: CustomerEntryType;
  amount: string;
  note: string | null;
  source: EntrySource;
  transcript: string | null;
  created_at: Date;
}

const mapCustomer = (r: CustomerRow): Customer => ({ id: r.id, name: r.name, phone: r.phone });

const mapBalance = (r: BalanceRow): CustomerBalance => ({
  id: r.customer_id,
  name: r.name,
  phone: r.phone,
  balance: Number(r.balance),
  lastActivity: r.last_activity ? r.last_activity.toISOString() : null,
});

const mapEntry = (r: EntryRow): LedgerEntry => ({
  id: r.id,
  customerId: r.customer_id,
  entryType: r.entry_type,
  amount: Number(r.amount),
  note: r.note,
  source: r.source,
  transcript: r.transcript,
  createdAt: r.created_at.toISOString(),
});
