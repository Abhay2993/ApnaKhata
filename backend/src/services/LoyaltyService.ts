/**
 * ApnaKhata — Consumer loyalty program
 * ------------------------------------
 * Points tied to the customer khata: every credit purchase earns points, which
 * the consumer redeems for value. This turns the kirana's customer
 * relationships into data that lives in ApnaKhata — a third side of the network
 * and a real switching cost.
 *
 *   Earn  : 1 point per ₹50 of purchase.
 *   Redeem: 1 point = ₹1 of value.
 *   Tier  : SILVER < 200 lifetime pts, GOLD < 1000, PLATINUM ≥ 1000.
 */

import { Pool } from 'pg';

export type LoyaltyTier = 'SILVER' | 'GOLD' | 'PLATINUM';

export interface LoyaltyAccount {
  customerId: string;
  customerName?: string;
  pointsBalance: number;
  lifetimePoints: number;
  tier: LoyaltyTier;
}

const EARN_PER_RUPEE = 1 / 50;
const tierFor = (lifetime: number): LoyaltyTier => (lifetime >= 1000 ? 'PLATINUM' : lifetime >= 200 ? 'GOLD' : 'SILVER');

export class LoyaltyService {
  constructor(private readonly db: Pool) {}

  /** Award points for a purchase (best-effort — never blocks the ledger entry). */
  async earnForPurchase(ownerId: string, customerId: string, purchaseAmount: number, ref?: string): Promise<LoyaltyAccount | null> {
    const points = Math.floor(purchaseAmount * EARN_PER_RUPEE);
    if (points <= 0) return null;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<AccountRow>(
        `
        INSERT INTO loyalty_accounts (customer_id, owner_id, points_balance, lifetime_points, tier)
        VALUES ($1, $2, $3, $3, $4)
        ON CONFLICT (customer_id) DO UPDATE
          SET points_balance  = loyalty_accounts.points_balance + EXCLUDED.points_balance,
              lifetime_points = loyalty_accounts.lifetime_points + EXCLUDED.lifetime_points
        RETURNING *
        `,
        [customerId, ownerId, points, tierFor(points)],
      );
      const acct = rows[0];
      const newTier = tierFor(acct.lifetime_points);
      if (newTier !== acct.tier) {
        await client.query(`UPDATE loyalty_accounts SET tier = $2 WHERE id = $1`, [acct.id, newTier]);
        acct.tier = newTier;
      }
      await client.query(
        `INSERT INTO loyalty_txns (account_id, direction, points, reason, ref) VALUES ($1,'EARN',$2,'PURCHASE',$3)`,
        [acct.id, points, ref ?? null],
      );
      await client.query('COMMIT');
      return mapAccount(acct);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Redeem points for value (1 pt = ₹1). Returns the rupee value redeemed. */
  async redeem(ownerId: string, customerId: string, points: number): Promise<{ account: LoyaltyAccount; valueRupees: number }> {
    if (!(points > 0)) throw new Error('points must be positive');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<AccountRow>(
        `SELECT * FROM loyalty_accounts WHERE customer_id = $1 AND owner_id = $2 FOR UPDATE`,
        [customerId, ownerId],
      );
      const acct = rows[0];
      if (!acct) throw new Error('no loyalty account for this customer');
      if (points > acct.points_balance) throw new Error('insufficient points');

      await client.query(`UPDATE loyalty_accounts SET points_balance = points_balance - $2 WHERE id = $1`, [acct.id, points]);
      await client.query(
        `INSERT INTO loyalty_txns (account_id, direction, points, reason) VALUES ($1,'REDEEM',$2,'REDEMPTION')`,
        [acct.id, points],
      );
      await client.query('COMMIT');
      acct.points_balance -= points;
      return { account: mapAccount(acct), valueRupees: points };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getAccount(ownerId: string, customerId: string): Promise<LoyaltyAccount | null> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT * FROM loyalty_accounts WHERE customer_id = $1 AND owner_id = $2`,
      [customerId, ownerId],
    );
    return rows.length ? mapAccount(rows[0]) : null;
  }

  /** Loyalty roster for the shop — members ranked by points. */
  async listForOwner(ownerId: string): Promise<LoyaltyAccount[]> {
    const { rows } = await this.db.query<AccountRow & { customer_name: string }>(
      `
      SELECT la.*, c.name AS customer_name
      FROM loyalty_accounts la JOIN customers c ON c.id = la.customer_id
      WHERE la.owner_id = $1
      ORDER BY la.points_balance DESC
      `,
      [ownerId],
    );
    return rows.map((r) => ({ ...mapAccount(r), customerName: r.customer_name }));
  }
}

interface AccountRow {
  id: string; customer_id: string; points_balance: number; lifetime_points: number; tier: LoyaltyTier;
}

const mapAccount = (r: AccountRow): LoyaltyAccount => ({
  customerId: r.customer_id,
  pointsBalance: r.points_balance,
  lifetimePoints: r.lifetime_points,
  tier: r.tier,
});
