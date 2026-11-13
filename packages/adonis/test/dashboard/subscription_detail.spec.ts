import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DashboardProvider from '../../providers/dashboard_provider.js';
import { AUDIT_ACTIONS } from '../../src/billing/billing_store.js';
import { DEV_TOOLS_BINDING, type DevToolsLib } from '../../src/dashboard/dev_tools.js';
import { subscriptionDetail, subscriptions } from '../../src/dashboard/handlers.js';
import { resetBillingStore, setBillingStore } from '../../src/services/main.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

/**
 * `GET <api>/subscriptions/:id`: one subscription in full, by this store's id or the gateway's,
 * scoped to the viewer's organizations like every other read.
 */

const TENANCY = Symbol.for('@agora/context:tenancy');

async function seed(store: InMemoryBillingStore) {
  for (const owner of ['a', 'b']) {
    await store.saveCustomer({
      gatewayId: `cus_${owner}`,
      provider: 'fake',
      ownerType: 'organization',
      ownerId: owner,
      email: `${owner}@example.com`,
    });
    await store.saveSubscription({
      gatewayId: `sub_${owner}`,
      provider: 'fake',
      customerId: `cus_${owner}`,
      status: 'active',
      planId: 'pro',
      externalReference: `team-${owner}`,
    });
    await store.savePayment({
      gatewayId: `pay_${owner}`,
      provider: 'fake',
      status: 'paid',
      amount: 100,
      currency: 'BRL',
      customerId: `cus_${owner}`,
      subscriptionId: `sub_${owner}`,
    });
  }
  // A charge of the same customer for something else: not this subscription's.
  await store.savePayment({
    gatewayId: 'pay_one_off',
    provider: 'fake',
    status: 'paid',
    amount: 50,
    currency: 'BRL',
    customerId: 'cus_a',
  });
  await store.recordAuditEvent({
    action: 'subscription.canceled',
    actor: 'ana',
    subjectType: 'subscription',
    subjectId: 'sub_a',
  });
}

describe('subscriptionDetail (handler)', () => {
  it('answers the subscription, its customer, its payments and its audit rows', async () => {
    const store = new InMemoryBillingStore();
    await seed(store);
    const res = await subscriptionDetail(
      { store, currency: 'BRL' },
      { params: { id: 'sub_a' }, query: {} },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      subscription: { gatewayId: string; status: string; planId: string };
      customer: { gatewayId: string; email: string } | null;
      payments: Array<{ gatewayId: string; owner: { id: string } | null }>;
      audit: Array<{ action: string }>;
      events: { rows: unknown[] };
    };
    expect(body.subscription).toMatchObject({
      gatewayId: 'sub_a',
      status: 'active',
      planId: 'pro',
      externalReference: 'team-a',
    });
    expect(body.customer).toMatchObject({ gatewayId: 'cus_a', email: 'a@example.com' });
    expect(body.payments.map((p) => p.gatewayId)).toEqual(['pay_a']);
    expect(body.payments[0]?.owner?.id).toBe('a');
    expect(body.audit.map((a) => a.action)).toEqual(['subscription.canceled']);
    expect(body.events.rows).toEqual([]);
  });

  it('finds a managed subscription (no gateway id) by its own id', async () => {
    const store = new InMemoryBillingStore();
    await seed(store);
    const managed = await store.createManagedSubscription({
      provider: 'fake',
      customerId: 'cus_a',
      status: 'active',
      planId: 'basic',
      amount: 990,
      currency: 'BRL',
      cycle: 'monthly',
      currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
      nextChargeAt: new Date('2026-12-01T00:00:00Z'),
    });
    await store.savePayment({
      gatewayId: 'pay_managed',
      provider: 'fake',
      status: 'paid',
      amount: 990,
      currency: 'BRL',
      customerId: 'cus_a',
      subscriptionId: String(managed.id),
    });
    const res = await subscriptionDetail(
      { store, currency: 'BRL' },
      { params: { id: String(managed.id) }, query: {} },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      subscription: { managed: boolean; amount: number; cycle: string };
      payments: Array<{ gatewayId: string }>;
    };
    expect(body.subscription).toMatchObject({ managed: true, amount: 990, cycle: 'monthly' });
    expect(body.payments.map((p) => p.gatewayId)).toEqual(['pay_managed']);
  });

  it('answers 404 for an unknown id and 400 without one', async () => {
    const store = new InMemoryBillingStore();
    await seed(store);
    const missing = await subscriptionDetail(
      { store, currency: 'BRL' },
      { params: { id: 'sub_nope' }, query: {} },
    );
    expect(missing).toEqual({
      status: 404,
      body: { error: 'No subscription "sub_nope" is recorded locally.' },
    });
    expect(
      (await subscriptionDetail({ store, currency: 'BRL' }, { params: {}, query: {} })).status,
    ).toBe(400);
  });

  it('the list filters by customer', async () => {
    const store = new InMemoryBillingStore();
    await seed(store);
    const res = await subscriptions(
      { store, currency: 'BRL' },
      { params: {}, query: { filter: { customerId: 'cus_b' } } },
    );
    const rows = (res.body as { data: Array<{ gatewayId: string }> }).data;
    expect(rows.map((r) => r.gatewayId)).toEqual(['sub_b']);
  });
});

describe('GET <api>/subscriptions/:id with organizations on', () => {
  const als = new AsyncLocalStorage<{ tenant?: string }>();
  let store: InMemoryBillingStore;

  beforeEach(async () => {
    (globalThis as Record<symbol, unknown>)[TENANCY] = {
      version: 1,
      tenancy: () => ({ enabled: true, required: false }),
      tenantFilter() {
        const frame = als.getStore();
        if (!frame) return { mode: 'system' };
        return frame.tenant
          ? {
              mode: 'tenant',
              tenant: { id: frame.tenant, kind: 'organization', source: 'authkit' },
            }
          : { mode: 'tenantless' };
      },
      withTenant: <T>(_input: unknown, fn: () => T) => fn(),
      allTenants: <T>(fn: () => T) => fn(),
    };
    store = new InMemoryBillingStore();
    setBillingStore(store);
    await seed(store);
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[TENANCY];
    resetBillingStore();
  });

  function ctx(id: string, qs: Record<string, string> = {}) {
    const recorded: { status?: number; body?: unknown } = {};
    const response = {
      getHeader: () => undefined,
      status(code: number) {
        recorded.status = code;
        return this;
      },
      json(body: unknown) {
        recorded.body = body;
        return this;
      },
      header() {
        return this;
      },
      send: () => undefined,
      redirect: () => undefined,
    };
    return {
      recorded,
      ctx: {
        response,
        params: { id },
        request: {
          qs: () => qs,
          body: () => ({}),
          url: () => `/payments/api/subscriptions/${id}`,
          method: () => 'GET',
          header: () => undefined,
          headers: () => ({}),
        },
      },
    };
  }

  async function boot(authorize: () => unknown) {
    const routes = new Map<string, (ctx: unknown) => unknown>();
    const registered: DevToolsLib[] = [];
    const reg = (method: string) => (pattern: string, handler: (ctx: unknown) => unknown) => {
      routes.set(`${method} ${pattern}`, handler);
      return { as: () => undefined };
    };
    const router = { get: reg('get'), post: reg('post') };
    const hub = { version: 1, register: (lib: DevToolsLib) => void registered.push(lib) };
    const app = {
      inProduction: false,
      config: { get: (key: string) => (key === 'payments_dashboard' ? { authorize } : {}) },
      booted: async (callback: () => Promise<void>) => callback(),
      container: {
        hasBinding: (key: string) => key === DEV_TOOLS_BINDING,
        make: async (key: unknown) => {
          if (key === 'router') return router;
          if (key === DEV_TOOLS_BINDING) return hub;
          throw new Error(`not bound: ${String(key)}`);
        },
      },
    } as unknown as ApplicationService;
    await new DashboardProvider(app).boot();
    const route = routes.get('get /payments/api/subscriptions/:id');
    if (!route) throw new Error('route not registered');
    return { route, lib: registered[0] };
  }

  it("shows a viewer their own organization's subscription, with its audit rows", async () => {
    const { route } = await boot(() => true);
    const { ctx: c, recorded } = ctx('sub_a');
    await als.run({ tenant: 'a' }, () => route(c));
    expect(recorded.status).toBe(200);
    expect((recorded.body as { audit: unknown[] }).audit).toHaveLength(1);
  });

  it("answers 404 for another organization's subscription, by gateway id or own id", async () => {
    const { route } = await boot(() => true);
    const other = ctx('sub_b');
    await als.run({ tenant: 'a' }, () => route(other.ctx));
    expect(other.recorded.status).toBe(404);
    const [row] = await store.listSubscriptions({ gatewayId: 'sub_b' });
    const byId = ctx(String(row?.id));
    await als.run({ tenant: 'a' }, () => route(byId.ctx));
    expect(byId.recorded.status).toBe(404);
  });

  it('a pick outside the grant reads as not found and is audited', async () => {
    const { route } = await boot(() => ({ allowed: true, tenants: ['a'] }));
    const forged = ctx('sub_b', { tenant: 'b' });
    await als.run({}, () => route(forged.ctx));
    expect(forged.recorded.status).toBe(404);
    const audit = await store.listAuditEvents({ action: AUDIT_ACTIONS.tenantForged });
    expect(audit.map((r) => r.subjectId)).toEqual(['b']);
  });

  it('the MCP tool answers the same, scoped the same', async () => {
    const { lib } = await boot(() => true);
    const tool = lib?.tools.find((t) => t.name === 'payments_get_subscription');
    if (!tool) throw new Error('tool not registered');
    const own = ctx('x');
    const call = {
      ctx: own.ctx as never,
      caller: { id: 'dev-open', via: 'open' as const },
      limits: { maxRows: 100, maxBytes: 48_000 },
    };
    const out = (await als.run({ tenant: 'a' }, async () => {
      await lib?.authorize(own.ctx as never);
      return tool.run({ id: 'sub_a' }, call);
    })) as { subscription: { gatewayId: string } };
    expect(out.subscription.gatewayId).toBe('sub_a');
    await expect(als.run({ tenant: 'a' }, () => tool.run({ id: 'sub_b' }, call))).rejects.toThrow(
      /^404/,
    );
  });
});
