/**
 * ApnaKhata — Minimal job scheduler (dependency-free)
 * ---------------------------------------------------
 * A tiny setTimeout-based scheduler for the daily batch jobs. Chained
 * (re-armed after each run) rather than setInterval, so a slow run never
 * overlaps its next fire. One job throwing never affects the others.
 *
 * Times are the server's local clock — set TZ=Asia/Kolkata in the worker's
 * environment so "dailyAt 02:00" means 2 AM IST.
 */

export type Schedule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'dailyAt'; hour: number; minute: number };

export interface ScheduledJob {
  name: string;
  schedule: Schedule;
  run: () => Promise<void>;
}

/** Milliseconds from `now` until the schedule's next fire. */
export function nextDelayMs(schedule: Schedule, now: Date = new Date()): number {
  if (schedule.kind === 'interval') return Math.max(schedule.everyMs, 0);
  const next = new Date(now);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export class JobScheduler {
  private timers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly logger: (msg: string) => void = console.log) {}

  start(jobs: ScheduledJob[]): void {
    for (const job of jobs) {
      const when = nextDelayMs(job.schedule);
      this.logger(`[scheduler] ${job.name} armed, first run in ${Math.round(when / 1000)}s`);
      this.arm(job);
    }
  }

  private arm(job: ScheduledJob): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.fire(job);
    }, nextDelayMs(job.schedule));
    this.timers.add(timer);
  }

  private async fire(job: ScheduledJob): Promise<void> {
    const started = Date.now();
    try {
      await job.run();
      this.logger(`[job:${job.name}] ok in ${Date.now() - started}ms`);
    } catch (err) {
      this.logger(`[job:${job.name}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.arm(job); // re-arm for the next occurrence
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
