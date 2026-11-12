import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import { BillingDispute } from '../src/billing/mixins/index.js';
import { resolveBillingStore } from '../src/billing/resolve_store.js';
import { createBillingTables, type LucidDatabase } from '../src/billing/schema.js';
import { billingStores } from '../src/define_config.js';

/**
 * `billing.schema` where it must be refused, and the parts that need no Postgres: name
 * validation, inheritance into the store, and SQLite failing the boot.
 */
describe('billing.schema', () => {
  let db: Database;

  beforeAll(async () => {
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    db = new Database(
      {
        connection: 'sqlite',
        connections: {
          sqlite: {
            client: 'better-sqlite3',
            connection: { filename: ':memory:' },
            useNullAsDefault: true,
          },
        },
      },
      new LoggerFactory().create(),
      new Emitter(app),
    );
    BaseModel.useAdapter(db.modelAdapter());
  });

  afterAll(async () => {
    await db?.manager.closeAll();
  });

  it.each(['1billing', 'bill-ing', 'billing"; DROP TABLE x; --', 'a'.repeat(64), ''])(
    'refuses the schema name %j',
    async (schema) => {
      expect(() => new LucidBillingStore({}, { schema })).toThrow(/Invalid billing.schema/);
      await expect(resolveBillingStore({ billing: { schema } })).rejects.toThrow(
        /Invalid billing.schema/,
      );
    },
  );

  it('fails the boot on SQLite, naming the schema', async () => {
    await expect(resolveBillingStore({ billing: { schema: 'billing' } })).rejects.toThrow(
      /billing.schema is "billing", but the billing connection is .*sqlite/i,
    );
  });

  it('fails the boot on SQLite for a store the app built with billingStores.lucid', async () => {
    await expect(
      resolveBillingStore({
        billing: { schema: 'billing', store: billingStores.lucid({ models: {} }) },
      }),
    ).rejects.toThrow(/sqlite/i);
  });

  it('never falls back on SQLite: the store refuses its first query, and the DDL refuses too', async () => {
    const store = new LucidBillingStore({}, { schema: 'billing' });
    await expect(store.listPayments({})).rejects.toThrow(/sqlite/i);
    await expect(
      createBillingTables(db.connection() as unknown as LucidDatabase, { schema: 'billing' }),
    ).rejects.toThrow(/sqlite/i);
  });

  it('without a schema, SQLite works exactly as before', async () => {
    const store = await resolveBillingStore({});
    expect(await store.listPayments({})).toEqual([]);
  });

  it('billingStores.lucid inherits billing.schema and billing.connection', async () => {
    const factory = billingStores.lucid();
    const store = (await factory({
      config: () => ({ billing: { schema: 'billing', connection: 'other' } }),
    })) as LucidBillingStore;
    expect(store.database).toEqual({ schema: 'billing', connection: 'other' });

    const own = (await billingStores.lucid({ schema: 'mine' })({
      config: () => ({ billing: { schema: 'billing' } }),
    })) as LucidBillingStore;
    expect(own.database.schema).toBe('mine');
  });

  it('refuses a hand-built store whose schema disagrees with the config', async () => {
    await expect(
      resolveBillingStore({
        billing: { schema: 'billing', store: () => new LucidBillingStore() },
      }),
    ).rejects.toThrow(
      /billing.schema is "billing" but billing.store built a LucidBillingStore with no schema/,
    );
  });

  it('qualifies the models it queries, and leaves an already-qualified table alone', async () => {
    class Elsewhere extends BillingDispute {
      static override table = 'elsewhere.billing_disputes';
    }
    const store = new LucidBillingStore(
      { disputeModel: Elsewhere },
      { schema: 'billing', autoCreateSchema: false },
    );
    // SQLite would refuse the schema before the first query; only which tables get named matters.
    vi.spyOn(store, 'assertDatabase').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(BaseModel, 'query');
    const tables = new Set<string>();
    try {
      await store.listDisputes({}).catch(() => undefined);
      await store.listPayments({}).catch(() => undefined);
      for (const model of spy.mock.contexts) tables.add((model as { table: string }).table);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect([...tables].sort()).toEqual(['billing.billing_payments', 'elsewhere.billing_disputes']);
    // The shipped classes themselves are untouched: the store queries subclasses of them.
    expect(BillingDispute.table).toBe('billing_disputes');
  });
});
