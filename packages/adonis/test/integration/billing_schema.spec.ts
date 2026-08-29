import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import {
  BILLING_TABLES,
  createBillingTables,
  dropBillingTables,
} from '../../src/billing/schema.js';
import { type IntegrationDatabase, createIntegrationDatabase } from './harness.js';

/**
 * `createBillingTables` against a real Postgres.
 *
 * The unit spec asserts what SQL comes out; this asserts that Postgres accepts it. The
 * difference is not academic — the first two versions of this function passed every unit
 * assertion and failed here, both times on ordering: an `ALTER TABLE` two statements above
 * its own `CREATE TABLE`, and an index on a column an older install does not have yet.
 * Either one fails the whole call, so the schema is half-built on every boot and the only
 * symptom is a query error somewhere else.
 *
 * `migrate: false` is what makes this test real: it hands back an EMPTY schema, so the
 * function under test is the only thing that creates anything.
 */
describe('createBillingTables (integration)', () => {
  let database: IntegrationDatabase;

  beforeAll(async () => {
    database = await createIntegrationDatabase('schema_test', { migrate: false });
  });

  afterAll(async () => {
    await database.teardown();
  });

  /** Which of the billing tables exist in this schema right now. */
  const existingTables = async (): Promise<string[]> => {
    const result = (await database.db.rawQuery(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'billing_%'
       ORDER BY table_name`,
    )) as { rows: { table_name: string }[] };
    return result.rows.map((row) => row.table_name);
  };

  const columnsOf = async (table: string): Promise<string[]> => {
    const result = (await database.db.rawQuery(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ?
       ORDER BY column_name`,
      [table],
    )) as { rows: { column_name: string }[] };
    return result.rows.map((row) => row.column_name);
  };

  const indexesOf = async (table: string): Promise<string[]> => {
    const result = (await database.db.rawQuery(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = ? ORDER BY indexname`,
      [table],
    )) as { rows: { indexname: string }[] };
    return result.rows.map((row) => row.indexname);
  };

  it('creates every table on an empty schema', async () => {
    expect(await existingTables()).toEqual([]);

    await createBillingTables(database.db.connection());

    expect(await existingTables()).toEqual([...BILLING_TABLES].sort());
  });

  it('creates the indexes the reads depend on', async () => {
    // Not decoration. `billing_disputes_deadline_idx` is what makes "which windows close this
    // week" a range scan instead of a table scan on a table that grows with every dispute.
    expect(await indexesOf('billing_payments')).toEqual(
      expect.arrayContaining([
        'billing_payments_customer_idx',
        'billing_payments_subscription_idx',
        'billing_payments_external_reference_idx',
      ]),
    );
    expect(await indexesOf('billing_disputes')).toEqual(
      expect.arrayContaining(['billing_disputes_payment_idx', 'billing_disputes_deadline_idx']),
    );
  });

  it('runs a second time without touching anything', async () => {
    // The store calls this on first use of every process. If it were not idempotent, the
    // second boot of an app would fail — and the first would look fine.
    const before = await existingTables();

    await expect(createBillingTables(database.db.connection())).resolves.toBeUndefined();
    await expect(createBillingTables(database.db.connection())).resolves.toBeUndefined();

    expect(await existingTables()).toEqual(before);
  });

  it('upgrades a schema that predates two columns and a table', async () => {
    // The 0.2.0 shape: `billing_payments` without `external_reference`,
    // `billing_webhook_events` without `normalized`, and no `billing_disputes` at all. This
    // is the case `CREATE TABLE IF NOT EXISTS` alone cannot serve, and the reason the ALTER
    // phase exists — without it, upgrading the package leaves the old schema in place and the
    // first query naming a new column fails.
    await database.db.rawQuery('ALTER TABLE billing_payments DROP COLUMN external_reference');
    await database.db.rawQuery('ALTER TABLE billing_payments DROP COLUMN refunded_amount');
    await database.db.rawQuery('ALTER TABLE billing_webhook_events DROP COLUMN normalized');
    await database.db.rawQuery('DROP TABLE billing_disputes');

    expect(await columnsOf('billing_payments')).not.toContain('external_reference');
    expect(await columnsOf('billing_payments')).not.toContain('refunded_amount');
    expect(await existingTables()).not.toContain('billing_disputes');

    await createBillingTables(database.db.connection());

    expect(await columnsOf('billing_payments')).toContain('external_reference');
    // 0.4.0's column, carried by the same ALTER phase. Without it an upgraded install takes a
    // partial refund and fails on `column "refunded_amount" does not exist` — or, worse,
    // silently skips the write, which is what `#hasColumn` does.
    expect(await columnsOf('billing_payments')).toContain('refunded_amount');
    expect(await columnsOf('billing_webhook_events')).toContain('normalized');
    expect(await existingTables()).toContain('billing_disputes');
    // And the index that names the column it just added — the ordering bug, pinned.
    expect(await indexesOf('billing_payments')).toContain(
      'billing_payments_external_reference_idx',
    );
  });

  it('drops everything it created', async () => {
    await dropBillingTables(database.db.connection());
    expect(await existingTables()).toEqual([]);
  });
});

/**
 * The store creating its own schema, which is the path an app actually takes: nothing ran a
 * migration, someone opens the dashboard or takes a first webhook, and it has to work.
 */
describe('LucidBillingStore autoCreateSchema (integration)', () => {
  let database: IntegrationDatabase;

  beforeAll(async () => {
    database = await createIntegrationDatabase('autocreate_test', { migrate: false });
  });

  afterAll(async () => {
    await database.teardown();
  });

  it('creates the tables on the first call, whatever that call is', async () => {
    // A READ, deliberately. The first thing an app does is not always a write — a dashboard
    // opened before the first charge, a health check on a fresh deploy — and a schema that
    // only appears on the write path is a schema that exists most of the time.
    const store = new LucidBillingStore();

    expect(await store.findPaymentByGatewayId('pi_missing')).toBeNull();

    const result = (await database.db.rawQuery(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'billing_%'`,
    )) as { rows: { table_name: string }[] };
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([...BILLING_TABLES].sort());
  });

  it('then reads and writes normally', async () => {
    const store = new LucidBillingStore();
    await store.savePayment({
      gatewayId: 'pi_autocreate',
      provider: 'stripe',
      status: 'paid',
      amount: 1990,
      currency: 'brl',
      externalReference: 'order_1',
    });

    const row = await store.findPaymentByExternalReference('order_1');
    expect(row?.gatewayId).toBe('pi_autocreate');
    expect(row?.amount).toBe(1990);
  });

  it('creates nothing when it is turned off', async () => {
    // The escape hatch has to actually escape. An app that manages its own schema must not
    // have DDL run behind its back — that is the whole reason the flag exists.
    await dropBillingTables(database.db.connection());

    const store = new LucidBillingStore({}, { autoCreateSchema: false });
    await expect(store.findPaymentByGatewayId('pi_missing')).rejects.toThrow(
      /billing_payments|does not exist/i,
    );
  });
});
