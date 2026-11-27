import { describe, expect, it } from 'vitest';
import loader from '../commands/main.js';
import type { BillingHealth } from '../src/billing/billing_health.js';
import { BILLING_TABLES } from '../src/billing/schema.js';
import {
  AGORA_DOCTOR_BINDING,
  type AgoraDoctorRegistry,
  registerDoctorChecks,
} from '../src/doctor/agora_doctor.js';
import {
  checkConsoleGate,
  checkHealth,
  checkTables,
  checkWebhookCsrf,
  checkWebhookSecret,
  csrfBlocksRoute,
  paymentsDoctorChecks,
} from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';

describe('payments.webhook-secret', () => {
  const stripe = { name: 'stripe', provider: 'stripe' };

  it('skips without gateways', () => {
    expect(checkWebhookSecret([], undefined, false).status).toBe('skip');
  });

  it('is ok when every signing gateway has a credential', () => {
    const result = checkWebhookSecret(
      [
        { ...stripe, webhookVerification: 'configured' },
        { name: 'efi', webhookVerification: 'unsupported' },
        { name: 'custom' },
      ],
      undefined,
      true,
    );
    expect(result.status).toBe('ok');
  });

  it('warns in dev and errors in production on a missing credential', () => {
    const drivers = [{ ...stripe, webhookVerification: 'unconfigured' as const }];
    const dev = checkWebhookSecret(drivers, undefined, false);
    expect(dev.status).toBe('warn');
    expect(dev.message).toContain('stripe');
    expect(checkWebhookSecret(drivers, undefined, true).status).toBe('error');
  });

  it('warns (never errors) on gateways the app accepts unverified', () => {
    const drivers = [
      { name: 'main', provider: 'stripe', webhookVerification: 'unconfigured' as const },
    ];
    expect(checkWebhookSecret(drivers, ['stripe'], true).status).toBe('warn');
    expect(checkWebhookSecret(drivers, ['main'], true).status).toBe('warn');
    expect(checkWebhookSecret(drivers, true, true).status).toBe('warn');
    expect(checkWebhookSecret(drivers, ['other'], true).status).toBe('error');
  });
});

describe('payments.webhook-csrf', () => {
  const payments = { providers: { asaas: undefined } };
  const shield = (csrf: object) => ({ csrf: { enabled: true, ...csrf } });

  it('skips without config and on a worker process', () => {
    expect(checkWebhookCsrf(undefined, undefined).status).toBe('skip');
    expect(checkWebhookCsrf({ billing: { role: 'worker' } }, shield({})).status).toBe('skip');
  });

  it('is ok when CSRF is off or POST is not checked', () => {
    expect(checkWebhookCsrf(payments, undefined).status).toBe('ok');
    expect(checkWebhookCsrf(payments, { csrf: { enabled: false } }).status).toBe('ok');
    expect(checkWebhookCsrf(payments, shield({ methods: ['PUT'] })).status).toBe('ok');
    // Shield validates every method when the list is empty.
    expect(checkWebhookCsrf(payments, shield({ methods: [] })).status).toBe('error');
  });

  it('reads an exceptRoutes array', () => {
    expect(
      checkWebhookCsrf(payments, shield({ exceptRoutes: ['/payments/webhook/:provider'] })).status,
    ).toBe('ok');
    // Shield matches the route pattern, never the URL.
    expect(
      checkWebhookCsrf(payments, shield({ exceptRoutes: ['/payments/webhook/asaas'] })).status,
    ).toBe('error');
    const blocked = checkWebhookCsrf(payments, shield({ exceptRoutes: ['/api/*'] }));
    expect(blocked.status).toBe('error');
    expect(blocked.fix).toContain('/payments/webhook/:provider');
    expect(checkWebhookCsrf(payments, shield({})).status).toBe('error');
  });

  it('probes an exceptRoutes function with the delivery url and the route pattern', () => {
    const seen: unknown[] = [];
    const byUrl = (ctx: { request: { url(): string } }) => {
      seen.push(ctx.request.url());
      return ctx.request.url().startsWith('/payments/webhook/');
    };
    expect(checkWebhookCsrf(payments, shield({ exceptRoutes: byUrl })).status).toBe('ok');
    expect(seen).toEqual(['/payments/webhook/asaas']);
    const byPattern = (ctx: { route: { pattern: string } }) =>
      ctx.route.pattern === '/payments/webhook/:provider';
    expect(checkWebhookCsrf(payments, shield({ exceptRoutes: byPattern })).status).toBe('ok');
    expect(checkWebhookCsrf(payments, shield({ exceptRoutes: () => false })).status).toBe('error');
  });

  it('warns when the function throws when the function throws', () => {
    const throws = () => {
      throw new Error('needs a full ctx');
    };
    expect(csrfBlocksRoute(shield({ exceptRoutes: throws }), '/x', '/x')).toBe('unknown');
    const result = checkWebhookCsrf(payments, shield({ exceptRoutes: throws }));
    expect(result.status).toBe('warn');
    expect(result.message).toContain('threw');
  });
});

describe('payments.console-gate', () => {
  it('skips without config, when disabled and when the provider is not mounted', () => {
    expect(checkConsoleGate(undefined, undefined, true).status).toBe('skip');
    expect(checkConsoleGate({ enabled: false }, undefined, true).status).toBe('skip');
    expect(checkConsoleGate({}, false, true).status).toBe('skip');
  });

  it('is ok with an authorize', () => {
    expect(checkConsoleGate({ authorize: () => true }, true, true).status).toBe('ok');
  });

  it('warns in dev and errors in production without one', () => {
    expect(checkConsoleGate({}, true, false).status).toBe('warn');
    expect(checkConsoleGate({}, undefined, true).status).toBe('error');
  });
});

describe('payments.tables', () => {
  const db = (present: readonly string[]) => ({
    connection: () => ({ schema: { hasTable: async (table: string) => present.includes(table) } }),
  });

  it('skips when billing is off, the store is custom, or Lucid is absent', async () => {
    expect((await checkTables({ billing: { enabled: false } }, db([]))).status).toBe('skip');
    expect(
      (await checkTables({ billing: { store: async () => ({}) as never } }, db([]))).status,
    ).toBe('skip');
    expect((await checkTables({}, undefined)).status).toBe('skip');
  });

  it('errors, rather than throwing, on a billing.connection that does not exist', async () => {
    const missing = {
      connection: () => {
        throw new Error(
          'E_UNMANAGED_DB_CONNECTION: Cannot connect to unregistered connection nope',
        );
      },
    } as never;
    const result = await checkTables({ billing: { connection: 'nope' } }, missing);
    expect(result.status).toBe('error');
    expect(result.message).toContain('"nope"');
  });

  it('is ok when every table exists', async () => {
    expect((await checkTables({}, db(BILLING_TABLES))).status).toBe('ok');
  });

  it('warns when missing tables are created on first use, errors when they are not', async () => {
    const some = db(['billing_customers']);
    const auto = await checkTables({}, some);
    expect(auto.status).toBe('warn');
    expect(auto.message).toContain('billing_payments');
    expect((await checkTables({ billing: { autoCreateSchema: false } }, some)).status).toBe(
      'error',
    );
  });
});

describe('payments.tables write probe (billing.schema)', () => {
  /** A pg-like connection whose zero-row INSERT probe behaves as `insert` says. */
  function schemaDb(
    insert: (sql: string, attempt: number) => void,
    catalog: readonly string[] = BILLING_TABLES,
  ) {
    const attempts = new Map<string, number>();
    const transactions: Array<{ rolledBack: boolean }> = [];
    const client = {
      dialect: { name: 'postgres' },
      schema: {
        hasTable: async () => true,
        withSchema: () => ({ hasTable: async () => true }),
      },
      rawQuery: async (sql: string) =>
        sql.includes('information_schema.tables')
          ? { rows: catalog.map((name) => ({ name })) }
          : sql.includes('information_schema')
            ? { rows: [{}] }
            : {},
      transaction: async () => {
        const trx = { rolledBack: false };
        transactions.push(trx);
        return {
          rawQuery: async (sql: string) => {
            const n = (attempts.get(sql) ?? 0) + 1;
            attempts.set(sql, n);
            insert(sql, n);
            return {};
          },
          rollback: async () => {
            trx.rolledBack = true;
          },
        };
      },
    };
    return { db: { connection: () => client } as never, transactions };
  }
  const config = { billing: { schema: 'billing' } };

  it('reads existence from the catalog of exactly this schema, not hasTable', async () => {
    // hasTable says yes for everything (the search path); the schema's catalog lacks one.
    const { db } = schemaDb(
      () => undefined,
      BILLING_TABLES.filter((t) => t !== 'billing_disputes'),
    );
    const result = await checkTables(config, db);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Missing billing_disputes in schema "billing"');
  });

  it('a table the INSERT cannot find is not reported as "cannot write"', async () => {
    const { db } = schemaDb((sql) => {
      if (sql.includes('billing_audit_events')) {
        throw Object.assign(new Error('relation "billing.billing_audit_events" does not exist'), {
          code: '42P01',
        });
      }
    });
    const result = await checkTables(config, db);
    expect(result.status).toBe('warn');
    expect(result.message).not.toContain('cannot write');
    expect(result.message).toContain('does not exist [42P01]');
  });

  it('probes each table in its own rolled-back transaction', async () => {
    const { db, transactions } = schemaDb(() => undefined);
    expect((await checkTables(config, db)).status).toBe('ok');
    expect(transactions.length).toBe(BILLING_TABLES.length);
    expect(transactions.every((t) => t.rolledBack)).toBe(true);
  });

  it('reports a privilege refusal as an error, with the database message and code', async () => {
    const { db } = schemaDb((sql) => {
      if (sql.includes('billing_payments')) {
        throw Object.assign(new Error('permission denied for table billing_payments'), {
          code: '42501',
        });
      }
    });
    const result = await checkTables(config, db);
    expect(result.status).toBe('error');
    expect(result.message).toContain(
      'billing_payments (permission denied for table billing_payments [42501])',
    );
  });

  it('retries a transient failure (concurrent doctors) instead of reporting no write access', async () => {
    const { db } = schemaDb((_sql, attempt) => {
      if (attempt === 1)
        throw Object.assign(new Error('too many clients already'), { code: '53300' });
    });
    expect((await checkTables(config, db)).status).toBe('ok');
  });

  it('a persistent non-privilege failure is a warning that shows the error, not "cannot write"', async () => {
    const { db } = schemaDb((sql) => {
      if (sql.includes('billing_disputes')) {
        throw Object.assign(new Error('could not obtain lock on relation'), { code: '55P03' });
      }
    });
    const result = await checkTables(config, db);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('could not obtain lock on relation [55P03]');
    expect(result.message).not.toContain('cannot write');
  });
});

describe('payments.health', () => {
  const report = (counts: number[]): BillingHealth => ({
    healthy: counts.every((count) => count === 0),
    checkedAt: new Date(),
    checks: counts.map((count, index) => ({
      key: 'stuck_webhooks',
      label: `problem ${index}`,
      count,
      healthy: count === 0,
      hint: '',
    })),
    failures: [],
    deadlines: [],
    openDisputes: [],
  });

  it('is ok on a healthy report and warns with the counts otherwise', () => {
    expect(checkHealth(report([0, 0])).status).toBe('ok');
    const result = checkHealth(report([0, 3, 2]));
    expect(result.status).toBe('warn');
    expect(result.message).toBe('3 problem 1; 2 problem 2');
  });
});

describe('registration', () => {
  const ids = [
    'payments.webhook-secret',
    'payments.webhook-csrf',
    'payments.console-gate',
    'payments.tables',
    'payments.health',
    'payments.tenant',
    'payments.console-commands',
    'payments.console-commands-key',
  ];

  it('exposes the frozen ids, deep ones marked', () => {
    const checks = paymentsDoctorChecks();
    expect(checks.map((check) => check.id)).toEqual(ids);
    expect(checks.filter((check) => check.cost === 'deep').map((check) => check.id)).toEqual([
      'payments.tables',
      'payments.health',
      'payments.console-commands-key',
    ]);
    expect(checks.every((check) => check.lib === 'payments')).toBe(true);
    expect(agoraDoctorChecks.map((check) => check.id)).toEqual(ids);
  });

  it('creates the registry when absent and skips duplicates', async () => {
    const bindings = new Map<string, unknown>();
    const container = {
      hasBinding: (key: string) => bindings.has(key),
      bindValue: (key: string, value: unknown) => void bindings.set(key, value),
      make: async (key: string) => bindings.get(key),
    };
    await registerDoctorChecks(container, paymentsDoctorChecks());
    await registerDoctorChecks(container, paymentsDoctorChecks());
    const registry = bindings.get(AGORA_DOCTOR_BINDING) as AgoraDoctorRegistry;
    expect(registry.version).toBe(1);
    expect(registry.checks.map((check) => check.id)).toEqual(ids);
  });

  it('ships agora:doctor and payments:doctor in the commands barrel', async () => {
    const names = (await loader.getMetaData()).map((meta) => meta.commandName);
    expect(names).toEqual(expect.arrayContaining(['agora:doctor', 'payments:doctor']));
  });
});
