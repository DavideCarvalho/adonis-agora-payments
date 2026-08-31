import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DashboardProvider from '../../providers/dashboard_provider.js';
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
      'GET /payments/api/webhook-events',
      'GET /payments/api/providers',
      'POST /payments/api/payments/:gatewayId/refund',
      'POST /payments/api/webhook-events/:gatewayEventId/retry',
      'POST /payments/api/disputes/:gatewayId/resolve',
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
      '/ops/billing/api/webhook-events',
      '/ops/billing/api/providers',
      '/ops/billing/api/payments/:gatewayId/refund',
      '/ops/billing/api/webhook-events/:gatewayEventId/retry',
      '/ops/billing/api/disputes/:gatewayId/resolve',
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
      '/api/webhook-events',
      '/api/providers',
      '/api/payments/:gatewayId/refund',
      '/api/webhook-events/:gatewayEventId/retry',
      '/api/disputes/:gatewayId/resolve',
    ]);
  });

  it('leaves the actions absent along with everything else when disabled', async () => {
    // "Registered but 403ing" is not the same as absent: the endpoint still answers, and a write
    // endpoint that answers is a write endpoint someone can probe.
    expect(await bootWith({ enabled: false })).toEqual([]);
  });

  it('adds no auth routes when dashboardAuth is unconfigured', async () => {
    const routes = await bootWith({});
    expect(routes.some((r) => r.pattern.includes('login'))).toBe(false);
    expect(routes.some((r) => r.pattern.includes('logout'))).toBe(false);
  });

  it('adds the login page + submit + logout for Mode B', async () => {
    const routes = await bootWith({
      dashboardAuth: { secret: 's'.repeat(32), login: () => null },
    });
    const named = routes.map((r) => `${r.method.toUpperCase()} ${r.pattern}`);
    expect(named).toContain('GET /payments/login');
    expect(named).toContain('POST /payments/login');
    expect(named).toContain('GET /payments/logout');
    // Mode B alone must not mount the host-session mint endpoint.
    expect(named).not.toContain('POST /payments/session');
  });

  it('adds the session mint (and no login page) for Mode A alone', async () => {
    const routes = await bootWith({
      dashboardAuth: { secret: 's'.repeat(32), session: () => null },
    });
    const named = routes.map((r) => `${r.method.toUpperCase()} ${r.pattern}`);
    expect(named).toContain('POST /payments/session');
    expect(named).toContain('GET /payments/logout');
    expect(named).not.toContain('GET /payments/login');
  });

  it('registers no auth routes at all when disabled, even with dashboardAuth set', async () => {
    expect(
      await bootWith({
        enabled: false,
        dashboardAuth: { secret: 's'.repeat(32), login: () => null },
      }),
    ).toEqual([]);
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
  function fakeCtx(recorded: Recorded, cookie?: string) {
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
        plainCookie: () => cookie,
        secure: () => false,
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

    it(`401s the ${name} action when dashboardAuth is on and there is no session`, async () => {
      const recorded: Recorded = {};
      const handler = await routeHandler(
        { dashboardAuth: { secret: 's'.repeat(32), login: () => null } },
        pattern,
      );
      await handler(fakeCtx(recorded));
      expect(recorded.status).toBe(401);
      expect(recorded.body).toMatchObject({ error: 'unauthorized' });
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
        plainCookie: () => undefined,
        secure: () => false,
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

  it('serves the "open from your app" page (401) when only a session hook is configured', async () => {
    const recorded: Recorded = { headers: {} };
    await (await pageHandler({ dashboardAuth: { secret: 's'.repeat(32), session: () => null } }))(
      fakeCtx(recorded),
    );
    expect(recorded.status).toBe(401);
    expect(recorded.body).toContain('<h1>Open this console from your app</h1>');
    expect(recorded.body).not.toContain('/payments/login');
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
        dashboardAuth: { secret: 's'.repeat(32), login: () => null },
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
      loginHref: '/payments/login',
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

  it('puts the CSP nonce on the inline <style> when the host exposes one', async () => {
    const recorded: Recorded = { headers: {} };
    await (await pageHandler({ authorize: () => false }))(fakeCtx(recorded, { nonce: 'n0nce' }));
    expect(recorded.body).toContain('<style nonce="n0nce">');
  });
});

/**
 * The built-in login page must work with its script dropped by a CSP (or JavaScript off): the
 * same `POST` answers JSON to the page's `fetch` and a redirect to a classic form submit.
 */
describe('login routes: JSON for the script, redirects for a plain form', () => {
  interface Recorded {
    status?: number;
    body?: unknown;
    headers: Record<string, string>;
    redirect?: { path: string; qs?: Record<string, string> };
    cookie?: string;
  }

  function fakeCtx(
    recorded: Recorded,
    request: { body?: unknown; contentType?: string; qs?: Record<string, unknown>; nonce?: string },
  ) {
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
      redirect: () => {
        let qs: Record<string, string> | undefined;
        const chain = {
          withQs(value: Record<string, string>) {
            qs = value;
            return chain;
          },
          toPath(path: string) {
            recorded.redirect = qs ? { path, qs } : { path };
          },
        };
        return chain;
      },
      plainCookie: (_name: string, value: string) => {
        recorded.cookie = value;
      },
      ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
    };
    return {
      response,
      params: {},
      request: {
        qs: () => request.qs ?? {},
        body: () => request.body ?? {},
        header: (name: string) =>
          name.toLowerCase() === 'content-type' ? request.contentType : undefined,
        url: () => '/payments',
        plainCookie: () => undefined,
        secure: () => false,
        headers: () => ({}),
      },
    };
  }

  const config: PaymentsDashboardConfig = {
    dashboardAuth: {
      secret: 's'.repeat(32),
      login: (username, password) =>
        username === 'ana' && password === 'pw' ? { id: 'u1', name: 'Ana' } : null,
    },
  };

  async function handler(method: 'get' | 'post') {
    const routes = await bootWith(config);
    const route = routes.find((r) => r.pattern === '/payments/login' && r.method === method);
    expect(route?.handler).toBeTypeOf('function');
    return route?.handler as (ctx: unknown) => Promise<unknown>;
  }

  it('GET renders the page with the sanitized returnTo, the error flag and the CSP nonce', async () => {
    const recorded: Recorded = { headers: {} };
    await (await handler('get'))(
      fakeCtx(recorded, { qs: { returnTo: '/payments/p/1', error: '1' }, nonce: 'n0nce' }),
    );
    expect(recorded.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(recorded.body).toContain('name="returnTo" value="/payments/p/1"');
    expect(recorded.body).toContain('role="alert" style="display:block"');
    expect(recorded.body).toContain('<script nonce="n0nce">');

    const open: Recorded = { headers: {} };
    await (await handler('get'))(fakeCtx(open, { qs: { returnTo: '//evil.com' } }));
    expect(open.body).toContain('name="returnTo" value="/payments"');
    expect(open.body).not.toContain('style="display:block"');
  });

  it('POST as JSON keeps answering JSON', async () => {
    const ok: Recorded = { headers: {} };
    await (await handler('post'))(
      fakeCtx(ok, {
        contentType: 'application/json',
        body: { username: 'ana', password: 'pw', returnTo: '/payments/p/1' },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ redirectTo: '/payments/p/1' });
    expect(ok.cookie).toBeTypeOf('string');
    expect(ok.redirect).toBeUndefined();

    const bad: Recorded = { headers: {} };
    await (await handler('post'))(
      fakeCtx(bad, { contentType: 'application/json', body: { username: 'ana', password: 'x' } }),
    );
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'Invalid username or password.' });
  });

  it('POST as a form redirects: to returnTo on success, back to the login page on failure', async () => {
    const ok: Recorded = { headers: {} };
    await (await handler('post'))(
      fakeCtx(ok, {
        contentType: 'application/x-www-form-urlencoded',
        body: { username: 'ana', password: 'pw', returnTo: '/payments/p/1' },
      }),
    );
    expect(ok.cookie).toBeTypeOf('string');
    expect(ok.redirect).toEqual({ path: '/payments/p/1' });
    expect(ok.body).toBeUndefined();

    const bad: Recorded = { headers: {} };
    await (await handler('post'))(
      fakeCtx(bad, {
        contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        body: { username: 'ana', password: 'x', returnTo: '/payments/p/1' },
      }),
    );
    expect(bad.cookie).toBeUndefined();
    expect(bad.redirect).toEqual({
      path: '/payments/login',
      qs: { error: '1', returnTo: '/payments/p/1' },
    });

    const malformed: Recorded = { headers: {} };
    await (await handler('post'))(
      fakeCtx(malformed, {
        contentType: 'application/x-www-form-urlencoded',
        body: { returnTo: 'https://evil.com' },
      }),
    );
    expect(malformed.redirect).toEqual({
      path: '/payments/login',
      qs: { error: '1', returnTo: '/payments' },
    });
  });
});
