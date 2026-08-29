import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import PaymentsClientProvider from '../../providers/payments_client_provider.js';
import type { PaymentsClientConfig } from '../../src/client/define_config.js';
import { setBillingStore } from '../../src/services/main.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

interface RegisteredRoute {
  method: 'get';
  pattern: string;
  name?: string;
  handler?: (ctx: unknown) => Promise<unknown>;
}

function fakeRouter(): { routes: RegisteredRoute[]; router: never } {
  const routes: RegisteredRoute[] = [];
  const get = (pattern: string, handler?: (ctx: unknown) => Promise<unknown>) => {
    const route: RegisteredRoute = { method: 'get', pattern, ...(handler ? { handler } : {}) };
    routes.push(route);
    return {
      as(name: string) {
        route.name = name;
        return this;
      },
    };
  };
  return { routes, router: { get } as never };
}

function fakeApp(config: PaymentsClientConfig, router: unknown): ApplicationService {
  return {
    config: { get: () => config },
    booted: async (callback: () => Promise<void>) => {
      await callback();
    },
    container: { make: async () => router },
  } as unknown as ApplicationService;
}

async function bootWith(config: PaymentsClientConfig): Promise<RegisteredRoute[]> {
  const { routes, router } = fakeRouter();
  await new PaymentsClientProvider(fakeApp(config, router)).boot();
  return routes;
}

/** An `HttpContext` stand-in recording the status, body and headers the route writes. */
function fakeContext(auth: unknown, reference?: string) {
  const written = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const response = {
    header(name: string, value: string) {
      written.headers[name] = value;
      return this;
    },
    status(code: number) {
      written.status = code;
      return this;
    },
    json(body: unknown) {
      written.body = body;
      return body;
    },
  };
  const ctx = {
    auth,
    request: { qs: () => (reference === undefined ? {} : { reference }) },
    response,
  };
  return { ctx, written };
}

describe('PaymentsClientProvider route registration', () => {
  it('registers NOTHING when disabled, which is the default', async () => {
    // Not "registers a route that 401s" — registers nothing. An endpoint every logged-in
    // browser can reach is one an app takes on deliberately.
    expect(await bootWith({})).toEqual([]);
    expect(await bootWith({ enabled: false })).toEqual([]);
  });

  it('registers exactly one GET route when enabled', async () => {
    const routes = await bootWith({ enabled: true });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe('get');
    expect(routes[0]?.pattern).toBe('/payments/client/status');
    expect(routes[0]?.name).toBe('payments_client.status');
  });

  it('mounts below the webhook route, never over it', async () => {
    // `/payments/webhook/:provider` belongs to the payments provider. A guard mounted over
    // that prefix is how a gateway delivery ends up answering 403.
    const routes = await bootWith({ enabled: true });
    expect(routes[0]?.pattern.startsWith('/payments/webhook')).toBe(false);
  });

  it('honours a custom path', async () => {
    const routes = await bootWith({ enabled: true, path: '/checkout/' });
    expect(routes[0]?.pattern).toBe('/checkout/status');
  });

  it('sends Cache-Control: no-store on every answer', async () => {
    // This URL is polled and its answer is per-caller. A shared proxy that cached one would
    // hand one customer's settled charge to the next caller with the same URL.
    setBillingStore(new InMemoryBillingStore());
    const routes = await bootWith({ enabled: true });
    const { ctx, written } = fakeContext({}, 'pay_1');
    await routes[0]?.handler?.(ctx);

    expect(written.headers['cache-control']).toBe('no-store');
    expect(written.status).toBe(401);
  });

  it('reads the reference off the query string and answers 400 without one', async () => {
    setBillingStore(new InMemoryBillingStore());
    const routes = await bootWith({ enabled: true });
    const { ctx, written } = fakeContext({ user: { id: 1 } });
    await routes[0]?.handler?.(ctx);
    expect(written.status).toBe(400);
  });
});
