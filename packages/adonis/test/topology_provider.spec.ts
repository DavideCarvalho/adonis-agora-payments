import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import PaymentsProvider from '../providers/payments_provider.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import type { PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { resetPayments, setWebhookDispatcher } from '../src/services/main.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import { memoryTenantLedger } from '../src/topology/ledger.js';
import type { HubTransport } from '../src/topology/transports.js';
import { sharedSecretVerifier } from '../src/topology/verify.js';
import type { WebhookEvent } from '../src/types.js';

afterEach(() => {
  resetPayments();
  setWebhookDispatcher(undefined);
});

type Handler = (ctx: HttpContext) => unknown;

/** An `ApplicationService` stand-in that records the routes the provider mounts. */
function fakeApp(config: PaymentsConfig) {
  const bindings = new Map<unknown, () => Promise<unknown> | unknown>();
  const routes = new Map<string, Handler>();
  const route = (method: string) => (path: string, handler: Handler) => {
    routes.set(`${method} ${path}`, handler);
    return { as: () => {} };
  };
  const router = { post: route('POST'), get: route('GET'), route: () => ({ as: () => {} }) };
  const app = {
    inTest: true,
    config: { get: () => config },
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
      make: async (token: unknown) => {
        if (token === 'router') return router;
        const factory = bindings.get(token);
        if (!factory) throw new Error(`nothing bound for ${String(token)}`);
        return factory();
      },
    },
  } as unknown as ApplicationService;
  return { app, routes };
}

/** Call a recorded route with a minimal HttpContext. */
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

describe('PaymentsProvider with topology control-plane + tenant', () => {
  it('a tenant charges through the Hub and its own handler runs on the forwarded webhook', async () => {
    const gateway = new FakePaymentsDriver({ provider: 'asaas' });
    const hubStore = new InMemoryBillingStore();
    const hub = fakeApp({
      topology: 'control-plane',
      controlPlane: {
        verifyTenant: sharedSecretVerifier({ partitions: { 'entre-textos': 'et-secret' } }),
        ledger: memoryTenantLedger(),
      },
      providers: { asaas: async () => gateway },
      billing: { store: () => hubStore, dispatcher: 'in-process' },
    });
    const hubProvider = new PaymentsProvider(hub.app);
    hubProvider.register();
    await hubProvider.boot();
    const rpc = hub.routes.get('POST /_payments/rpc');
    expect(rpc).toBeDefined();
    expect(hub.routes.has('POST /payments/webhook/:provider')).toBe(true);

    const transport: HubTransport = {
      name: 'in-process http',
      request: async (message) => (await call(rpc as Handler, message)).body as never,
    };
    const received: WebhookEvent[] = [];
    const tenantStore = new InMemoryBillingStore();
    const tenant = fakeApp({
      topology: 'tenant',
      tenant: {
        partition: 'entre-textos',
        token: 'et-secret',
        providers: ['asaas'],
        transport,
      },
      methods: { pix: 'asaas' },
      billing: {
        store: () => tenantStore,
        dispatcher: 'in-process',
        handlers: { 'payment.succeeded': (event) => void received.push(event) },
      },
    });
    const tenantProvider = new PaymentsProvider(tenant.app);
    tenantProvider.register();
    await tenantProvider.boot();
    // No gateway credentials, so no webhook route on the tenant.
    expect(tenant.routes.has('POST /payments/webhook/:provider')).toBe(false);

    const manager = (await tenant.app.container.make(PaymentsManager)) as PaymentsManager;
    const customer = await manager.hub().customer('sub_42', 'asaas', { name: 'Ana' });
    const payment = await manager
      .driver('pix')
      .charge({ amount: 4990, customerId: customer.id } as never);
    expect(gateway.chargeCalls[0]?.input).toMatchObject({ amount: 4990, method: 'pix' });

    // The gateway tells the Hub; the Hub processes it, then forwards it to the owning app.
    const hubDispatcher = (await hub.app.container.make(WebhookDispatcher)) as WebhookDispatcher;
    const event: WebhookEvent = {
      id: 'evt_paid',
      provider: 'asaas',
      type: 'payment.succeeded',
      data: {
        gatewayId: payment.gatewayId,
        customerId: customer.id,
        amount: 4990,
        currency: 'brl',
      },
      raw: { id: 'evt_paid' },
    };
    expect((await hubDispatcher.dispatchAll(event)).failures).toEqual([]);
    expect(await hubStore.findWebhookEventByGatewayEventId('evt_paid')).not.toBeNull();

    expect(await manager.hub().drain()).toBe(1);
    expect(received.map((e) => e.id)).toEqual(['evt_paid']);
    // Delivered once: the queue is empty and a second drain does nothing.
    expect(await manager.hub().drain()).toBe(0);
    expect(received).toHaveLength(1);
  });

  it('answers 401 to a refused token on the HTTP route', async () => {
    const hub = fakeApp({
      topology: 'control-plane',
      controlPlane: {
        verifyTenant: sharedSecretVerifier({ partitions: { a: 's' } }),
        ledger: memoryTenantLedger(),
        path: 'billing-hub/',
      },
      providers: { asaas: async () => new FakePaymentsDriver({ provider: 'asaas' }) },
      billing: { store: () => new InMemoryBillingStore(), dispatcher: 'in-process' },
    });
    const provider = new PaymentsProvider(hub.app);
    provider.register();
    await provider.boot();
    const rpc = hub.routes.get('POST /billing-hub/rpc') as Handler;
    const reply = await call(rpc, {
      v: 1,
      id: 'x',
      operation: 'whoami',
      token: 'nope',
      partition: 'a',
      issuedAt: Date.now(),
    });
    expect(reply.status).toBe(401);
  });

  it('refuses to boot a tenant that still builds gateway providers', () => {
    const tenant = fakeApp({
      topology: 'tenant',
      tenant: {
        partition: 'a',
        token: 's',
        providers: ['asaas'],
        url: 'http://hub.test/_payments',
      },
      providers: { asaas: async () => new FakePaymentsDriver() },
    });
    const provider = new PaymentsProvider(tenant.app);
    provider.register();
    return expect(tenant.app.container.make(PaymentsManager)).rejects.toThrow(/control plane/);
  });
});
