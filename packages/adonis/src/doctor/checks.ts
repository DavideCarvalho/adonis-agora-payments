import type { ApplicationService } from '@adonisjs/core/types';
import { type BillingHealth, billingHealth } from '../billing/billing_health.js';
import type { BillingStore } from '../billing/billing_store.js';
import { resolveRole } from '../billing/resolve_dispatch.js';
import { resolveBillingStore } from '../billing/resolve_store.js';
import { assertSchemaDialect, BILLING_TABLES, billingTableRef } from '../billing/schema.js';
import { type PaymentsDashboardConfig, resolveConfig } from '../dashboard/define_config.js';
import type { PaymentsConfig } from '../define_config.js';
import type { WebhookVerificationState } from '../driver.js';
import { PaymentsManager, resolveDrivers } from '../payments_manager.js';
import { describeTenantSources, resolvePaymentsTenant } from '../topology/authkit_tenant.js';
import { resolveTopology } from '../topology/runtime.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';
import { consoleCommandsDoctorChecks } from './console_commands.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/payments';

/** The route `payments_provider` mounts for every gateway's deliveries. */
export const WEBHOOK_ROUTE_PATTERN = '/payments/webhook/:provider';

/** What the webhook-secret check needs to know about one configured driver. */
export interface DriverVerification {
  name: string;
  provider?: string;
  webhookVerification?: WebhookVerificationState;
}

/** `payments.webhook-secret`: every gateway that can verify deliveries has its credential. */
export function checkWebhookSecret(
  drivers: readonly DriverVerification[],
  allowUnverified: PaymentsConfig['allowUnverifiedWebhooks'],
  inProduction: boolean,
): AgoraDoctorResult {
  if (drivers.length === 0) return { status: 'skip', message: 'No gateway is configured.' };
  const allowed = new Set<string>(Array.isArray(allowUnverified) ? allowUnverified : []);
  const unconfigured = drivers.filter((driver) => driver.webhookVerification === 'unconfigured');
  const accepted = unconfigured.filter(
    (driver) =>
      allowUnverified === true ||
      allowed.has(driver.name) ||
      (driver.provider !== undefined && allowed.has(driver.provider)),
  );
  const missing = unconfigured.filter((driver) => !accepted.includes(driver));
  if (missing.length > 0) {
    const names = missing.map((driver) => driver.name).join(', ');
    return {
      status: inProduction ? 'error' : 'warn',
      message: `${names} can verify webhook deliveries but ${missing.length === 1 ? 'has' : 'have'} no webhook credential: the app will not boot, and the route would accept forged deliveries.`,
      fix: `Set the webhook secret/token of ${names} in config/payments.ts (see each provider's docs page for the env var).`,
      docs: `${DOCS}/webhooks`,
    };
  }
  if (accepted.length > 0) {
    const names = accepted.map((driver) => driver.name).join(', ');
    return {
      status: 'warn',
      message: `${names} accept${accepted.length === 1 ? 's' : ''} unverified webhook deliveries (allowUnverifiedWebhooks).`,
      fix: 'Keep it only if verification is terminated upstream; otherwise set the webhook credential and drop allowUnverifiedWebhooks.',
      docs: `${DOCS}/webhooks`,
    };
  }
  return { status: 'ok', message: 'Every gateway that signs its webhooks has a credential.' };
}

/** The `csrf` block of `config/shield.ts`, duck-typed. */
interface ShieldCsrfLike {
  enabled?: boolean;
  methods?: string[];
  exceptRoutes?: string[] | ((ctx: unknown) => boolean);
}

/**
 * Whether shield's CSRF check would reject a gateway's `POST` to `url` (route `pattern`). `false`
 * when CSRF is off, `POST` is not a checked method, or `exceptRoutes` exempts the route (an array
 * naming the route pattern, or a function answering `true` for a minimal context of that request);
 * `'unknown'` when the function throws on that minimal context.
 */
export function csrfBlocksRoute(
  shield: unknown,
  pattern: string,
  url: string,
): boolean | 'unknown' {
  const csrf = (shield as { csrf?: ShieldCsrfLike } | undefined)?.csrf;
  if (csrf === undefined || csrf.enabled !== true) return false;
  // An explicit, non-empty method list without POST never checks a delivery. Shield reads an empty
  // list as "validate every method", like an absent one.
  if (
    Array.isArray(csrf.methods) &&
    csrf.methods.length > 0 &&
    !csrf.methods.some((method) => method.toUpperCase() === 'POST')
  ) {
    return false;
  }
  const except = csrf.exceptRoutes;
  if (typeof except === 'function') {
    try {
      const probe = {
        request: { url: () => url, method: () => 'POST', header: () => undefined },
        route: { pattern },
        params: {},
      };
      return except(probe) !== true;
    } catch {
      return 'unknown';
    }
  }
  // Shield matches an array against the route PATTERN only, never the URL.
  if (Array.isArray(except)) return !except.includes(pattern);
  return true;
}

/** `payments.webhook-csrf`: shield's CSRF check lets gateway deliveries through. */
export function checkWebhookCsrf(
  payments: PaymentsConfig | undefined,
  shield: unknown,
): AgoraDoctorResult {
  if (payments === undefined) return { status: 'skip', message: 'config/payments.ts is missing.' };
  if (resolveRole(payments) === 'worker') {
    return { status: 'skip', message: "billing.role is 'worker': no webhook route is mounted." };
  }
  const provider = Object.keys(payments.providers ?? {})[0] ?? 'stripe';
  const verdict = csrfBlocksRoute(shield, WEBHOOK_ROUTE_PATTERN, `/payments/webhook/${provider}`);
  if (verdict === false) return { status: 'ok', message: 'Webhook deliveries pass CSRF.' };
  if (verdict === 'unknown') {
    return {
      status: 'warn',
      message:
        'shield csrf.exceptRoutes threw when probed, so whether it exempts /payments/webhook/:provider is unknown.',
      fix: 'Make sure `csrf.exceptRoutes` (config/shield.ts) exempts `/payments/webhook/:provider`.',
      docs: `${DOCS}/webhooks`,
    };
  }
  return {
    status: 'error',
    message: "Shield's CSRF check rejects every gateway delivery to /payments/webhook/*.",
    fix: 'Exempt `/payments/webhook/:provider` in `csrf.exceptRoutes` (config/shield.ts).',
    docs: `${DOCS}/webhooks`,
  };
}

/** `payments.console-gate`: the console has an `authorize`. */
export function checkConsoleGate(
  dashboard: PaymentsDashboardConfig | undefined,
  mounted: boolean | undefined,
  inProduction: boolean,
): AgoraDoctorResult {
  if (dashboard === undefined) {
    return { status: 'skip', message: 'config/payments_dashboard.ts is missing.' };
  }
  const resolved = resolveConfig(dashboard);
  if (!resolved.enabled) return { status: 'skip', message: 'The console is disabled.' };
  if (mounted === false) {
    return { status: 'skip', message: 'The dashboard provider is not registered.' };
  }
  if (resolved.authorize !== null) {
    return { status: 'ok', message: 'The console has an authorize.' };
  }
  return {
    status: inProduction ? 'error' : 'warn',
    message: inProduction
      ? 'The console has no authorize: it denies every request in production.'
      : 'The console has no authorize: it is open here and denies every request in production.',
    fix: 'Set `authorize` in config/payments_dashboard.ts.',
    docs: `${DOCS}/dashboard`,
  };
}

/** A Lucid database, duck-typed: what the table check reads. */
interface LucidLike {
  connection(name?: string): {
    dialect?: { name?: string };
    schema: {
      hasTable(table: string): Promise<boolean>;
      withSchema?(schema: string): { hasTable(table: string): Promise<boolean> };
    };
    rawQuery?(sql: string, bindings?: unknown[]): Promise<unknown>;
    /** A transaction of its own (Lucid's `transaction()`): the write probe runs and rolls back in it. */
    transaction?(): Promise<{
      rawQuery(sql: string, bindings?: unknown[]): Promise<unknown>;
      rollback(): Promise<unknown>;
    }>;
  };
}

/** A database error as one line: its message, with the driver's code when it has one. */
function dbErrorText(error: unknown): string {
  const { code, errno, sqlState } = (error ?? {}) as {
    code?: unknown;
    errno?: unknown;
    sqlState?: unknown;
  };
  const message = error instanceof Error ? error.message : String(error);
  const id = [code, sqlState ?? errno].filter((v) => v !== undefined && v !== null).join('/');
  return id ? `${message} [${id}]` : message;
}

/** Whether a database error says the table is not there (pg 42P01, mysql 1146). */
function isMissingTableError(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  const text = error instanceof Error ? error.message : String(error);
  return (
    code === '42P01' ||
    errno === 1146 ||
    code === 'ER_NO_SUCH_TABLE' ||
    /relation .* does not exist|doesn't exist|no such table/i.test(text)
  );
}

/** Whether a database error is a privilege refusal (pg 42501, mysql ER_*ACCESS_DENIED*). */
function isPermissionError(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  const text = error instanceof Error ? error.message : String(error);
  return (
    code === '42501' ||
    errno === 1142 ||
    errno === 1044 ||
    (typeof code === 'string' && /ACCESS_DENIED/.test(code)) ||
    /permission denied|access denied|command denied/i.test(text)
  );
}

/**
 * Whether this connection may INSERT into `ref`: a zero-row insert, inside a transaction of its
 * own that is always rolled back (so concurrent doctors, or a concurrent migration, cannot see or
 * break each other), retried once when the failure is not a privilege refusal (a pool or lock
 * blip). Answers the error when it fails.
 */
async function probeInsert(
  client: ReturnType<LucidLike['connection']>,
  sql: string,
): Promise<unknown | undefined> {
  const attempt = async (): Promise<unknown | undefined> => {
    try {
      if (typeof client.transaction === 'function') {
        const trx = await client.transaction();
        try {
          await trx.rawQuery(sql);
        } finally {
          await trx.rollback().catch(() => undefined);
        }
      } else {
        await client.rawQuery!(sql);
      }
      return undefined;
    } catch (error) {
      return error ?? new Error('unknown database error');
    }
  };
  const first = await attempt();
  if (first === undefined || isPermissionError(first)) return first;
  await new Promise((resolve) => setTimeout(resolve, 100));
  return attempt();
}

/** The rows of a `rawQuery`, on either driver shape (`{ rows }` on pg, `[rows, fields]` on mysql). */
function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** `payments.tables`: the billing tables exist (in `billing.schema`, when set, and writable). */
export async function checkTables(
  payments: PaymentsConfig | undefined,
  db: LucidLike | undefined,
): Promise<AgoraDoctorResult> {
  if (payments?.billing?.enabled === false) {
    return { status: 'skip', message: 'The billing layer is disabled.' };
  }
  if (payments?.billing?.store !== undefined) {
    return { status: 'skip', message: 'billing.store is your own: its tables are yours too.' };
  }
  if (db === undefined) {
    return {
      status: 'skip',
      message: 'Lucid is not registered: the billing tables cannot be read.',
    };
  }
  let client: ReturnType<LucidLike['connection']>;
  try {
    client = db.connection(payments?.billing?.connection);
  } catch (error) {
    return {
      status: 'error',
      message: `billing.connection "${payments?.billing?.connection}" cannot be opened: ${(error as Error).message}`,
      fix: 'Use a connection name declared in config/database.ts.',
      docs: `${DOCS}/configuration`,
    };
  }
  const autoCreate = payments?.billing?.autoCreateSchema !== false;
  const schema = payments?.billing?.schema;
  if (schema !== undefined) return checkSchemaTables(client, schema, autoCreate);

  const present = await Promise.all(BILLING_TABLES.map((table) => client.schema.hasTable(table)));
  const missing = BILLING_TABLES.filter((_, index) => !present[index]);
  if (missing.length === 0) return { status: 'ok', message: 'Every billing table exists.' };
  return {
    status: autoCreate ? 'warn' : 'error',
    message: autoCreate
      ? `Missing ${missing.join(', ')}: they are created on first use (autoCreateSchema).`
      : `Missing ${missing.join(', ')} and autoCreateSchema is off: billing writes will fail.`,
    fix: 'Publish and run the billing migration: `node ace configure @adonis-agora/payments`, then `node ace migration:run`.',
    docs: `${DOCS}/billing`,
  };
}

/**
 * `payments.tables` with `billing.schema` set: the schema exists, every table is IN it (not
 * merely somewhere on the search path), and this connection can write there.
 */
async function checkSchemaTables(
  client: ReturnType<LucidLike['connection']>,
  schema: string,
  autoCreate: boolean,
): Promise<AgoraDoctorResult> {
  const docs = `${DOCS}/configuration`;
  const dialect = client.dialect?.name;
  try {
    assertSchemaDialect(schema, dialect);
  } catch (error) {
    return {
      status: 'error',
      message: (error as Error).message,
      fix: 'Remove `billing.schema`, or point `billing.connection` at Postgres or MySQL.',
      docs,
    };
  }
  if (client.rawQuery === undefined || client.schema.withSchema === undefined) {
    return { status: 'skip', message: 'This Lucid client cannot read the catalog.' };
  }
  const exists =
    rowsOf(
      await client.rawQuery(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?',
        [schema],
      ),
    ).length > 0;
  if (!exists) {
    return {
      status: autoCreate ? 'warn' : 'error',
      message: autoCreate
        ? `The billing schema "${schema}" does not exist yet: it is created with the tables on first use (autoCreateSchema).`
        : `The billing schema "${schema}" does not exist and autoCreateSchema is off: billing writes will fail.`,
      fix: 'Run the billing migration (it creates the schema), or create it yourself and grant this connection USAGE and CREATE on it.',
      docs,
    };
  }
  // The catalog, asked for exactly this schema: `withSchema().hasTable()` can answer from the
  // search path (or another database on MySQL) and call a table present that the write probe then
  // cannot find.
  const listed = new Set(
    rowsOf(
      await client.rawQuery(
        `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name IN (${BILLING_TABLES.map(() => '?').join(', ')})`,
        [schema, ...BILLING_TABLES],
      ),
    )
      .map((row) => {
        const value = row as {
          name?: unknown;
          NAME?: unknown;
          table_name?: unknown;
          TABLE_NAME?: unknown;
        };
        return value.name ?? value.NAME ?? value.table_name ?? value.TABLE_NAME;
      })
      .filter((name): name is string => typeof name === 'string'),
  );
  const missing = BILLING_TABLES.filter((table) => !listed.has(table));
  if (missing.length > 0) {
    return {
      status: autoCreate ? 'warn' : 'error',
      message: autoCreate
        ? `Missing ${missing.join(', ')} in schema "${schema}": they are created on first use (autoCreateSchema).`
        : `Missing ${missing.join(', ')} in schema "${schema}" and autoCreateSchema is off: billing writes will fail.`,
      fix: 'Run the billing migration — it reads `billing.schema` from config/payments.ts.',
      docs,
    };
  }
  // Zero rows, so nothing is written — but the database still checks the INSERT privilege.
  const from = /mysql|mariadb/i.test(dialect ?? '') ? ' FROM DUAL' : '';
  const denied: string[] = [];
  const failed: string[] = [];
  for (const table of BILLING_TABLES) {
    const error = await probeInsert(
      client,
      `INSERT INTO ${billingTableRef(dialect, schema, table)} (id) SELECT NULL${from} WHERE 1 = 0`,
    );
    if (error === undefined) continue;
    if (isMissingTableError(error)) {
      // The catalog listed it, the INSERT did not find it (created or dropped meanwhile).
      failed.push(
        `${table} (${dbErrorText(error)}; it is created on first use when autoCreateSchema is on)`,
      );
      continue;
    }
    (isPermissionError(error) ? denied : failed).push(`${table} (${dbErrorText(error)})`);
  }
  if (denied.length > 0) {
    return {
      status: 'error',
      message: `This connection cannot write to ${denied.join(', ')} in schema "${schema}".`,
      fix: `Grant the connection's role USAGE on schema "${schema}" and SELECT, INSERT, UPDATE, DELETE on its billing tables.`,
      docs,
    };
  }
  if (failed.length > 0) {
    // Not a privilege refusal: the database answered something else (busy, a concurrent DDL).
    return {
      status: 'warn',
      message: `Could not confirm writes to ${failed.join(', ')} in schema "${schema}".`,
      fix: 'Run `node ace agora:doctor` again; if it persists, the error above says what the database refused.',
      docs,
    };
  }
  return {
    status: 'ok',
    message: `Every billing table exists in schema "${schema}" and is writable.`,
  };
}

/** `payments.health`: the `payments:health` report, any problem reported with its count. */
export function checkHealth(report: BillingHealth): AgoraDoctorResult {
  const problems = report.checks.filter((check) => !check.healthy);
  if (problems.length === 0) {
    return { status: 'ok', message: 'payments:health reports nothing wrong.' };
  }
  return {
    status: 'warn',
    message: problems.map((check) => `${check.count} ${check.label}`).join('; '),
    fix: 'Run `node ace payments:health` for the details and what to do about each.',
    docs: `${DOCS}/production`,
  };
}

function paymentsConfig(app: ApplicationService): PaymentsConfig | undefined {
  return app.config.get<PaymentsConfig | undefined>('payments', undefined);
}

/** The configured drivers: the booted manager's, else built from config (`--no-boot`). */
async function configuredDrivers(app: ApplicationService): Promise<DriverVerification[]> {
  let drivers: Iterable<
    [string, { provider?: string; webhookVerification?: WebhookVerificationState }]
  >;
  if (app.container.hasBinding(PaymentsManager)) {
    drivers = (await app.container.make(PaymentsManager)).drivers;
  } else {
    const config = paymentsConfig(app);
    if (config === undefined) return [];
    drivers = await resolveDrivers(config);
  }
  return [...drivers].map(([name, driver]) => ({
    name,
    ...(driver.provider !== undefined ? { provider: driver.provider } : {}),
    ...(driver.webhookVerification !== undefined
      ? { webhookVerification: driver.webhookVerification }
      : {}),
  }));
}

/** Whether the dashboard routes are mounted; `undefined` when it cannot be told (not booted). */
async function dashboardMounted(app: ApplicationService): Promise<boolean | undefined> {
  if (!app.isBooted) return undefined;
  try {
    const router = (await app.container.make('router')) as { has?(name: string): boolean };
    return typeof router.has === 'function' ? router.has('payments_dashboard.index') : undefined;
  } catch {
    return undefined;
  }
}

async function lucid(app: ApplicationService): Promise<LucidLike | undefined> {
  if (!app.container.hasBinding('lucid.db' as never)) return undefined;
  return (await app.container.make('lucid.db' as never)) as LucidLike;
}

/**
 * `payments.tenant`: a tenant knows its control plane, token and partition, and says where each
 * comes from (`explicit`, or `authkit-client (auto)` when `@adonis-agora/authkit-client`'s
 * `tenantOf` supplies it).
 */
export async function checkTenant(
  config: PaymentsConfig | undefined,
  container?: Parameters<typeof resolvePaymentsTenant>[1],
): Promise<AgoraDoctorResult> {
  if (config?.topology !== 'tenant') return { status: 'skip', message: 'Not a payments tenant.' };
  let resolved: Awaited<ReturnType<typeof resolvePaymentsTenant<PaymentsConfig>>>;
  try {
    resolved = await resolvePaymentsTenant(config, container);
  } catch (error) {
    const message = (error as Error).message;
    const at = message.indexOf(' Fix: ');
    return {
      status: 'error',
      message: message.slice(0, at),
      fix: message.slice(at + 6),
      docs: `${DOCS}/control-plane`,
    };
  }
  try {
    resolveTopology(resolved.config);
  } catch (error) {
    return {
      status: 'error',
      message: (error as Error).message,
      fix: 'Fix the `tenant` block in config/payments.ts.',
      docs: `${DOCS}/control-plane`,
    };
  }
  const where = resolved.sources ? describeTenantSources(resolved.sources) : 'tenant';
  const transport =
    config.tenant?.transport !== undefined ? ` (transport: ${config.tenant.transport.name})` : '';
  return { status: 'ok', message: `${where}${transport}.` };
}

/** The checks `@adonis-agora/payments` registers into `agora:doctor`. */
export function paymentsDoctorChecks(
  deps: {
    /** The billing store the provider built, when it did. */
    store?: () => BillingStore | undefined;
  } = {},
): AgoraDoctorCheck[] {
  return [
    {
      id: 'payments.webhook-secret',
      lib: 'payments',
      title: 'Webhook deliveries are verified',
      run: async (app) => {
        const config = paymentsConfig(app);
        return checkWebhookSecret(
          await configuredDrivers(app),
          config?.allowUnverifiedWebhooks,
          app.inProduction,
        );
      },
    },
    {
      id: 'payments.webhook-csrf',
      lib: 'payments',
      title: 'Webhook route passes CSRF',
      run: (app) => checkWebhookCsrf(paymentsConfig(app), app.config.get('shield', undefined)),
    },
    {
      id: 'payments.console-gate',
      lib: 'payments',
      title: 'Console access in production',
      run: async (app) =>
        checkConsoleGate(
          app.config.get<PaymentsDashboardConfig | undefined>('payments_dashboard', undefined),
          await dashboardMounted(app),
          app.inProduction,
        ),
    },
    {
      id: 'payments.tables',
      lib: 'payments',
      title: 'Billing tables exist',
      cost: 'deep',
      run: async (app) => checkTables(paymentsConfig(app), await lucid(app)),
    },
    {
      id: 'payments.health',
      lib: 'payments',
      title: 'Billing health (payments:health)',
      cost: 'deep',
      run: async (app) => {
        const config = paymentsConfig(app) ?? {};
        if (config.billing?.enabled === false) {
          return { status: 'skip', message: 'The billing layer is disabled.' };
        }
        const store = deps.store?.() ?? (await resolveBillingStore(config));
        return checkHealth(await billingHealth(store));
      },
    },
    {
      id: 'payments.tenant',
      lib: 'payments',
      title: 'Tenant control plane, token and partition',
      run: (app) => checkTenant(paymentsConfig(app), app.container as never),
    },
    ...consoleCommandsDoctorChecks(),
  ];
}
