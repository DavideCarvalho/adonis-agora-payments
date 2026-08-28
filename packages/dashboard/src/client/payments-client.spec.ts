import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiBase, buildQuery, displayCurrency, paymentsClient, uiBase } from './payments-client';

const originalFetch = globalThis.fetch;

function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): {
  calls: string[];
  /** The `RequestInit` each call carried — how a test tells a `GET` from a `POST`. */
  inits: Array<RequestInit | undefined>;
} {
  const calls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    inits.push(init);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({}),
      ...response,
    } as Response;
  }) as typeof globalThis.fetch;
  return { calls, inits };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, '__PAYMENTS_BASE__');
  Reflect.deleteProperty(window, '__PAYMENTS_API__');
  Reflect.deleteProperty(window, '__PAYMENTS_CURRENCY__');
});

describe('base resolution', () => {
  it('falls back to the default mount when the provider injected nothing', () => {
    expect(uiBase()).toBe('/payments-dashboard');
    expect(apiBase()).toBe('/payments-dashboard/api');
    expect(displayCurrency()).toBe('BRL');
  });

  it('honors the injected globals', () => {
    window.__PAYMENTS_BASE__ = '/ops/billing';
    window.__PAYMENTS_API__ = '/ops/billing/api';
    window.__PAYMENTS_CURRENCY__ = 'USD';
    expect(uiBase()).toBe('/ops/billing');
    expect(apiBase()).toBe('/ops/billing/api');
    expect(displayCurrency()).toBe('USD');
  });

  it('honors an EMPTY injected base (a root-mounted dashboard) instead of defaulting', () => {
    // The trap a truthy check falls into: `''` is a deliberate, valid base.
    window.__PAYMENTS_BASE__ = '';
    expect(uiBase()).toBe('');
    expect(apiBase()).toBe('/api');
  });
});

describe('buildQuery', () => {
  it('drops absent and empty values so `?status=` never reaches the server', () => {
    expect(buildQuery({ status: undefined, limit: 20 })).toBe('?limit=20');
    expect(buildQuery({ status: '' })).toBe('');
    expect(buildQuery({})).toBe('');
  });

  it('encodes values', () => {
    expect(buildQuery({ status: 'a b' })).toBe('?status=a+b');
  });
});

describe('paymentsClient request shapes', () => {
  beforeEach(() => {
    window.__PAYMENTS_API__ = '/pd/api';
  });

  it('requests the overview with the selected period', async () => {
    const { calls } = stubFetch({ json: async () => ({ metrics: [] }) });
    await paymentsClient.overview('7d');
    expect(calls).toEqual(['/pd/api/overview?period=7d']);
  });

  it('requests the overview with NO period when none is selected', async () => {
    const { calls } = stubFetch({ json: async () => ({ metrics: [] }) });
    await paymentsClient.overview();
    expect(calls).toEqual(['/pd/api/overview']);
  });

  it('passes the payments status filter and paging through', async () => {
    const { calls } = stubFetch({ json: async () => ({ payments: [] }) });
    await paymentsClient.payments({ status: 'failed', limit: 25, offset: 50 });
    expect(calls).toEqual(['/pd/api/payments?status=failed&limit=25&offset=50']);
  });

  it('hits the hyphenated webhook-events route', async () => {
    const { calls } = stubFetch({ json: async () => ({ events: [] }) });
    await paymentsClient.webhookEvents({ status: 'failed' });
    expect(calls).toEqual(['/pd/api/webhook-events?status=failed']);
  });

  it('passes the provider filter through on every list endpoint', async () => {
    const { calls } = stubFetch({ json: async () => ({}) });
    await paymentsClient.payments({ provider: 'asaas' });
    await paymentsClient.subscriptions({ provider: 'asaas', status: 'past_due' });
    await paymentsClient.webhookEvents({ provider: 'asaas' });
    expect(calls).toEqual([
      '/pd/api/payments?provider=asaas',
      '/pd/api/subscriptions?status=past_due&provider=asaas',
      '/pd/api/webhook-events?provider=asaas',
    ]);
  });

  it('asks for the dispute LOG when no horizon is given', async () => {
    const { calls } = stubFetch({ json: async () => ({ disputes: [] }) });
    await paymentsClient.disputes({ status: 'lost', provider: 'stripe', limit: 50, offset: 0 });
    expect(calls).toEqual(['/pd/api/disputes?status=lost&provider=stripe&limit=50&offset=0']);
  });

  it('asks for the WORK LIST with an explicit horizon in hours', async () => {
    const { calls } = stubFetch({ json: async () => ({ disputes: [] }) });
    await paymentsClient.disputes({ dueWithin: 72, limit: 50, offset: 0 });
    expect(calls).toEqual(['/pd/api/disputes?dueWithin=72&limit=50&offset=0']);
  });

  it('drops a status sent alongside a horizon instead of passing one the server ignores', async () => {
    // The work list is already scoped to the open statuses that carry a deadline. A filter that
    // appears to apply and silently does not is worse than no filter at all.
    const { calls } = stubFetch({ json: async () => ({ disputes: [] }) });
    await paymentsClient.disputes({ dueWithin: 24, status: 'lost', provider: 'asaas' });
    expect(calls).toEqual(['/pd/api/disputes?provider=asaas&dueWithin=24']);
  });

  it('sends a zero-hour horizon rather than dropping it as empty', async () => {
    // `dueWithin=0` is "everything already past due", a real question. Dropping it would answer
    // the log's question instead, and the caller could not tell.
    const { calls } = stubFetch({ json: async () => ({ disputes: [] }) });
    await paymentsClient.disputes({ dueWithin: 0 });
    expect(calls).toEqual(['/pd/api/disputes?dueWithin=0']);
  });

  it('requests health and providers with no query at all', async () => {
    const { calls } = stubFetch({ json: async () => ({}) });
    await paymentsClient.health();
    await paymentsClient.providers();
    expect(calls).toEqual(['/pd/api/health', '/pd/api/providers']);
  });
});

/**
 * The two calls that CHANGE something.
 *
 * `POST` is the property under test, not an implementation detail: a refund reachable by `GET` is
 * a refund a crawler, a prefetcher or a pasted link can trigger.
 */
describe('actions are POSTs', () => {
  beforeEach(() => {
    window.__PAYMENTS_API__ = '/pd/api';
  });

  it('posts a full refund with an empty body', async () => {
    const { calls, inits } = stubFetch({ json: async () => ({ refund: {} }) });
    await paymentsClient.refundPayment('pi_1');
    expect(calls).toEqual(['/pd/api/payments/pi_1/refund']);
    expect(inits[0]?.method).toBe('POST');
    expect(inits[0]?.body).toBe('{}');
  });

  it('posts a partial refund as integer minor units', async () => {
    const { inits } = stubFetch({ json: async () => ({ refund: {} }) });
    await paymentsClient.refundPayment('pi_1', 1999);
    expect(inits[0]?.body).toBe('{"amount":1999}');
  });

  it('escapes a gateway id that would otherwise break out of the path', async () => {
    const { calls } = stubFetch({ json: async () => ({ refund: {} }) });
    await paymentsClient.refundPayment('pi/../../admin');
    expect(calls).toEqual(['/pd/api/payments/pi%2F..%2F..%2Fadmin/refund']);
  });

  it('posts the webhook retry', async () => {
    const { calls, inits } = stubFetch({ json: async () => ({ status: 'processed' }) });
    await paymentsClient.retryWebhookEvent('evt_1');
    expect(calls).toEqual(['/pd/api/webhook-events/evt_1/retry']);
    expect(inits[0]?.method).toBe('POST');
  });

  it("surfaces the gateway's refusal instead of a bare 502", async () => {
    stubFetch({ ok: false, status: 502, json: async () => ({ error: 'charge_already_refunded' }) });
    await expect(paymentsClient.refundPayment('pi_1')).rejects.toThrow('charge_already_refunded');
  });

  /**
   * The console is mounted INSIDE a host application, and an AdonisJS app running
   * `@adonisjs/shield` guards every state-changing route with CSRF. Shield publishes the
   * token as an `XSRF-TOKEN` cookie precisely so a browser client can echo it in
   * `x-xsrf-token`; without the header these two POSTs are rejected before they reach the
   * dashboard's own authorization, and the refund button does nothing for a reason no
   * message on screen explains.
   */
  it("echoes the host app's CSRF cookie on a refund", () => {
    document.cookie = 'XSRF-TOKEN=abc%20123';
    const { inits } = stubFetch({ json: async () => ({ refund: {} }) });
    return paymentsClient.refundPayment('pi_1').then(() => {
      expect((inits[0]?.headers as Record<string, string>)['x-xsrf-token']).toBe('abc 123');
    });
  });

  it('echoes it on a webhook retry too', () => {
    document.cookie = 'XSRF-TOKEN=tok2';
    const { inits } = stubFetch({ json: async () => ({ status: 'processed' }) });
    return paymentsClient.retryWebhookEvent('evt_1').then(() => {
      expect((inits[0]?.headers as Record<string, string>)['x-xsrf-token']).toBe('tok2');
    });
  });

  it('sends no CSRF header when the host sets no cookie', () => {
    // A host without shield has no token to send, and an empty one would be worse than none.
    document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    const { inits } = stubFetch({ json: async () => ({ refund: {} }) });
    return paymentsClient.refundPayment('pi_1').then(() => {
      expect(inits[0]?.headers as Record<string, string>).not.toHaveProperty('x-xsrf-token');
    });
  });
});

describe('error handling', () => {
  beforeEach(() => {
    window.__PAYMENTS_API__ = '/pd/api';
  });

  it("surfaces the server's own message for a 503 (billing layer off)", async () => {
    stubFetch({
      ok: false,
      status: 503,
      json: async () => ({ error: '[payments] The billing store is not ready yet.' }),
    });
    await expect(paymentsClient.overview()).rejects.toThrow(
      '[payments] The billing store is not ready yet.',
    );
  });

  it('falls back to a readable 503 message when the body is unreadable', async () => {
    stubFetch({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(paymentsClient.overview()).rejects.toThrow(
      'The billing layer is disabled in this deployment.',
    );
  });

  it('throws status + statusText for any other failure', async () => {
    stubFetch({ ok: false, status: 500, statusText: 'Internal Server Error' });
    await expect(paymentsClient.overview()).rejects.toThrow('500 Internal Server Error');
  });
});

/**
 * The disputes screen is READ-ONLY, and this is the test that keeps it that way.
 *
 * Whether a chargeback is worth contesting turns on margin, customer value and fraud history —
 * a business rule that lives in the app's code. The JSON API has no action route for disputes, so
 * the client must not grow a method that implies one.
 */
describe('disputes have no actions', () => {
  it('exposes exactly one dispute call, and it is a read', async () => {
    const disputeCalls = Object.keys(paymentsClient).filter((key) => /dispute/i.test(key));
    expect(disputeCalls).toEqual(['disputes']);

    window.__PAYMENTS_API__ = '/pd/api';
    const { inits } = stubFetch({ json: async () => ({ disputes: [] }) });
    await paymentsClient.disputes({ dueWithin: 72 });
    expect(inits[0]?.method).toBeUndefined();
  });
});
