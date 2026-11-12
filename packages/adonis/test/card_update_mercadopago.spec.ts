import { afterEach, describe, expect, it, vi } from 'vitest';
import { mercadopagoMounter } from '../src/account_console/card_mounters/mercadopago.js';
import { MercadoPagoDriver } from '../src/drivers/mercadopago.js';

function makeDriver(config: Record<string, unknown> = {}) {
  return new MercadoPagoDriver(
    { config: () => ({}) },
    { accessToken: 'TEST-token', currency: 'brl', ...config },
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

describe('Mercado Pago card update', () => {
  it('cardSetup loads SDK v2 with the public key', async () => {
    expect(await makeDriver({ publicKey: 'TEST-pk' }).cardSetup({ customerId: 'cus_1' })).toEqual({
      scripts: [{ src: 'https://sdk.mercadopago.com/js/v2' }],
      props: { publicKey: 'TEST-pk' },
    });
  });

  it('cardSetup reads MERCADOPAGO_PUBLIC_KEY and refuses without one', async () => {
    vi.stubEnv('MERCADOPAGO_PUBLIC_KEY', 'APP_USR-env');
    expect((await makeDriver().cardSetup({ customerId: 'cus_1' })).props).toEqual({
      publicKey: 'APP_USR-env',
    });
    vi.stubEnv('MERCADOPAGO_PUBLIC_KEY', undefined);
    await expect(makeDriver().cardSetup({ customerId: 'cus_1' })).rejects.toThrow(
      /\[payments\].*MERCADOPAGO_PUBLIC_KEY/,
    );
  });

  it('saveCard moves each preapproval to the card token', async () => {
    const fetchMock = routeFetch([['PUT', '/preapproval/', { id: 'pre_1' }]]);
    const saved = await makeDriver().saveCard({
      customerId: 'cus_1',
      token: 'card_tok_1',
      subscriptionGatewayIds: ['pre_1'],
    });
    expect(saved).toEqual({ paymentMethodId: 'card_tok_1' });
    expect(calls(fetchMock)).toEqual([
      {
        method: 'PUT',
        url: 'https://api.mercadopago.com/preapproval/pre_1',
        body: { card_token_id: 'card_tok_1' },
      },
    ]);
  });

  it('saveCard refuses without gateway subscriptions: a library-managed one cannot renew on it', async () => {
    const fetchMock = routeFetch([]);
    await expect(
      makeDriver().saveCard({ customerId: 'cus_1', token: 'card_tok_1' }),
    ).rejects.toThrow(/\[payments\].*library-managed subscription cannot renew/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the mounter parses and registers itself', () => {
    expect(typeof register(mercadopagoMounter).mercadopago).toBe('function');
  });
});
