/**
 * ApnaKhata — Daily batch jobs
 * ----------------------------
 * The scheduled counterparts to the service methods that are otherwise only
 * reachable on demand. Every job is idempotent per day (the underlying SQL
 * dedupes), so a missed run catches up cleanly and a double run is harmless.
 *
 *   00:30  interest-accrual       — one day of late-fee interest on overdue bills
 *   01:00  expiry-writeoff        — zero out expired batches for every owner
 *   02:00  nightly-credit-refresh — re-evaluate each shopkeeper (feeds the score
 *                                   trend: the trigger snapshots one point/day)
 *   09:00  autopay-mandates       — execute due UPI AutoPay debits (capped at dues)
 *   10:00  payment-reminders      — dispatch due WhatsApp/SMS nudges, cadence-throttled
 */

import { Pool } from 'pg';

import { ConsoleNotifier, Notifier } from '../notifications/Notifier';
import { BatchExpiryService } from '../services/BatchExpiryService';
import { CreditScoreEvaluator } from '../services/CreditScoreEvaluator';
import { InterestAccrualService } from '../services/InterestAccrualService';
import { PaymentReminderService } from '../services/PaymentReminderService';
import { UpiMandateService } from '../services/UpiMandateService';
import { ScheduledJob } from './scheduler';

export function buildDailyJobs(db: Pool, notifier: Notifier = new ConsoleNotifier()): ScheduledJob[] {
  const reminders = new PaymentReminderService(db, notifier);
  const interest = new InterestAccrualService(db);
  const expiry = new BatchExpiryService(db);
  const evaluator = new CreditScoreEvaluator(db);
  const mandates = new UpiMandateService(db);

  return [
    {
      name: 'interest-accrual',
      schedule: { kind: 'dailyAt', hour: 0, minute: 30 },
      run: async () => {
        await interest.accrueForDate();
      },
    },
    {
      name: 'expiry-writeoff',
      schedule: { kind: 'dailyAt', hour: 1, minute: 0 },
      run: async () => {
        const { rows } = await db.query<{ owner_id: string }>(
          `
          SELECT DISTINCT i.owner_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
          WHERE b.qty_remaining > 0 AND b.expiry_date < CURRENT_DATE
          `,
        );
        for (const r of rows) await expiry.writeOffExpired(r.owner_id);
      },
    },
    {
      name: 'nightly-credit-refresh',
      schedule: { kind: 'dailyAt', hour: 2, minute: 0 },
      run: async () => {
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM users WHERE is_active AND role = 'SHOPKEEPER'`,
        );
        for (const r of rows) {
          try {
            await evaluator.evaluate(r.id);
          } catch (err) {
            // One thin-file user shouldn't abort the batch.
            console.warn(`credit refresh skipped ${r.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      },
    },
    {
      name: 'payment-reminders',
      schedule: { kind: 'dailyAt', hour: 10, minute: 0 },
      run: async () => {
        await reminders.dispatchDueReminders();
      },
    },
    {
      name: 'autopay-mandates',
      schedule: { kind: 'dailyAt', hour: 9, minute: 0 },
      run: async () => {
        const { executed, skipped } = await mandates.executeDue();
        if (executed || skipped) console.log(`autopay: ${executed} debits executed, ${skipped} rolled forward`);
      },
    },
  ];
}
