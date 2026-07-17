/**
 * ApnaKhata — Migration runner
 * ----------------------------
 * Applies database/schema.sql then database/migrations/*.sql in order, once
 * each, tracked in a schema_migrations table. Application + recording happen in
 * a single transaction per file (the file's own BEGIN/COMMIT is stripped and
 * replaced by ours), so a crash mid-migration leaves nothing half-applied and
 * the file is retried on the next run.
 *
 * Run: DATABASE_URL=… node dist/db/migrate.js   (or `npm run migrate`)
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const DB_DIR = join(__dirname, '../../../database');

interface MigrationFile {
  name: string;
  path: string;
}

function discoverFiles(): MigrationFile[] {
  const files: MigrationFile[] = [{ name: '000_schema.sql', path: join(DB_DIR, 'schema.sql') }];
  const migrationsDir = join(DB_DIR, 'migrations');
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    files.push({ name: f, path: join(migrationsDir, f) });
  }
  return files;
}

/** Strip a leading `BEGIN;` and trailing `COMMIT;` so we control the txn. */
function stripOuterTransaction(sql: string): string {
  return sql
    .replace(/^\s*BEGIN\s*;/i, '')
    .replace(/COMMIT\s*;\s*$/i, '')
    .trim();
}

export async function runMigrations(db: Pool, log: (m: string) => void = console.log): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  const ran: string[] = [];
  for (const file of discoverFiles()) {
    if (applied.has(file.name)) {
      log(`= ${file.name} (already applied)`);
      continue;
    }
    const body = stripOuterTransaction(readFileSync(file.path, 'utf8'));
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(body);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file.name]);
      await client.query('COMMIT');
      log(`+ ${file.name} applied`);
      ran.push(file.name);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }
  log(ran.length ? `migrations complete (${ran.length} applied)` : 'database already up to date');
  return ran;
}

/* istanbul ignore next -- CLI entry */
if (require.main === module) {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  runMigrations(db)
    .then(() => db.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      db.end().finally(() => process.exit(1));
    });
}
