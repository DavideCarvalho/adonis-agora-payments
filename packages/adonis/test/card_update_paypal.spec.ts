import { afterEach, describe, expect, it, vi } from 'vitest';
import { paypalMounter } from '../src/account_console/card_mounters/paypal.js';
import { PayPalDriver } from '../src/drivers/paypal.js';

function makeDriver() {
  return new PayPalDriver(
    { config: () => ({}) },
    { clientId: 'client-id', clientSecret: 'client-secret', currency: 'usd', sandbox: true },
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
  // The OAuth token call is form-encoded, not JSON; it is not what these tests check.
  return fetchMock.mock.calls
    .filter(([url]) => !String(url).endsWith('/v1/oauth2/token'))
    .map(([url, init]) => ({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }));
}

/** Runs a mounter source the way the console page does and returns what it registered. */
function register(source: string): Record<string, unknown> {
  const mounters: Record<string, unknown> = {};
  new Function('mounters', source)(mounters);
  return mounters;
}

const token: Route = ['POST', '/v1/oauth2/token', { access_token: 'A21', expires_in: 3600 }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PayPal saved payment method', () => {
  it('cardSetup creates a vault setup token and loads the JS SDK with the client id', async () => {
    const fetchMock = routeFetch([token, ['POST', '/v3/vault/setup-tokens', { id: '5C991763' }]]);
    const session = await makeDriver().cardSetup({ customerId: 'user_1' });
    expect(session).toEqual({
      scripts: [
        { src: 'https://www.paypal.com/sdk/js?client-id=client-id&vault=true&components=buttons' },
      ],
      props: { setupToken: '5C991763' },
    });
    const setup = calls(fetchMock).find((call) => call.url.endsWith('/v3/vault/setup-tokens'))!;
    expect(setup.url).toBe('https://api-m.sandbox.paypal.com/v3/vault/setup-tokens');
    expect(setup.body).toEqual({
      customer: { merchant_customer_id: 'user_1' },
      payment_source: { paypal: { usage_type: 'MERCHANT' } },
    });
  });

  it('saveCard exchanges the approved setup token for a payment token', async () => {
    const fetchMock = routeFetch([token, ['POST', '/v3/vault/payment-tokens', { id: '8kk8451t' }]]);
    expect(await makeDriver().saveCard({ customerId: 'user_1', token: '5C991763' })).toEqual({
      paymentMethodId: '8kk8451t',
    });
    const create = calls(fetchMock).find((call) => call.url.endsWith('/v3/vault/payment-tokens'))!;
    expect(create.body).toEqual({
      payment_source: { token: { id: '5C991763', type: 'SETUP_TOKEN' } },
    });
  });

  it('saveCard refuses gateway subscriptions, whose funding PayPal does not change by API', async () => {
    const fetchMock = routeFetch([]);
    await expect(
      makeDriver().saveCard({ customerId: 'user_1', token: 't', subscriptionGatewayIds: ['I-1'] }),
    ).rejects.toThrow(/\[payments\].*PayPal subscriptions cannot change/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the mounter parses and registers itself', () => {
    expect(typeof register(paypalMounter).paypal).toBe('function');
  });
});
