import { describe, expect, it } from 'vitest';
import {
  BILLING_TABLES,
  createBillingTables,
  dropBillingTables,
  type LucidDatabase,
} from '../src/billing/schema.js';

/** A Lucid client that records SQL instead of running it, optionally failing on a pattern. */
function fakeDb(
  dialect: string,
  fail?: { on: RegExp; message: string },
): LucidDatabase & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    dialect: { name: dialect },
    async rawQuery(statement: string) {
      sql.push(statement.replace(/\s+/g, ' ').trim());
      if (fail?.on.test(statement)) throw new Error(fail.message);
      return undefined;
    },
  };
}

describe('createBillingTables', () => {
  it('creates every table the billing layer owns', async () => {
    const db = fakeDb('postgres');
    await createBillingTables(db);

    for (const table of BILLING_TABLES) {
      expect(
        db.sql.some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${table} `)),
        `no CREATE for ${table}`,
      ).toBe(true);
    }
  });

  it('is idempotent by construction, not by checking first', async () => {
    // Every statement guards itself, which is what lets an install that already ran the old
    // Knex migration call this and have it do nothing — and what lets the store call it on
    // every boot without asking the database a question first.
    const db = fakeDb('postgres');
    await createBillingTables(db);

    const unguarded = db.sql.filter(
      (s) => !/IF NOT EXISTS/i.test(s) && /^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(s),
    );
    expect(unguarded, `statements that would fail on a second run: ${unguarded}`).toEqual([]);
  });

  it('carries columns added after their table shipped', async () => {
    // The whole upgrade path for an install already on 0.2.0: its `billing_payments` exists,
    // so the CREATE skips it, and `external_reference` would never arrive.
    const db = fakeDb('postgres');
    await createBillingTables(db);

    expect(db.sql).toContain(
      'ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS external_reference VARCHAR(255)',
    );
    expect(db.sql).toContain(
      'ALTER TABLE billing_webhook_events ADD COLUMN IF NOT EXISTS normalized JSONB',
    );
  });

  it('adds a late column before indexing it', async () => {
    // Order, not presence. An install on an older version has `billing_payments` WITHOUT
    // `external_reference`, so the CREATE skips the table — and `CREATE INDEX ... ON
    // billing_payments (external_reference)` then fails the whole call with `column does not
    // exist`, leaving the schema half-built on every boot. The integration suite caught this
    // against a real Postgres; this pins it without needing one.
    const db = fakeDb('postgres');
    await createBillingTables(db);

    const alter = db.sql.findIndex((s) =>
      /ALTER TABLE billing_payments .*external_reference/.test(s),
    );
    const index = db.sql.findIndex((s) => /CREATE INDEX.*external_reference_idx/.test(s));

    expect(alter, 'no ALTER for external_reference').toBeGreaterThanOrEqual(0);
    expect(index, 'no index for external_reference').toBeGreaterThanOrEqual(0);
    expect(alter, 'the column must be added before it is indexed').toBeLessThan(index);
  });

  it('creates every table before touching any of them', async () => {
    // Three phases, in this order: CREATE TABLE, then the late-column ALTERs, then the
    // indexes. Both of the other orderings were written first and both failed against a real
    // Postgres — an ALTER on a table two statements below it, and an index on a column an
    // older install does not have yet. Each one fails the whole call, so the schema is
    // half-built on every boot and nothing says why.
    const db = fakeDb('postgres');
    await createBillingTables(db);

    const lastCreate = db.sql.map((s) => /^CREATE TABLE/.test(s)).lastIndexOf(true);
    const firstAlter = db.sql.findIndex((s) => /^ALTER TABLE/.test(s));
    const firstIndex = db.sql.findIndex((s) => /^CREATE INDEX/.test(s));

    expect(firstAlter, 'no ALTER phase').toBeGreaterThanOrEqual(0);
    expect(firstIndex, 'no index phase').toBeGreaterThanOrEqual(0);
    expect(lastCreate, 'every table must exist before the first ALTER').toBeLessThan(firstAlter);
    expect(firstAlter, 'every late column must exist before the first index').toBeLessThan(
      firstIndex,
    );
  });

  it.each([
    ['postgres', 'TIMESTAMPTZ', 'JSONB'],
    ['mysql', 'DATETIME', 'JSON'],
    ['sqlite3', 'DATETIME', 'TEXT'],
  ])('uses %s types', async (dialect, timestamp, json) => {
    const db = fakeDb(dialect);
    await createBillingTables(db);
    const payments = db.sql.find((s) =>
      s.startsWith('CREATE TABLE IF NOT EXISTS billing_payments'),
    );

    expect(payments).toContain(`created_at ${timestamp}`);
    expect(payments).toContain(`payload ${json}`);
  });

  it('does not send MySQL an index guard it cannot parse', async () => {
    // MySQL rejects `CREATE INDEX IF NOT EXISTS` with a syntax error, so there the statement
    // is attempted bare and a duplicate-name error is swallowed instead.
    const db = fakeDb('mysql');
    await createBillingTables(db);

    expect(db.sql.filter((s) => /^CREATE INDEX IF NOT EXISTS/i.test(s))).toEqual([]);
    expect(db.sql.some((s) => /^CREATE INDEX billing_payments_customer_idx/i.test(s))).toBe(true);
  });

  it('swallows only the duplicate on a second MySQL run', async () => {
    const duplicate = fakeDb('mysql', { on: /^CREATE INDEX/i, message: "Duplicate key name 'x'" });
    await expect(createBillingTables(duplicate)).resolves.toBeUndefined();

    // Anything else is a real failure and has to surface: a permission error swallowed here
    // is a schema that silently never gets created.
    const denied = fakeDb('mysql', { on: /^CREATE INDEX/i, message: 'permission denied' });
    await expect(createBillingTables(denied)).rejects.toThrow(/permission denied/);
  });

  it('reads the dialect off a deferred migration client too', async () => {
    // `this.defer((db) => …)` hands over a query client that exposes `dialect` directly,
    // while the root `Database` exposes it under `connection()`. Both have to work: the
    // migration path uses the first and the store uses the second.
    const sql: string[] = [];
    const viaConnection: LucidDatabase = {
      connection: () => ({ dialect: { name: 'postgres' } }),
      async rawQuery(statement: string) {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return undefined;
      },
    };
    await createBillingTables(viaConnection);

    expect(sql.some((s) => s.includes('created_at TIMESTAMPTZ'))).toBe(true);
  });

  it('drops in reverse, and only if present', async () => {
    const db = fakeDb('postgres');
    await dropBillingTables(db);

    expect(db.sql).toEqual([...BILLING_TABLES].reverse().map((t) => `DROP TABLE IF EXISTS ${t}`));
  });
});
