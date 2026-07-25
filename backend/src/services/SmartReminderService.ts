/**
 * ApnaKhata — Liquidity-timed payment reminders
 * ---------------------------------------------
 * A reminder lands best when the customer actually has cash. We already hold
 * every debtor's payment history, so for each shopkeeper who owes a distributor
 * we learn their typical pay-day (day-of-month they usually settle) and suggest
 * sending the nudge just before it — not on a blind fixed cadence. Read-only
 * over payments + the ledger; it recommends *when*, the notifier still sends.
 */

import { Pool } from 'pg';

export interface ReminderSuggestion {
  payerId: string;
  businessName: string;
  outstanding: number;
  overdueInvoices: number;
  typicalPayDayOfMonth: number | null; // 1..28, learned from history
  samplePayments: number;
  confidence: 'high' | 'medium' | 'low';
  suggestedSendDate: string; // ISO date — a day before typical liquidity
  rationale: string;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export class SmartReminderService {
  constructor(private readonly db: Pool) {}

  /** Debtors of this distributor, each with a liquidity-timed send date. */
  async getSuggestions(distributorId: string, today = new Date()): Promise<ReminderSuggestion[]> {
    const { rows } = await this.db.query<{
      payer_id: string;
      business_name: string;
      outstanding: string;
      overdue_invoices: string;
      typical_dom: number | null;
      sample_payments: string;
    }>(
      `
      WITH dues AS (
        SELECT receiver_id AS payer_id,
               SUM(balance_remaining)                              AS outstanding,
               COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)     AS overdue_invoices
        FROM transactions_ledger
        WHERE sender_id = $1 AND balance_remaining > 0
        GROUP BY receiver_id
      ),
      timing AS (
        SELECT payer_id,
               ROUND(AVG(EXTRACT(DAY FROM paid_at)))::int AS typical_dom,
               COUNT(*)                                   AS sample_payments
        FROM payments
        WHERE payee_id = $1
        GROUP BY payer_id
      )
      SELECT d.payer_id, u.business_name, d.outstanding, d.overdue_invoices,
             t.typical_dom, COALESCE(t.sample_payments, 0) AS sample_payments
      FROM dues d
      JOIN users u ON u.id = d.payer_id
      LEFT JOIN timing t ON t.payer_id = d.payer_id
      ORDER BY d.outstanding DESC
      `,
      [distributorId],
    );

    return rows.map((r) => {
      const samples = Number(r.sample_payments);
      const dom = r.typical_dom != null ? Math.min(Math.max(r.typical_dom, 1), 28) : null;
      const confidence = samples >= 4 ? 'high' : samples >= 2 ? 'medium' : 'low';
      const send = this.suggestDate(today, dom);
      return {
        payerId: r.payer_id,
        businessName: r.business_name,
        outstanding: Number(r.outstanding),
        overdueInvoices: Number(r.overdue_invoices),
        typicalPayDayOfMonth: dom,
        samplePayments: samples,
        confidence,
        suggestedSendDate: send,
        rationale:
          dom != null
            ? `Usually pays around the ${ordinal(dom)}; nudge on ${send} (${samples} past payments).`
            : `No payment history yet — sending soon (${send}); timing will sharpen with data.`,
      };
    });
  }

  /** The day before the next occurrence of the typical pay-day. */
  private suggestDate(today: Date, dom: number | null): string {
    if (dom == null) {
      const soon = new Date(today);
      soon.setDate(soon.getDate() + 1);
      return iso(soon);
    }
    // Next occurrence of `dom`, then step back one day to arrive just before.
    let target = new Date(today.getFullYear(), today.getMonth(), dom);
    if (target <= today) target = new Date(today.getFullYear(), today.getMonth() + 1, dom);
    target.setDate(target.getDate() - 1);
    if (target <= today) target = new Date(today.getTime() + 86400000);
    return iso(target);
  }
}

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};
