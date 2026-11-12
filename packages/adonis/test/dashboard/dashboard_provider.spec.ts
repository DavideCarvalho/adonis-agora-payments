import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DashboardProvider, {
  auditActor,
  NO_AUTHORIZE_WARNING,
} from '../../providers/dashboard_provider.js';
import { authorizeByToken } from '../../src/dashboard/console_authorize.js';
import type { PaymentsDashboardConfig } from '../../src/dashboard/define_config.js';

/**
 * The provider's ROUTE-REGISTRATION contract.
 *
 * `enabled: false` has to mean the dashboard is absent from the app, not merely guarded: a
 * registered-but-403ing console still answers, still appears in `node ace list:routes`, and still
 * tells an attacker the endpoint exists. The only way to observe the difference is to watch what
 * reaches the router, which is what the fake below is for.
 */

interface RegisteredRoute {
  method: 'get' | 'post';
  pattern: string;
  name?: string;
  /** The route's own handler, so a test can drive it with a fake context. */
  handler?: (ctx: unknown) => Promise<unknown>;
}

/** A router stand-in recording every registration, with the `.as()` chain the provider uses. */
function fakeRouter(): { routes: RegisteredRoute[]; router: never } {
  const routes: RegisteredRoute[] = [];
  const register =
    (method: 'get' | 'post') => (pattern: string, handler?: (ctx: unknown) => Promise<unknown>) => {
      const route: RegisteredRoute = { method, pattern, ...(handler ? { handler } : {}) };
      routes.push(route);
      return {
        as(name: string) {
          route.name = name;
          return this;
        },
      };
    };
  return {
    routes,
    router: { get: register('get'), post: register('post') } as never,
  };
}

/** An `ApplicationService` stand-in exposing only what `boot()` touches. */
function fakeApp(config: PaymentsDashboardConfig, router: unknown): ApplicationService {
  return {
    config: { get: () => config },
    booted: async (callback: () => Promise<void>) => {
      await callback();
    },
    container: { make: async () => router },
  } as unknown as ApplicationService;
}

async function bootWith(config: PaymentsDashboardConfig): Promise<RegisteredRoute[]> {
  const { routes, router } = fakeRouter();
  const provider = new DashboardProvider(fakeApp(config, router));
  await provider.boot();
  return routes;
}

describe('PaymentsDashboardProvider route registration', () => {
  it('registers NOTHING at all when disabled', async () => {
    // Not "registers routes that 403" — registers nothing. The console is absent.
    expect(await bootWith({ enabled: false })).toEqual([]);
  });

  it('registers the SPA, the read endpoints and the two actions by default', async () => {
    const routes = await bootWith({});
    expect(routes.map((r) => `${r.method.toUpperCase()} ${r.pattern}`)).toEqual([
      'GET /payments',
      'GET /payments/assets/:file',
      'GET /payments/api/health',
      'GET /payments/api/overview',
      'GET /payments/api/payments',
      'GET /payments/api/payments/:gatewayId',
      'GET /payments/api/customers',
      'GET /payments/api/audit',
      'GET /payments/api/disputes',
      'GET /payments/api/subscriptions',
      'GET /payments/api/subscriptions/:id',
      'GET /payments/api/webhook-events',
      'GET /payments/api/providers',
      'POST /payments/api/payments/:gatewayId/refund',
      'POST /payments/api/webhook-events/:gatewayEventId/retry',
      'POST /payments/api/disputes/:gatewayId/resolve',
      'GET /payments/api/consoles',
      'GET /payments/api/consoles/search',
      'GET /payments/api/tenants',
    ]);
  });

  it('exposes disputes as a read plus exactly one write, and that write is a POST', async () => {
    // Still no accept, no fight, no "submit evidence": whether to ANSWER a chargeback or refund
    // it is a business rule that stays in the app's code, and none of those routes exist. The
    // one write is `resolve`, which sends nothing to a gateway — it records how a dispute ended,
    // because several gateways publish no lost-dispute event and would otherwise leave the row
    // open forever, holding the health check red until nobody reads it.
    const routes = await bootWith({});
    const dispute = routes.filter((r) => r.pattern.includes('/disputes'));
    expect(dispute.map((r) => `${r.method} ${r.pattern}`)).toEqual([
      'get /payments/api/disputes',
      'post /payments/api/disputes/:gatewayId/resolve',
    ]);
  });

  it('registers the refund and the retry as POST ONLY — never reachable by URL', async () => {
    // A refund behind a `GET` is a refund a crawler, a prefetcher or a pasted link can trigger.
    const routes = await bootWith({});
    const actions = routes.filter(
      (r) => r.pattern.includes('/refund') || r.pattern.includes('/retry'),
    );
    expect(actions).toHaveLength(2);
    expect(actions.every((r) => r.method === 'post')).toBe(true);
    expect(routes.some((r) => r.method === 'get' && r.pattern.includes('/refund'))).toBe(false);
    expect(routes.some((r) => r.method === 'get' && r.pattern.includes('/retry'))).toBe(false);
  });

  it("cannot shadow the package's own machine endpoints", async () => {
    // The dashboard mounts at `/payments`, the same prefix as `POST
    // /payments/webhook/:provider` and `GET /payments/client/status`. That is safe for one
    // reason and one reason only: every route here is an EXACT path, so the dashboard's
    // `enforce` guard cannot reach a delivery it was never routed. A webhook 403'd by a
    // console looks exactly like a gateway outage from the outside, and would be found by
    // reading someone else's retry logs.
    const patterns = (await bootWith({})).map((r) => r.pattern);

    expect(patterns).not.toContain('/payments/webhook/:provider');
    expect(patterns).not.toContain('/payments/client/status');
    // The real invariant: no catch-all. A wildcard under this prefix would swallow both.
    expect(patterns.filter((p) => p.includes('*'))).toEqual([]);
    // And nothing dynamic directly under the prefix, which `:provider` and `client` would
    // both match.
    expect(patterns.filter((p) => /^\/payments\/:[^/]+$/.test(p))).toEqual([]);
  });

  it('honors a custom mount path everywhere, including the API and the actions', async () => {
    const routes = await bootWith({ path: 'ops/billing/' });
    expect(routes.map((r) => r.pattern)).toEqual([
      '/ops/billing',
      '/ops/billing/assets/:file',
      '/ops/billing/api/health',
      '/ops/billing/api/overview',
      '/ops/billing/api/payments',
      '/ops/billing/api/payments/:gatewayId',
      '/ops/billing/api/customers',
      '/ops/billing/api/audit',
      '/ops/billing/api/disputes',
      '/ops/billing/api/subscriptions',
      '/ops/billing/api/subscriptions/:id',
      '/ops/billing/api/webhook-events',
      '/ops/billing/api/providers',
      '/ops/billing/api/payments/:gatewayId/refund',
      '/ops/billing/api/webhook-events/:gatewayEventId/retry',
      '/ops/billing/api/disputes/:gatewayId/resolve',
      '/ops/billing/api/consoles',
      '/ops/billing/api/consoles/search',
      '/ops/billing/api/tenants',
    ]);
  });

  it('mounts at the router root without a doubled slash when path is "/"', async () => {
    const routes = await bootWith({ path: '/' });
    expect(routes.map((r) => r.pattern)).toEqual([
      '/',
      '/assets/:file',
      '/api/health',
      '/api/overview',
      '/api/payments',
      '/api/payments/:gatewayId',
      '/api/customers',
      '/api/audit',
      '/api/disputes',
      '/api/subscriptions',
      '/api/subscriptions/:id',
      '/api/webhook-events',
      '/api/providers',
      '/api/payments/:gatewayId/refund',
      '/api/webhook-events/:gatewayEventId/retry',
      '/api/disputes/:gatewayId/resolve',
      '/api/consoles',
      '/api/consoles/search',
      '/api/tenants',
    ]);
  });

  it('leaves the actions absent along with everything else when disabled', async () => {
    // "Registered but 403ing" is not the same as absent: the endpoint still answers, and a write
    // endpoint that answers is a write endpoint someone can probe.
    expect(await bootWith({ enabled: false })).toEqual([]);
  });

  it("registers no login, session or logout route: sign-in is the app's own", async () => {
    const patterns = (await bootWith({})).map((r) => r.pattern);
    expect(patterns.some((p) => /\/(login|logout|session)$/.test(p))).toBe(false);
  });

  it('names every route so an app can reference them by name', async () => {
    const routes = await bootWith({});
    expect(routes.every((r) => r.name?.startsWith('payments_dashboard.'))).toBe(true);
  });
});

/**
 * The guards on the WRITE routes.
 *
 * These are the first endpoints this console has ever had that CHANGE something, so "the actions
 * go through the same guard as the reads" is verified here rather than assumed from the fact that
 * they share a helper. The route's real handler is driven with a stand-in context.
 */
describe('action routes are guarded', () => {
  interface Recorded {
    status?: number;
    body?: unknown;
  }

  /** A minimal `HttpContext` stand-in: enough for `enforce` plus the JSON reply. */
  function fakeCtx(recorded: Recorded) {
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
      redirect: () => ({ withQs: () => ({ toPath: () => undefined }) }),
      header() {
        return this;
      },
      send: () => undefined,
    };
    return {
      response,
      params: { gatewayId: 'pi_1', gatewayEventId: 'evt_1' },
      request: {
        qs: () => ({}),
        body: () => ({}),
        url: () => '/payments',
        header: () => undefined,
        headers: () => ({}),
      },
    };
  }

  async function routeHandler(config: PaymentsDashboardConfig, pattern: string) {
    const routes = await bootWith(config);
    const route = routes.find((r) => r.pattern === pattern && r.method === 'post');
    expect(route?.handler).toBeTypeOf('function');
    return route?.handler as (ctx: unknown) => Promise<unknown>;
  }

  const REFUND = '/payments/api/payments/:gatewayId/refund';
  const RETRY = '/payments/api/webhook-events/:gatewayEventId/retry';

  for (const [name, pattern] of [
    ['refund', REFUND],
    ['retry', RETRY],
  ] as const) {
    it(`403s the ${name} action when authorize denies`, async () => {
      const recorded: Recorded = {};
      const handler = await routeHandler({ authorize: () => false }, pattern);
      await handler(fakeCtx(recorded));
      expect(recorded.status).toBe(403);
      expect(recorded.body).toEqual({ error: 'forbidden' });
    });

    it(`401s the ${name} action when authorize says nobody is signed in`, async () => {
      const recorded: Recorded = {};
      const handler = await routeHandler(
        { authorize: () => ({ allowed: false, reason: 'unauthenticated' }) },
        pattern,
      );
      await handler(fakeCtx(recorded));
      expect(recorded.status).toBe(401);
      expect(recorded.body).toEqual({ error: 'unauthenticated' });
    });

    it(`lets the ${name} action past the guard only to hit the missing billing store`, async () => {
      // Proves the ordering: the guard runs FIRST, and what stops an authorized request here is
      // the store being absent in this test app — a 503, not a 403.
      const recorded: Recorded = {};
      const handler = await routeHandler({ authorize: () => true }, pattern);
      await handler(fakeCtx(recorded));
      expect(recorded.status).toBe(503);
    });
  }
});

/**
 * A BROWSER that is refused gets a page, not the API's JSON. The shell and the assets route are
 * `page` requests; the API stays JSON so the SPA's `fetch` calls keep parsing it.
 */
describe('page routes are refused with the access-denied page', () => {
  interface Recorded {
    status?: number;
    body?: unknown;
    headers: Record<string, string>;
  }

  function fakeCtx(recorded: Recorded, extra: Record<string, unknown> = {}) {
    const response = {
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
      redirect: () => ({ withQs: () => ({ toPath: () => undefined }) }),
      ...extra,
    };
    return {
      response,
      params: { file: 'index.js' },
      request: {
        qs: () => ({}),
        body: () => ({}),
        url: () => '/payments',
        header: () => undefined,
        headers: () => ({}),
      },
    };
  }

  async function pageHandler(config: PaymentsDashboardConfig, pattern = '/payments') {
    const routes = await bootWith(config);
    const route = routes.find((r) => r.pattern === pattern && r.method === 'get');
    expect(route?.handler).toBeTypeOf('function');
    return route?.handler as (ctx: unknown) => Promise<unknown>;
  }

  it('answers a forbidden shell navigation with the built-in 403 page', async () => {
    const recorded: Recorded = { headers: {} };
    await (await pageHandler({ authorize: () => false }))(fakeCtx(recorded));
    expect(recorded.status).toBe(403);
    expect(recorded.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(recorded.headers['cache-control']).toBe('no-store, must-revalidate');
    expect(recorded.body).toContain('<!doctype html>');
    expect(recorded.body).toContain('<h1>Access denied</h1>');
    expect(recorded.body).toContain('Payments');
  });

  it('refuses the assets route the same way', async () => {
    const recorded: Recorded = { headers: {} };
    await (await pageHandler({ authorize: () => false }, '/payments/assets/:file'))(
      fakeCtx(recorded),
    );
    expect(recorded.status).toBe(403);
    expect(recorded.body).toContain('<h1>Access denied</h1>');
  });

  it('keeps JSON for the API', async () => {
    const recorded: Recorded = { headers: {} };
    await (await pageHandler({ authorize: () => false }, '/payments/api/health'))(
      fakeCtx(recorded),
    );
    expect(recorded.status).toBe(403);
    expect(recorded.body).toEqual({ error: 'forbidden' });
  });

  it('applies the accessDenied object options', async () => {
    const recorded: Recorded = { headers: {} };
    await (
      await pageHandler({
        authorize: () => false,
        accessDenied: { brand: 'Entre Textos', title: 'Sem acesso', homeHref: '/admin' },
      })
    )(fakeCtx(recorded));
    expect(recorded.body).toContain('<h1>Sem acesso</h1>');
    expect(recorded.body).toContain('Entre Textos');
    expect(recorded.body).toContain('href="/admin"');
  });

  it('serves a renderer function HTML with the refusal info and the ctx', async () => {
    const recorded: Recorded = { headers: {} };
    const ctx = fakeCtx(recorded);
    let seen: unknown[] = [];
    await (
      await pageHandler({
        authorize: () => false,
        accessDenied: (info, c) => {
          seen = [info, c];
          return '<p>custom</p>';
        },
      })
    )(ctx);
    expect(recorded.status).toBe(403);
    expect(recorded.body).toBe('<p>custom</p>');
    expect(seen[0]).toEqual({
      status: 403,
      reason: 'forbidden',
      basePath: '/payments',
    });
    expect(seen[1]).toBe(ctx);
  });

  it('stands down when the renderer redirected instead of returning HTML', async () => {
    const recorded: Recorded = { headers: {} };
    await (
      await pageHandler({
        authorize: () => false,
        accessDenied: (_info, c) => {
          (c.response as unknown as { header(n: string, v: string): void }).header(
            'location',
            '/login',
          );
        },
      })
    )(fakeCtx(recorded));
    expect(recorded.headers.location).toBe('/login');
    expect(recorded.body).toBeUndefined();
  });

  it('never overwrites a redirect the authorize hook already wrote', async () => {
    const recorded: Recorded = { headers: {} };
    await (
      await pageHandler({
        authorize: (c) => {
          (c.response as unknown as { header(n: string, v: string): void }).header(
            'location',
            '/login',
          );
          return false;
        },
      })
    )(fakeCtx(recorded));
    expect(recorded.headers.location).toBe('/login');
    expect(recorded.status).toBeUndefined();
    expect(recorded.body).toBeUndefined();
  });

  describe('the dashboard-gate contract (boolean | { allowed, reason })', () => {
    // A decision OBJECT is truthy: a guard written as `if (!(await authorize(ctx)))` would let
    // `{ allowed: false }` straight through. These pin that it denies, on both surfaces.
    const API = '/payments/api/health';
    const cases: Array<{
      name: string;
      authorize: NonNullable<PaymentsDashboardConfig['authorize']>;
      status: 401 | 403;
      error: 'unauthenticated' | 'forbidden';
      heading: string;
    }> = [
      {
        name: '{ allowed: false }',
        authorize: () => ({ allowed: false }),
        status: 403,
        error: 'forbidden',
        heading: '<h1>Access denied</h1>',
      },
      {
        name: "reason 'forbidden'",
        authorize: async () => ({ allowed: false, reason: 'forbidden' }),
        status: 403,
        error: 'forbidden',
        heading: '<h1>Access denied</h1>',
      },
      {
        name: "reason 'unauthenticated'",
        authorize: () => ({ allowed: false, reason: 'unauthenticated' }),
        status: 401,
        error: 'unauthenticated',
        heading: '<h1>',
      },
      {
        name: 'bare false',
        authorize: () => false,
        status: 403,
        error: 'forbidden',
        heading: '<h1>Access denied</h1>',
      },
      {
        name: 'a throwing hook',
        authorize: () => {
          throw new Error('auth backend down');
        },
        status: 403,
        error: 'forbidden',
        heading: '<h1>Access denied</h1>',
      },
    ];

    for (const c of cases) {
      it(`${c.name} -> ${c.status} page`, async () => {
        const recorded: Recorded = { headers: {} };
        await (await pageHandler({ authorize: c.authorize }))(fakeCtx(recorded));
        expect(recorded.status).toBe(c.status);
        expect(recorded.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(recorded.body).toContain(c.heading);
      });

      it(`${c.name} -> ${c.status} JSON on the API`, async () => {
        const recorded: Recorded = { headers: {} };
        await (await pageHandler({ authorize: c.authorize }, API))(fakeCtx(recorded));
        expect(recorded.status).toBe(c.status);
        expect(recorded.body).toEqual({ error: c.error });
      });
    }

    it('hands the matching reason to an accessDenied renderer', async () => {
      const seen: unknown[] = [];
      const recorded: Recorded = { headers: {} };
      await (
        await pageHandler({
          authorize: () => ({ allowed: false, reason: 'unauthenticated' }),
          accessDenied: (info) => {
            seen.push(info);
            return '<p>x</p>';
          },
        })
      )(fakeCtx(recorded));
      expect(seen[0]).toMatchObject({ status: 401, reason: 'unauthenticated' });
      expect(recorded.status).toBe(401);
    });

    for (const [name, authorize] of [
      ['true', () => true],
      ['{ allowed: true }', () => ({ allowed: true })],
    ] as const) {
      it(`${name} lets the API request through`, async () => {
        const recorded: Recorded = { headers: {} };
        await (await pageHandler({ authorize }, API))(fakeCtx(recorded));
        expect(recorded.status).not.toBe(401);
        expect(recorded.status).not.toBe(403);
        expect(recorded.body).not.toEqual({ error: 'forbidden' });
      });
    }

    it('keeps a redirect the hook wrote even when it answers { allowed: false } (page and API)', async () => {
      for (const pattern of ['/payments', API]) {
        const recorded: Recorded = { headers: {} };
        await (
          await pageHandler(
            {
              authorize: (c) => {
                (c.response as unknown as { header(n: string, v: string): void }).header(
                  'location',
                  '/login',
                );
                return { allowed: false, reason: 'unauthenticated' };
              },
            },
            pattern,
          )
        )(fakeCtx(recorded));
        expect(recorded.headers.location).toBe('/login');
        expect(recorded.status).toBeUndefined();
        expect(recorded.body).toBeUndefined();
      }
    });

    it('takes an authorizer class, built through the request container', async () => {
      class Access {
        constructor(private allow: boolean) {}
        authorize() {
          return this.allow
            ? true
            : { allowed: false as const, reason: 'unauthenticated' as const };
        }
      }
      for (const [allow, status] of [
        [false, 401],
        [true, undefined],
      ] as const) {
        const recorded: Recorded = { headers: {} };
        const ctx = {
          ...fakeCtx(recorded),
          containerResolver: { make: async (C: typeof Access) => new C(allow) },
        };
        await (await pageHandler({ authorize: Access }, API))(ctx);
        if (status) expect(recorded.status).toBe(status);
        else expect([401, 403]).not.toContain(recorded.status);
      }
    });

    it('takes a lazy import and runs the import once', async () => {
      class Access {
        authorize() {
          return false;
        }
      }
      let imports = 0;
      const handler = await pageHandler(
        {
          authorize: async () => {
            imports += 1;
            return { default: Access };
          },
        },
        API,
      );
      for (let i = 0; i < 2; i += 1) {
        const recorded: Recorded = { headers: {} };
        await handler(fakeCtx(recorded));
        expect(recorded.status).toBe(403);
        expect(recorded.body).toEqual({ error: 'forbidden' });
      }
      expect(imports).toBe(1);
    });

    it('redirects a page navigation on { redirectTo } and answers 401 JSON on the API', async () => {
      const page: Recorded = { headers: {} };
      const redirect = (url: string) => {
        page.headers.location = url;
      };
      await (await pageHandler({ authorize: () => ({ redirectTo: '/auth/login' }) }))(
        fakeCtx(page, { redirect }),
      );
      expect(page.headers.location).toBe('/auth/login');
      expect(page.body).toBeUndefined();

      const api: Recorded = { headers: {} };
      await (await pageHandler({ authorize: () => ({ redirectTo: '/auth/login' }) }, API))(
        fakeCtx(api),
      );
      expect(api.status).toBe(401);
      expect(api.body).toEqual({ error: 'unauthenticated', redirectTo: '/auth/login' });
      expect(api.headers.location).toBeUndefined();
    });
  });

  it('puts the CSP nonce on the inline <style> when the host exposes one', async () => {
    const recorded: Recorded = { headers: {} };
    await (await pageHandler({ authorize: () => false }))(fakeCtx(recorded, { nonce: 'n0nce' }));
    expect(recorded.body).toContain('<style nonce="n0nce">');
  });
});

/** Who a refund or a dispute resolution is recorded against. */
describe('auditActor', () => {
  function ctx(user: Record<string, unknown> | null, authorization?: string) {
    return {
      ...(user !== undefined ? { auth: { user } } : {}),
      request: {
        header: (name: string) => (name === 'authorization' ? authorization : undefined),
      },
    } as never;
  }

  it("names the app's signed-in user by email, then name, then id", () => {
    expect(auditActor(ctx({ email: 'ana@x.dev', name: 'Ana', id: 7 }))).toBe('ana@x.dev');
    expect(auditActor(ctx({ name: 'Ana', id: 7 }))).toBe('Ana');
    expect(auditActor(ctx({ id: 7 }))).toBe('7');
  });

  it('says bearer for a token caller and leaves everyone else unattributed', () => {
    expect(auditActor(ctx(null, 'Bearer t0ken'))).toBe('bearer');
    expect(auditActor(ctx(null))).toBeUndefined();
  });
});

/**
 * The default when `authorize` is omitted: open outside production, every request a 403 in
 * production, and ONE boot warning (in either environment) telling the host to set `authorize`.
 */
describe('the default when authorize is omitted', () => {
  const API = '/payments/api/health';
  const PAGE = '/payments';

  async function boot(config: PaymentsDashboardConfig, inProduction: boolean) {
    const { routes, router } = fakeRouter();
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const app = {
      inProduction,
      config: { get: () => config },
      booted: async (callback: () => Promise<void>) => {
        await callback();
      },
      container: { make: async (name: string) => (name === 'logger' ? logger : router) },
    } as unknown as ApplicationService;
    await new DashboardProvider(app).boot();
    const handler = (pattern: string) =>
      routes.find((r) => r.pattern === pattern)?.handler as (ctx: unknown) => Promise<unknown>;
    return { warnings, handler };
  }

  function ctx(
    recorded: { status?: number; body?: unknown; headers?: Record<string, string> },
    headers: Record<string, string> = {},
  ) {
    recorded.headers ??= {};
    const sent = recorded.headers;
    return {
      params: {},
      request: {
        header: (name: string) => headers[name.toLowerCase()],
        qs: () => ({ token: 'secret' }),
        body: () => ({}),
      },
      response: {
        getHeader: (name: string) => sent[name.toLowerCase()],
        status(code: number) {
          recorded.status = code;
          return this;
        },
        json(body: unknown) {
          recorded.body = body;
          return this;
        },
        header(name: string, value: string) {
          sent[name.toLowerCase()] = value;
          return this;
        },
        send(body: unknown) {
          recorded.body = body;
        },
      },
    };
  }

  it('denies the API and the page with 403 in production, warning exactly once at boot', async () => {
    const { warnings, handler } = await boot({}, true);
    expect(warnings).toEqual([NO_AUTHORIZE_WARNING]);
    for (let i = 0; i < 2; i += 1) {
      const recorded: { status?: number; body?: unknown } = {};
      await handler(API)(ctx(recorded));
      expect(recorded.status).toBe(403);
      expect(recorded.body).toEqual({ error: 'forbidden' });
    }
    const page: { status?: number; body?: unknown } = {};
    await handler(PAGE)(ctx(page));
    expect(page.status).toBe(403);
    expect(page.body).toContain('<h1>Access denied</h1>');
    expect(warnings).toHaveLength(1);
  });

  it('uses the shared wording', () => {
    expect(NO_AUTHORIZE_WARNING).toBe(
      '[@adonis-agora/payments] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/payments_dashboard.ts.',
    );
  });

  it('no longer accepts PAYMENTS_DASHBOARD_TOKEN or any token in production', async () => {
    const saved = process.env.PAYMENTS_DASHBOARD_TOKEN;
    process.env.PAYMENTS_DASHBOARD_TOKEN = 'secret';
    try {
      const { handler } = await boot({}, true);
      const recorded: { status?: number; body?: unknown } = {};
      await handler(API)(
        ctx(recorded, { authorization: 'Bearer secret', 'x-payments-token': 'secret' }),
      );
      expect(recorded.status).toBe(403);
    } finally {
      if (saved === undefined) delete process.env.PAYMENTS_DASHBOARD_TOKEN;
      else process.env.PAYMENTS_DASHBOARD_TOKEN = saved;
    }
  });

  it('is open outside production, and still warns once', async () => {
    const { warnings, handler } = await boot({}, false);
    expect(warnings).toEqual([NO_AUTHORIZE_WARNING]);
    const recorded: { status?: number; body?: unknown } = {};
    await handler(API)(ctx(recorded));
    expect([401, 403]).not.toContain(recorded.status);
  });

  it('does not warn when authorize is configured', async () => {
    const { warnings } = await boot({ authorize: () => true }, true);
    expect(warnings).toEqual([]);
  });

  it('gates machine access with authorizeByToken: 401 without the bearer, through with it', async () => {
    const { handler } = await boot({ authorize: authorizeByToken({ token: 'secret' }) }, true);
    const denied: { status?: number; body?: unknown } = {};
    await handler(API)(ctx(denied));
    expect(denied).toMatchObject({ status: 401, body: { error: 'unauthenticated' } });
    const allowed: { status?: number; body?: unknown } = {};
    await handler(API)(ctx(allowed, { authorization: 'Bearer secret' }));
    expect([401, 403]).not.toContain(allowed.status);
  });
});
