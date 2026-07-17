/**
 * ApnaKhata — Demo seed
 * ---------------------
 * Idempotent demo dataset (fixed UUIDs + ON CONFLICT DO NOTHING) so a fresh
 * clone has something to show: a distributor, two shopkeepers, inventory with
 * a preferred supplier and a forecast, an overdue invoice + settled history, a
 * reminder policy, credit terms, and an initial credit score. Safe to re-run.
 *
 * Run: DATABASE_URL=… node dist/db/seed.js   (or `npm run seed`)
 */

import { Pool } from 'pg';

import { CreditScoreEvaluator } from '../services/CreditScoreEvaluator';

export const DEMO = {
  distributor: '11111111-1111-1111-1111-111111111111',
  shopkeeper: '22222222-2222-2222-2222-222222222222',
  shopkeeper2: '33333333-3333-3333-3333-333333333333',
  saltInventory: '55555555-5555-5555-5555-555555555555',
};

export async function seed(db: Pool, log: (m: string) => void = console.log): Promise<void> {
  // Password hash is a bcrypt of "demo1234" — demo only.
  const pw = '$2b$10$Dq8Vh8xq8pXn0Zx8Zx8Zxu8Zx8Zx8Zx8Zx8Zx8Zx8Zx8Zx8Zx8Zx';

  await db.query(
    `
    INSERT INTO users (id, role, business_name, owner_name, phone, email, password_hash, gstin, city, state_code)
    VALUES
      ($1,'DISTRIBUTOR','Sharma Distributors','R Sharma','+919800000001','sharma@demo.in',$4,'27ABCDE1234F1Z5','Pune','27'),
      ($2,'SHOPKEEPER','Gupta General Store','A Gupta','+919800000002','gupta@demo.in',$4,'27PQRSX6789K1Z2','Pune','27'),
      ($3,'SHOPKEEPER','Rao Traders','S Rao','+919800000003','rao@demo.in',$4,'29LMNOP4567Q1Z8','Bengaluru','29')
    ON CONFLICT (id) DO NOTHING
    `,
    [DEMO.distributor, DEMO.shopkeeper, DEMO.shopkeeper2, pw],
  );

  // Inventory for the primary shopkeeper, supplied by the distributor.
  await db.query(
    `
    INSERT INTO inventory (id, owner_id, sku, product_name, category, unit, pack_size,
                           current_stock, minimum_threshold, wholesale_price, retail_price,
                           hsn_code, gst_rate, barcode, preferred_supplier_id)
    VALUES
      ($1,$2,'TATA-SALT-1KG','Tata Salt 1kg','Grocery','PCS',24,14,20,22,28,'2501',5,'8901030731234',$3),
      (gen_random_uuid(),$2,'FORT-OIL-1L','Fortune Sunflower Oil 1L','Grocery','PCS',12,22,15,150,165,'1512',5,'8902102163072',$3),
      (gen_random_uuid(),$2,'PARLE-G-800','Parle-G 800g Family Pack','Biscuits','PCS',20,35,20,84,98,'1905',18,'8901063014324',$3)
    ON CONFLICT (owner_id, sku) DO NOTHING
    `,
    [DEMO.saltInventory, DEMO.shopkeeper, DEMO.distributor],
  );

  // Stored forecast for the salt (drives the dashboard stock alert + one-tap reorder).
  await db.query(
    `
    INSERT INTO demand_forecasts (inventory_id, owner_id, sku, daily_demand_mean, safety_stock,
                                  recommended_order_qty, predicted_stockout_date, model_used)
    VALUES ($1,$2,'TATA-SALT-1KG',6.5,5,96,CURRENT_DATE + 2,'weighted_moving_average')
    ON CONFLICT (inventory_id) DO NOTHING
    `,
    [DEMO.saltInventory, DEMO.shopkeeper],
  );

  // Ledger: one open overdue invoice + six months of settled history (only if empty).
  const { rows: existing } = await db.query<{ n: string }>(
    `SELECT COUNT(*) n FROM transactions_ledger WHERE receiver_id = $1`,
    [DEMO.shopkeeper],
  );
  if (Number(existing[0].n) === 0) {
    await db.query(
      `
      INSERT INTO transactions_ledger (sender_id, receiver_id, invoice_number, amount, balance_remaining, due_date, created_at)
      VALUES ($1,$2,'DEMO-OPEN-1',18500,18500,CURRENT_DATE - 8, now() - interval '20 days')
      `,
      [DEMO.distributor, DEMO.shopkeeper],
    );
    for (let m = 1; m <= 6; m++) {
      const { rows } = await db.query<{ id: string }>(
        `
        INSERT INTO transactions_ledger (sender_id, receiver_id, invoice_number, amount, balance_remaining, due_date, created_at)
        VALUES ($1,$2,$3,16000,16000, (CURRENT_DATE - ($4::int * 30 - 15)), now() - ($4 || ' months')::interval)
        RETURNING id
        `,
        [DEMO.distributor, DEMO.shopkeeper, `DEMO-H-${m}`, m],
      );
      const { rows: pay } = await db.query<{ id: string }>(
        `
        INSERT INTO payments (payer_id, payee_id, amount, paid_at)
        VALUES ($1,$2,16000,(CURRENT_DATE - ($3::int * 30 - 13))::timestamptz) RETURNING id
        `,
        [DEMO.shopkeeper, DEMO.distributor, m],
      );
      // Apply specifically to this history invoice (targeted, so the demo open
      // invoice stays fully open regardless of FIFO ordering).
      await db.query(
        `
        WITH inv AS (SELECT balance_remaining FROM transactions_ledger WHERE id = $2)
        INSERT INTO payment_allocations (payment_id, transaction_id, amount_applied)
        SELECT $1, $2, balance_remaining FROM inv
        `,
        [pay[0].id, rows[0].id],
      );
      await db.query(
        `UPDATE transactions_ledger SET balance_remaining = 0, payment_status = 'PAID' WHERE id = $1`,
        [rows[0].id],
      );
    }
  }

  // Sales movements so inventory-turn (DIO) has signal.
  await db.query(
    `
    INSERT INTO stock_movements (time, inventory_id, owner_id, delta, reason, stock_after)
    SELECT now() - (d || ' days')::interval, $1, $2, -6, 'SALE', 14
    FROM generate_series(1, 60) d
    WHERE NOT EXISTS (SELECT 1 FROM stock_movements WHERE inventory_id = $1)
    `,
    [DEMO.saltInventory, DEMO.shopkeeper],
  );

  await db.query(
    `
    INSERT INTO reminder_policies (distributor_id, bucket, channel, min_interval_days)
    VALUES ($1,'OVERDUE_1_30','WHATSAPP',3), ($1,'OVERDUE_31_60','WHATSAPP',3), ($1,'OVERDUE_60_PLUS','SMS',2)
    ON CONFLICT (distributor_id, bucket) DO NOTHING
    `,
    [DEMO.distributor],
  );
  await db.query(
    `
    INSERT INTO distributor_credit_terms (distributor_id, grace_period_days, daily_interest_rate_pct, max_interest_pct)
    VALUES ($1, 15, 0.05, 10) ON CONFLICT (distributor_id) DO NOTHING
    `,
    [DEMO.distributor],
  );

  // Initial credit score so the dashboard has a number on first load.
  await new CreditScoreEvaluator(db).evaluate(DEMO.shopkeeper);

  log('seed complete — demo login: gupta@demo.in (shopkeeper), sharma@demo.in (distributor)');
  log(`  x-user-id for API calls: ${DEMO.shopkeeper}`);
}

/* istanbul ignore next -- CLI entry */
if (require.main === module) {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  seed(db)
    .then(() => db.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      db.end().finally(() => process.exit(1));
    });
}
