import { afterEach, describe, expect, it, vi } from 'vitest';
import { EfiDriver } from '../src/drivers/efi.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A `fetch` double that answers by URL suffix. Efí's driver talks to `/oauth/token` before
 * anything else, so every scenario has to serve that too — which is exactly what makes the
 * token-cache behaviour observable: count the calls to it.
 */
function fakeFetch(handlers: Array<[RegExp, (call: Call) => { status?: number; body: unknown }]>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((value, name) => {
      headers[name] = value;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    };
    calls.push(call);
    for (const [pattern, handler] of handlers) {
      if (pattern.test(call.url)) {
        const { status = 200, body } = handler(call);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const TOKEN_BODY = { access_token: 'tok_1', token_type: 'Bearer', expires_in: 3600 };

const COB = {
  txid: 'abc123def456ghi789jkl012mn',
  status: 'ATIVA',
  calendario: { criacao: '2026-08-01T10:00:00.000Z', expiracao: 3600 },
  valor: { original: '19.90' },
  chave: 'key-uuid',
  loc: { id: 42 },
  pixCopiaECola: '00020101BR.GOV.BCB.PIX',
};

function makeDriver(fetchImpl: typeof globalThis.fetch, config: Record<string, unknown> = {}) {
  return new EfiDriver(
    { config: () => ({}) },
    {
      clientId: 'id',
      clientSecret: 'secret',
      pixKey: 'key-uuid',
      sandbox: true,
      fetch: fetchImpl,
      ...config,
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EfiDriver boot', () => {
  it('refuses to boot without a certificate, naming what to do about it', () => {
    expect(
      () =>
        new EfiDriver(
          { config: () => ({}) },
          { clientId: 'id', clientSecret: 'secret', pixKey: 'key' },
        ),
    ).toThrow(/mutual TLS/);
  });

  it('refuses to boot when the certificate path cannot be read', () => {
    expect(
      () =>
        new EfiDriver(
          { config: () => ({}) },
          {
            clientId: 'id',
            clientSecret: 'secret',
            pixKey: 'key',
            certificate: '/nope/missing.p12',
          },
        ),
    ).toThrow(/could not be read/);
  });

  it('refuses to boot without OAuth credentials', () => {
    const { fn } = fakeFetch([]);
    expect(() => new EfiDriver({ config: () => ({}) }, { pixKey: 'key', fetch: fn })).toThrow(
      /requires clientId.*EFI_CLIENT_ID.*payments\.efi/s,
    );
  });

  it('refuses to boot without the receiving Pix key', () => {
    const { fn } = fakeFetch([]);
    expect(
      () => new EfiDriver({ config: () => ({}) }, { clientId: 'i', clientSecret: 's', fetch: fn }),
    ).toThrow(/requires pixKey.*EFI_PIX_KEY/s);
  });
});

describe('EfiDriver access token', () => {
  it('sends the client credentials as Basic auth to the homologation host', async () => {
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: COB })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    await makeDriver(fn).charge({ amount: 1990, method: 'pix' });

    const token = calls[0]!;
    expect(token.url).toBe('https://pix-h.api.efipay.com.br/oauth/token');
    expect(token.method).toBe('POST');
    expect(token.body).toEqual({ grant_type: 'client_credentials' });
    expect(token.headers.authorization).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
    expect(calls[1]!.headers.authorization).toBe('Bearer tok_1');
  });

  it('reuses a cached token while it is still valid', async () => {
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: COB })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    const driver = makeDriver(fn);
    await driver.charge({ amount: 1990, method: 'pix' });
    await driver.charge({ amount: 1990, method: 'pix' });

    expect(calls.filter((call) => call.url.includes('/oauth/token'))).toHaveLength(1);
  });

  it('does not outlive the token: a new one is minted once expires_in has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    let minted = 0;
    const { fn, calls } = fakeFetch([
      [
        /oauth\/token/,
        () => {
          minted += 1;
          return { body: { ...TOKEN_BODY, access_token: `tok_${minted}` } };
        },
      ],
      [/v2\/cob/, () => ({ body: COB })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    const driver = makeDriver(fn);
    await driver.charge({ amount: 1990, method: 'pix' });

    // 59 minutes in the token is still good (3600s minus a minute of skew).
    vi.setSystemTime(new Date('2026-08-01T10:58:00.000Z'));
    await driver.charge({ amount: 1990, method: 'pix' });
    expect(minted).toBe(1);

    // An hour and a bit later it is not, and the driver must notice before Efí does.
    vi.setSystemTime(new Date('2026-08-01T11:05:00.000Z'));
    await driver.charge({ amount: 1990, method: 'pix' });
    expect(minted).toBe(2);
    expect(calls.at(-2)!.headers.authorization).toBe('Bearer tok_2');
  });

  it('honours a short expires_in instead of assuming an hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
    let minted = 0;
    const { fn } = fakeFetch([
      [
        /oauth\/token/,
        () => {
          minted += 1;
          return { body: { access_token: `tok_${minted}`, expires_in: 120 } };
        },
      ],
      [/v2\/cob/, () => ({ body: COB })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    const driver = makeDriver(fn);
    await driver.charge({ amount: 1990, method: 'pix' });
    vi.setSystemTime(new Date('2026-08-01T10:02:30.000Z'));
    await driver.charge({ amount: 1990, method: 'pix' });
    expect(minted).toBe(2);
  });

  it('mints one token for concurrent calls, not one each', async () => {
    let minted = 0;
    const { fn } = fakeFetch([
      [
        /oauth\/token/,
        () => {
          minted += 1;
          return { body: TOKEN_BODY };
        },
      ],
      [/v2\/cob/, () => ({ body: COB })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    const driver = makeDriver(fn);
    await Promise.all([
      driver.charge({ amount: 100, method: 'pix' }),
      driver.charge({ amount: 100, method: 'pix' }),
      driver.charge({ amount: 100, method: 'pix' }),
    ]);
    expect(minted).toBe(1);
  });

  it('drops a revoked token on a 401 and retries the call once', async () => {
    let minted = 0;
    let cobCalls = 0;
    const { fn } = fakeFetch([
      [
        /oauth\/token/,
        () => {
          minted += 1;
          return { body: { ...TOKEN_BODY, access_token: `tok_${minted}` } };
        },
      ],
      [
        /v2\/cob/,
        () => {
          cobCalls += 1;
          return cobCalls === 1 ? { status: 401, body: { nome: 'unauthorized' } } : { body: COB };
        },
      ],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    const payment = await makeDriver(fn).charge({ amount: 1990, method: 'pix' });
    expect(minted).toBe(2);
    expect(cobCalls).toBe(2);
    expect(payment.gatewayId).toBe(COB.txid);
  });
});

describe('EfiDriver charges', () => {
  it('creates a cob with the amount as a decimal string and returns the BR Code', async () => {
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: COB })],
      [
        /v2\/loc\/42\/qrcode/,
        () => ({
          body: { qrcode: '00020101BR.GOV.BCB.PIX', imagemQrcode: 'data:image/png;base64,AAAA' },
        }),
      ],
    ]);
    const payment = await makeDriver(fn).charge({
      amount: 1990,
      method: 'pix',
      description: 'Plano Pro',
      customer: { name: 'Ana', taxId: '123.456.789-09' },
    });

    const cob = calls.find((call) => call.url.endsWith('/v2/cob'))!;
    expect(cob.method).toBe('POST');
    expect(cob.body).toEqual({
      calendario: { expiracao: 3600 },
      valor: { original: '19.90' },
      chave: 'key-uuid',
      devedor: { nome: 'Ana', cpf: '12345678909' },
      solicitacaoPagador: 'Plano Pro',
    });

    expect(payment.gatewayId).toBe(COB.txid);
    expect(payment.amount).toEqual({ amount: 1990, currency: 'brl' });
    expect(payment.status).toBe('pending');
    expect(payment.method).toBe('pix');
    expect(payment.pixCode).toBe('00020101BR.GOV.BCB.PIX');
    // The data-URI prefix is stripped: this field is documented as bare base64.
    expect(payment.pixQrCodeImage).toBe('AAAA');
  });

  it('uses a txid-shaped externalReference as the txid, so the webhook routes itself', async () => {
    const reference = 'orderabc123def456ghi789jkl0';
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: { ...COB, txid: reference } })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    const payment = await makeDriver(fn).charge({
      amount: 1990,
      method: 'pix',
      externalReference: reference,
    });
    const cob = calls.find((call) => call.url.includes('/v2/cob'))!;
    expect(cob.method).toBe('PUT');
    expect(cob.url).toBe(`https://pix-h.api.efipay.com.br/v2/cob/${reference}`);
    expect(payment.gatewayId).toBe(reference);
  });

  it('lets Efí generate the txid when the reference does not fit the charset', async () => {
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: COB })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    await makeDriver(fn).charge({ amount: 1990, method: 'pix', externalReference: 'pay:1' });
    const cob = calls.find((call) => call.url.includes('/v2/cob'))!;
    expect(cob.method).toBe('POST');
    expect(cob.url).toBe('https://pix-h.api.efipay.com.br/v2/cob');
  });

  it('omits the payer when only half of what Efí requires is known', async () => {
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: COB })],
      [/v2\/loc/, () => ({ body: {} })],
    ]);
    await makeDriver(fn).charge({ amount: 100, method: 'pix', customer: { name: 'Ana' } });
    const cob = calls.find((call) => call.url.endsWith('/v2/cob'))!;
    expect((cob.body as Record<string, unknown>).devedor).toBeUndefined();
  });

  it('refuses a method the Pix API cannot settle', async () => {
    const { fn } = fakeFetch([[/oauth\/token/, () => ({ body: TOKEN_BODY })]]);
    await expect(makeDriver(fn).charge({ amount: 100, method: 'boleto' })).rejects.toThrow(
      /Cobranças API/,
    );
  });

  it('maps a settled cob to a paid payment', async () => {
    const { fn } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [
        /v2\/cob/,
        () => ({
          body: {
            ...COB,
            status: 'CONCLUIDA',
            pix: [
              {
                endToEndId: 'E00038166201907261559y6j6mt1u0f6',
                valor: '19.90',
                horario: '2026-08-01T10:05:00.000Z',
              },
            ],
          },
        }),
      ],
    ]);
    const payment = await makeDriver(fn).findPayment(COB.txid);
    expect(payment?.status).toBe('paid');
    expect(payment?.paidAt).toBe('2026-08-01T10:05:00.000Z');
  });

  it('reads a MED-returned charge back as disputed, the way its webhook reports it', async () => {
    const { fn } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [
        /v2\/cob/,
        () => ({
          body: {
            ...COB,
            status: 'CONCLUIDA',
            pix: [
              {
                endToEndId: 'E1',
                valor: '19.90',
                devolucoes: [
                  { id: 'd1', valor: '19.90', natureza: 'MED_FRAUDE', status: 'DEVOLVIDO' },
                ],
              },
            ],
          },
        }),
      ],
    ]);
    // `refunded` would say the merchant gave the money back. The webhook calls the same
    // state `payment.disputed`; reading the charge has to agree with it.
    expect((await makeDriver(fn).findPayment(COB.txid))?.status).toBe('disputed');
  });
});

describe('EfiDriver refunds', () => {
  it('resolves the txid to the settled Pix and refunds against its endToEndId', async () => {
    const e2e = 'E00038166201907261559y6j6mt1u0f6';
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [
        /v2\/cob/,
        () => ({
          body: { ...COB, status: 'CONCLUIDA', pix: [{ endToEndId: e2e, valor: '19.90' }] },
        }),
      ],
      [
        /devolucao/,
        (call) => ({
          body: { id: call.url.split('/').at(-1), valor: '19.90', status: 'DEVOLVIDO' },
        }),
      ],
    ]);
    const refund = await makeDriver(fn).refund(COB.txid);
    const devolucao = calls.find((call) => call.url.includes('/devolucao/'))!;
    expect(devolucao.method).toBe('PUT');
    expect(devolucao.url).toContain(`/v2/pix/${e2e}/devolucao/`);
    expect(devolucao.body).toEqual({ valor: '19.90' });
    expect(refund.status).toBe('succeeded');
    expect(refund.amount).toEqual({ amount: 1990, currency: 'brl' });
  });

  it('refunds a partial amount as a decimal string', async () => {
    const e2e = 'E00038166201907261559y6j6mt1u0f6';
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [
        /v2\/cob/,
        () => ({
          body: { ...COB, status: 'CONCLUIDA', pix: [{ endToEndId: e2e, valor: '19.90' }] },
        }),
      ],
      [/devolucao/, () => ({ body: { id: 'r1', valor: '5.00', status: 'EM_PROCESSAMENTO' } })],
    ]);
    const refund = await makeDriver(fn).refund(COB.txid, 500);
    expect(calls.find((call) => call.url.includes('/devolucao/'))!.body).toEqual({ valor: '5.00' });
    expect(refund.status).toBe('pending');
  });

  it('says why an unpaid charge cannot be refunded', async () => {
    const { fn } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: COB })],
    ]);
    await expect(makeDriver(fn).refund(COB.txid)).rejects.toThrow(/has not been paid/);
  });
});

describe('EfiDriver webhooks', () => {
  const { fn } = fakeFetch([]);

  it('maps a received Pix to payment.succeeded, keyed by its endToEndId', () => {
    const driver = makeDriver(fn);
    const raw = JSON.stringify({
      pix: [
        {
          endToEndId: 'E00038166201907261559y6j6mt1u0f6',
          txid: COB.txid,
          chave: 'key-uuid',
          valor: '19.90',
          horario: '2026-08-01T10:05:00.000Z',
        },
      ],
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
    expect(event.id).toBe('E00038166201907261559y6j6mt1u0f6');
    const data = event.data as { gatewayId: string; amount: number; externalReference?: string };
    // The txid is the id `charge()` handed back — the two sides reconcile.
    expect(data.gatewayId).toBe(COB.txid);
    expect(data.amount).toBe(1990);
    expect(data.externalReference).toBe(COB.txid);
  });

  it('maps a completed devolução to payment.refunded under its own event id', () => {
    const raw = JSON.stringify({
      pix: [
        {
          endToEndId: 'E1',
          txid: COB.txid,
          valor: '19.90',
          devolucoes: [{ id: 'r1', valor: '19.90', status: 'DEVOLVIDO' }],
        },
      ],
    });
    const event = makeDriver(fn).parseWebhook(raw, {});
    expect(event.type).toBe('payment.refunded');
    expect(event.id).toBe('E1:devolvido');
  });

  it('maps a MED return to payment.disputed, not to payment.refunded', () => {
    // A Pix cannot be charged back, but it can be taken back: BACEN's MED returns money to
    // a payer who reported fraud, and it arrives as an ordinary `devolução` marked
    // `natureza: MED_FRAUDE`. Calling it a refund said the merchant chose to give the money
    // back — the one thing that did not happen.
    const raw = JSON.stringify({
      pix: [
        {
          endToEndId: 'E1',
          txid: COB.txid,
          valor: '19.90',
          devolucoes: [{ id: 'd1', valor: '19.90', natureza: 'MED_FRAUDE', status: 'DEVOLVIDO' }],
        },
      ],
    });
    const event = makeDriver(fn).parseWebhook(raw, {});
    expect(event.type).toBe('payment.disputed');
    expect(event.id).toBe('E1:med:d1:DEVOLVIDO');
    expect(event.data).toMatchObject({
      gatewayId: COB.txid,
      amount: 1990,
      currency: 'brl',
      disputeId: 'd1',
      reason: 'MED_FRAUDE',
    });
  });

  it('warns on a MED return that is still executing, and never calls it a chargeback', () => {
    // `EM_PROCESSAMENTO` is the return being executed: nothing has left the account yet, so
    // the payment row is still telling the truth when it says `paid`. It gets its own event
    // id so the `DEVOLVIDO` that follows is not skipped as a redelivery.
    const raw = JSON.stringify({
      pix: [
        {
          endToEndId: 'E1',
          txid: COB.txid,
          valor: '19.90',
          devolucoes: [
            { id: 'd1', valor: '19.90', natureza: 'MED_OPERACIONAL', status: 'EM_PROCESSAMENTO' },
          ],
        },
      ],
    });
    const event = makeDriver(fn).parseWebhook(raw, {});
    expect(event.type).toBe('payment.dispute_warning');
    expect(event.type).not.toBe('payment.disputed');
    expect(event.id).toBe('E1:med:d1:EM_PROCESSAMENTO');
    // Efí's Pix notification has no deadline field anywhere, and inventing one would be
    // worse than the absence.
    expect(event.data).not.toHaveProperty('actionableUntil');
  });

  it('does not treat a MED that was never executed as money leaving', () => {
    // `NAO_REALIZADO` is Efí's own example of a return that did not happen (insufficient
    // balance). Nothing was taken, so nothing is disputed.
    const raw = JSON.stringify({
      pix: [
        {
          endToEndId: 'E1',
          txid: COB.txid,
          valor: '19.90',
          devolucoes: [
            {
              id: 'd1',
              valor: '19.90',
              natureza: 'MED_FRAUDE',
              status: 'NAO_REALIZADO',
              motivo: 'Saldo insuficiente para realizar a devolução.',
            },
          ],
        },
      ],
    });
    const event = makeDriver(fn).parseWebhook(raw, {});
    expect(event.type).not.toBe('payment.disputed');
    expect(event.type).not.toBe('payment.dispute_warning');
  });

  it('still calls a merchant-initiated devolução a refund', () => {
    // `ORIGINAL` (and an absent `natureza`, which the API Pix spec says means `ORIGINAL`)
    // is the refund the merchant asked for. Nothing about that changed.
    const raw = JSON.stringify({
      pix: [
        {
          endToEndId: 'E1',
          txid: COB.txid,
          valor: '19.90',
          devolucoes: [{ id: 'r1', valor: '19.90', natureza: 'ORIGINAL', status: 'DEVOLVIDO' }],
        },
      ],
    });
    const event = makeDriver(fn).parseWebhook(raw, {});
    expect(event.type).toBe('payment.refunded');
    expect(event.id).toBe('E1:devolvido');
  });

  it('refuses a batched notification loudly rather than dropping the rest', () => {
    const raw = JSON.stringify({
      pix: [
        { endToEndId: 'E1', txid: 'tx1', valor: '1.00' },
        { endToEndId: 'E2', txid: 'tx2', valor: '2.00' },
      ],
    });
    expect(() => makeDriver(fn).parseWebhook(raw, {})).toThrow(/tx1, tx2/);
  });

  it('answers the registration probe with an inert event instead of throwing', () => {
    const event = makeDriver(fn).parseWebhook(JSON.stringify({ evento: 'teste_webhook' }), {});
    expect(event.type).toBe('efi.teste_webhook');
    expect(event.id).toMatch(/^efi-teste_webhook-/);
  });

  it('rejects a body that is not JSON', () => {
    expect(() => makeDriver(fn).parseWebhook('not json', {})).toThrow(/not JSON/);
  });

  it('registers the webhook with the skip-mTLS header when asked', async () => {
    const local = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/webhook/, () => ({ body: {} })],
    ]);
    await makeDriver(local.fn).registerPixWebhook(
      'https://app.test/payments/webhook/efi?ignorar=',
      {
        skipMtls: true,
      },
    );
    const call = local.calls.find((c) => c.url.includes('/v2/webhook'))!;
    expect(call.method).toBe('PUT');
    expect(call.body).toEqual({
      webhookUrl: 'https://app.test/payments/webhook/efi?ignorar=',
    });
    expect(call.headers['x-skip-mtls-checking']).toBe('true');
  });
});

describe('EfiDriver capabilities', () => {
  const { fn } = fakeFetch([]);

  it('is Pix-only and says so', () => {
    expect([...makeDriver(fn).supportedMethods]).toEqual(['pix']);
  });

  it('refuses subscriptions, naming the products that do have them', async () => {
    const driver = makeDriver(fn);
    expect(driver.capabilities.subscriptions).toBe(false);
    await expect(driver.createSubscription({ customerId: 'c', planId: 'p' })).rejects.toThrow(
      /Cobranças API|Pix Automático/,
    );
  });

  it('refuses customer operations the Pix API does not have', async () => {
    const driver = makeDriver(fn);
    await expect(driver.createCustomer({ name: 'Ana' })).rejects.toThrow(/no customer resource/);
  });

  it('throws on listInvoices instead of answering with an empty list', async () => {
    // An empty array is indistinguishable from "this customer has no invoices", which is
    // the same silent shape as the bugs this batch exists to remove: the caller reads zero
    // rows and concludes the customer never bought anything.
    const driver = makeDriver(fn);
    expect(driver.capabilities.invoices).toBe(false);
    await expect(driver.listInvoices('cus_1')).rejects.toThrow(
      /\[payments\] Ef\u00ed's Pix API has no invoices to list/,
    );
  });
});

describe('EfiDriver refund idempotency', () => {
  const settled = (e2e: string) =>
    [
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [
        /v2\/cob/,
        () => ({
          body: { ...COB, status: 'CONCLUIDA', pix: [{ endToEndId: e2e, valor: '19.90' }] },
        }),
      ],
      [
        /devolucao/,
        (call: Call) => ({
          body: { id: call.url.split('/').at(-1), valor: '19.90', status: 'DEVOLVIDO' },
        }),
      ],
    ] as Array<[RegExp, (call: Call) => { status?: number; body: unknown }]>;

  it('uses the idempotency key as the devolução id, which is what Efí deduplicates on', async () => {
    const e2e = 'E00038166201907261559y6j6mt1u0f6';
    const { fn, calls } = fakeFetch(settled(e2e));
    await makeDriver(fn).refund(COB.txid, undefined, { idempotencyKey: 'refundkey0001' });
    // The devolução id IS the deduplication on this API — a PUT to the same id is the same
    // refund — so the caller's key has to be the id, verbatim, not a random one beside it.
    expect(calls.find((call) => call.url.includes('/devolucao/'))!.url).toContain(
      `/v2/pix/${e2e}/devolucao/refundkey0001`,
    );
  });

  it('still mints an id when no key is given, so the call works without one', async () => {
    const e2e = 'E00038166201907261559y6j6mt1u0f6';
    const { fn, calls } = fakeFetch(settled(e2e));
    await makeDriver(fn).refund(COB.txid);
    const id = calls
      .find((call) => call.url.includes('/devolucao/'))!
      .url.split('/')
      .at(-1)!;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('refuses a key BACEN cannot accept rather than silently minting a random id', async () => {
    const e2e = 'E00038166201907261559y6j6mt1u0f6';
    const { fn } = fakeFetch(settled(e2e));
    // A UUID with its dashes is the obvious thing a caller passes, and it is outside the
    // charset. Dropping it here would turn the caller's retry guarantee into a second refund.
    await expect(
      makeDriver(fn).refund(COB.txid, undefined, {
        idempotencyKey: '4f1c2b3a-0000-4000-8000-abcdefabcdef',
      }),
    ).rejects.toThrow(/1\u201335 alphanumeric characters/);
  });
});

describe('EfiDriver checkout', () => {
  it('round-trips externalReference through the txid: in on the session, out of the webhook', async () => {
    const reference = 'chkabc123def456ghi789jkl012';
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: { ...COB, txid: reference } })],
    ]);
    const driver = makeDriver(fn);
    const session = await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://app.test/ok',
      externalReference: reference,
    });
    const cob = calls.find((call) => call.url.includes('/v2/cob'))!;
    expect(cob.method).toBe('PUT');
    expect(cob.url.endsWith(`/v2/cob/${reference}`)).toBe(true);
    expect(session.gatewayId).toBe(reference);
    expect(session.url).toBe('');

    const event = driver.parseWebhook(
      JSON.stringify({ pix: [{ endToEndId: 'E1', txid: reference, valor: '19.90' }] }),
      {},
    );
    expect((event.data as { externalReference?: string }).externalReference).toBe(reference);
    expect((event.data as { gatewayId: string }).gatewayId).toBe(session.gatewayId);
  });

  it('cannot echo a checkout reference that does not fit the txid charset', async () => {
    const { fn, calls } = fakeFetch([
      [/oauth\/token/, () => ({ body: TOKEN_BODY })],
      [/v2\/cob/, () => ({ body: COB })],
    ]);
    const session = await makeDriver(fn).createCheckout({
      amount: 1990,
      successUrl: 'https://app.test/ok',
      externalReference: 'chk:local:1',
    });
    // Efí generated the txid, so the app's reference is nowhere on the charge — and the
    // webhook will carry the txid instead. Persist `gatewayId` to route it.
    expect(calls.find((call) => call.url.includes('/v2/cob'))!.method).toBe('POST');
    expect(session.gatewayId).toBe(COB.txid);
  });
});
