import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import {
  BILLING_TABLES,
  createBillingTables,
  dropBillingTables,
  type LucidDatabase,
  truncateBillingTables,
} from '../../src/billing/schema.js';
import { checkTables } from '../../src/doctor/checks.js';
import { exerciseStore } from './schema_scenario.js';

/**
 * `billing.schema` on MySQL, where a schema is a DATABASE: the connection's default database is
 * `app`, the billing tables go in `billing_mysql`, and nothing may land in `app`.
 *
 * Its own container rather than the shared global one: only this file needs MySQL.
 */
const APP_DB = 'app';
const SCHEMA = 'billing_mysql';

async function tablesIn(db: Database, database: string): Promise<string[]> {
  const [rows] = (await db.rawQuery(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'billing\\_%' ORDER BY table_name",
    [database],
  )) as [Array<{ name: string }>];
  return rows.map((row) => row.name);
}

describe('billing.schema on MySQL (integration)', () => {
  let container: StartedMySqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8.4')
      .withDatabase(APP_DB)
      .withRootPassword('root')
      .start();
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    db = new Database(
      {
        connection: 'primary',
        connections: {
          primary: {
            client: 'mysql2',
            connection: {
              host: container.getHost(),
              port: container.getPort(),
              user: 'root',
              password: 'root',
              database: APP_DB,
            },
            pool: { min: 0, max: 4 },
          },
        },
      } as never,
      new LoggerFactory().create(),
      new Emitter(app as never),
    );
    BaseModel.useAdapter(db.modelAdapter());
  });

  afterAll(async () => {
    await db?.manager.closeAll();
    await container?.stop();
  });

  it('creates the database and every table in it — and nothing in the default database', async () => {
    await createBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    expect(await tablesIn(db, SCHEMA)).toEqual([...BILLING_TABLES].sort());
    expect(await tablesIn(db, APP_DB)).toEqual([]);
    // Idempotent: the duplicate-index and duplicate-column errors are the expected ones.
    await createBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
  });

  it('self-repairs a column inside the billing database', async () => {
    await db.rawQuery(`ALTER TABLE \`${SCHEMA}\`.billing_payments DROP COLUMN refunded_amount`);
    await createBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    const [rows] = (await db.rawQuery(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = 'billing_payments' AND column_name = 'refunded_amount'",
      [SCHEMA],
    )) as [unknown[]];
    expect(rows.length).toBe(1);
  });

  it('serves every read and write the store does from the billing database', async () => {
    await truncateBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    await exerciseStore(new LucidBillingStore({}, { schema: SCHEMA }));
    expect(await tablesIn(db, APP_DB)).toEqual([]);
  });

  it('runs inside the app’s own transaction', async () => {
    await db.transaction(async (trx) => {
      await truncateBillingTables(trx as unknown as LucidDatabase, { schema: SCHEMA });
      await createBillingTables(trx as unknown as LucidDatabase, { schema: SCHEMA });
    });
    expect(await tablesIn(db, SCHEMA)).toEqual([...BILLING_TABLES].sort());
  });

  it('is what agora:doctor reads', async () => {
    const lucid = { connection: (name?: string) => db.connection(name) } as never;
    expect(await checkTables({ billing: { schema: SCHEMA } }, lucid)).toMatchObject({
      status: 'ok',
    });
  });

  it('drops only its own tables', async () => {
    await dropBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    expect(await tablesIn(db, SCHEMA)).toEqual([]);
  });
});
