/**
 * ApnaKhata — Cash-drawer reconciliation
 * --------------------------------------
 * The daily "cash vs digital" close every shop does by hand: open the drawer
 * with a float, log cash in/out through the day, then count the drawer at close
 * and compare against what the books expect. Expected close =
 *   opening + Σ(cash IN) − Σ(cash OUT); variance = counted − expected.
 * A non-zero variance is the shrinkage/error the shopkeeper wants surfaced.
 */

import { Pool } from 'pg';

export type CashDirection = 'IN' | 'OUT';
export type DrawerStatus = 'OPEN' | 'CLOSED';

export interface DrawerSummary {
  id: string;
  businessDate: string;
  status: DrawerStatus;
  openingBalance: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number | null;
  variance: number | null;
  movementCount: number;
  openedAt: string;
  closedAt: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class CashDrawerService {
  constructor(private readonly db: Pool) {}

  /** Open (or return) today's drawer with an opening float. */
  async open(ownerId: string, openingBalance = 0, date?: string): Promise<DrawerSummary> {
    if (openingBalance < 0) throw new Error('opening balance cannot be negative');
    const { rows } = await this.db.query<{ id: string }>(
      `
      INSERT INTO cash_drawer_days (owner_id, business_date, opening_balance)
      VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3)
      ON CONFLICT (owner_id, business_date) DO UPDATE
        SET opening_balance = CASE WHEN cash_drawer_days.status = 'OPEN'
                                   THEN EXCLUDED.opening_balance ELSE cash_drawer_days.opening_balance END
      RETURNING id
      `,
      [ownerId, date ?? null, openingBalance],
    );
    return this.summary(ownerId, rows[0].id);
  }

  /** Record a cash movement against the open drawer. */
  async addMovement(
    ownerId: string,
    input: { direction: CashDirection; amount: number; reason?: string; note?: string; date?: string },
  ): Promise<DrawerSummary> {
    if (!(input.amount > 0)) throw new Error('amount must be positive');
    const drawer = await this.currentDrawer(ownerId, input.date);
    if (!drawer) throw new Error('no open drawer — open the drawer first');
    if (drawer.status === 'CLOSED') throw new Error('drawer already closed for this date');

    await this.db.query(
      `INSERT INTO cash_drawer_movements (drawer_id, direction, amount, reason, note)
       VALUES ($1, $2, $3, COALESCE($4,'CASH_SALE'), $5)`,
      [drawer.id, input.direction, round2(input.amount), input.reason ?? null, input.note ?? null],
    );
    return this.summary(ownerId, drawer.id);
  }

  /** Close the drawer against a physically counted amount; returns the variance. */
  async close(ownerId: string, countedClosing: number, date?: string): Promise<DrawerSummary> {
    if (countedClosing < 0) throw new Error('counted amount cannot be negative');
    const drawer = await this.currentDrawer(ownerId, date);
    if (!drawer) throw new Error('no open drawer to close');
    if (drawer.status === 'CLOSED') throw new Error('drawer already closed for this date');

    await this.db.query(
      `UPDATE cash_drawer_days SET counted_closing = $2, status = 'CLOSED', closed_at = now() WHERE id = $1`,
      [drawer.id, round2(countedClosing)],
    );
    return this.summary(ownerId, drawer.id);
  }

  /** Today's (or a given date's) drawer summary, or null if none opened. */
  async getToday(ownerId: string, date?: string): Promise<DrawerSummary | null> {
    const drawer = await this.currentDrawer(ownerId, date);
    return drawer ? this.summary(ownerId, drawer.id) : null;
  }

  private async currentDrawer(ownerId: string, date?: string): Promise<{ id: string; status: DrawerStatus } | null> {
    const { rows } = await this.db.query<{ id: string; status: DrawerStatus }>(
      `SELECT id, status FROM cash_drawer_days
        WHERE owner_id = $1 AND business_date = COALESCE($2::date, CURRENT_DATE)`,
      [ownerId, date ?? null],
    );
    return rows[0] ?? null;
  }

  private async summary(ownerId: string, drawerId: string): Promise<DrawerSummary> {
    const { rows } = await this.db.query<{
      id: string; business_date: Date; status: DrawerStatus; opening_balance: string;
      counted_closing: string | null; opened_at: Date; closed_at: Date | null;
      cash_in: string; cash_out: string; movement_count: string;
    }>(
      `
      SELECT d.id, d.business_date, d.status, d.opening_balance, d.counted_closing, d.opened_at, d.closed_at,
             COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'IN'), 0)  AS cash_in,
             COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'OUT'), 0) AS cash_out,
             COUNT(m.id) AS movement_count
      FROM cash_drawer_days d
      LEFT JOIN cash_drawer_movements m ON m.drawer_id = d.id
      WHERE d.id = $1 AND d.owner_id = $2
      GROUP BY d.id
      `,
      [drawerId, ownerId],
    );
    const d = rows[0];
    if (!d) throw new Error('drawer not found');
    const opening = Number(d.opening_balance);
    const cashIn = Number(d.cash_in);
    const cashOut = Number(d.cash_out);
    const expected = round2(opening + cashIn - cashOut);
    const counted = d.counted_closing === null ? null : Number(d.counted_closing);
    return {
      id: d.id,
      businessDate: d.business_date.toISOString().slice(0, 10),
      status: d.status,
      openingBalance: opening,
      cashIn,
      cashOut,
      expectedClosing: expected,
      countedClosing: counted,
      variance: counted === null ? null : round2(counted - expected),
      movementCount: Number(d.movement_count),
      openedAt: d.opened_at.toISOString(),
      closedAt: d.closed_at ? d.closed_at.toISOString() : null,
    };
  }
}
