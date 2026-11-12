import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DashboardProvider from '../providers/dashboard_provider.js';
import {
  currentTenantFilter,
  resolvePaymentsTenancy,
  type TenantRef,
} from '../src/agora/tenancy.js';
import { AUDIT_ACTIONS } from '../src/billing/billing_store.js';
import { ownerScopeOfFilter } from '../src/billing/owner_scope.js';
import { OwnerScopingUnsupportedError, scopedBillingStore } from '../src/billing/scoped_store.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { normalizeConsoleAuthorizeResult } from '../src/dashboard/console_authorize.js';
import { resolveConsoleTenantScope } from '../src/dashboard/tenant_scope.js';
import { ensureCustomer } from '../src/ensure_customer.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { resetBillingStore, resetPayments, setBillingStore } from '../src/services/main.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

const TENANCY = Symbol.for('@agora/context:tenancy');
const ACCESSOR = Symbol.for('@agora/context:accessor');

interface Frame {
  tenant?: TenantRef;
  all?: boolean;
  userId?: string;
}

/**
 * A stand-in for `@adonis-agora/context`'s tenancy slot (version 1): the same four filter modes,
 * the same kind walk up a chain, `withTenant` and `allTenants`, over its own AsyncLocalStorage.
 */
function installContext(options: { enabled: boolean; kinds?: string[]; required?: boolean }) {
  const als = new AsyncLocalStorage<Frame>();
  const slot = {
    version: 1 as const,
    tenancy: () => ({
      enabled: options.enabled,
      required: options.required === true,
      ...(options.kinds ? { kinds: options.kinds } : {}),
    }),
    tenantFilter(filter?: { kinds?: string[]; required?: boolean }) {
      const frame = als.getStore();
      if (!frame) return { mode: 'system' as const };
      if (frame.all) return { mode: 'all' as const };
      const kinds = filter?.kinds ?? options.kinds;
      const tenant = frame.tenant;
      if (tenant) {
        const chain = tenant.chain ?? [tenant];
        for (let i = chain.length - 1; i >= 0; i--) {
          const level = chain[i]!;
          if (kinds === undefined || kinds.includes(level.kind)) {
            return {
              mode: 'tenant' as const,
              tenant: { ...level, source: tenant.source },
              chain: chain.slice(0, i + 1),
            };
          }
        }
      }
      if (filter?.required ?? (options.enabled && options.required)) {
        throw Object.assign(new Error('E_TENANT_REQUIRED'), { code: 'E_TENANT_REQUIRED' });
      }
      return { mode: 'tenantless' as const };
    },
    withTenant<T>(input: Record<string, unknown> | null, fn: () => T): T {
      const tenant =
        input === null
          ? undefined
          : ({ ...input, id: String(input.id), source: input.source ?? 'app' } as TenantRef);
      return als.run({ ...(als.getStore() ?? {}), all: false, tenant }, fn);
    },
    allTenants<T>(fn: () => T): T {
      return als.run({ ...(als.getStore() ?? {}), all: true }, fn);
    },
    tenantLabels: async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, `Org ${id.toUpperCase()}`])),
  };
  const globals = globalThis as Record<symbol, unknown>;
  globals[TENANCY] = slot;
  globals[ACCESSOR] = {
    userRef: () => {
      const id = als.getStore()?.userId;
      return id ? { type: 'user', id } : undefined;
    },
  };
  return {
    slot,
    /** Run `fn` as a request with this tenant (or none) and signed-in user. */
    as<T>(frame: Frame, fn: () => T): T {
      return als.run(frame, fn);
    },
    current: () => als.getStore(),
  };
}

function org(id: string): TenantRef {
  return { id, kind: 'organization', source: 'authkit' };
}

afterEach(() => {
  const globals = globalThis as Record<symbol, unknown>;
  delete globals[TENANCY];
  delete globals[ACCESSOR];
  resetPayments();
  resetBillingStore();
});

describe('resolvePaymentsTenancy', () => {
  it('is off without context, whatever the option says', () => {
    expect(resolvePaymentsTenancy('inherit').enabled).toBe(false);
    expect(resolvePaymentsTenancy({ enabled: true }).enabled).toBe(false);
  });

  it("follows context's switch by default ('inherit')", () => {
    installContext({ enabled: false });
    expect(resolvePaymentsTenancy(undefined).enabled).toBe(false);
    installContext({ enabled: true, kinds: ['organization'] });
    const resolved = resolvePaymentsTenancy(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.kinds).toEqual(['organization']);
    expect(resolved.ownerKinds).toEqual({ organization: 'organization' });
  });

  it('`false` opts payments out even when context enables tenancy', () => {
    installContext({ enabled: true });
    expect(resolvePaymentsTenancy(false).enabled).toBe(false);
  });

  it('derives the owner type map from a string `ownerType`', () => {
    installContext({ enabled: true, kinds: ['organization'] });
    const resolved = resolvePaymentsTenancy({ ownerType: 'Organization' });
    expect(resolved.ownerType(org('a'))).toBe('Organization');
    expect(resolved.ownerKinds).toEqual({ Organization: 'organization' });
  });

  it('reads a tenant of another kind as no tenant', () => {
    const context = installContext({ enabled: true });
    const tenancy = resolvePaymentsTenancy({ kinds: ['organization'] });
    context.as({ tenant: { id: 'u1', kind: 'user', source: 'personal' } }, () => {
      expect(currentTenantFilter(tenancy)).toEqual({ mode: 'tenantless' });
    });
  });

  it('scopes by the configured level of a nested tenant', () => {
    const context = installContext({ enabled: true });
    const tenancy = resolvePaymentsTenancy({ kinds: ['clinic'] });
    const unit: TenantRef = {
      id: 'unit-1',
      kind: 'unit',
      source: 'app',
      chain: [
        { id: 'clinic-1', kind: 'clinic' },
        { id: 'unit-1', kind: 'unit' },
      ],
    };
    context.as({ tenant: unit }, () => {
      const filter = currentTenantFilter(tenancy);
      expect(filter.mode).toBe('tenant');
      expect(filter.mode === 'tenant' && filter.tenant.id).toBe('clinic-1');
    });
  });
});

describe('ensureCustomer with tenancy', () => {
  let store: InMemoryBillingStore;
  let driver: FakePaymentsDriver;
  beforeEach(() => {
    store = new InMemoryBillingStore();
    driver = new FakePaymentsDriver();
  });

  it('records the active organization as the owner when none is passed', async () => {
    const context = installContext({ enabled: true });
    const customer = await context.as({ tenant: org('acme') }, () =>
      ensureCustomer(driver, null, { name: 'Acme' }, { store }),
    );
    const row = await store.findCustomerByGatewayId(customer.id);
    expect(row).toMatchObject({ ownerType: 'organization', ownerId: 'acme' });
  });

  it('an explicit owner always wins', async () => {
    const context = installContext({ enabled: true });
    const customer = await context.as({ tenant: org('acme') }, () =>
      ensureCustomer(driver, null, { name: 'Ana' }, { store, owner: { type: 'User', id: 7 } }),
    );
    expect(await store.findCustomerByGatewayId(customer.id)).toMatchObject({
      ownerType: 'User',
      ownerId: '7',
    });
  });

  it('records no owner with tenancy off (unchanged)', async () => {
    const context = installContext({ enabled: false });
    const customer = await context.as({ tenant: org('acme') }, () =>
      ensureCustomer(driver, null, { name: 'Acme' }, { store }),
    );
    expect(await store.findCustomerByGatewayId(customer.id)).toMatchObject({
      ownerType: null,
      ownerId: null,
    });
  });

  it('with `required`, refuses before creating anything at the gateway', async () => {
    const context = installContext({ enabled: true });
    await expect(
      context.as({}, () =>
        ensureCustomer(driver, null, { name: 'x' }, { store, tenancy: { required: true } }),
      ),
    ).rejects.toThrow('E_TENANT_REQUIRED');
    expect(driver.createCustomerCalls).toHaveLength(0);
  });
});

describe('payments.currentCustomer() and usage', () => {
  let store: InMemoryBillingStore;
  let manager: PaymentsManager;
  beforeEach(async () => {
    store = new InMemoryBillingStore();
    manager = new PaymentsManager({
      drivers: new Map([['fake', new FakePaymentsDriver()]]),
      store: () => store,
    });
    await store.saveCustomer({
      gatewayId: 'cus_org',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'acme',
    });
    await store.saveCustomer({
      gatewayId: 'cus_user',
      provider: 'fake',
      ownerType: 'User',
      ownerId: '42',
    });
  });

  it('is the active organization’s customer', async () => {
    const context = installContext({ enabled: true });
    const customer = await context.as({ tenant: org('acme'), userId: '42' }, () =>
      manager.currentCustomer(),
    );
    expect(customer?.gatewayId).toBe('cus_org');
  });

  it('is the signed-in user’s customer outside an organization', async () => {
    const context = installContext({ enabled: true });
    expect((await context.as({ userId: '42' }, () => manager.currentCustomer()))?.gatewayId).toBe(
      'cus_user',
    );
    // `ctx.auth.user` works too, with or without context.
    expect(
      (await manager.currentCustomer({ ctx: { auth: { user: { id: 42 } } } }))?.gatewayId,
    ).toBe('cus_user');
  });

  it('is null for an organization with no customer (never the user’s)', async () => {
    const context = installContext({ enabled: true });
    expect(
      await context.as({ tenant: org('globex'), userId: '42' }, () => manager.currentCustomer()),
    ).toBeNull();
  });

  it('usage with no customerId is the current customer’s', async () => {
    const context = installContext({ enabled: true });
    await context.as({ tenant: org('acme') }, async () => {
      await manager.usage().record({ meter: 'ai', quantity: 3 });
      expect(await manager.usage().total({ meter: 'ai' })).toBe(3);
    });
    expect(await store.usageReport({ customerId: 'cus_org' })).toEqual([
      { meter: 'ai', quantity: 3 },
    ]);
    // Another organization does not see it.
    await context.as({ tenant: org('globex') }, async () => {
      await expect(manager.usage().total({ meter: 'ai' })).rejects.toThrow('No current customer');
    });
  });

  it('usage with no customer anywhere throws rather than record unattributed usage', async () => {
    const context = installContext({ enabled: true });
    await expect(
      context.as({ tenant: org('globex') }, () =>
        manager.usage().record({ meter: 'ai', quantity: 1 }),
      ),
    ).rejects.toThrow('No current customer');
    // …but a scoped record (a project) stays valid, as before.
    await context.as({ tenant: org('globex') }, () =>
      manager.usage().record({ meter: 'ai', quantity: 1, scope: { type: 'project', id: 'p' } }),
    );
  });

  it('usage is unchanged with tenancy off', async () => {
    const context = installContext({ enabled: false });
    await context.as({ tenant: org('acme') }, () =>
      manager.usage().record({ meter: 'ai', quantity: 2 }),
    );
    expect(await store.usageReport({ customerId: 'cus_org' })).toEqual([]);
    expect(await manager.usage().total({ meter: 'ai' })).toBe(2);
  });
});

describe('the §4 matching rule (scoped store)', () => {
  let store: InMemoryBillingStore;
  beforeEach(async () => {
    store = new InMemoryBillingStore();
    await store.saveCustomer({
      gatewayId: 'cus_a',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'a',
    });
    await store.saveCustomer({
      gatewayId: 'cus_b',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'b',
    });
    await store.saveCustomer({
      gatewayId: 'cus_u',
      provider: 'fake',
      ownerType: 'User',
      ownerId: '1',
    });
    for (const [gatewayId, customerId] of [
      ['pay_a', 'cus_a'],
      ['pay_b', 'cus_b'],
      ['pay_u', 'cus_u'],
      ['pay_none', null],
    ] as const) {
      await store.savePayment({
        gatewayId,
        provider: 'fake',
        status: 'paid',
        amount: 1000,
        currency: 'BRL',
        customerId,
        paidAt: new Date(),
      });
    }
  });

  const ids = async (s: InMemoryBillingStore) =>
    (await s.listPayments({})).map((row) => row.gatewayId).sort();

  it('a tenant sees its rows only; other tenants and rows of none are not found', async () => {
    const context = installContext({ enabled: true });
    const tenancy = resolvePaymentsTenancy(undefined);
    await context.as({ tenant: org('a') }, async () => {
      const scoped = scopedBillingStore(
        store,
        ownerScopeOfFilter(tenancy, currentTenantFilter(tenancy)),
      );
      expect(await ids(scoped)).toEqual(['pay_a']);
      expect(await scoped.findPaymentByGatewayId('pay_b')).toBeNull();
      expect(await scoped.findPaymentByGatewayId('pay_none')).toBeNull();
      expect(await scoped.revenue({})).toBe(1000);
      expect((await scoped.listCustomers({})).map((c) => c.gatewayId)).toEqual(['cus_a']);
    });
  });

  it("`nullRows: 'shared'` also shows rows of no tenant inside a tenant", async () => {
    const context = installContext({ enabled: true });
    const tenancy = resolvePaymentsTenancy({ nullRows: 'shared' });
    await context.as({ tenant: org('a') }, async () => {
      const scoped = scopedBillingStore(
        store,
        ownerScopeOfFilter(tenancy, currentTenantFilter(tenancy)),
      );
      expect(await ids(scoped)).toEqual(['pay_a', 'pay_none', 'pay_u']);
    });
  });

  it('a request with no tenant sees only rows of none (a user’s own included)', async () => {
    const context = installContext({ enabled: true });
    const tenancy = resolvePaymentsTenancy(undefined);
    await context.as({}, async () => {
      const scoped = scopedBillingStore(
        store,
        ownerScopeOfFilter(tenancy, currentTenantFilter(tenancy)),
      );
      expect(await ids(scoped)).toEqual(['pay_none', 'pay_u']);
    });
  });

  it('`allTenants` and no context see everything', async () => {
    const context = installContext({ enabled: true });
    const tenancy = resolvePaymentsTenancy(undefined);
    await context.as({ tenant: org('a') }, () =>
      context.slot.allTenants(async () => {
        expect(ownerScopeOfFilter(tenancy, currentTenantFilter(tenancy))).toBeUndefined();
      }),
    );
    expect(ownerScopeOfFilter(tenancy, currentTenantFilter(tenancy))).toBeUndefined();
  });

  it('a store that cannot scope refuses (501) instead of leaking', async () => {
    const custom = Object.create(store, { ownerScoping: { value: false } });
    const scoped = scopedBillingStore(custom as InMemoryBillingStore, {
      tenantOwnerTypes: ['organization'],
      tenantIds: ['a'],
      includeNull: false,
    });
    await expect(scoped.listPayments({})).rejects.toBeInstanceOf(OwnerScopingUnsupportedError);
  });

  it('the webhook ledger is invisible to a scoped view', async () => {
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'fake',
      type: 'payment.succeeded',
      payload: {},
    });
    const scoped = scopedBillingStore(store, {
      tenantOwnerTypes: ['organization'],
      tenantIds: ['a'],
      includeNull: false,
    });
    expect(await scoped.listWebhookEvents({})).toEqual([]);
    expect(await store.listWebhookEvents({})).toHaveLength(1);
  });
});

describe('webhook handlers run inside the customer’s organization', () => {
  it('stamps the handler with the owner tenant; built-in sync unchanged', async () => {
    const context = installContext({ enabled: true });
    const store = new InMemoryBillingStore();
    await store.saveCustomer({
      gatewayId: 'cus_a',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'a',
    });
    let seen: Frame | undefined;
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'payment.succeeded': async () => {
          seen = context.current();
        },
      },
      tenancy: () => resolvePaymentsTenancy(undefined),
    });
    await processor.process({
      id: 'evt_1',
      provider: 'fake',
      type: 'payment.succeeded',
      data: { gatewayId: 'pay_1', amount: 100, currency: 'BRL', customerId: 'cus_a' },
      raw: {},
    });
    expect(seen?.tenant).toMatchObject({ id: 'a', kind: 'organization' });
    expect(await store.findPaymentByGatewayId('pay_1')).not.toBeNull();
  });

  it('a customer of no organization runs the handler as it is', async () => {
    const context = installContext({ enabled: true });
    const store = new InMemoryBillingStore();
    let seen: Frame | undefined = { userId: 'sentinel' };
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'payment.succeeded': async () => {
          seen = context.current();
        },
      },
      tenancy: () => resolvePaymentsTenancy(undefined),
    });
    await processor.process({
      id: 'evt_2',
      provider: 'fake',
      type: 'payment.succeeded',
      data: { gatewayId: 'pay_2', amount: 100, currency: 'BRL' },
      raw: {},
    });
    expect(seen).toBeUndefined();
  });
});

describe('console organization scope', () => {
  it('normalizes `tenants` on an allowing result', () => {
    expect(normalizeConsoleAuthorizeResult({ allowed: true, tenants: '*' })).toEqual({
      allowed: true,
      tenants: '*',
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, tenants: ['a', '', 3] })).toEqual({
      allowed: true,
      tenants: ['a'],
    });
    expect(normalizeConsoleAuthorizeResult(true)).toEqual({ allowed: true });
  });

  it('resolves own / list / every organization / forged picks', () => {
    const own = { id: 'a' };
    expect(
      resolveConsoleTenantScope({ granted: undefined, own, selected: undefined }),
    ).toMatchObject({ authorized: ['a'], ids: ['a'], forged: false });
    expect(
      resolveConsoleTenantScope({ granted: undefined, own: undefined, selected: undefined }),
    ).toMatchObject({ authorized: 'none', ids: [] });
    expect(resolveConsoleTenantScope({ granted: '*', own, selected: undefined })).toMatchObject({
      ids: undefined,
    });
    expect(resolveConsoleTenantScope({ granted: '*', own, selected: 'b' })).toMatchObject({
      ids: ['b'],
      forged: false,
    });
    expect(resolveConsoleTenantScope({ granted: ['a'], own, selected: 'b' })).toMatchObject({
      ids: [],
      forged: true,
    });
  });
});

describe('payments console under tenancy (routes)', () => {
  interface Recorded {
    status?: number;
    body?: unknown;
  }
  function fakeCtx(recorded: Recorded, qs: Record<string, string> = {}, params = {}) {
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
      response,
      params,
      request: {
        qs: () => qs,
        body: () => ({}),
        url: () => '/payments/api/payments',
        method: () => 'GET',
        header: () => undefined,
        headers: () => ({}),
      },
    };
  }

  async function boot(authorize: (ctx: unknown) => unknown) {
    const routes: Array<{ method: string; pattern: string; handler: (ctx: unknown) => unknown }> =
      [];
    const reg = (method: string) => (pattern: string, handler: (ctx: unknown) => unknown) => {
      routes.push({ method, pattern, handler });
      return { as: () => undefined };
    };
    const router = { get: reg('get'), post: reg('post') };
    const app = {
      inProduction: false,
      config: {
        get: (key: string) =>
          key === 'payments_dashboard' ? { authorize } : key === 'payments' ? {} : {},
      },
      booted: async (callback: () => Promise<void>) => callback(),
      container: {
        make: async (key: unknown) => {
          if (key === 'router') return router;
          throw new Error(`not bound: ${String(key)}`);
        },
      },
    } as unknown as ApplicationService;
    await new DashboardProvider(app).boot();
    const find = (method: string, pattern: string) =>
      routes.find((r) => r.method === method && r.pattern === pattern)!.handler;
    return { routes, find };
  }

  let store: InMemoryBillingStore;
  beforeEach(async () => {
    store = new InMemoryBillingStore();
    setBillingStore(store);
    for (const [customer, owner] of [
      ['cus_a', 'a'],
      ['cus_b', 'b'],
    ] as const) {
      await store.saveCustomer({
        gatewayId: customer,
        provider: 'fake',
        ownerType: 'organization',
        ownerId: owner,
      });
      await store.savePayment({
        gatewayId: `pay_${owner}`,
        provider: 'fake',
        status: 'paid',
        amount: 100,
        currency: 'BRL',
        customerId: customer,
      });
    }
  });

  it('with tenancy off, the picker route answers `off` (no 404 on load) and no switch is mounted', async () => {
    installContext({ enabled: false });
    const { routes, find } = await boot(() => true);
    expect(routes.filter((r) => r.pattern.includes('/tenants')).map((r) => r.method)).toEqual([
      'get',
    ]);
    const picker: Recorded = {};
    await find('get', '/payments/api/tenants')(fakeCtx(picker));
    expect(picker.status).toBe(200);
    expect(picker.body).toEqual({
      mode: 'off',
      all: false,
      selected: null,
      ownerTypes: [],
      tenants: [],
    });
  });

  it("shows a viewer their own organization's rows only", async () => {
    const context = installContext({ enabled: true });
    const { find } = await boot(() => true);
    const recorded: Recorded = {};
    await context.as({ tenant: org('a') }, () =>
      find('get', '/payments/api/payments')(fakeCtx(recorded)),
    );
    expect(recorded.status).toBe(200);
    const rows = (recorded.body as { payments: Array<{ gatewayId: string }> }).payments;
    expect(rows.map((r) => r.gatewayId)).toEqual(['pay_a']);
  });

  it('answers another organization’s payment as not found, and refuses its refund', async () => {
    const context = installContext({ enabled: true });
    const { find } = await boot(() => true);
    const detail: Recorded = {};
    await context.as({ tenant: org('a') }, () =>
      find('get', '/payments/api/payments/:gatewayId')(fakeCtx(detail, {}, { gatewayId: 'pay_b' })),
    );
    expect(detail.status).toBe(404);
    const refund: Recorded = {};
    await context.as({ tenant: org('a') }, () =>
      find(
        'post',
        '/payments/api/payments/:gatewayId/refund',
      )(fakeCtx(refund, {}, { gatewayId: 'pay_b' })),
    );
    expect(refund.status).toBe(404);
  });

  it('a forged ?tenant= outside the grant reads as empty and is audited', async () => {
    const context = installContext({ enabled: true });
    const { find } = await boot(() => ({ allowed: true, tenants: ['a'] }));
    const recorded: Recorded = {};
    await context.as({}, () =>
      find('get', '/payments/api/payments')(fakeCtx(recorded, { tenant: 'b' })),
    );
    expect((recorded.body as { payments: unknown[] }).payments).toEqual([]);
    const audit = await store.listAuditEvents({ action: AUDIT_ACTIONS.tenantForged });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.subjectId).toBe('b');
  });

  it("`tenants: '*'` sees every organization and may narrow to one", async () => {
    const context = installContext({ enabled: true });
    const { find } = await boot(() => ({ allowed: true, tenants: '*' }));
    const all: Recorded = {};
    await context.as({}, () => find('get', '/payments/api/payments')(fakeCtx(all)));
    expect((all.body as { payments: unknown[] }).payments).toHaveLength(2);
    const one: Recorded = {};
    await context.as({}, () =>
      find('get', '/payments/api/payments')(fakeCtx(one, { tenant: 'b' })),
    );
    expect(
      (one.body as { payments: Array<{ gatewayId: string }> }).payments.map((r) => r.gatewayId),
    ).toEqual(['pay_b']);
    const picker: Recorded = {};
    await context.as({}, () => find('get', '/payments/api/tenants')(fakeCtx(picker)));
    expect(picker.body).toMatchObject({
      mode: 'pick',
      all: true,
      ownerTypes: ['organization'],
      tenants: [
        { id: 'a', label: 'Org A' },
        { id: 'b', label: 'Org B' },
      ],
    });
  });

  it('views over every organization are not available to a scoped viewer', async () => {
    const context = installContext({ enabled: true });
    const { find } = await boot(() => true);
    const recorded: Recorded = {};
    await context.as({ tenant: org('a') }, () =>
      find('get', '/payments/api/webhook-events')(fakeCtx(recorded)),
    );
    expect(recorded.status).toBe(404);
  });

  it('an explicit empty grant is "no organization" in the picker', async () => {
    const context = installContext({ enabled: true });
    const { find } = await boot(() => ({ allowed: true, tenants: [] }));
    const picker: Recorded = {};
    await context.as({ tenant: org('a') }, () =>
      find('get', '/payments/api/tenants')(fakeCtx(picker)),
    );
    expect(picker.body).toMatchObject({ mode: 'none' });
  });

  it('a viewer with no organization sees nothing (and the picker says so)', async () => {
    const context = installContext({ enabled: true });
    const { find } = await boot(() => true);
    const recorded: Recorded = {};
    await context.as({}, () => find('get', '/payments/api/payments')(fakeCtx(recorded)));
    expect((recorded.body as { payments: unknown[] }).payments).toEqual([]);
    const picker: Recorded = {};
    await context.as({}, () => find('get', '/payments/api/tenants')(fakeCtx(picker)));
    expect(picker.body).toMatchObject({ mode: 'none' });
  });
});

describe('payments:sync --backfill-owner', () => {
  const log = { info: () => undefined, warning: () => undefined };

  it('assigns an owner to one ownerless customer, never to an owned one', async () => {
    const { backfillCustomerOwners } = await import('../commands/payments_sync.js');
    const store = new InMemoryBillingStore();
    await store.saveCustomer({ gatewayId: 'cus_1', provider: 'fake' });
    await store.saveCustomer({
      gatewayId: 'cus_2',
      provider: 'fake',
      ownerType: 'User',
      ownerId: '9',
    });
    const one = await backfillCustomerOwners(store, {
      ownerType: 'Organization',
      customer: 'cus_1',
      ownerId: 'a',
      log,
    });
    expect(one).toEqual({ updated: 1, owned: 0, unresolved: 0 });
    const owned = await backfillCustomerOwners(store, {
      ownerType: 'Organization',
      customer: 'cus_2',
      ownerId: 'a',
      log,
    });
    expect(owned).toEqual({ updated: 0, owned: 1, unresolved: 0 });
    expect(await store.findCustomerByGatewayId('cus_2')).toMatchObject({ ownerType: 'User' });
  });

  it('reads the owner id from stored metadata for every ownerless customer', async () => {
    const { backfillCustomerOwners } = await import('../commands/payments_sync.js');
    const store = new InMemoryBillingStore();
    await store.saveCustomer({ gatewayId: 'cus_1', provider: 'fake', metadata: { orgId: 'a' } });
    await store.saveCustomer({ gatewayId: 'cus_2', provider: 'fake', metadata: {} });
    const result = await backfillCustomerOwners(store, {
      ownerType: 'Organization',
      ownerKey: 'orgId',
      log,
    });
    expect(result).toEqual({ updated: 1, owned: 0, unresolved: 1 });
    expect(await store.findCustomerByGatewayId('cus_1')).toMatchObject({
      ownerType: 'Organization',
      ownerId: 'a',
    });
  });
});

describe('pullfrog review follow-ups', () => {
  it('the scoped dispute work-lists are scoped in the store, past any first page', async () => {
    const store = new InMemoryBillingStore();
    await store.saveCustomer({
      gatewayId: 'cus_a',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'a',
    });
    await store.saveCustomer({
      gatewayId: 'cus_b',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'b',
    });
    const now = new Date('2026-11-12T00:00:00.000Z');
    const due = new Date('2026-11-12T06:00:00.000Z');
    // Another organization's due disputes fill more than a page before ours.
    for (let i = 0; i < 205; i++) {
      await store.savePayment({
        gatewayId: `pay_b${i}`,
        provider: 'fake',
        status: 'disputed',
        amount: 1,
        currency: 'BRL',
        customerId: 'cus_b',
      });
      await store.saveDispute({
        gatewayId: `dp_b${i}`,
        paymentGatewayId: `pay_b${i}`,
        provider: 'fake',
        status: 'open',
        evidenceDueBy: due,
      });
    }
    await store.savePayment({
      gatewayId: 'pay_a',
      provider: 'fake',
      status: 'disputed',
      amount: 1,
      currency: 'BRL',
      customerId: 'cus_a',
    });
    await store.saveDispute({
      gatewayId: 'dp_a',
      paymentGatewayId: 'pay_a',
      provider: 'fake',
      status: 'open',
      evidenceDueBy: new Date('2026-11-12T07:00:00.000Z'),
    });
    const scoped = scopedBillingStore(store, {
      tenantOwnerTypes: ['organization'],
      tenantIds: ['a'],
      includeNull: false,
    });
    const rows = await scoped.listDisputesDueWithin({ withinHours: 24, now, size: 200 });
    expect(rows.map((r) => r.gatewayId)).toEqual(['dp_a']);
    expect(await scoped.countDisputesDueWithin({ withinHours: 24, now })).toBe(1);
    expect(await scoped.countOpenDisputes({})).toBe(1);
    expect((await scoped.listOpenDisputes({})).map((r) => r.gatewayId)).toEqual(['dp_a']);
  });

  it("a visible payment's audit count agrees with its audit list", async () => {
    const store = new InMemoryBillingStore();
    await store.saveCustomer({
      gatewayId: 'cus_a',
      provider: 'fake',
      ownerType: 'organization',
      ownerId: 'a',
    });
    await store.savePayment({
      gatewayId: 'pay_a',
      provider: 'fake',
      status: 'paid',
      amount: 1,
      currency: 'BRL',
      customerId: 'cus_a',
    });
    await store.recordAuditEvent({
      action: AUDIT_ACTIONS.refund,
      subjectType: 'payment',
      subjectId: 'pay_a',
    });
    const scoped = scopedBillingStore(store, {
      tenantOwnerTypes: ['organization'],
      tenantIds: ['a'],
      includeNull: false,
    });
    const query = { subjectType: 'payment', subjectId: 'pay_a' };
    expect(await scoped.listAuditEvents(query)).toHaveLength(1);
    expect(await scoped.countAuditEvents(query)).toBe(1);
    expect(await scoped.countAuditEvents({})).toBe(0);
  });
});
