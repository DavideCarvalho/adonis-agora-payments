/**
 * The billing schema, as standalone idempotent functions.
 *
 * This is the ecosystem convention — a lib owns its own schema — and it is why
 * `@adonis-agora/durable` exports `createDurableTables` and `@adonis-agora/authz` exports
 * `createAuthzTables`. This package did not follow it, and the cost showed up quickly: every
 * column added after the first release became another migration file with hand-written
 * `hasColumn` / `hasTable` guards, and an app adopting the library had three files to publish
 * and run before it could take a single payment.
 *
 * Two paths, one DDL. {@link LucidBillingStore} calls {@link createBillingTables} once on
 * first use (`autoCreateSchema`, on by default), and the published migration stub calls the
 * SAME function — so the two can never drift, which is the whole reason the DDL lives here
 * rather than in a stub the store knows nothing about.
 *
 * The DDL is portable `rawQuery` (`CREATE TABLE IF NOT EXISTS`) rather than Knex's schema
 * builder, matching the posture authz takes: it keeps the `@adonisjs/lucid` coupling to the
 * `rawQuery` surface, and it is idempotent by construction — which is what lets an install
 * that already ran the old Knex migration call this and have it do nothing.
 */

/** The bindings a Lucid `rawQuery` accepts. */
export type LucidQueryBindings = readonly unknown[] | Record<string, unknown>;

/**
 * The slice of a Lucid query client these functions rely on. Both the root `Database` and a
 * connection client satisfy it, so the dependency is on the surface rather than a concrete
 * Lucid type.
 *
 * `rawQuery` is declared as a METHOD, not a function-typed property: methods are checked
 * bivariantly, which is what lets a real Lucid client — whose signature is more specific than
 * this mirror — satisfy the interface under `strictFunctionTypes`. Declared the other way, no
 * real client satisfies it and the published migration stub does not compile in a consumer
 * app even though every check inside this repo passes.
 */
export interface LucidQueryClient {
  rawQuery(sql: string, bindings?: LucidQueryBindings): Promise<unknown>;
}

/**
 * A Lucid `Database`, connection, or query client.
 *
 * Dialect detection accepts both shapes the library is handed: the root `Database` exposes
 * the dialect via `connection().dialect`, while a migration's deferred query client
 * (`this.defer((db) => …)`) exposes `dialect` directly.
 */
export interface LucidDatabase extends LucidQueryClient {
  dialect?: { name?: string };
  connection?(name?: string): { dialect?: { name?: string } };
}

/**
 * Every table the billing layer owns.
 *
 * Deliberately NOT configurable, unlike authz's table names. The models are the source of
 * truth here (`BillingModels` lets an app swap any of them), and DDL that could name a table
 * the models do not read is a way to create an empty table beside a missing one. An app that
 * renames a table swaps the model and writes its own migration.
 */
export const BILLING_TABLES = [
  'billing_customers',
  'billing_subscriptions',
  'billing_payments',
  'billing_webhook_events',
  'billing_disputes',
  'billing_usage_events',
  'billing_audit_events',
] as const;

/** Best-effort dialect name; `undefined` when it cannot be read. */
export function detectDialect(db: LucidDatabase): string | undefined {
  try {
    const direct = db.dialect?.name;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    return db.connection?.()?.dialect?.name;
  } catch {
    return undefined;
  }
}

function isPostgres(dialect: string | undefined): boolean {
  return !!dialect && /postgres|pg|redshift/i.test(dialect);
}

function isMysql(dialect: string | undefined): boolean {
  return !!dialect && /mysql|mariadb/i.test(dialect);
}

/** The column types that differ by dialect, resolved once. */
interface Types {
  /** A timestamp that keeps its zone. Every date this package stores is an instant. */
  timestamp: string;
  /** A JSON document. Gateway payloads are stored verbatim and queried rarely. */
  json: string;
}

function typesFor(dialect: string | undefined): Types {
  if (isPostgres(dialect)) return { timestamp: 'TIMESTAMPTZ', json: 'JSONB' };
  if (isMysql(dialect)) return { timestamp: 'DATETIME', json: 'JSON' };
  // SQLite: no native JSON or timestamp types. It stores both as TEXT and Lucid serializes
  // on the way in, which is why the models declare `prepare`/`consume` rather than trusting
  // the column type.
  return { timestamp: 'DATETIME', json: 'TEXT' };
}

/**
 * Create a secondary index, idempotently.
 *
 * Postgres and SQLite take `CREATE INDEX IF NOT EXISTS`. **MySQL does not** — it fails with
 * a syntax error — so there the statement is attempted and a duplicate-name error is
 * swallowed. That is narrower than it looks: the only way this statement fails on a second
 * run is that the index is already there, which is the outcome asked for. Any other failure
 * still throws.
 */
async function createIndex(
  db: LucidDatabase,
  dialect: string | undefined,
  name: string,
  table: string,
  columns: string,
): Promise<void> {
  if (!isMysql(dialect)) {
    await db.rawQuery(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns})`);
    return;
  }
  try {
    await db.rawQuery(`CREATE INDEX ${name} ON ${table} (${columns})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate key name|already exists/i.test(message)) throw error;
  }
}

/**
 * Add a column that was introduced AFTER its table shipped, idempotently.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so it cannot carry
 * a new column to an install that ran an earlier version. Without this, upgrading the package
 * would silently leave the old schema in place and the first query naming the new column
 * would fail — which is the failure mode a library owning its own schema exists to prevent.
 *
 * Postgres has `ADD COLUMN IF NOT EXISTS`. SQLite and MySQL do not, so there the statement is
 * attempted and a duplicate-column error is swallowed: the only way this fails twice is that
 * the column is already there, which is the outcome asked for. Anything else still throws.
 */
async function addColumn(
  db: LucidDatabase,
  dialect: string | undefined,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  if (isPostgres(dialect)) {
    await db.rawQuery(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    return;
  }
  try {
    await db.rawQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column|already exists/i.test(message)) throw error;
  }
}

/**
 * Create every billing table, idempotently.
 *
 * Safe to call from a Lucid migration's `up()`, and safe to call repeatedly at boot — which
 * is exactly what {@link LucidBillingStore} does when `autoCreateSchema` is on. An install
 * that already ran the older Knex migrations gets no-ops: every statement is
 * `IF NOT EXISTS`.
 *
 * It also carries columns added AFTER a table shipped — see the block at the end. That is
 * what makes this a real upgrade path rather than a first-install convenience: an app that
 * ran the 0.2.0 migration and then upgrades gets the columns the new code reads, without
 * having to be told to publish and run a second migration.
 */
export async function createBillingTables(db: LucidDatabase): Promise<void> {
  const dialect = detectDialect(db);
  const t = typesFor(dialect);
  const run = (sql: string) => db.rawQuery(sql);

  await run(
    `CREATE TABLE IF NOT EXISTS billing_customers (
      id VARCHAR(36) PRIMARY KEY,
      owner_type VARCHAR(255),
      owner_id VARCHAR(255),
      gateway_id VARCHAR(255) UNIQUE,
      provider VARCHAR(255),
      email VARCHAR(255),
      name VARCHAR(255),
      tax_id VARCHAR(255),
      metadata ${t.json},
      created_at ${t.timestamp} NOT NULL,
      updated_at ${t.timestamp} NOT NULL
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id VARCHAR(36) PRIMARY KEY,
      gateway_id VARCHAR(255) UNIQUE,
      provider VARCHAR(255),
      status VARCHAR(255),
      plan_id VARCHAR(255),
      customer_id VARCHAR(255),
      trial_ends_at ${t.timestamp},
      ends_at ${t.timestamp},
      payload ${t.json},
      created_at ${t.timestamp} NOT NULL,
      updated_at ${t.timestamp} NOT NULL
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS billing_payments (
      id VARCHAR(36) PRIMARY KEY,
      gateway_id VARCHAR(255) UNIQUE,
      provider VARCHAR(255),
      status VARCHAR(255),
      amount BIGINT,
      currency VARCHAR(3),
      customer_id VARCHAR(255),
      subscription_id VARCHAR(255),
      external_reference VARCHAR(255),
      refunded_amount BIGINT,
      payload ${t.json},
      paid_at ${t.timestamp},
      created_at ${t.timestamp} NOT NULL,
      updated_at ${t.timestamp} NOT NULL
    )`,
  );

  // The key an app actually looks a payment up by — its own order id, not the gateway's. An
  // unindexed lookup here is a sequential scan on a table that grows with every charge.

  await run(
    `CREATE TABLE IF NOT EXISTS billing_webhook_events (
      id VARCHAR(36) PRIMARY KEY,
      gateway_event_id VARCHAR(255) UNIQUE,
      provider VARCHAR(255),
      type VARCHAR(255),
      status VARCHAR(255),
      payload ${t.json},
      normalized ${t.json},
      error TEXT,
      created_at ${t.timestamp} NOT NULL,
      updated_at ${t.timestamp} NOT NULL
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS billing_disputes (
      id VARCHAR(36) PRIMARY KEY,
      gateway_id VARCHAR(255) UNIQUE,
      payment_gateway_id VARCHAR(255),
      provider VARCHAR(255),
      status VARCHAR(255),
      reason VARCHAR(255),
      amount BIGINT,
      currency VARCHAR(3),
      evidence_due_by ${t.timestamp},
      outcome VARCHAR(255),
      opened_at ${t.timestamp},
      closed_at ${t.timestamp},
      payload ${t.json},
      created_at ${t.timestamp} NOT NULL,
      updated_at ${t.timestamp} NOT NULL
    )`,
  );
  // The deadline read — open disputes ordered by the window closing soonest — scans exactly
  // these two columns, in this order.

  // Added in 0.4.0. A NEW table, not a new column, which is why it needs nothing from the ALTER
  // block below: `CREATE TABLE IF NOT EXISTS` carries a table to an existing install exactly as
  // well as to a fresh one. Only columns added to a table that already shipped have the upgrade
  // problem, and only they belong down there.
  await run(
    `CREATE TABLE IF NOT EXISTS billing_audit_events (
      id VARCHAR(36) PRIMARY KEY,
      action VARCHAR(255),
      actor VARCHAR(255),
      provider VARCHAR(255),
      subject_type VARCHAR(255),
      subject_id VARCHAR(255),
      amount BIGINT,
      currency VARCHAR(3),
      message TEXT,
      metadata ${t.json},
      created_at ${t.timestamp} NOT NULL,
      updated_at ${t.timestamp} NOT NULL
    )`,
  );

  await run(
    `CREATE TABLE IF NOT EXISTS billing_usage_events (
      id VARCHAR(36) PRIMARY KEY,
      subscription_id VARCHAR(255),
      customer_id VARCHAR(255),
      meter VARCHAR(255),
      quantity INTEGER DEFAULT 1,
      metadata ${t.json},
      recorded_at ${t.timestamp} NOT NULL,
      updated_at ${t.timestamp} NOT NULL
    )`,
  );

  // ── Columns added after their table shipped ────────────────────────────────────────────
  //
  // Placed here, BEFORE the indexes, and the order is load-bearing: an install on an older
  // version has `billing_payments` without `external_reference`, so `CREATE TABLE IF NOT
  // EXISTS` skips the table and indexing a column that does not exist yet fails the whole
  // call. The integration suite caught exactly that, against a real Postgres, on the first
  // run after this function was written.
  //
  // These columns are already declared in the CREATE statements above, so on a FRESH database
  // every statement here is a no-op. They are repeated as ALTERs for the install that already
  // has the table — which is what makes this an upgrade path rather than a first-install
  // convenience.
  //
  // Anything added to a CREATE statement from now on belongs here too, on the same day. A
  // column that exists only above works on every machine that has not shipped yet.

  // 0.3.0 — the app's own reference on a payment, and the normalized event on the ledger row.
  await addColumn(db, dialect, 'billing_payments', 'external_reference', 'VARCHAR(255)');
  await addColumn(db, dialect, 'billing_webhook_events', 'normalized', t.json);

  // 0.4.0 — how much of a payment has been refunded, in the same integer minor units as
  // `amount`. A PARTIAL refund had nowhere to be recorded before this, so the only two
  // options were to overwrite the status with `refunded` (writing off the whole charge) or to
  // drop the event — and the library dropped it, leaving revenue overstated forever.
  // `BIGINT`, matching `amount`, so net revenue is one subtraction and never a division.
  await addColumn(db, dialect, 'billing_payments', 'refunded_amount', 'BIGINT');

  // 0.7.0 — library-managed subscriptions. When `subscriptions.mode` is `'managed'` the
  // recurrence lives HERE, not at the gateway: there is no `gateway_id` to read the amount,
  // the cycle or the period back from, because no gateway subscription was ever created. Each
  // cycle is an ordinary charge, which is what makes cancelling and re-pricing local
  // operations on a gateway whose API cannot do either.
  //
  // Nullable across the board: a gateway-mode row has none of this and must not be forced to
  // invent it.
  await addColumn(db, dialect, 'billing_subscriptions', 'managed', 'BOOLEAN');
  await addColumn(db, dialect, 'billing_subscriptions', 'amount', 'BIGINT');
  await addColumn(db, dialect, 'billing_subscriptions', 'currency', 'VARCHAR(3)');
  await addColumn(db, dialect, 'billing_subscriptions', 'cycle', 'VARCHAR(32)');
  await addColumn(db, dialect, 'billing_subscriptions', 'method', 'VARCHAR(32)');
  await addColumn(db, dialect, 'billing_subscriptions', 'description', 'VARCHAR(255)');
  await addColumn(db, dialect, 'billing_subscriptions', 'external_reference', 'VARCHAR(255)');
  await addColumn(db, dialect, 'billing_subscriptions', 'current_period_start', t.timestamp);
  await addColumn(db, dialect, 'billing_subscriptions', 'current_period_end', t.timestamp);
  // The renewal runner's only input. Indexed below: it is scanned on every tick.
  await addColumn(db, dialect, 'billing_subscriptions', 'next_charge_at', t.timestamp);
  await addColumn(db, dialect, 'billing_subscriptions', 'cancel_at_period_end', 'BOOLEAN');

  // 0.9.0 — o que a renovação gerenciada deixou para trás.
  //
  // `renewDue` devolvia `{ result: 'failed', error }` e o app logava. Nada persistia, então
  // ninguém conseguia perguntar "quais assinaturas estão falhando, e há quanto tempo" — o
  // ledger de webhook responde isso para entregas, e a renovação não tinha equivalente.
  // Três colunas, não uma tabela: a pergunta operacional é sobre o ESTADO ATUAL de cada
  // assinatura, não sobre o histórico de cada tentativa.
  await addColumn(db, dialect, 'billing_subscriptions', 'last_renewal_error', 'VARCHAR(500)');
  await addColumn(db, dialect, 'billing_subscriptions', 'last_renewal_attempt_at', t.timestamp);
  await addColumn(db, dialect, 'billing_subscriptions', 'renewal_failure_count', 'INTEGER');

  // ── Indexes ───────────────────────────────────────────────────────────────────────────
  //
  // Last, and that is load-bearing twice over. Every table above has to exist, and so does
  // every column added by the block above — `billing_payments_external_reference_idx` names
  // a column an older install does not have until that ALTER runs. Getting this wrong fails
  // the whole call and leaves the schema half-built on every boot; the integration suite
  // caught both orderings against a real Postgres.
  await createIndex(
    db,
    dialect,
    'billing_customers_owner_idx',
    'billing_customers',
    'owner_type, owner_id',
  );
  await createIndex(
    db,
    dialect,
    'billing_subscriptions_customer_idx',
    'billing_subscriptions',
    'customer_id',
  );
  await createIndex(
    db,
    dialect,
    'billing_payments_customer_idx',
    'billing_payments',
    'customer_id',
  );
  await createIndex(
    db,
    dialect,
    'billing_payments_subscription_idx',
    'billing_payments',
    'subscription_id',
  );
  await createIndex(
    db,
    dialect,
    'billing_payments_external_reference_idx',
    'billing_payments',
    'external_reference',
  );
  await createIndex(
    db,
    dialect,
    'billing_disputes_payment_idx',
    'billing_disputes',
    'payment_gateway_id',
  );
  await createIndex(
    db,
    dialect,
    'billing_disputes_deadline_idx',
    'billing_disputes',
    'status, evidence_due_by',
  );
  // The two ways the audit trail is read: "what did the endpoint reject in the last day"
  // (the health check) and "what has anyone done to THIS payment" (the timeline).
  await createIndex(
    db,
    dialect,
    'billing_audit_events_action_idx',
    'billing_audit_events',
    'action, created_at',
  );
  await createIndex(
    db,
    dialect,
    'billing_audit_events_subject_idx',
    'billing_audit_events',
    'subject_type, subject_id',
  );
  await createIndex(
    db,
    dialect,
    'billing_usage_subscription_meter_idx',
    'billing_usage_events',
    'subscription_id, meter',
  );
  await createIndex(
    db,
    dialect,
    'billing_usage_customer_meter_idx',
    'billing_usage_events',
    'customer_id, meter',
  );
  // The renewal runner's working set: every tick asks "which managed subscriptions are due".
  // Unindexed, that is a full scan of every subscription ever created, on a schedule.
  await createIndex(
    db,
    dialect,
    'billing_subscriptions_due_idx',
    'billing_subscriptions',
    'managed, status, next_charge_at',
  );
}

/**
 * Callbacks that forget a store's memoized "the schema exists" answer.
 *
 * A `LucidBillingStore` creates the tables once and caches the promise, so after
 * {@link dropBillingTables} the store still believes the tables are there and every
 * subsequent query fails with `relation ... does not exist`. The store registers here so the
 * drop can tell it otherwise — a Set of callbacks rather than an import, because the store
 * already imports this module and the reverse would be a cycle.
 */
const schemaCacheResets = new Set<() => void>();

/**
 * Register a "forget the cached schema" callback. Returns the unregister function.
 * Internal — {@link LucidBillingStore} is the only caller.
 */
export function registerBillingSchemaCache(reset: () => void): () => void {
  schemaCacheResets.add(reset);
  return () => {
    schemaCacheResets.delete(reset);
  };
}

/**
 * Drop every billing table, newest-dependency-first.
 *
 * Only for a migration's `down()` and for tests. There is no auto-drop and there will not be
 * one: a library that can delete a payments table on a config typo is a library that will.
 *
 * Every live store is told to forget its cached schema afterwards, so a store built before
 * the drop re-creates the tables on its next query instead of querying tables that are gone.
 */
export async function dropBillingTables(db: LucidDatabase): Promise<void> {
  for (const table of [...BILLING_TABLES].reverse()) {
    await db.rawQuery(`DROP TABLE IF EXISTS ${table}`);
  }
  for (const reset of schemaCacheResets) reset();
}

/**
 * Empty every billing table, keeping the schema.
 *
 * What a test suite actually needs between groups, and the reason it is here rather than in
 * every app: dropping the tables invalidates the store (see above), while leaving the ROWS
 * in place means one test's webhook ledger deduplicates the next test's event — the
 * library's own idempotency working perfectly, against the suite. The app that found this
 * hand-wrote it with a `to_regclass` guard; this is that, dialect-agnostically.
 *
 * Order is the reverse of creation, so a foreign key never blocks a delete. `DELETE FROM`
 * rather than `TRUNCATE`: it is the one statement every dialect here spells the same way,
 * and these tables are test-sized.
 */
export async function truncateBillingTables(db: LucidDatabase): Promise<void> {
  for (const table of [...BILLING_TABLES].reverse()) {
    // A table that was never created is not an error to a suite that only wants it empty —
    // and asking `information_schema` per table per group costs more than the delete does.
    try {
      await db.rawQuery(`DELETE FROM ${table}`);
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }
}

/** Whether a driver error is "that table does not exist" rather than a real failure. */
function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /does not exist|no such table|doesn't exist|Unknown table|Invalid object name/i.test(message) ||
    // Postgres `undefined_table`, MySQL `ER_NO_SUCH_TABLE`.
    (error as { code?: string })?.code === '42P01' ||
    (error as { errno?: number })?.errno === 1146
  );
}
