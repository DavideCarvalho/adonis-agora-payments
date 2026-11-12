import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardProvider from '../../providers/dashboard_provider.js';
import {
  AGORA_CONSOLES_BINDING,
  type AgoraConsoleEntry,
  type AgoraConsoleRegistry,
  listVisibleConsoles,
  otherConsoles,
  paymentsConsoleSearch,
  registerAgoraConsole,
  searchConsoles,
} from '../../src/dashboard/console_switcher.js';
import { renderIndexHtml } from '../../src/dashboard/spa.js';
import { resetBillingStore, setBillingStore } from '../../src/services/main.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

const TENANCY = Symbol.for('@agora/context:tenancy');

function fakeContainer() {
  const values = new Map<string, unknown>();
  return {
    values,
    hasBinding: (key: string) => values.has(key),
    bindValue: (key: string, value: unknown) => void values.set(key, value),
    make: async (key: string) => values.get(key),
  };
}

const allow = async () => ({ allowed: true });
const deny = async () => ({ allowed: false, reason: 'forbidden' });

function entry(over: Partial<AgoraConsoleEntry> & { id: string }): AgoraConsoleEntry {
  return {
    title: over.id,
    icon: 'generic',
    path: `/${over.id}`,
    order: 50,
    authorize: allow,
    ...over,
  };
}

const ctx = {} as HttpContext;

describe('registerAgoraConsole', () => {
  it('creates the registry when absent and reuses it when present', async () => {
    const container = fakeContainer();
    expect(await registerAgoraConsole(container, entry({ id: 'durable' }))).toBe(true);
    // A second lib's copy of the helper appends to the same value.
    expect(await registerAgoraConsole(container, entry({ id: 'payments' }))).toBe(true);
    const registry = container.values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    expect(registry.version).toBe(1);
    expect(registry.entries.map((e) => e.id)).toEqual(['durable', 'payments']);
  });

  it('skips a registry of another version', async () => {
    const container = fakeContainer();
    container.bindValue(AGORA_CONSOLES_BINDING, { version: 2, entries: [] });
    expect(await registerAgoraConsole(container, entry({ id: 'durable' }))).toBe(false);
  });

  it('warns on a duplicate id', async () => {
    const container = fakeContainer();
    const warn = vi.fn();
    await registerAgoraConsole(container, entry({ id: 'durable' }), { warn });
    expect(await registerAgoraConsole(container, entry({ id: 'durable' }), { warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"durable" already registered'));
  });

  it('rejects a bad id or path', async () => {
    const container = fakeContainer();
    await expect(registerAgoraConsole(container, entry({ id: 'Bad Id' }))).rejects.toThrow();
    await expect(
      registerAgoraConsole(container, entry({ id: 'x', path: '//evil.example' })),
    ).rejects.toThrow();
    await expect(
      registerAgoraConsole(container, entry({ id: 'y', path: 'https://evil.example' })),
    ).rejects.toThrow();
  });
});

describe('listVisibleConsoles', () => {
  it('lists the allowed others, sorted, without self, never a reason', async () => {
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [
        entry({ id: 'durable', order: 10 }),
        entry({ id: 'media', order: 50, icon: 'media' }),
        entry({ id: 'payments', order: 40, authorize: deny }),
        entry({ id: 'telescope', order: 20, package: '@adonis-agora/telescope' }),
        entry({
          id: 'agent',
          order: 30,
          authorize: async () => ({ allowed: false, redirectTo: '/login' }),
        }),
        entry({ id: 'odd', order: 60, icon: 'weird' as never }),
        entry({ id: 'broken', order: 70, authorize: async () => Promise.reject(new Error('x')) }),
      ],
    };
    const out = await listVisibleConsoles(registry, 'durable', ctx);
    expect(out).toEqual({
      version: 1,
      current: 'durable',
      consoles: [
        {
          id: 'telescope',
          title: 'telescope',
          package: '@adonis-agora/telescope',
          icon: 'generic',
          href: '/telescope',
        },
        { id: 'media', title: 'media', icon: 'media', href: '/media' },
        { id: 'odd', title: 'odd', icon: 'generic', href: '/odd' },
      ],
    });
  });

  it('runs the gates in parallel and hides a slow one after 300 ms', async () => {
    vi.useFakeTimers();
    try {
      const slow = () =>
        new Promise<{ allowed: boolean }>((r) => setTimeout(() => r({ allowed: true }), 1000));
      const fine = () =>
        new Promise<{ allowed: boolean }>((r) => setTimeout(() => r({ allowed: true }), 200));
      const registry: AgoraConsoleRegistry = {
        version: 1,
        entries: [
          entry({ id: 'a', authorize: fine }),
          entry({ id: 'b', authorize: fine }),
          entry({ id: 'c', authorize: slow }),
        ],
      };
      const pending = listVisibleConsoles(registry, 'self', ctx);
      await vi.advanceTimersByTimeAsync(301);
      const out = await pending;
      // a + b each take 200 ms: run one after the other they would miss the 300 ms total.
      expect(out.consoles.map((c) => c.id)).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks ctx as a probe while the others decide', async () => {
    const seen: unknown[] = [];
    const probeCtx = {} as HttpContext & { agoraProbe?: boolean };
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [
        entry({
          id: 'x',
          authorize: async (c) => {
            seen.push((c as typeof probeCtx).agoraProbe);
            return { allowed: true };
          },
        }),
      ],
    };
    await listVisibleConsoles(registry, 'self', probeCtx);
    expect(seen).toEqual([true]);
    expect(probeCtx.agoraProbe).toBeUndefined();
  });

  it('is empty without a registry', async () => {
    expect((await listVisibleConsoles(undefined, 'durable', ctx)).consoles).toEqual([]);
    expect(otherConsoles(undefined, 'durable')).toBe(0);
  });
});

describe('searchConsoles', () => {
  it('searches self and the allowed others, 5 safe hits each', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `p${i}`, href: `/payments#${i}` }));
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [
        entry({
          id: 'durable',
          order: 10,
          search: async () => [{ title: 'run-1', href: '/durable#/run/run-1' }],
        }),
        entry({ id: 'payments', order: 40, search: async () => many }),
        entry({
          id: 'media',
          order: 50,
          authorize: deny,
          search: async () => [{ title: 'm', href: '/m' }],
        }),
        entry({
          id: 'evil',
          order: 60,
          search: async () => [
            { title: 'x', href: 'https://evil.example' },
            { title: 'y', href: '//evil.example' },
          ],
        }),
        entry({ id: 'nosearch', order: 70 }),
      ],
    };
    const out = await searchConsoles(registry, 'durable', ctx, '  run  ');
    expect(out.q).toBe('run');
    expect(out.results.map((r) => r.id)).toEqual(['durable', 'payments']);
    expect(out.results[1]?.hits).toHaveLength(5);
  });

  it('answers nothing for a blank query', async () => {
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [entry({ id: 'a', search: async () => [{ title: 't', href: '/t' }] })],
    };
    expect((await searchConsoles(registry, 'a', ctx, '   ')).results).toEqual([]);
  });
});

describe('paymentsConsoleSearch', () => {
  async function seeded() {
    const store = new InMemoryBillingStore();
    await store.saveCustomer({
      gatewayId: 'cus_1',
      provider: 'stripe',
      ownerType: 'user',
      ownerId: '42',
      email: 'ana@example.com',
    });
    await store.savePayment({
      gatewayId: 'pi_1',
      provider: 'stripe',
      status: 'paid',
      amount: 1990,
      currency: 'BRL',
      customerId: 'cus_1',
      externalReference: 'order-7',
    });
    return store;
  }

  it('finds a payment by gateway id or reference, a customer by gateway id or owner id', async () => {
    const store = await seeded();
    const search = paymentsConsoleSearch(async () => store, '/payments');
    expect(await search(ctx, 'pi_1', 5)).toEqual([
      {
        title: 'pi_1',
        subtitle: 'payment · paid · stripe · order-7',
        href: '/payments#/payments/pi_1',
      },
    ]);
    expect(await search(ctx, 'order-7', 5)).toHaveLength(1);
    expect(await search(ctx, '42', 5)).toEqual([
      {
        title: 'ana@example.com',
        subtitle: 'customer · stripe · cus_1 · user 42',
        href: '/payments#/payments?customer=cus_1',
      },
    ]);
    expect(await search(ctx, 'cus_1', 5)).toHaveLength(1);
    expect(await search(ctx, 'nothing', 5)).toEqual([]);
  });

  it('keeps every matching subscription, even two with the same status', async () => {
    const store = await seeded();
    for (const id of ['sub_1', 'sub_2']) {
      await store.saveSubscription({
        gatewayId: id,
        provider: 'stripe',
        customerId: 'cus_1',
        status: 'active',
        planId: 'pro',
        externalReference: 'team-9',
      });
    }
    const hits = await paymentsConsoleSearch(async () => store, '/payments')(ctx, 'team-9', 5);
    expect(hits.map((hit) => hit.title).sort()).toEqual(['sub_1', 'sub_2']);
    expect(hits[0]?.href).toBe('/payments#/subscriptions?status=active');
  });

  it('links from the root mount, and answers nothing without a store', async () => {
    const store = await seeded();
    expect((await paymentsConsoleSearch(async () => store, '')(ctx, 'pi_1', 5))[0]?.href).toBe(
      '/#/payments/pi_1',
    );
    expect(await paymentsConsoleSearch(async () => undefined, '/payments')(ctx, 'pi_1', 5)).toEqual(
      [],
    );
  });
});

describe('renderIndexHtml switcher field', () => {
  const html = '<html><head></head><body></body></html>';

  it('adds the field only when other consoles exist', () => {
    const none = renderIndexHtml(html, '/payments', '/payments/api', 'BRL', {
      endpoint: '/payments/api/consoles',
      others: 0,
    });
    expect(none).not.toContain('switcher');
    const some = renderIndexHtml(html, '/payments', '/payments/api', 'BRL', {
      endpoint: '/payments/api/consoles',
      others: 2,
    });
    expect(some).toContain('"switcher":{"endpoint":"/payments/api/consoles","others":2}');
  });
});

describe('PaymentsDashboardProvider — console switcher', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[TENANCY];
    resetBillingStore();
  });

  function fakeRouter() {
    const handlers = new Map<string, (ctx: unknown) => unknown>();
    const reg = (method: string) => (path: string, handler: (ctx: unknown) => unknown) => {
      handlers.set(`${method} ${path}`, handler);
      return { as: () => undefined };
    };
    return { router: { get: reg('get'), post: reg('post') }, handlers };
  }

  function fakeApp(dashboard: Record<string, unknown>, container = fakeContainer()) {
    const { router, handlers } = fakeRouter();
    const make = container.make;
    const app = {
      inProduction: false,
      config: { get: (key: string) => (key === 'payments_dashboard' ? dashboard : {}) },
      container: {
        ...container,
        make: async (key: string) =>
          key === 'router' ? router : key === 'logger' ? { warn: () => {} } : make(key),
      },
      booted: async (fn: () => Promise<void>) => fn(),
    };
    return { app: app as unknown as ApplicationService, handlers, container };
  }

  function jsonCtx(query: Record<string, string> = {}) {
    const out: { status?: number; body?: unknown; headers: Record<string, string> } = {
      headers: {},
    };
    const response = {
      getHeader: () => undefined,
      header: (k: string, v: string) => {
        out.headers[k] = v;
        return response;
      },
      status: (code: number) => {
        out.status = code;
        return response;
      },
      json: (body: unknown) => {
        out.body = body;
        return response;
      },
      send: () => response,
    };
    const request = {
      qs: () => query,
      header: () => undefined,
      url: () => '/payments/api/consoles',
      method: () => 'GET',
    };
    return { ctx: { request, response, params: {} } as never, out };
  }

  it('registers itself as "payments" and answers the others behind its own gate', async () => {
    const { app, handlers, container } = fakeApp({});
    await registerAgoraConsole(container, entry({ id: 'durable', order: 10, icon: 'workflow' }));
    await new DashboardProvider(app).boot();

    const registry = container.values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    const payments = registry.entries.find((e) => e.id === 'payments');
    expect(payments).toMatchObject({
      title: 'Payments',
      package: '@adonis-agora/payments',
      icon: 'payments',
      path: '/payments',
      order: 40,
    });
    // Omitted authorize: open outside production, like the console itself.
    expect(await payments?.authorize(ctx)).toEqual({ allowed: true });

    const { ctx: c, out } = jsonCtx();
    await handlers.get('get /payments/api/consoles')?.(c);
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toBe('private, no-store');
    expect(out.body).toEqual({
      version: 1,
      current: 'payments',
      consoles: [{ id: 'durable', title: 'durable', icon: 'workflow', href: '/durable' }],
    });
  });

  it('a viewer the console refuses gets the refusal, not the list', async () => {
    const { app, handlers, container } = fakeApp({ authorize: () => false });
    await registerAgoraConsole(container, entry({ id: 'durable' }));
    await new DashboardProvider(app).boot();
    for (const route of ['get /payments/api/consoles', 'get /payments/api/consoles/search']) {
      const { ctx: c, out } = jsonCtx({ q: 'pi_1' });
      await handlers.get(route)?.(c);
      expect(out.status).toBe(403);
      expect(out.body).toEqual({ error: 'forbidden' });
    }
  });

  it('a disabled console does not join', async () => {
    const { app, container } = fakeApp({ enabled: false });
    await new DashboardProvider(app).boot();
    expect(container.values.has(AGORA_CONSOLES_BINDING)).toBe(false);
  });

  it('search answers this console and the others, over the rows the viewer may see', async () => {
    const store = new InMemoryBillingStore();
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
        externalReference: 'shared-ref',
      });
    }
    (globalThis as Record<symbol, unknown>)[TENANCY] = {
      version: 1,
      tenancy: () => ({ enabled: true, required: false }),
      tenantFilter: () => ({
        mode: 'tenant',
        tenant: { id: 'a', kind: 'organization', source: 'authkit' },
      }),
      withTenant: <T>(_i: unknown, fn: () => T) => fn(),
      allTenants: <T>(fn: () => T) => fn(),
    };
    const { app, handlers, container } = fakeApp({});
    await registerAgoraConsole(
      container,
      entry({
        id: 'durable',
        order: 10,
        search: async (_c, q) => [{ title: `run ${q}`, href: '/durable#/run/1' }],
      }),
    );
    await new DashboardProvider(app).boot();

    // From payments' own endpoint: organization a sees its payment, never b's.
    const { ctx: c, out } = jsonCtx({ q: 'shared-ref', tenant: 'b' });
    await handlers.get('get /payments/api/consoles/search')?.(c);
    expect(out.body).toEqual({
      version: 1,
      q: 'shared-ref',
      results: [
        {
          id: 'durable',
          title: 'durable',
          icon: 'generic',
          hits: [{ title: 'run shared-ref', href: '/durable#/run/1' }],
        },
        {
          id: 'payments',
          title: 'Payments',
          icon: 'payments',
          hits: [
            {
              title: 'pay_a',
              subtitle: 'payment · paid · fake · shared-ref',
              href: '/payments#/payments/pay_a',
            },
          ],
        },
      ],
    });
    // A forged `?tenant=` on another console's page is not a pick here, and is not audited.
    expect(await store.listAuditEvents({})).toEqual([]);

    // From another console's search (payments' entry asked through the registry).
    const registry = container.values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    const other = await searchConsoles(registry, 'durable', jsonCtx().ctx, 'pay_b');
    expect(other.results.find((r) => r.id === 'payments')).toBeUndefined();
  });

  it('counts no other console when payments is alone', async () => {
    const { app, container } = fakeApp({});
    await new DashboardProvider(app).boot();
    expect(otherConsoles(container.values.get(AGORA_CONSOLES_BINDING) as never, 'payments')).toBe(
      0,
    );
  });
});
