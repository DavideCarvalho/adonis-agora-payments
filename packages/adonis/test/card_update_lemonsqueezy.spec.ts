import { afterEach, describe, expect, it, vi } from 'vitest';
import { LemonSqueezyDriver } from '../src/drivers/lemonsqueezy.js';

function makeDriver() {
  return new LemonSqueezyDriver({ config: () => ({}) }, { apiKey: 'ls_test_key', storeId: 42 });
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

function subscription(attributes: Record<string, unknown>) {
  return {
    data: { type: 'subscriptions', id: '1', attributes: { status: 'active', ...attributes } },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lemon Squeezy card update URL', () => {
  it("returns the subscription's update_payment_method link", async () => {
    const fetchMock = routeFetch([
      [
        'GET',
        '/subscriptions/1',
        subscription({
          customer_id: 7,
          urls: { update_payment_method: 'https://x.lemonsqueezy.com/sub/1/payment' },
        }),
      ],
    ]);
    const url = await makeDriver().cardUpdateUrl({
      customerId: '7',
      subscriptionGatewayId: '1',
      returnUrl: 'https://app.test/account',
    });
    expect(url).toBe('https://x.lemonsqueezy.com/sub/1/payment');
    expect(calls(fetchMock)[0]!.url).toBe('https://api.lemonsqueezy.com/v1/subscriptions/1');
  });

  it('requires the subscription', async () => {
    await expect(
      makeDriver().cardUpdateUrl({ customerId: '7', returnUrl: 'https://app.test' }),
    ).rejects.toThrow(/\[payments\].*subscriptionGatewayId/);
  });

  it("refuses another customer's subscription", async () => {
    routeFetch([
      [
        'GET',
        '/subscriptions/1',
        subscription({ customer_id: 8, urls: { update_payment_method: 'https://x' } }),
      ],
    ]);
    await expect(
      makeDriver().cardUpdateUrl({
        customerId: '7',
        subscriptionGatewayId: '1',
        returnUrl: 'https://app.test',
      }),
    ).rejects.toThrow(/\[payments\].*another customer/);
  });

  it('refuses when Lemon Squeezy returns no link', async () => {
    routeFetch([['GET', '/subscriptions/1', subscription({ customer_id: 7 })]]);
    await expect(
      makeDriver().cardUpdateUrl({
        customerId: '7',
        subscriptionGatewayId: '1',
        returnUrl: 'https://app.test',
      }),
    ).rejects.toThrow(/\[payments\].*update_payment_method/);
  });
});
