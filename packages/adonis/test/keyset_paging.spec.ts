import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import { keysetContract } from './keyset_contract.js';

/**
 * Keyset paging on the in-memory store and the Lucid store over a real SQLite. Postgres and
 * MySQL run the same contract in the integration suite (`schema_scenario.ts`).
 */
describe('keyset paging', () => {
  it('in memory', async () => {
    await keysetContract(new InMemoryBillingStore());
  });

  describe('Lucid on SQLite', () => {
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

    it('walks every list once, filters included', async () => {
      await keysetContract(new LucidBillingStore());
    });
  });
});
