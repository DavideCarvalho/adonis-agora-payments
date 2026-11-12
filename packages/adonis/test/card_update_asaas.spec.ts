import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsaasDriver } from '../src/drivers/asaas.js';

function makeDriver() {
  return new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
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

describe('Asaas card update', () => {
  it('cardSetup loads nothing: the console draws its own form', async () => {
    const fetchMock = routeFetch([]);
    expect(await makeDriver().cardSetup({ customerId: 'cus_1' })).toEqual({
      scripts: [],
      props: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saveCard moves each subscription to the token without charging and returns the token', async () => {
    const fetchMock = routeFetch([['PUT', '/creditCard', { id: 'sub_1' }]]);
    const saved = await makeDriver().saveCard({
      customerId: 'cus_1',
      token: 'tok-uuid',
      subscriptionGatewayIds: ['sub_1', 'sub_2'],
      remoteIp: '116.213.42.7',
    });
    expect(saved).toEqual({ paymentMethodId: 'tok-uuid' });
    expect(calls(fetchMock)).toEqual([
      {
        method: 'PUT',
        url: 'https://api-sandbox.asaas.com/v3/subscriptions/sub_1/creditCard',
        body: { creditCardToken: 'tok-uuid', remoteIp: '116.213.42.7' },
      },
      {
        method: 'PUT',
        url: 'https://api-sandbox.asaas.com/v3/subscriptions/sub_2/creditCard',
        body: { creditCardToken: 'tok-uuid', remoteIp: '116.213.42.7' },
      },
    ]);
  });

  it('saveCard without subscriptions sends nothing', async () => {
    const fetchMock = routeFetch([]);
    expect(await makeDriver().saveCard({ customerId: 'cus_1', token: 'tok-uuid' })).toEqual({
      paymentMethodId: 'tok-uuid',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saveCard omits remoteIp when the payer IP is unknown', async () => {
    const fetchMock = routeFetch([['PUT', '/creditCard', { id: 'sub_1' }]]);
    await makeDriver().saveCard({
      customerId: 'cus_1',
      token: 't',
      subscriptionGatewayIds: ['sub_1'],
    });
    expect(calls(fetchMock)[0]!.body).toEqual({ creditCardToken: 't' });
  });

  it('saveCard refuses an empty token', async () => {
    await expect(makeDriver().saveCard({ customerId: 'cus_1', token: '' })).rejects.toThrow(
      /\[payments\].*creditCardToken/,
    );
  });
});
