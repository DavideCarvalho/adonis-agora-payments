import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BILLING_LIST_INDEXES,
  createBillingListIndexes,
  dropBillingListIndexes,
  type LucidDatabase,
} from '../../src/billing/schema.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * The opt-in `add_billing_list_indexes` migration on a real Postgres: the harness runs the
 * published stub (CONCURRENTLY, outside a transaction), and running it again on an install that
 * already has the indexes is a no-op.
 */
describe('console list indexes (integration)', () => {
  let database: IntegrationDatabase;
  const schema = 'list_indexes_spec';
  const names = BILLING_LIST_INDEXES.map(([name]) => name);

  const present = async () => {
    const result = (await database.db.rawQuery(
      'SELECT indexname FROM pg_indexes WHERE schemaname = ?',
      [schema],
    )) as { rows: Array<{ indexname: string }> };
    return result.rows.map((row) => row.indexname).filter((name) => names.includes(name));
  };

  beforeAll(async () => {
    database = await createIntegrationDatabase(schema);
  });
  afterAll(async () => {
    await database?.teardown();
  });

  it('the published migration created every index', async () => {
    expect((await present()).sort()).toEqual([...names].sort());
  });

  it('runs again as a no-op, and drops cleanly', async () => {
    const db = database.db.connection() as unknown as LucidDatabase;
    await createBillingListIndexes(db);
    expect(await present()).toHaveLength(names.length);
    await dropBillingListIndexes(db);
    expect(await present()).toEqual([]);
    await createBillingListIndexes(db);
    expect(await present()).toHaveLength(names.length);
  });
});
