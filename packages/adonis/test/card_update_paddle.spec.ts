import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaddleDriver } from '../src/drivers/paddle.js';

function makeDriver() {
  return new PaddleDriver(
    { config: () => ({}) },
    { apiKey: 'pdl_sdbx_apikey_test', currency: 'usd', sandbox: true },
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

describe('Paddle card update URL', () => {
  it("returns the update-payment-method transaction's checkout URL", async () => {
    const fetchMock = routeFetch([
      [
        'GET',
        '/update-payment-method-transaction',
        {
          data: {
            id: 'txn_1',
            status: 'ready',
            customer_id: 'ctm_1',
            checkout: { url: 'https://app.test/pay?_ptxn=txn_1' },
          },
        },
      ],
    ]);
    const url = await makeDriver().cardUpdateUrl({
      customerId: 'ctm_1',
      subscriptionGatewayId: 'sub_1',
      returnUrl: 'https://app.test/account',
    });
    expect(url).toBe('https://app.test/pay?_ptxn=txn_1');
    expect(calls(fetchMock)[0]).toMatchObject({
      method: 'GET',
      url: 'https://sandbox-api.paddle.com/subscriptions/sub_1/update-payment-method-transaction',
    });
  });

  it('requires the subscription', async () => {
    await expect(
      makeDriver().cardUpdateUrl({ customerId: 'ctm_1', returnUrl: 'https://app.test' }),
    ).rejects.toThrow(/\[payments\].*subscriptionGatewayId/);
  });

  it("refuses another customer's subscription", async () => {
    routeFetch([
      [
        'GET',
        '/update-payment-method-transaction',
        { data: { id: 'txn_1', customer_id: 'ctm_2', checkout: { url: 'https://x' } } },
      ],
    ]);
    await expect(
      makeDriver().cardUpdateUrl({
        customerId: 'ctm_1',
        subscriptionGatewayId: 'sub_1',
        returnUrl: 'https://app.test',
      }),
    ).rejects.toThrow(/\[payments\].*another customer/);
  });

  it('refuses when there is no checkout URL (no default payment link)', async () => {
    routeFetch([
      [
        'GET',
        '/update-payment-method-transaction',
        { data: { id: 'txn_1', customer_id: 'ctm_1', checkout: null } },
      ],
    ]);
    await expect(
      makeDriver().cardUpdateUrl({
        customerId: 'ctm_1',
        subscriptionGatewayId: 'sub_1',
        returnUrl: 'https://app.test',
      }),
    ).rejects.toThrow(/\[payments\].*default payment link/);
  });
});
