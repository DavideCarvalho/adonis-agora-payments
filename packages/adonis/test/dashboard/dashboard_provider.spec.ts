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
      'GET /payments/api/disputes',
      'GET /payments/api/subscriptions',
      'GET /payments/api/webhook-events',
      'GET /payments/api/providers',
      'POST /payments/api/payments/:gatewayId/refund',
      'POST /payments/api/webhook-events/:gatewayEventId/retry',
    ]);
  });

  it('exposes disputes as a read and nothing else', async () => {
    // No accept, no fight, no "submit evidence": whether to answer a chargeback or refund it
    // is a business rule that stays in the app's code. A write route here would be a decision
    // this console is not entitled to make.
    const routes = await bootWith({});
    const dispute = routes.filter((r) => r.pattern.includes('/disputes'));
    expect(dispute.map((r) => r.method)).toEqual(['get']);
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
      '/ops/billing/api/disputes',
      '/ops/billing/api/subscriptions',
      '/ops/billing/api/webhook-events',
      '/ops/billing/api/providers',
      '/ops/billing/api/payments/:gatewayId/refund',
      '/ops/billing/api/webhook-events/:gatewayEventId/retry',
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
      '/api/disputes',
      '/api/subscriptions',
      '/api/webhook-events',
      '/api/providers',
      '/api/payments/:gatewayId/refund',
      '/api/webhook-events/:gatewayEventId/retry',
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
