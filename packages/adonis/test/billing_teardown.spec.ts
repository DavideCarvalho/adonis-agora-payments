import { describe, expect, it, vi } from 'vitest';
import {
  BILLING_TABLES,
  dropBillingTables,
  type LucidDatabase,
  registerBillingSchemaCache,
  truncateBillingTables,
} from '../src/billing/schema.js';

/** A database stand-in that records the SQL it is handed. */
function fakeDb(onQuery?: (sql: string) => void): { db: LucidDatabase; sql: string[] } {
  const sql: string[] = [];
  const db = {
    rawQuery: async (statement: string) => {
      sql.push(statement);
      onQuery?.(statement);
      return undefined;
    },
  } as unknown as LucidDatabase;
  return { db, sql };
}

/**
 * The teardown trap, in the words of the app that hit it: *"sem limpar as LINHAS entre grupos,
 * o ledger de webhooks de um teste dedupe o evento do seguinte — a idempotência da lib
 * funcionando contra a suíte."* Dropping the tables instead is not a fix, because
 * `LucidBillingStore` memoizes "the schema exists" and never re-creates them.
 */
describe('truncateBillingTables', () => {
  it('empties every billing table, reverse-dependency order', async () => {
    const { db, sql } = fakeDb();
    await truncateBillingTables(db);
    expect(sql).toEqual([...BILLING_TABLES].reverse().map((t) => `DELETE FROM ${t}`));
  });

  it('keeps the schema — nothing is dropped', async () => {
    const { db, sql } = fakeDb();
    await truncateBillingTables(db);
    expect(sql.some((s) => /DROP/i.test(s))).toBe(false);
  });

  it('tolerates a table that was never created', async () => {
    const { db } = fakeDb((sql) => {
      if (sql.includes('billing_disputes')) {
        throw Object.assign(new Error('relation "billing_disputes" does not exist'), {
          code: '42P01',
        });
      }
    });
    await expect(truncateBillingTables(db)).resolves.toBeUndefined();
  });

  it('does NOT swallow a real failure', async () => {
    const { db } = fakeDb(() => {
      throw new Error('permission denied for table billing_payments');
    });
    await expect(truncateBillingTables(db)).rejects.toThrow(/permission denied/);
  });
});

describe('dropBillingTables', () => {
  it('tells live stores to forget the schema they memoized', async () => {
    // Without this a suite that drops between groups leaves the store certain the tables are
    // still there, and every following query fails on a table nothing will re-create.
    const reset = vi.fn();
    const unregister = registerBillingSchemaCache(reset);
    try {
      const { db } = fakeDb();
      await dropBillingTables(db);
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('drops after, not before, so a reset cannot race the DDL', async () => {
    const order: string[] = [];
    const unregister = registerBillingSchemaCache(() => order.push('reset'));
    try {
      const { db } = fakeDb((sql) => order.push(sql));
      await dropBillingTables(db);
      expect(order[order.length - 1]).toBe('reset');
    } finally {
      unregister();
    }
  });
});
