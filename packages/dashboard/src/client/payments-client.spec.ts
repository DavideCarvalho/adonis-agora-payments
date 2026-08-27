import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiBase, buildQuery, displayCurrency, paymentsClient, uiBase } from './payments-client';

const originalFetch = globalThis.fetch;

function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): {
  calls: string[];
} {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({}),
      ...response,
    } as Response;
  }) as typeof globalThis.fetch;
  return { calls };
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
