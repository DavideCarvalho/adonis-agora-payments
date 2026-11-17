import { createHash, randomUUID } from 'node:crypto';
import {
  assertBillingSchemaName,
  assertSchemaDialect,
  billingTableRef,
  detectDialect,
  type LucidDatabase,
} from '../billing/schema.js';
import type { TenantLedger, TenantObjectKind } from './ledger.js';
import { DEFAULT_CALL_LEASE_MS, isSharedKind, serializeEvent } from './ledger.js';
import type { HubEventEnvelope, HubReplyMessage } from './protocol.js';

/** The tables the control plane adds next to the billing tables. */
export const TENANT_LEDGER_TABLES = [
  'billing_tenant_objects',
  'billing_tenant_events',
  'billing_tenant_calls',
  'billing_tenant_locks',
] as const;

type LedgerTable = (typeof TENANT_LEDGER_TABLES)[number];

export interface LucidTenantLedgerOptions {
  /** The Lucid connection. Default: the app's default connection. */
  connection?: string | undefined;
  /** The schema the tables live in, qualified in every query. */
  schema?: string | undefined;
  /** Create the tables on first use (`CREATE ... IF NOT EXISTS`). Default `true`. */
  autoCreateSchema?: boolean;
  /** The query client. Default: `@adonisjs/lucid/services/db`, on `connection`. */
  db?: () => LucidDatabase | Promise<LucidDatabase>;
}

const isPostgres = (dialect: string | undefined) =>
  dialect === 'postgres' || dialect === 'pg' || dialect === 'postgresql' || dialect === 'redshift';
const isMysql = (dialect: string | undefined) => dialect === 'mysql' || dialect === 'mysql2';

/** Rows out of a `rawQuery` result, whatever the dialect returned. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    // mysql2: `[rows, fields]`; better-sqlite3: the rows.
    if (result.length === 2 && Array.isArray(result[0]) && Array.isArray(result[1])) {
      return result[0] as Record<string, unknown>[];
    }
    return result as Record<string, unknown>[];
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

const EVENT_KEY_MAX = 512;

/**
 * The dedupe key of a queued event. A key that fits is stored as is (the rows written before
 * hashing existed keep matching); a longer one is hashed WHOLE instead of truncated, so two
 * events that only differ past the column width stay two rows.
 */
export function eventKey(partition: string, provider: string, eventId: string): string {
  const raw = `${partition}|${provider}|${eventId}`;
  if (raw.length <= EVENT_KEY_MAX) return raw;
  return `#sha256|${createHash('sha256').update(raw).digest('hex')}`;
}

/** A lock key that fits its column whatever the account id. */
const lockKey = (key: string) =>
  key.length <= 191 ? key : `#sha256|${createHash('sha256').update(key).digest('hex')}`;

/**
 * Create the ledger tables. Idempotent: the lazy first-use path and an app's own migration may
 * both call it.
 */
export async function createTenantLedgerTables(
  db: LucidDatabase,
  options: { schema?: string | undefined } = {},
): Promise<void> {
  const dialect = detectDialect(db);
  const schema = options.schema;
  if (schema !== undefined) {
    assertBillingSchemaName(schema);
    assertSchemaDialect(schema, dialect);
    await db.rawQuery(
      isMysql(dialect)
        ? `CREATE DATABASE IF NOT EXISTS \`${schema}\``
        : `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    );
  }
  const T = (table: LedgerTable) => billingTableRef(dialect, schema, table);
  const timestamp = isPostgres(dialect) ? 'TIMESTAMPTZ' : 'DATETIME';
  const json = isPostgres(dialect) ? 'JSONB' : isMysql(dialect) ? 'JSON' : 'TEXT';
  const serial = isPostgres(dialect)
    ? 'BIGSERIAL PRIMARY KEY'
    : isMysql(dialect)
      ? 'BIGINT AUTO_INCREMENT PRIMARY KEY'
      : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  await db.rawQuery(
    `CREATE TABLE IF NOT EXISTS ${T('billing_tenant_objects')} (
      kind VARCHAR(32) NOT NULL,
      gateway_id VARCHAR(255) NOT NULL,
      tenant VARCHAR(191) NOT NULL,
      provider VARCHAR(255) NOT NULL,
      created_at ${timestamp} NOT NULL,
      PRIMARY KEY (kind, gateway_id, tenant)
    )`,
  );
  await db.rawQuery(
    `CREATE TABLE IF NOT EXISTS ${T('billing_tenant_events')} (
      id ${serial},
      tenant VARCHAR(191) NOT NULL,
      event_key VARCHAR(512) NOT NULL UNIQUE,
      event ${json} NOT NULL,
      created_at ${timestamp} NOT NULL,
      delivered_at ${timestamp} NULL
    )`,
  );
  await db.rawQuery(
    `CREATE TABLE IF NOT EXISTS ${T('billing_tenant_calls')} (
      tenant VARCHAR(191) NOT NULL,
      call_id VARCHAR(191) NOT NULL,
      claim VARCHAR(64) NOT NULL,
      reply ${json} NULL,
      created_at ${timestamp} NOT NULL,
      PRIMARY KEY (tenant, call_id)
    )`,
  );
  await db.rawQuery(
    `CREATE TABLE IF NOT EXISTS ${T('billing_tenant_locks')} (
      lock_key VARCHAR(191) NOT NULL PRIMARY KEY,
      holder VARCHAR(64) NOT NULL,
      expires_at ${timestamp} NOT NULL
    )`,
  );
  const index = isMysql(dialect)
    ? `CREATE INDEX billing_tenant_events_pending_idx ON ${T('billing_tenant_events')} (tenant, delivered_at, id)`
    : `CREATE INDEX IF NOT EXISTS billing_tenant_events_pending_idx ON ${T('billing_tenant_events')} (tenant, delivered_at, id)`;
  try {
    await db.rawQuery(index);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate key name|already exists/i.test(message)) throw error;
  }
}

/** Drop the ledger tables (tests, teardown). */
export async function dropTenantLedgerTables(
  db: LucidDatabase,
  options: { schema?: string | undefined } = {},
): Promise<void> {
  const dialect = detectDialect(db);
  for (const table of TENANT_LEDGER_TABLES) {
    await db.rawQuery(`DROP TABLE IF EXISTS ${billingTableRef(dialect, options.schema, table)}`);
  }
}

/**
 * The ledger in the control plane's database, next to the billing tables (pass the same
 * connection and schema). Every query names the schema; nothing depends on `search_path`.
 */
export function lucidTenantLedger(options: LucidTenantLedgerOptions = {}): TenantLedger {
  let ready: Promise<{ db: LucidDatabase; dialect: string | undefined }> | undefined;

  const resolveDb = async (): Promise<LucidDatabase> => {
    if (options.db) return options.db();
    const mod = (await import('@adonisjs/lucid/services/db')) as unknown as {
      default: { connection(name?: string): LucidDatabase };
    };
    return mod.default.connection(options.connection);
  };

  const prepare = () => {
    ready ??= (async () => {
      const db = await resolveDb();
      const dialect = detectDialect(db);
      if (options.autoCreateSchema !== false) {
        await createTenantLedgerTables(db, { schema: options.schema });
      } else if (options.schema !== undefined) {
        assertSchemaDialect(options.schema, dialect);
      }
      return { db, dialect };
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  const now = () => new Date().toISOString();

  const query = async (
    sql: (T: (table: LedgerTable) => string, dialect: string | undefined) => string,
    bindings: unknown[] = [],
  ) => {
    const { db, dialect } = await prepare();
    const T = (table: LedgerTable) => billingTableRef(dialect, options.schema, table);
    return rowsOf(await db.rawQuery(sql(T, dialect), bindings));
  };

  /** `INSERT` that does nothing on a duplicate key, in each dialect's words. */
  const insertIgnore = (dialect: string | undefined, rest: string) =>
    isMysql(dialect) ? `INSERT IGNORE INTO ${rest}` : `INSERT INTO ${rest} ON CONFLICT DO NOTHING`;

  const owners = async (kind: TenantObjectKind, gatewayId: string) =>
    (
      await query(
        (T) =>
          `SELECT tenant FROM ${T('billing_tenant_objects')} WHERE kind = ? AND gateway_id = ?`,
        [kind, gatewayId],
      )
    ).map((row) => String(row.tenant));

  return {
    async claim(partition, kind, gatewayId, provider) {
      const before = await owners(kind, gatewayId);
      if (before.includes(partition)) return true;
      if (!isSharedKind(kind) && before.length > 0) return false;
      await query(
        (T, dialect) =>
          insertIgnore(
            dialect,
            `${T('billing_tenant_objects')} (kind, gateway_id, tenant, provider, created_at) VALUES (?, ?, ?, ?, ?)`,
          ),
        [kind, gatewayId, partition, provider, now()],
      );
      if (isSharedKind(kind)) return true;
      // Two apps racing for one single-owner object: the oldest row wins, the other backs out.
      const after = await query(
        (T) =>
          `SELECT tenant FROM ${T('billing_tenant_objects')} WHERE kind = ? AND gateway_id = ? ORDER BY created_at, tenant`,
        [kind, gatewayId],
      );
      const winner = after[0] === undefined ? undefined : String(after[0].tenant);
      if (winner === partition) return true;
      await query(
        (T) =>
          `DELETE FROM ${T('billing_tenant_objects')} WHERE kind = ? AND gateway_id = ? AND tenant = ?`,
        [kind, gatewayId, partition],
      );
      return false;
    },

    owners,

    async enqueue(partition, event) {
      const key = eventKey(partition, event.provider, event.id);
      await query(
        (T, dialect) =>
          insertIgnore(
            dialect,
            `${T('billing_tenant_events')} (tenant, event_key, event, created_at) VALUES (?, ?, ?, ?)`,
          ),
        [partition, key, JSON.stringify(serializeEvent(event)), now()],
      );
    },

    async pull(partition, limit) {
      const rows = await query(
        (T) =>
          `SELECT id, event FROM ${T('billing_tenant_events')} WHERE tenant = ? AND delivered_at IS NULL ORDER BY id LIMIT ?`,
        [partition, Math.max(1, Math.min(500, Math.trunc(limit)))],
      );
      return rows.map((row) => ({
        seq: String(row.id),
        event: parseJson<HubEventEnvelope['event']>(row.event),
      }));
    },

    async ack(partition, seqs) {
      const ids = seqs.map((seq) => Number(seq)).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(', ');
      const pending = await query(
        (T) =>
          `SELECT id FROM ${T('billing_tenant_events')} WHERE tenant = ? AND delivered_at IS NULL AND id IN (${placeholders})`,
        [partition, ...ids],
      );
      if (pending.length === 0) return 0;
      await query(
        (T) =>
          `UPDATE ${T('billing_tenant_events')} SET delivered_at = ? WHERE tenant = ? AND delivered_at IS NULL AND id IN (${placeholders})`,
        [now(), partition, ...ids],
      );
      return pending.length;
    },

    async beginCall(partition, id, callOptions = {}) {
      const claim = randomUUID();
      await query(
        (T, dialect) =>
          insertIgnore(
            dialect,
            `${T('billing_tenant_calls')} (tenant, call_id, claim, reply, created_at) VALUES (?, ?, ?, NULL, ?)`,
          ),
        [partition, id, claim, now()],
      );
      const read = () =>
        query(
          (T) =>
            `SELECT claim, reply FROM ${T('billing_tenant_calls')} WHERE tenant = ? AND call_id = ?`,
          [partition, id],
        );
      let row = (await read())[0];
      if (row === undefined) return { state: 'new', claim };
      if (String(row.claim) === claim) return { state: 'new', claim };
      if (row.reply !== null && row.reply !== undefined) {
        return { state: 'done', reply: parseJson<HubReplyMessage>(row.reply) };
      }
      // An attempt that never finished nor released the id (the process died mid-call). Past its
      // lease, ONE caller takes it over (compare-and-set on the claim it saw) and reconciles.
      const leaseMs = callOptions.leaseMs ?? DEFAULT_CALL_LEASE_MS;
      const expiredBefore = new Date(Date.now() - leaseMs).toISOString();
      await query(
        (T) =>
          `UPDATE ${T('billing_tenant_calls')} SET claim = ?, created_at = ? WHERE tenant = ? AND call_id = ? AND claim = ? AND reply IS NULL AND created_at < ?`,
        [claim, now(), partition, id, String(row.claim), expiredBefore],
      );
      row = (await read())[0];
      if (row !== undefined && String(row.claim) === claim) return { state: 'stale', claim };
      if (row !== undefined && row.reply !== null && row.reply !== undefined) {
        return { state: 'done', reply: parseJson<HubReplyMessage>(row.reply) };
      }
      return { state: 'running' };
    },

    async finishCall(partition, id, reply, claim) {
      await query(
        (T) =>
          `UPDATE ${T('billing_tenant_calls')} SET reply = ? WHERE tenant = ? AND call_id = ?${claim !== undefined ? ' AND claim = ?' : ''}`,
        [JSON.stringify(reply), partition, id, ...(claim !== undefined ? [claim] : [])],
      );
    },

    async abandonCall(partition, id, claim) {
      await query(
        (T) =>
          `DELETE FROM ${T('billing_tenant_calls')} WHERE tenant = ? AND call_id = ? AND reply IS NULL${claim !== undefined ? ' AND claim = ?' : ''}`,
        [partition, id, ...(claim !== undefined ? [claim] : [])],
      );
    },

    async lock(key, leaseMs) {
      const holder = randomUUID();
      const lock = lockKey(key);
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      await query(
        (T, dialect) =>
          insertIgnore(
            dialect,
            `${T('billing_tenant_locks')} (lock_key, holder, expires_at) VALUES (?, ?, ?)`,
          ),
        [lock, holder, expiresAt],
      );
      // A holder that died without unlocking: take its expired lock over.
      await query(
        (T) =>
          `UPDATE ${T('billing_tenant_locks')} SET holder = ?, expires_at = ? WHERE lock_key = ? AND holder <> ? AND expires_at < ?`,
        [holder, expiresAt, lock, holder, now()],
      );
      const rows = await query(
        (T) => `SELECT holder FROM ${T('billing_tenant_locks')} WHERE lock_key = ?`,
        [lock],
      );
      return rows[0] !== undefined && String(rows[0].holder) === holder ? holder : null;
    },

    async unlock(key, holder) {
      await query(
        (T) => `DELETE FROM ${T('billing_tenant_locks')} WHERE lock_key = ? AND holder = ?`,
        [lockKey(key), holder],
      );
    },

    async prune(before) {
      const cutoff = before.toISOString();
      const events = await query(
        (T) =>
          `SELECT COUNT(*) AS n FROM ${T('billing_tenant_events')} WHERE delivered_at IS NOT NULL AND created_at < ?`,
        [cutoff],
      );
      await query(
        (T) =>
          `DELETE FROM ${T('billing_tenant_events')} WHERE delivered_at IS NOT NULL AND created_at < ?`,
        [cutoff],
      );
      const calls = await query(
        (T) => `SELECT COUNT(*) AS n FROM ${T('billing_tenant_calls')} WHERE created_at < ?`,
        [cutoff],
      );
      await query((T) => `DELETE FROM ${T('billing_tenant_calls')} WHERE created_at < ?`, [cutoff]);
      await query((T) => `DELETE FROM ${T('billing_tenant_locks')} WHERE expires_at < ?`, [cutoff]);
      return { events: Number(events[0]?.n ?? 0), calls: Number(calls[0]?.n ?? 0) };
    },

    async backlog() {
      const rows = await query(
        (T) =>
          `SELECT tenant, COUNT(*) AS n FROM ${T('billing_tenant_events')} WHERE delivered_at IS NULL GROUP BY tenant`,
      );
      const out: Record<string, number> = {};
      for (const row of rows) out[String(row.tenant)] = Number(row.n);
      return out;
    },
  };
}
