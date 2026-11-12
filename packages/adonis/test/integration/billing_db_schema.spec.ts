import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { resolveBillingStore } from '../../src/billing/resolve_store.js';
import {
  BILLING_TABLES,
  createBillingTables,
  dropBillingTables,
  type LucidDatabase,
  truncateBillingTables,
} from '../../src/billing/schema.js';
import { checkTables } from '../../src/doctor/checks.js';
import { createIntegrationDatabase } from './harness.js';
import { exerciseStore } from './schema_scenario.js';

/**
 * `billing.schema` on Postgres, against a connection whose default schema stays `public`.
 *
 * The connection here has NO `searchPath`, on purpose: that is the production setup the option
 * exists for (PgBouncer in transaction mode, where `SET search_path` leaks between clients). Any
 * statement that forgot to name the schema lands in `public` — and the last assertion of every
 * block is that `public` holds no billing table.
 */
const SCHEMA = 'billing_schema_spec';

function makeDatabase(url: string, extra: Record<string, unknown> = {}): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  return new Database(
    {
      connection: 'primary',
      connections: {
        primary: { client: 'pg', connection: url, pool: { min: 0, max: 4 } },
        ...extra,
      },
    } as never,
    new LoggerFactory().create(),
    new Emitter(app as never),
  );
}

async function tablesIn(db: Database, schema: string, connection?: string): Promise<string[]> {
  const result = (await db
    .connection(connection)
    .rawQuery(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'billing\\_%' ORDER BY table_name",
      [schema],
    )) as { rows: Array<{ table_name: string }> };
  return result.rows.map((row) => row.table_name);
}

describe('billing.schema on Postgres (integration)', () => {
  let db: Database;
  const url = () => process.env.PAYMENTS_TEST_PG_URL as string;

  beforeAll(async () => {
    db = makeDatabase(url());
    BaseModel.useAdapter(db.modelAdapter());
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterAll(async () => {
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await db.manager.closeAll();
  });

  it('creates the schema, every table and every index in it — and nothing in public', async () => {
    await createBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    expect(await tablesIn(db, SCHEMA)).toEqual([...BILLING_TABLES].sort());
    expect(await tablesIn(db, 'public')).toEqual([]);

    const indexes = (await db.rawQuery(
      "SELECT indexname FROM pg_indexes WHERE schemaname = ? AND indexname LIKE 'billing\\_%\\_idx'",
      [SCHEMA],
    )) as { rows: unknown[] };
    expect(indexes.rows.length).toBeGreaterThan(15);

    // Idempotent, including the index drops and column adds that name the schema.
    await createBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
  });

  it('self-repairs a column inside the schema, not in public', async () => {
    await db.rawQuery(`ALTER TABLE "${SCHEMA}".billing_payments DROP COLUMN refunded_amount`);
    await createBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    const columns = (await db.rawQuery(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = 'billing_payments' AND column_name = 'refunded_amount'",
      [SCHEMA],
    )) as { rows: unknown[] };
    expect(columns.rows.length).toBe(1);
  });

  it('serves every read and write the store does from the schema', async () => {
    await truncateBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    const store = new LucidBillingStore({}, { schema: SCHEMA });
    await exerciseStore(store);
    expect(await tablesIn(db, 'public')).toEqual([]);
  });

  it('probes the capability columns in the schema when autoCreateSchema is off', async () => {
    await truncateBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new LucidBillingStore({}, { schema: SCHEMA, autoCreateSchema: false });
      await exerciseStore(store);
      // Nothing was "missing": every probe found its column in the schema.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('creates the tables on first use from an empty database', async () => {
    await db.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const store = new LucidBillingStore({}, { schema: SCHEMA });
    await store.listPayments({});
    expect(await tablesIn(db, SCHEMA)).toEqual([...BILLING_TABLES].sort());
    expect(await tablesIn(db, 'public')).toEqual([]);
  });

  it('runs inside the app’s own transaction', async () => {
    await db.transaction(async (trx) => {
      await truncateBillingTables(trx as unknown as LucidDatabase, { schema: SCHEMA });
      await createBillingTables(trx as unknown as LucidDatabase, { schema: SCHEMA });
      await trx.rawQuery(
        `INSERT INTO "${SCHEMA}".billing_audit_events (id, action, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000aa', 'trx', now(), now())`,
      );
    });
    const store = new LucidBillingStore({}, { schema: SCHEMA, autoCreateSchema: false });
    expect(await store.countAuditEvents({ action: 'trx' })).toBe(1);
  });

  it('is what agora:doctor reads: schema present, tables in it, writable', async () => {
    const lucid = { connection: (name?: string) => db.connection(name) } as never;
    const ok = await checkTables({ billing: { schema: SCHEMA } }, lucid);
    expect(ok).toMatchObject({ status: 'ok' });
    expect(ok.message).toContain(SCHEMA);

    const missing = await checkTables(
      { billing: { schema: 'billing_schema_spec_absent', autoCreateSchema: false } },
      lucid,
    );
    expect(missing.status).toBe('error');
    expect(missing.message).toContain('billing_schema_spec_absent');

    // Without `schema`, the check is today's: it looks in the current schema, which is empty.
    expect((await checkTables({}, lucid)).status).toBe('warn');
  });

  it('drops only its own tables, and leaves the schema', async () => {
    await dropBillingTables(db.connection() as unknown as LucidDatabase, { schema: SCHEMA });
    expect(await tablesIn(db, SCHEMA)).toEqual([]);
    const schemata = (await db.rawQuery(
      'SELECT 1 FROM information_schema.schemata WHERE schema_name = ?',
      [SCHEMA],
    )) as { rows: unknown[] };
    expect(schemata.rows.length).toBe(1);
  });

  it('fails with the grant to ask for when the role cannot create the schema', async () => {
    await db.rawQuery('DROP ROLE IF EXISTS billing_schema_spec_ro');
    await db.rawQuery("CREATE ROLE billing_schema_spec_ro LOGIN PASSWORD 'ro'");
    const parsed = new URL(url());
    parsed.username = 'billing_schema_spec_ro';
    parsed.password = 'ro';
    const ro = makeDatabase(parsed.toString());
    try {
      await expect(
        createBillingTables(ro.connection() as unknown as LucidDatabase, {
          schema: 'billing_schema_spec_denied',
        }),
      ).rejects.toThrow(/Could not create the billing schema "billing_schema_spec_denied".*GRANT/);
    } finally {
      await ro.manager.closeAll();
      await db.rawQuery('DROP ROLE IF EXISTS billing_schema_spec_ro');
    }
  });
});

describe('billing.connection (integration)', () => {
  // A second database on the same server, reachable only through the `billing` connection. A
  // model that ignored the option would query `primary` and find nothing there.
  const DATABASE = 'billing_connection_spec';
  let db: Database;

  beforeAll(async () => {
    const url = process.env.PAYMENTS_TEST_PG_URL as string;
    const admin = makeDatabase(url);
    await admin.rawQuery(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.rawQuery(`CREATE DATABASE ${DATABASE}`);
    await admin.manager.closeAll();
    const other = new URL(url);
    other.pathname = `/${DATABASE}`;
    db = makeDatabase(url, {
      billing: { client: 'pg', connection: other.toString(), pool: { min: 0, max: 2 } },
    });
    BaseModel.useAdapter(db.modelAdapter());
  });

  afterAll(async () => {
    await db.manager.closeAll();
  });

  it('puts the tables, and every query, on that connection and in the schema', async () => {
    const store = await resolveBillingStore({
      billing: { connection: 'billing', schema: 'billing' },
    });
    await exerciseStore(store as LucidBillingStore);
    expect(await tablesIn(db, 'billing', 'billing')).toEqual([...BILLING_TABLES].sort());
    expect(await tablesIn(db, 'billing')).toEqual([]);
  });
});

describe('the published migration with billing.schema (integration)', () => {
  it('creates the tables in the configured schema, not the connection’s', async () => {
    // The harness connection resolves unqualified names to its own schema (`searchPath`), so a
    // migration that ignored `billing.schema` would put the tables there.
    const database = await createIntegrationDatabase('billing_schema_stub_spec', {
      billingSchema: 'billing_schema_stub_target',
    });
    try {
      expect(await tablesIn(database.db, 'billing_schema_stub_target')).toEqual(
        [...BILLING_TABLES].sort(),
      );
      expect(await tablesIn(database.db, 'billing_schema_stub_spec')).toEqual([]);
    } finally {
      await database.db.rawQuery('DROP SCHEMA IF EXISTS billing_schema_stub_target CASCADE');
      await database.teardown();
    }
  });
});
