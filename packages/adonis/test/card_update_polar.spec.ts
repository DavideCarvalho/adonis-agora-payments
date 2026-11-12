import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolarDriver } from '../src/drivers/polar.js';

function makeDriver() {
  return new PolarDriver(
    { config: () => ({}) },
    { accessToken: 'polar_oat_test', currency: 'usd', sandbox: true },
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

describe('Polar card update URL', () => {
  it('creates a customer session and returns its portal URL', async () => {
    const fetchMock = routeFetch([
      [
        'POST',
        '/v1/customer-sessions/',
        {
          token: 'polar_cst_1',
          customer_portal_url: 'https://polar.sh/acme/portal?customer_session_token=polar_cst_1',
        },
      ],
    ]);
    const url = await makeDriver().cardUpdateUrl({
      customerId: 'cus_1',
      returnUrl: 'https://app.test/account',
    });
    expect(url).toBe('https://polar.sh/acme/portal?customer_session_token=polar_cst_1');
    expect(calls(fetchMock)).toEqual([
      {
        method: 'POST',
        url: 'https://sandbox-api.polar.sh/v1/customer-sessions/',
        body: { customer_id: 'cus_1', return_url: 'https://app.test/account' },
      },
    ]);
  });

  it('omits return_url when there is none', async () => {
    const fetchMock = routeFetch([
      ['POST', '/v1/customer-sessions/', { customer_portal_url: 'https://polar.sh/acme/portal' }],
    ]);
    await makeDriver().cardUpdateUrl({ customerId: 'cus_1' });
    expect(calls(fetchMock)[0]!.body).toEqual({ customer_id: 'cus_1' });
  });

  it('refuses a session without a portal URL', async () => {
    routeFetch([['POST', '/v1/customer-sessions/', { token: 'polar_cst_1' }]]);
    await expect(
      makeDriver().cardUpdateUrl({ customerId: 'cus_1', returnUrl: 'https://app.test' }),
    ).rejects.toThrow(/\[payments\].*portal URL/);
  });
});
