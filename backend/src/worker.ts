/**
 * ApnaKhata — Worker process
 * --------------------------
 * Runs the daily batch jobs on a schedule, separate from the API gateway so it
 * scales and restarts independently. `buildDailyJobs` is exported for tests and
 * for a cron-invoked one-shot mode (call each job's run() from a serverless
 * cron instead of keeping this process resident).
 *
 * Env: DATABASE_URL, TZ (recommend Asia/Kolkata).
 * Run: node dist/worker.js
 */

import { Pool } from 'pg';

import { buildDailyJobs } from './jobs/dailyJobs';
import { JobScheduler } from './jobs/scheduler';

/* istanbul ignore next -- process wiring, exercised in deployment */
if (require.main === module) {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const scheduler = new JobScheduler();
  scheduler.start(buildDailyJobs(db));
  console.log(`apnakhata-worker started (TZ=${process.env.TZ ?? 'system'})`);

  const shutdown = (signal: string) => {
    console.log(`apnakhata-worker: ${signal}, shutting down`);
    scheduler.stop();
    db.end().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
