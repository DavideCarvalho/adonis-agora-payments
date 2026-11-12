import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardProvider from '../../providers/dashboard_provider.js';
import { AUDIT_ACTIONS } from '../../src/billing/billing_store.js';
import { anyAuthorize, authorizeByToken } from '../../src/dashboard/console_authorize.js';
import {
  DEV_TOOLS_BINDING,
  type DevTool,
  type DevToolCall,
  type DevToolsLib,
  type PaymentsDevToolsOptions,
  paymentsDevTools,
  registerPaymentsDevTools,
} from '../../src/dashboard/dev_tools.js';
import { resetBillingStore, setBillingStore } from '../../src/services/main.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

const TENANCY = Symbol.for('@agora/context:tenancy');

/** A minimal stand-in for `@adonis-agora/context`'s tenancy slot (version 1). */
function installContext(enabled: boolean) {
  const als = new AsyncLocalStorage<{ tenant?: string }>();
  (globalThis as Record<symbol, unknown>)[TENANCY] = {
    version: 1,
    tenancy: () => ({ enabled, required: false }),
    tenantFilter() {
      const frame = als.getStore();
      if (!frame) return { mode: 'system' };
      if (frame.tenant) {
        return {
          mode: 'tenant',
          tenant: { id: frame.tenant, kind: 'organization', source: 'authkit' },
        };
      }
      return { mode: 'tenantless' };
    },
    withTenant: <T>(_input: unknown, fn: () => T) => fn(),
    allTenants: <T>(fn: () => T) => fn(),
    tenantLabels: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `Org ${id}`])),
  };
  return { as: <T>(tenant: string | undefined, fn: () => T) => als.run({ tenant }, fn) };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[TENANCY];
  resetBillingStore();
});

function fakeCtx(
  options: { header?: string; qs?: Record<string, string>; params?: Record<string, string> } = {},
) {
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
  const ctx = {
    response,
    params: options.params ?? {},
    request: {
      qs: () => options.qs ?? {},
      body: () => ({}),
      url: () => '/mcp/agora',
      method: () => 'POST',
      header: (name: string) => (name === 'authorization' ? options.header : undefined),
      headers: () => ({}),
    },
  };
  return { ctx: ctx as never, recorded };
}

function call(ctx: unknown, id = 'token:abc123'): DevToolCall {
  return {
    ctx: ctx as never,
    caller: { id, via: 'token' },
    limits: { maxRows: 100, maxBytes: 48_000 },
  };
}

/** Boot the provider against a fake app holding a dev-tools hub; returns what it registered. */
async function boot(
  dashboard: Record<string, unknown>,
  options: { inProduction?: boolean; hub?: unknown } = {},
) {
  const registered: DevToolsLib[] = [];
  const hub = options.hub ?? {
    version: 1,
    register: (lib: DevToolsLib) => void registered.push(lib),
  };
  const routes: Array<{ method: string; pattern: string; handler: (ctx: unknown) => unknown }> = [];
  const reg = (method: string) => (pattern: string, handler: (ctx: unknown) => unknown) => {
    routes.push({ method, pattern, handler });
    return { as: () => undefined };
  };
  const router = { get: reg('get'), post: reg('post') };
  const warn = vi.fn();
  const app = {
    inProduction: options.inProduction === true,
    config: {
      get: (key: string) => (key === 'payments_dashboard' ? dashboard : {}),
    },
    booted: async (callback: () => Promise<void>) => callback(),
    container: {
      hasBinding: (key: string) => key === DEV_TOOLS_BINDING,
      make: async (key: unknown) => {
        if (key === 'router') return router;
        if (key === 'logger') return { warn };
        if (key === DEV_TOOLS_BINDING) return hub;
        throw new Error(`not bound: ${String(key)}`);
      },
    },
  } as unknown as ApplicationService;
  await new DashboardProvider(app).boot();
  const lib = registered[0];
  const tool = (name: string) => lib?.tools.find((t) => t.name === name) as DevTool;
  const route = (method: string, pattern: string) =>
    routes.find((r) => r.method === method && r.pattern === pattern)?.handler;
  return { registered, lib, tool, route, warn };
}

describe('payments dev tools catalogue', () => {
  const options: PaymentsDevToolsOptions = {
    serve: async () => ({ status: 200, body: {} }),
    canRefund: async () => true,
    tenancyEnabled: () => false,
    organizations: async () => ({ mode: 'off', all: false, tenants: [] }),
    recordAudit: async () => {},
  };

  it('declares the tools, every name prefixed, in the JSON Schema subset', () => {
    const tools = paymentsDevTools(options);
    expect(tools.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'read:payments_get_overview',
      'read:payments_get_health',
      'read:payments_list_payments',
      'read:payments_get_payment',
      'read:payments_list_subscriptions',
      'read:payments_list_disputes',
      'read:payments_list_webhook_events',
      'read:payments_list_customers',
      'read:payments_list_audit',
      'read:payments_list_organizations',
      'action:payments_refund_payment',
      'action:payments_retry_webhook_event',
      'action:payments_resolve_dispute',
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^payments_(list|get|refund|retry|resolve)_[a-z_]+$/);
      expect(tool.input.type).toBe('object');
      for (const property of Object.values(tool.input.properties)) {
        expect(['string', 'number', 'integer', 'boolean', 'array']).toContain(property.type);
      }
      for (const key of tool.input.required ?? [])
        expect(tool.input.properties).toHaveProperty(key);
    }
    const refund = tools.find((t) => t.name === 'payments_refund_payment');
    expect(refund?.destructive).toBe(true);
  });

  it('hides the refund without a refund-capable gateway, organizations without tenancy', async () => {
    const tools = paymentsDevTools({ ...options, canRefund: async () => false });
    const byName = (name: string) => tools.find((t) => t.name === name);
    expect(await byName('payments_refund_payment')?.available?.()).toBe(false);
    expect(await byName('payments_list_organizations')?.available?.()).toBe(false);
  });

  it('turns a console refusal into a tool error with its message', async () => {
    const tools = paymentsDevTools({
      ...options,
      serve: async () => ({ status: 404, body: { error: 'No payment "x" is recorded locally.' } }),
    });
    const get = tools.find((t) => t.name === 'payments_get_payment') as DevTool;
    await expect(get.run({ gatewayId: 'x' }, call({}))).rejects.toThrow(
      '404: No payment "x" is recorded locally.',
    );
    await expect(get.run({}, call({}))).rejects.toThrow('gatewayId is required');
  });

  it('records an MCP webhook retry in the audit trail, attributed to the caller', async () => {
    const recordAudit = vi.fn(async () => {});
    const serve = vi.fn(async () => ({
      status: 200,
      body: { gatewayEventId: 'evt_1', status: 'processed' },
    }));
    const tools = paymentsDevTools({ ...options, serve, recordAudit });
    const retry = tools.find((t) => t.name === 'payments_retry_webhook_event') as DevTool;
    expect(await retry.run({ gatewayEventId: 'evt_1' }, call({}))).toEqual({
      gatewayEventId: 'evt_1',
      status: 'processed',
    });
    expect(serve).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ needsActions: true, everyOrganization: true }),
      { params: { gatewayEventId: 'evt_1' }, query: {} },
      { actor: 'mcp:token:abc123', tenant: undefined },
    );
    expect(recordAudit).toHaveBeenCalledWith({
      action: AUDIT_ACTIONS.webhookRetried,
      actor: 'mcp:token:abc123',
      provider: null,
      subjectType: 'webhook',
      subjectId: 'evt_1',
    });
  });

  it('pages lists as { items, next }, limit capped at 100 and mapped to the console size', async () => {
    const serve = vi.fn(async (_ctx: unknown, _route: unknown, req: { query: unknown }) => ({
      status: 200,
      body: {
        customers: Array.from({ length: Number((req.query as { size: string }).size) }, () => ({})),
      },
    }));
    const tools = paymentsDevTools({ ...options, serve });
    const list = tools.find((t) => t.name === 'payments_list_customers') as DevTool;
    const out = (await list.run({ limit: 500, page: 2, ownerId: '42' }, call({}))) as {
      items: unknown[];
      next: number | null;
    };
    expect(serve.mock.calls[0]?.[2]).toEqual({
      params: {},
      query: { page: '2', size: '100', ownerId: '42' },
    });
    expect(out.items).toHaveLength(100);
    expect(out.next).toBe(3);
  });
});

describe('registerPaymentsDevTools', () => {
  const options = {
    authorize: async () => ({ allowed: true }) as const,
    serve: async () => ({ status: 200, body: {} }),
    canRefund: async () => false,
    tenancyEnabled: () => false,
    organizations: async () => ({ mode: 'off', all: false, tenants: [] }),
    recordAudit: async () => {},
  };

  it('does nothing without the hub binding', async () => {
    const container = { hasBinding: () => false, make: vi.fn() };
    expect(await registerPaymentsDevTools(container, options)).toBe(false);
    expect(container.make).not.toHaveBeenCalled();
    // A container without `hasBinding` (an old stand-in) is "no hub" too.
    expect(await registerPaymentsDevTools({ make: vi.fn() }, options)).toBe(false);
  });

  it('registers the payments lib into a v1 hub, with the console gate', async () => {
    const registered: DevToolsLib[] = [];
    const hub = { version: 1 as const, register: (lib: DevToolsLib) => registered.push(lib) };
    const container = { hasBinding: () => true, make: async () => hub };
    expect(await registerPaymentsDevTools(container, options)).toBe(true);
    expect(registered[0]?.lib).toBe('payments');
    expect(registered[0]?.authorize).toBe(options.authorize);
    expect(registered[0]?.tools).toHaveLength(13);
  });

  it('skips a hub of another version', async () => {
    const hub = { version: 2, register: vi.fn() };
    const container = { hasBinding: () => true, make: async () => hub };
    expect(await registerPaymentsDevTools(container, options)).toBe(false);
    expect(hub.register).not.toHaveBeenCalled();
  });
});

describe('PaymentsDashboardProvider registers its dev tools', () => {
  let store: InMemoryBillingStore;
  beforeEach(async () => {
    store = new InMemoryBillingStore();
    setBillingStore(store);
    for (const owner of ['a', 'b']) {
      await store.saveCustomer({
        gatewayId: `cus_${owner}`,
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
        customerId: `cus_${owner}`,
      });
    }
  });

  it('gates the tools with the console authorize; open outside production when omitted', async () => {
    const dev = await boot({});
    expect(await dev.lib?.authorize(fakeCtx().ctx)).toEqual({ allowed: true });

    const prod = await boot({}, { inProduction: true });
    expect(await prod.lib?.authorize(fakeCtx().ctx)).toEqual({
      allowed: false,
      reason: 'forbidden',
    });

    const token = await boot({ authorize: authorizeByToken({ token: 's3cret' }) });
    expect(await token.lib?.authorize(fakeCtx({ header: 'Bearer s3cret' }).ctx)).toEqual({
      allowed: true,
    });
    expect(await token.lib?.authorize(fakeCtx().ctx)).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });

    const login = await boot({ authorize: () => ({ redirectTo: '/login' }) });
    expect(await login.lib?.authorize(fakeCtx().ctx)).toEqual({
      allowed: false,
      reason: 'unauthenticated',
      redirectTo: '/login',
    });
  });

  it('a disabled console registers no tools', async () => {
    const { registered } = await boot({ enabled: false });
    expect(registered).toEqual([]);
  });

  it('a hub that throws does not break boot', async () => {
    const hub = {
      version: 1,
      register: () => {
        throw new Error('duplicate lib');
      },
    };
    const { warn, route } = await boot({}, { hub });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not register'));
    expect(route('get', '/payments/api/payments')).toBeDefined();
  });

  it('answers exactly what the console API answers', async () => {
    const { lib, tool, route } = await boot({});
    const api = fakeCtx({ qs: { status: 'paid', page: '1', size: '20' } });
    await route('get', '/payments/api/payments')?.(api.ctx);
    const viaApi = api.recorded.body as { payments: unknown[] };
    expect(viaApi.payments).toHaveLength(2);

    const mcp = fakeCtx();
    await lib?.authorize(mcp.ctx);
    const viaTool = (await tool('payments_list_payments').run(
      { status: 'paid' },
      call(mcp.ctx),
    )) as { items: unknown[]; next: unknown };
    expect(viaTool.items).toEqual(viaApi.payments);
    expect(viaTool.next).toBeNull();
  });

  it('refuses a call the console gate refuses, even without the hub', async () => {
    const { tool } = await boot({ authorize: () => false });
    await expect(tool('payments_list_payments').run({}, call(fakeCtx().ctx))).rejects.toThrow(
      '403: forbidden',
    );
  });

  it('records a dispute resolution against the MCP caller', async () => {
    await store.saveDispute({
      gatewayId: 'dp_1',
      paymentGatewayId: 'pay_a',
      provider: 'fake',
      status: 'needs_response',
    });
    const { lib, tool } = await boot({});
    const mcp = fakeCtx();
    await lib?.authorize(mcp.ctx);
    await tool('payments_resolve_dispute').run(
      { gatewayId: 'dp_1', status: 'lost', note: 'lost at the gateway' },
      call(mcp.ctx, 'user:42'),
    );
    const audit = await store.listAuditEvents({ action: AUDIT_ACTIONS.disputeResolved });
    expect(audit[0]).toMatchObject({ actor: 'mcp:user:42', subjectId: 'dp_1' });
  });

  describe('with organizations on', () => {
    it("shows a viewer their own organization's rows only", async () => {
      const context = installContext(true);
      const { lib, tool } = await boot({});
      const mcp = fakeCtx();
      const out = (await context.as('a', async () => {
        await lib?.authorize(mcp.ctx);
        return tool('payments_list_payments').run({}, call(mcp.ctx));
      })) as { items: Array<{ gatewayId: string }> };
      expect(out.items.map((p) => p.gatewayId)).toEqual(['pay_a']);
      // Another organization's payment does not exist for this viewer.
      await expect(
        context.as('a', () =>
          tool('payments_get_payment').run({ gatewayId: 'pay_b' }, call(mcp.ctx)),
        ),
      ).rejects.toThrow(/^404/);
      // A view over every organization is refused, as in the console.
      await expect(
        context.as('a', () => tool('payments_get_health').run({}, call(mcp.ctx))),
      ).rejects.toThrow(/^404: This view spans every organization/);
    });

    it('narrows to `tenant` inside the grant; outside it reads empty and is audited', async () => {
      const context = installContext(true);
      const { lib, tool } = await boot({ authorize: () => ({ allowed: true, tenants: ['a'] }) });
      const mcp = fakeCtx();
      await context.as(undefined, () => lib?.authorize(mcp.ctx));
      const own = (await context.as(undefined, () =>
        tool('payments_list_payments').run({ tenant: 'a' }, call(mcp.ctx)),
      )) as { items: unknown[] };
      expect(own.items).toHaveLength(1);
      const forged = (await context.as(undefined, () =>
        tool('payments_list_payments').run({ tenant: 'b' }, call(mcp.ctx)),
      )) as { items: unknown[] };
      expect(forged.items).toEqual([]);
      const audit = await store.listAuditEvents({ action: AUDIT_ACTIONS.tenantForged });
      expect(audit.map((row) => row.subjectId)).toEqual(['b']);
    });

    it('lists the organizations the viewer may pick', async () => {
      const context = installContext(true);
      const { lib, tool } = await boot({ authorize: () => ({ allowed: true, tenants: '*' }) });
      const mcp = fakeCtx();
      expect(await tool('payments_list_organizations').available?.()).toBe(true);
      const out = await context.as(undefined, async () => {
        await lib?.authorize(mcp.ctx);
        return tool('payments_list_organizations').run({}, call(mcp.ctx));
      });
      expect(out).toEqual({
        items: [
          { id: 'a', label: 'Org a' },
          { id: 'b', label: 'Org b' },
        ],
        all: true,
      });
    });
  });
});

describe('anyAuthorize', () => {
  const ctx = (header?: string) =>
    ({ request: { header: () => header } }) as unknown as Parameters<
      ReturnType<typeof anyAuthorize>
    >[0];

  it('allows when any authorizer allows, tried in order, keeping its tenants', async () => {
    const authorize = anyAuthorize(authorizeByToken({ token: 't' }), () => false);
    expect(await authorize(ctx('Bearer t'))).toEqual({ allowed: true });
    expect(
      await anyAuthorize(
        () => false,
        () => ({ allowed: true, tenants: ['a'] }),
      )(ctx()),
    ).toEqual({ allowed: true, tenants: ['a'] });
  });

  it('prefers a redirect, then unauthenticated, then forbidden', async () => {
    expect(
      await anyAuthorize(
        () => false,
        () => ({ redirectTo: '/login' }),
      )(ctx()),
    ).toEqual({ redirectTo: '/login' });
    expect(await anyAuthorize(() => false, authorizeByToken({ token: 't' }))(ctx())).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
    const throwing = () => {
      throw new Error('boom');
    };
    expect(await anyAuthorize(throwing, () => false)(ctx())).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
  });

  it('needs at least one authorizer', () => {
    expect(() => anyAuthorize()).toThrow('at least one');
  });
});
