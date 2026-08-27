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
}

/** A router stand-in recording every registration, with the `.as()` chain the provider uses. */
function fakeRouter(): { routes: RegisteredRoute[]; router: never } {
  const routes: RegisteredRoute[] = [];
  const register = (method: 'get' | 'post') => (pattern: string) => {
    const route: RegisteredRoute = { method, pattern };
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

  it('registers the SPA and the three read endpoints by default', async () => {
    const routes = await bootWith({});
    expect(routes.map((r) => `${r.method.toUpperCase()} ${r.pattern}`)).toEqual([
      'GET /payments-dashboard',
      'GET /payments-dashboard/assets/:file',
      'GET /payments-dashboard/api/overview',
      'GET /payments-dashboard/api/payments',
      'GET /payments-dashboard/api/webhook-events',
    ]);
  });

  it('registers no control actions — this console only reads', async () => {
    const routes = await bootWith({});
    expect(routes.filter((r) => r.method === 'post')).toEqual([]);
  });

  it("does not collide with the package's own POST /payments/webhook/:provider", async () => {
    // The default mount is `/payments-dashboard` precisely so a dashboard guard can never end
    // up in front of a gateway's delivery endpoint.
    const patterns = (await bootWith({})).map((r) => r.pattern);
    expect(patterns.some((p) => p === '/payments' || p.startsWith('/payments/'))).toBe(false);
  });

  it('honors a custom mount path everywhere, including the API', async () => {
    const routes = await bootWith({ path: 'ops/billing/' });
    expect(routes.map((r) => r.pattern)).toEqual([
      '/ops/billing',
      '/ops/billing/assets/:file',
      '/ops/billing/api/overview',
      '/ops/billing/api/payments',
      '/ops/billing/api/webhook-events',
    ]);
  });

  it('mounts at the router root without a doubled slash when path is "/"', async () => {
    const routes = await bootWith({ path: '/' });
    expect(routes.map((r) => r.pattern)).toEqual([
      '/',
      '/assets/:file',
      '/api/overview',
      '/api/payments',
      '/api/webhook-events',
    ]);
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
    expect(named).toContain('GET /payments-dashboard/login');
    expect(named).toContain('POST /payments-dashboard/login');
    expect(named).toContain('GET /payments-dashboard/logout');
    // Mode B alone must not mount the host-session mint endpoint.
    expect(named).not.toContain('POST /payments-dashboard/session');
  });

  it('adds the session mint (and no login page) for Mode A alone', async () => {
    const routes = await bootWith({
      dashboardAuth: { secret: 's'.repeat(32), session: () => null },
    });
    const named = routes.map((r) => `${r.method.toUpperCase()} ${r.pattern}`);
    expect(named).toContain('POST /payments-dashboard/session');
    expect(named).toContain('GET /payments-dashboard/logout');
    expect(named).not.toContain('GET /payments-dashboard/login');
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
