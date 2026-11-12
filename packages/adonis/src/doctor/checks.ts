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
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

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
  };
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
  const client = db.connection(payments?.billing?.connection);
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
  const builder = client.schema.withSchema.bind(client.schema);
  const present = await Promise.all(BILLING_TABLES.map((table) => builder(schema).hasTable(table)));
  const missing = BILLING_TABLES.filter((_, index) => !present[index]);
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
  for (const table of BILLING_TABLES) {
    try {
      await client.rawQuery(
        `INSERT INTO ${billingTableRef(dialect, schema, table)} (id) SELECT NULL${from} WHERE 1 = 0`,
      );
    } catch {
      denied.push(table);
    }
  }
  if (denied.length > 0) {
    return {
      status: 'error',
      message: `This connection cannot write to ${denied.join(', ')} in schema "${schema}".`,
      fix: `Grant the connection's role USAGE on schema "${schema}" and SELECT, INSERT, UPDATE, DELETE on its billing tables.`,
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
  ];
}
