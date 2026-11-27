import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PaymentsProvider from '../providers/payments_provider.js';
import type { PaymentsConfig } from '../src/define_config.js';
import { checkTenant } from '../src/doctor/checks.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { resetPayments, setWebhookDispatcher } from '../src/services/main.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import { resolvePaymentsTenant } from '../src/topology/authkit_tenant.js';
import { memoryTenantLedger } from '../src/topology/ledger.js';
import type { HubTransport } from '../src/topology/transports.js';
import { sharedSecretVerifier } from '../src/topology/verify.js';

afterEach(() => {
  resetPayments();
  setWebhookDispatcher(undefined);
  vi.unstubAllGlobals();
});

type Handler = (ctx: HttpContext) => unknown;

/** A fake `authkit.client` binding: authkit-client 1.1's `tenantOf`, by shape. */
function fakeAuthkit(partition = 'shop') {
  const resources: string[] = [];
  const client = {
    tenantOf(resource: string) {
      resources.push(resource);
      return {
        url: Object.assign(async () => 'http://hub.test/_payments', {
          refresh: async () => 'http://hub.test/_payments',
        }),
        token: Object.assign(async () => `auto-token-for-${resource}`, { reset() {} }),
        partition,
      };
    },
  };
  return { client, resources };
}

function containerWith(binding: unknown) {
  return {
    hasBinding: (key: string) => key === 'authkit.client' && binding !== undefined,
    make: async () => binding,
  };
}

/** An `ApplicationService` stand-in that records routes, with optional extra bindings. */
function fakeApp(
  config: PaymentsConfig,
  extra: Record<string, unknown> = {},
  environment = 'test',
) {
  const bindings = new Map<unknown, () => Promise<unknown> | unknown>();
  for (const [key, value] of Object.entries(extra)) bindings.set(key, () => value);
  const routes = new Map<string, Handler>();
  const route = (method: string) => (path: string, handler: Handler) => {
    routes.set(`${method} ${path}`, handler);
    return { as: () => {} };
  };
  const router = { post: route('POST'), get: route('GET'), route: () => ({ as: () => {} }) };
  const warnings: string[] = [];
  const app = {
    inTest: true,
    getEnvironment: () => environment,
    config: { get: (key: string, fallback: unknown) => (key === 'payments' ? config : fallback) },
    booted: async (callback: () => Promise<void>) => callback(),
    makePath: (...parts: string[]) => `/nonexistent/${parts.join('/')}`,
    container: {
      singleton: (token: unknown, factory: () => unknown) => {
        let built: { value: unknown } | undefined;
        bindings.set(token, async () => {
          if (!built) built = { value: await factory() };
          return built.value;
        });
      },
      bindValue: (token: unknown, value: unknown) => bindings.set(token, () => value),
      alias: (alias: unknown, target: unknown) =>
        bindings.set(alias, () => (bindings.get(target) as () => unknown)()),
      hasBinding: (token: unknown) => bindings.has(token),
      make: async (token: unknown) => {
        if (token === 'router') return router;
        if (token === 'logger') return { warn: (line: string) => warnings.push(line) };
        const factory = bindings.get(token);
        if (!factory) throw new Error(`nothing bound for ${String(token)}`);
        return factory();
      },
    },
  } as unknown as ApplicationService;
  return { app, routes, warnings };
}

async function call(handler: Handler, body: unknown): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let sent: unknown;
  const response = {
    header: () => response,
    status: (code: number) => {
      status = code;
      return response;
    },
    json: (value: unknown) => {
      sent = value;
      return value;
    },
  };
  await handler({ request: { body: () => body }, response } as unknown as HttpContext);
  return { status, body: sent };
}

describe('a payments tenant with @adonis-agora/authkit-client', () => {
  it('charges through the control plane with url, token and partition from tenantOf', async () => {
    const gateway = new FakePaymentsDriver({ provider: 'asaas' });
    const hub = fakeApp({
      topology: 'control-plane',
      controlPlane: {
        verifyTenant: sharedSecretVerifier({
          partitions: { shop: 'auto-token-for-urn:agora:payments' },
        }),
        ledger: memoryTenantLedger(),
      },
      providers: { asaas: async () => gateway },
      billing: { store: () => new InMemoryBillingStore(), dispatcher: 'in-process' },
    });
    const hubProvider = new PaymentsProvider(hub.app);
    hubProvider.register();
    await hubProvider.boot();
    const rpc = hub.routes.get('POST /_payments/rpc') as Handler;
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      urls.push(url);
      const reply = await call(rpc, JSON.parse(String(init.body)));
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });

    const authkit = fakeAuthkit();
    const tenant = fakeApp(
      {
        topology: 'tenant',
        tenant: { providers: ['asaas'] },
        methods: { pix: 'asaas' },
        billing: { store: () => new InMemoryBillingStore(), dispatcher: 'in-process' },
      },
      { 'authkit.client': authkit.client },
    );
    const provider = new PaymentsProvider(tenant.app);
    provider.register();
    await provider.boot();
    const manager = (await tenant.app.container.make(PaymentsManager)) as PaymentsManager;
    const customer = await manager.hub().customer('sub_1', 'asaas', { name: 'Ana' });
    await manager.driver('pix').charge({ amount: 100, customerId: customer.id } as never);

    expect(gateway.chargeCalls[0]?.input).toMatchObject({ amount: 100 });
    expect(urls[0]).toBe('http://hub.test/_payments/rpc');
    expect(authkit.resources).toEqual(['urn:agora:payments']);
    await provider.shutdown?.();
    await hubProvider.shutdown?.();
  });

  it('an explicit field wins, field by field, and providers/transport stay as they are', async () => {
    const transport: HubTransport = { name: 'mine', request: async () => ({}) as never };
    const { config, sources } = await resolvePaymentsTenant(
      {
        topology: 'tenant',
        tenant: { partition: 'acme', providers: ['asaas'], transport },
      } as PaymentsConfig,
      containerWith(fakeAuthkit().client),
    );
    expect(config.tenant?.partition).toBe('acme');
    expect(config.tenant?.transport).toBe(transport);
    expect(config.tenant?.providers).toEqual(['asaas']);
    // With its own transport, no HTTP url is added behind its back.
    expect(config.tenant?.url).toBeUndefined();
    expect(typeof config.tenant?.token).toBe('function');
    expect(sources).toEqual({ token: 'authkit-client (auto)', partition: 'explicit' });

    const explicitUrl = await resolvePaymentsTenant(
      {
        topology: 'tenant',
        tenant: { url: 'https://mine.test/_payments', providers: ['asaas'] },
      } as PaymentsConfig,
      containerWith(fakeAuthkit().client),
    );
    expect(explicitUrl.config.tenant?.url).toBe('https://mine.test/_payments');
    expect(explicitUrl.config.tenant?.partition).toBe('shop');
  });

  it('never calls tenantOf when every field is explicit', async () => {
    const authkit = fakeAuthkit();
    await resolvePaymentsTenant(
      {
        topology: 'tenant',
        tenant: { url: 'https://x.test', partition: 'a', token: 't', providers: ['asaas'] },
      },
      containerWith(authkit.client),
    );
    expect(authkit.resources).toEqual([]);
  });

  it('`tenant.auto: false` turns the detection off', async () => {
    await expect(
      resolvePaymentsTenant(
        { topology: 'tenant', tenant: { auto: false, providers: ['asaas'] } },
        containerWith(fakeAuthkit().client),
      ),
    ).rejects.toThrow(/`tenant.auto` is false/);
  });

  it('without the binding and without the fields: a web boot fails naming both fixes', async () => {
    const { app } = fakeApp(
      { topology: 'tenant', tenant: { providers: ['asaas'] }, billing: { enabled: false } },
      {},
      'web',
    );
    const provider = new PaymentsProvider(app);
    provider.register();
    await expect(provider.boot()).rejects.toThrow(
      "[@adonis-agora/payments] topology 'tenant' needs tenant.url, tenant.token, tenant.partition. Fix: configure @adonis-agora/authkit-client's `service: { name, clientId, clientSecret }` (config/authkit_client.ts), which supplies them for urn:agora:payments, or set `tenant: { url, token, partition, providers }` in config/payments.ts.",
    );
  });

  it('an ace command (console environment) logs it instead of failing its boot', async () => {
    const { app, warnings } = fakeApp(
      { topology: 'tenant', tenant: { providers: ['asaas'] }, billing: { enabled: false } },
      {},
      'console',
    );
    const provider = new PaymentsProvider(app);
    provider.register();
    await expect(provider.boot()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warnings.join('\n')).toMatch(/needs tenant\.url/));
  });

  it('a binding without tenantOf (an older authkit-client) counts as absent', async () => {
    await expect(
      resolvePaymentsTenant(
        { topology: 'tenant', tenant: { providers: ['asaas'], partition: 'a' } },
        containerWith({ appCallTokens: () => undefined }),
      ),
    ).rejects.toThrow(/needs tenant\.url, tenant\.token\. Fix:/);
  });
});

describe('agora:doctor payments.tenant', () => {
  it('says where each field came from', async () => {
    expect(await checkTenant({}, containerWith(undefined))).toMatchObject({ status: 'skip' });
    expect(
      await checkTenant(
        { topology: 'tenant', tenant: { providers: ['asaas'] } },
        containerWith(fakeAuthkit().client),
      ),
    ).toEqual({ status: 'ok', message: 'tenant url/token/partition: authkit-client (auto).' });
    expect(
      await checkTenant(
        {
          topology: 'tenant',
          tenant: { providers: ['asaas'], url: 'https://hub.example/_payments', token: 't' },
        },
        containerWith(fakeAuthkit().client),
      ),
    ).toEqual({
      status: 'ok',
      message: 'tenant url/token: explicit; partition: authkit-client (auto).',
    });
    const none = await checkTenant(
      { topology: 'tenant', tenant: { providers: ['asaas'] } },
      containerWith(undefined),
    );
    expect(none).toMatchObject({
      status: 'error',
      message:
        "[@adonis-agora/payments] topology 'tenant' needs tenant.url, tenant.token, tenant.partition.",
    });
    expect(none.fix).toContain("configure @adonis-agora/authkit-client's `service:");
    const noProviders = await checkTenant(
      { topology: 'tenant' },
      containerWith(fakeAuthkit().client),
    );
    expect(noProviders).toMatchObject({
      status: 'error',
      message: expect.stringContaining('tenant.providers'),
    });
  });
});
