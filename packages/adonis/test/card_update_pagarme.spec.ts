import { afterEach, describe, expect, it, vi } from 'vitest';
import { pagarmeMounter } from '../src/account_console/card_mounters/pagarme.js';
import { PagarmeDriver } from '../src/drivers/pagarme.js';

function makeDriver(config: Record<string, unknown> = {}) {
  return new PagarmeDriver({ config: () => ({}) }, { secretKey: 'sk_test_123', ...config });
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

describe('Pagar.me card update', () => {
  it('cardSetup hands the browser the public key and loads no script', async () => {
    expect(await makeDriver({ publicKey: 'pk_test_1' }).cardSetup({ customerId: 'cus_1' })).toEqual(
      { scripts: [], props: { publicKey: 'pk_test_1' } },
    );
  });

  it('cardSetup reads PAGARME_PUBLIC_KEY', async () => {
    vi.stubEnv('PAGARME_PUBLIC_KEY', 'pk_env');
    const session = await makeDriver().cardSetup({ customerId: 'cus_1' });
    expect(session.props).toEqual({ publicKey: 'pk_env' });
  });

  it('cardSetup refuses without a public key', async () => {
    vi.stubEnv('PAGARME_PUBLIC_KEY', undefined);
    await expect(makeDriver().cardSetup({ customerId: 'cus_1' })).rejects.toThrow(
      /\[payments\].*PAGARME_PUBLIC_KEY/,
    );
  });

  it('saveCard creates the card from the token, moves each subscription to it and returns the card id', async () => {
    const fetchMock = routeFetch([
      ['POST', '/customers/cus_1/cards', { id: 'card_1', brand: 'Visa', last_four_digits: '4242' }],
      ['PATCH', '/card', { id: 'sub_1' }],
    ]);
    const saved = await makeDriver().saveCard({
      customerId: 'cus_1',
      token: 'token_abc',
      subscriptionGatewayIds: ['sub_1'],
    });
    expect(saved).toEqual({ paymentMethodId: 'card_1', brand: 'Visa', last4: '4242' });
    expect(calls(fetchMock)).toEqual([
      {
        method: 'POST',
        url: 'https://api.pagar.me/core/v5/customers/cus_1/cards',
        body: { token: 'token_abc' },
      },
      {
        method: 'PATCH',
        url: 'https://api.pagar.me/core/v5/subscriptions/sub_1/card',
        body: { card_id: 'card_1' },
      },
    ]);
  });

  it('a renewal charges the saved card id off-session', async () => {
    const fetchMock = routeFetch([
      [
        'POST',
        '/orders',
        { id: 'or_1', status: 'paid', charges: [{ id: 'ch_1', status: 'paid', amount: 1990 }] },
      ],
    ]);
    await makeDriver().charge({
      customerId: 'cus_1',
      amount: 1990,
      method: 'credit_card',
      paymentMethodId: 'card_1',
    });
    const [order] = calls(fetchMock);
    expect(order!.body.customer_id).toBe('cus_1');
    expect(order!.body.payments[0].credit_card.card_id).toBe('card_1');
  });

  it('the mounter parses and registers itself', () => {
    expect(typeof register(pagarmeMounter).pagarme).toBe('function');
  });
});
