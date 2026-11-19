import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import DashboardProvider from '../../providers/dashboard_provider.js';
import { resolvePaymentsTenancy } from '../../src/agora/tenancy.js';
import { consoleCapabilities, createConsoleActions } from '../../src/dashboard/api_core.js';
import type { PaymentsDashboardConfig } from '../../src/dashboard/define_config.js';
import type { PaymentsDriver } from '../../src/driver.js';
import { answerPaymentsConsoleCommands } from '../../src/federation/console.js';
import { memoryIdempotencyStore } from '../../src/federation/idempotency.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';
import { RedisBus } from '../federation/redis_bus.js';

/**
 * The Hub's console routes with `apps`: `GET /api/apps`, `?app=` on the real query string, the
 * `apps` grant, and an action's capability and `Idempotency-Key`.
 */

interface Route {
  method: 'get' | 'post';
  pattern: string;
  handler: (ctx: unknown) => Promise<unknown>;
}

interface Recorded {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function fakeCtx(
  recorded: Recorded,
  input: {
    qs?: Record<string, unknown>;
    params?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
    user?: Record<string, unknown>;
  } = {},
) {
  return {
    ...(input.user ? { auth: { user: input.user } } : {}),
    params: input.params ?? {},
    response: {
      getHeader: (name: string) => recorded.headers[name.toLowerCase()],
      status(code: number) {
        recorded.status = code;
        return this;
      },
      json(body: unknown) {
        recorded.body = body;
        return this;
      },
      header(name: string, value: string) {
        recorded.headers[name.toLowerCase()] = value;
        return this;
      },
      send(body: unknown) {
        recorded.body = body;
      },
    },
    request: {
      qs: () => input.qs ?? {},
      body: () => input.body ?? {},
      url: () => '/payments/api',
      method: () => 'GET',
      header: (name: string) => input.headers?.[name.toLowerCase()],
      headers: () => input.headers ?? {},
    },
  };
}

describe('federated console routes', () => {
  const bus = new RedisBus();
  const etStore = new InMemoryBillingStore();
  const refunds: string[] = [];
  let routes: Route[] = [];
  let owning: RedisConsoleChannel;
  let provider: DashboardProvider;

  const call = async (
    method: 'get' | 'post',
    pattern: string,
    input: Parameters<typeof fakeCtx>[1] = {},
  ) => {
    const route = routes.find((r) => r.method === method && r.pattern === pattern);
    if (!route) throw new Error(`no route ${method} ${pattern}`);
    const recorded: Recorded = { headers: {} };
    await route.handler(fakeCtx(recorded, input));
    return recorded;
  };

  beforeAll(async () => {
    await etStore.saveCustomer({
      gatewayId: 'cus_1',
      provider: 'stripe',
      taxId: '12.345.678/0001-90',
      email: 'finance@example.com',
    });
    await etStore.savePayment({
      gatewayId: 'pay_1',
      provider: 'stripe',
      status: 'paid',
      amount: 1000,
      currency: 'BRL',
      customerId: 'cus_1',
    });
    const drivers = new Map<string, PaymentsDriver>([
      [
        'stripe',
        {
          provider: 'stripe',
          capabilities: { refunds: true },
          async refund(gatewayId: string) {
            refunds.push(gatewayId);
            return {
              gatewayId: 're_1',
              provider: 'stripe',
              amount: { amount: 1000, currency: 'BRL' },
              status: 'pending',
              createdAt: new Date().toISOString(),
            };
          },
        } as unknown as PaymentsDriver,
      ],
    ]);
    owning = await answerPaymentsConsoleCommands({
      client: bus.connection(),
      prefix: 'et',
      actions: new Set(['refund']),
      idempotency: memoryIdempotencyStore(),
      runtime: {
        currency: 'BRL',
        store: () => etStore,
        capabilities: async () => consoleCapabilities(drivers),
        actions: async (store) =>
          createConsoleActions({
            manager: { driver: (name) => drivers.get(name) as never },
            store,
            tenancy: () => resolvePaymentsTenancy(undefined),
          }),
      },
    });

    const config: PaymentsDashboardConfig = {
      appLabel: 'Hub',
      authorize: (ctx) => {
        const user = (ctx as unknown as { auth?: { user?: { role?: string } } }).auth?.user;
        if (user?.role === 'admin') {
          return { allowed: true, apps: '*', capabilities: ['payments:refund'] };
        }
        if (user?.role === 'viewer') return { allowed: true, apps: ['et'] };
        return { allowed: true, apps: [] };
      },
      apps: {
        et: {
          label: 'Entre Textos',
          store: etStore,
          controlPlane: new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }),
        },
        other: {
          store: new InMemoryBillingStore(),
          controlPlane: { prefix: 'other' },
          actions: false,
        },
      },
    };
    routes = [];
    const register = (method: 'get' | 'post') => (pattern: string, handler: Route['handler']) => {
      routes.push({ method, pattern, handler });
      return { as: () => undefined };
    };
    const router = { get: register('get'), post: register('post') };
    const app = {
      config: { get: (key: string) => (key === 'payments_dashboard' ? config : {}) },
      booted: async (callback: () => Promise<void>) => callback(),
      container: { make: async () => router },
      inProduction: false,
    } as unknown as ApplicationService;
    provider = new DashboardProvider(app);
    await provider.boot();
  });

  afterAll(async () => {
    await provider.shutdown();
    await owning.close();
  });

  it('GET /api/apps lists the apps the viewer is granted', async () => {
    const admin = await call('get', '/payments/api/apps', { user: { role: 'admin' } });
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({
      local: { label: 'Hub' },
      apps: [
        { id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' },
        { id: 'other', label: 'other', mode: 'federated', actions: 'none' },
      ],
      selected: null,
    });
    const viewer = await call('get', '/payments/api/apps', {
      user: { role: 'viewer' },
      qs: { app: 'et' },
    });
    expect((viewer.body as { apps: unknown[] }).apps).toHaveLength(1);
    expect((viewer.body as { selected: string }).selected).toBe('et');
    const nobody = await call('get', '/payments/api/apps', {});
    expect((nobody.body as { apps: unknown[] }).apps).toHaveLength(0);
  });

  it('?app= reads the federated app, masked', async () => {
    const page = await call('get', '/payments/api/customers', {
      user: { role: 'viewer' },
      qs: { app: 'et' },
    });
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    const [row] = (page.body as { data: Array<{ taxId: string }> }).data;
    expect(row?.taxId).toBe('12.345.678/****-**');
  });

  it('?app= outside the grant is 403', async () => {
    const page = await call('get', '/payments/api/payments', { qs: { app: 'et' } });
    expect(page.status).toBe(403);
  });

  it('an action needs the capability and an Idempotency-Key, then runs in the app', async () => {
    const viewer = await call('post', '/payments/api/payments/:gatewayId/refund', {
      user: { role: 'viewer' },
      qs: { app: 'et' },
      params: { gatewayId: 'pay_1' },
      headers: { 'idempotency-key': 'console-key-0001' },
    });
    expect(viewer.status).toBe(403);
    const noKey = await call('post', '/payments/api/payments/:gatewayId/refund', {
      user: { role: 'admin', email: 'ops@hub.example' },
      qs: { app: 'et' },
      params: { gatewayId: 'pay_1' },
    });
    expect(noKey.status).toBe(400);
    expect(refunds).toHaveLength(0);

    const input = {
      user: { role: 'admin', email: 'ops@hub.example' },
      qs: { app: 'et' },
      params: { gatewayId: 'pay_1' },
      headers: { 'idempotency-key': 'console-key-0002' },
    };
    const done = await call('post', '/payments/api/payments/:gatewayId/refund', input);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const again = await call('post', '/payments/api/payments/:gatewayId/refund', input);
    expect(again.body).toEqual(done.body);
    expect(refunds).toEqual(['pay_1']);
    const [audit] = await etStore.listAuditEvents({ action: 'payment.refunded' });
    expect(audit?.actor).toBe('ops@hub.example (via Hub)');
  });

  it('a browse-only app refuses actions', async () => {
    const answer = await call('post', '/payments/api/payments/:gatewayId/refund', {
      user: { role: 'admin' },
      qs: { app: 'other' },
      params: { gatewayId: 'pay_1' },
      headers: { 'idempotency-key': 'console-key-0003' },
    });
    expect(answer.status).toBe(403);
  });
});
