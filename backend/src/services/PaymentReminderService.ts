/**
 * ApnaKhata — Payment Reminder Service
 * ------------------------------------
 * Dispatches escalating WhatsApp/SMS nudges on overdue invoices. Escalation is
 * driven by the invoice's aging bucket (via the invoices_due_for_reminder DB
 * function, which honours each distributor's per-bucket cadence), and every
 * dispatch is logged to payment_reminders for audit and throttling.
 *
 * Intended to be run on a schedule (e.g. a daily cron / worker).
 */

import { Pool } from 'pg';
import { Notifier, NotificationChannel } from '../notifications/Notifier';

export type AgingBucket = 'CURRENT' | 'OVERDUE_1_30' | 'OVERDUE_31_60' | 'OVERDUE_60_PLUS';

export interface ReminderPolicyInput {
  distributorId: string;
  bucket: AgingBucket;
  channel: NotificationChannel;
  minIntervalDays?: number;
  templateKey?: string;
  enabled?: boolean;
}

export interface DispatchSummary {
  considered: number;
  sent: number;
  failed: number;
}

interface DueRow {
  invoice_id: string;
  creditor_id: string;
  debtor_id: string;
  bucket: AgingBucket;
  channel: NotificationChannel;
  outstanding: string;
  template_key: string;
}

const BUCKET_TONE: Record<Exclude<AgingBucket, 'CURRENT'>, string> = {
  OVERDUE_1_30: 'is now overdue',
  OVERDUE_31_60: 'is over a month overdue',
  OVERDUE_60_PLUS: 'is seriously overdue and may affect your credit score',
};

export class PaymentReminderService {
  constructor(
    private readonly db: Pool,
    private readonly notifier: Notifier,
  ) {}

  /** Upsert an escalation policy for one (distributor, bucket). */
  async upsertPolicy(policy: ReminderPolicyInput): Promise<void> {
    await this.db.query(
      `
      INSERT INTO reminder_policies (distributor_id, bucket, channel, min_interval_days, template_key, enabled)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (distributor_id, bucket) DO UPDATE SET
        channel = EXCLUDED.channel,
        min_interval_days = EXCLUDED.min_interval_days,
        template_key = EXCLUDED.template_key,
        enabled = EXCLUDED.enabled
      `,
      [
        policy.distributorId,
        policy.bucket,
        policy.channel,
        policy.minIntervalDays ?? 3,
        policy.templateKey ?? 'reminder.default',
        policy.enabled ?? true,
      ],
    );
  }

  /**
   * Find every invoice due for a reminder (optionally scoped to one
   * distributor), dispatch it, and log the outcome. Cadence throttling is
   * enforced in SQL so concurrent runs won't double-send within the window.
   */
  async dispatchDueReminders(distributorId?: string): Promise<DispatchSummary> {
    const { rows } = await this.db.query<DueRow>(
      `SELECT * FROM invoices_due_for_reminder($1)`,
      [distributorId ?? null],
    );

    const summary: DispatchSummary = { considered: rows.length, sent: 0, failed: 0 };

    for (const row of rows) {
      const reminderId = await this.logQueued(row);
      try {
        const debtorPhone = await this.lookupPhone(row.debtor_id);
        const result = await this.notifier.send({
          channel: row.channel,
          toPhone: debtorPhone,
          templateKey: row.template_key,
          body: this.buildBody(row),
          variables: {
            invoiceId: row.invoice_id,
            amount: row.outstanding,
            bucket: row.bucket,
          },
        });
        await this.markSent(reminderId, result.providerMessageId);
        summary.sent += 1;
      } catch (err) {
        await this.markFailed(reminderId, err instanceof Error ? err.message : String(err));
        summary.failed += 1;
      }
    }

    return summary;
  }

  private buildBody(row: DueRow): string {
    const tone = row.bucket === 'CURRENT' ? 'is due' : BUCKET_TONE[row.bucket];
    const amount = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(Number(row.outstanding));
    return `Reminder: your ApnaKhata balance of ${amount} ${tone}. Please settle at the earliest.`;
  }

  private async logQueued(row: DueRow): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `
      INSERT INTO payment_reminders
        (invoice_id, debtor_id, creditor_id, bucket, channel, outstanding_amount, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED')
      RETURNING id
      `,
      [row.invoice_id, row.debtor_id, row.creditor_id, row.bucket, row.channel, row.outstanding],
    );
    return rows[0].id;
  }

  private async markSent(reminderId: string, providerMessageId: string): Promise<void> {
    await this.db.query(
      `UPDATE payment_reminders SET status = 'SENT', provider_message_id = $2, sent_at = now() WHERE id = $1`,
      [reminderId, providerMessageId],
    );
  }

  private async markFailed(reminderId: string, detail: string): Promise<void> {
    await this.db.query(
      `UPDATE payment_reminders SET status = 'FAILED', error_detail = $2 WHERE id = $1`,
      [reminderId, detail],
    );
  }

  private async lookupPhone(userId: string): Promise<string> {
    const { rows } = await this.db.query<{ phone: string }>(`SELECT phone FROM users WHERE id = $1`, [userId]);
    if (!rows[0]) throw new Error(`user ${userId} not found`);
    return rows[0].phone;
  }
}
