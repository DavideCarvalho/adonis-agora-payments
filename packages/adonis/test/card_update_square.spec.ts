import { afterEach, describe, expect, it, vi } from 'vitest';
import { squareMounter } from '../src/account_console/card_mounters/square.js';
import { SquareDriver } from '../src/drivers/square.js';

function makeDriver(config: Record<string, unknown> = {}) {
  return new SquareDriver(
    { config: () => ({}) },
    { accessToken: 'EAAA-token', locationId: 'L_MAIN', currency: 'usd', ...config },
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

/** Runs a mounter source the way the console page does and returns what it registered. */
function register(source: string): Record<string, unknown> {
  const mounters: Record<string, unknown> = {};
  new Function('mounters', source)(mounters);
  return mounters;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Square card update', () => {
  it('cardSetup loads the Web Payments SDK with the application and location ids', async () => {
    expect(
      await makeDriver({ applicationId: 'sq0idp-app' }).cardSetup({ customerId: 'C1' }),
    ).toEqual({
      scripts: [{ src: 'https://web.squarecdn.com/v1/square.js' }],
      props: { applicationId: 'sq0idp-app', locationId: 'L_MAIN' },
    });
  });

  it('cardSetup loads the sandbox SDK in the sandbox and reads SQUARE_APPLICATION_ID', async () => {
    vi.stubEnv('SQUARE_APPLICATION_ID', 'sandbox-sq0idb-app');
    const session = await makeDriver({ sandbox: true }).cardSetup({ customerId: 'C1' });
    expect(session.scripts).toEqual([{ src: 'https://sandbox.web.squarecdn.com/v1/square.js' }]);
    expect(session.props.applicationId).toBe('sandbox-sq0idb-app');
  });

  it('cardSetup refuses without an application id', async () => {
    vi.stubEnv('SQUARE_APPLICATION_ID', undefined);
    await expect(makeDriver().cardSetup({ customerId: 'C1' })).rejects.toThrow(
      /\[payments\].*SQUARE_APPLICATION_ID/,
    );
  });

  it('saveCard stores the nonce as a card on file and moves each subscription to it', async () => {
    const fetchMock = routeFetch([
      ['POST', '/v2/cards', { card: { id: 'ccof:abc', card_brand: 'VISA', last_4: '1111' } }],
      ['PUT', '/v2/subscriptions/', { subscription: { id: 'sub_1' } }],
    ]);
    const saved = await makeDriver().saveCard({
      customerId: 'C1',
      token: 'cnon:nonce',
      subscriptionGatewayIds: ['sub_1'],
    });
    expect(saved).toEqual({ paymentMethodId: 'ccof:abc', brand: 'VISA', last4: '1111' });
    const [create, update] = calls(fetchMock);
    expect(create!.url).toBe('https://connect.squareup.com/v2/cards');
    expect(create!.body).toMatchObject({ source_id: 'cnon:nonce', card: { customer_id: 'C1' } });
    expect(typeof create!.body.idempotency_key).toBe('string');
    expect(update).toEqual({
      method: 'PUT',
      url: 'https://connect.squareup.com/v2/subscriptions/sub_1',
      body: { subscription: { card_id: 'ccof:abc' } },
    });
  });

  it('a renewal charges the card on file with the customer', async () => {
    const fetchMock = routeFetch([
      [
        'POST',
        '/v2/payments',
        {
          payment: {
            id: 'pay_1',
            status: 'COMPLETED',
            amount_money: { amount: 500, currency: 'USD' },
          },
        },
      ],
    ]);
    await makeDriver().charge({ customerId: 'C1', amount: 500, paymentMethodId: 'ccof:abc' });
    const [payment] = calls(fetchMock);
    expect(payment!.body).toMatchObject({ source_id: 'ccof:abc', customer_id: 'C1' });
  });

  it('the mounter parses and registers itself', () => {
    expect(typeof register(squareMounter).square).toBe('function');
  });
});
