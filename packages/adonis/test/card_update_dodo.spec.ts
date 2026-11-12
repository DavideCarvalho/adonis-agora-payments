import { afterEach, describe, expect, it, vi } from 'vitest';
import { DodoDriver } from '../src/drivers/dodo.js';

function makeDriver() {
  return new DodoDriver(
    { config: () => ({}) },
    { apiKey: 'dodo_test_key', currency: 'usd', sandbox: true },
  );
}

type Route = [method: string, path: string, body: unknown];

/** A fetch double answering each request from the first route whose method and path match. */
function routeFetch(routes: Route[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const route = routes.find(([m, p]) => m === method && String(url).includes(p));
    if (route === undefined) throw new Error(`unexpected ${method} ${String(url)}`);
    return { ok: true, status: 200, json: async () => route[2], text: async () => '' };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The calls the double received, as method + url + parsed JSON body. */
function calls(fetchMock: ReturnType<typeof routeFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    method: init?.method ?? 'GET',
    url: String(url),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  }));
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dodo card update URL', () => {
  it('creates a customer portal session without emailing and returns its link', async () => {
    const fetchMock = routeFetch([
      [
        'POST',
        '/customer-portal/session',
        { link: 'https://test.customer.dodopayments.com/session/abc' },
      ],
    ]);
    const url = await makeDriver().cardUpdateUrl({
      customerId: 'cus_1',
      returnUrl: 'https://app.test',
    });
    expect(url).toBe('https://test.customer.dodopayments.com/session/abc');
    expect(calls(fetchMock)[0]).toMatchObject({
      method: 'POST',
      url: 'https://test.dodopayments.com/customers/cus_1/customer-portal/session?send_email=false',
    });
  });

  it('refuses a session without a link', async () => {
    routeFetch([['POST', '/customer-portal/session', {}]]);
    await expect(
      makeDriver().cardUpdateUrl({ customerId: 'cus_1', returnUrl: 'https://app.test' }),
    ).rejects.toThrow(/\[payments\].*without a link/);
  });
});
