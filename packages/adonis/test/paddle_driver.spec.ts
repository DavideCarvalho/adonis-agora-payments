import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaddleDriver } from '../src/drivers/paddle.js';

const WEBHOOK_SECRET = 'pdl_ntfset_test';

function makeDriver(overrides: Record<string, unknown> = {}) {
  return new PaddleDriver({ config: () => ({}) }, {
    apiKey: 'pdl_sdbx_apikey_test',
    currency: 'usd',
    sandbox: true,
    productId: 'pro_test',
    webhookSecret: WEBHOOK_SECRET,
    ...overrides,
  } as never);
}

/** Sign a body exactly the way Paddle does: HMAC-SHA256 over `<ts>:<body>`, hex. */
function sign(body: string, secret = WEBHOOK_SECRET, ts = '1700000000') {
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`, 'utf8').digest('hex');
  return { 'paddle-signature': `ts=${ts};h1=${h1}` };
}

function stubFetch(json: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => json });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const transactionCompleted = {
  event_id: 'evt_01hv8x2axb33yr5y238zfwcn5p',
  event_type: 'transaction.completed',
  occurred_at: '2026-04-12T10:18:50.155553Z',
  notification_id: 'ntf_01hv8x2azy7scaan4s0eb0273x',
  data: {
    id: 'txn_01hv8wptq8987qeep44cyrewp9',
    status: 'completed',
    customer_id: 'ctm_01hv6y1jedq4p1n0yqn5ba3ky4',
    subscription_id: 'sub_01hv8x29kz0t586xy6zn1a62ny',
    custom_data: { external_reference: 'order:local_1' },
    currency_code: 'USD',
    billed_at: '2026-04-12T10:18:48.294633Z',
    created_at: '2026-04-12T10:12:33.2014Z',
    details: { totals: { total: '1990', grand_total: '1990', currency_code: 'USD' } },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PaddleDriver', () => {
  it('refuses to boot without an API key', () => {
    // `vi.stubEnv(name, undefined)` actually removes the var (and restores it after),
    // which `process.env.PADDLE_API_KEY = undefined` does not — it stores the
    // string "undefined", which reads as a perfectly good credential.
    vi.stubEnv('PADDLE_API_KEY', undefined);
    try {
      expect(() => makeDriver({ apiKey: undefined })).toThrow(/requires apiKey/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses to boot without a currency', () => {
    expect(() => makeDriver({ currency: undefined })).toThrow(/no currency configured/);
  });

  it('creates a checkout as a transaction, sending the amount as a string of cents', async () => {
    const fetchMock = stubFetch({
      data: {
        id: 'txn_1',
        status: 'ready',
        currency_code: 'USD',
        customer_id: 'ctm_1',
        checkout: { url: 'https://app.example/pay?_ptxn=txn_1' },
        details: { totals: { total: '1990', currency_code: 'USD' } },
      },
    });
    const driver = makeDriver();

    const session = await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://app.example/pay',
      description: 'Pro plan',
      externalReference: 'order:local_1',
    });

    expect(session.gatewayId).toBe('txn_1');
    expect(session.url).toBe('https://app.example/pay?_ptxn=txn_1');
    expect(session.status).toBe('open');
    expect(session.amount).toEqual({ amount: 1990, currency: 'usd' });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://sandbox-api.paddle.com/transactions');
    const body = JSON.parse(String(init.body));
    // Paddle money is a string of the smallest unit with the currency named separately.
    expect(body.items[0].price.unit_price).toEqual({ amount: '1990', currency_code: 'USD' });
    expect(body.items[0].price.product_id).toBe('pro_test');
    expect(body.currency_code).toBe('USD');
    expect(body.custom_data).toEqual({ external_reference: 'order:local_1' });
    expect(body.checkout).toEqual({ url: 'https://app.example/pay' });
  });

  it('round-trips externalReference from the session into the webhook', async () => {
    const fetchMock = stubFetch({
      data: {
        id: 'txn_rt',
        status: 'ready',
        currency_code: 'USD',
        checkout: { url: 'https://app.example/pay?_ptxn=txn_rt' },
        details: { totals: { total: '1990', currency_code: 'USD' } },
      },
    });
    const driver = makeDriver();

    await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://app.example/pay',
      externalReference: 'order:local_7',
    });

    const sent = JSON.parse(String((fetchMock.mock.calls[0]! as [string, RequestInit])[1].body));
    expect(sent.custom_data).toEqual({ external_reference: 'order:local_7' });

    // The same key comes back on the transaction's own webhook, which is the only thing
    // tying the confirmation to the app's row.
    const raw = JSON.stringify({
      ...transactionCompleted,
      data: { ...transactionCompleted.data, custom_data: sent.custom_data },
    });
    const event = driver.parseWebhook(raw, sign(raw));
    expect((event.data as { externalReference: string }).externalReference).toBe('order:local_7');
  });

  it('still honours metadata.externalReference for callers written before the field existed', async () => {
    const fetchMock = stubFetch({
      data: { id: 'txn_m', status: 'ready', currency_code: 'USD', details: { totals: {} } },
    });

    await makeDriver().createCheckout({
      amount: 1990,
      successUrl: 'https://app.example/pay',
      metadata: { externalReference: 'order:legacy' },
    });

    const sent = JSON.parse(String((fetchMock.mock.calls[0]! as [string, RequestInit])[1].body));
    expect(sent.custom_data).toEqual({ external_reference: 'order:legacy' });
  });

  it('maps a transaction onto the canonical Payment with integer cents', async () => {
    stubFetch({
      data: {
        id: 'txn_2',
        status: 'completed',
        currency_code: 'USD',
        customer_id: 'ctm_1',
        subscription_id: 'sub_1',
        billed_at: '2026-04-12T10:18:48.294633Z',
        created_at: '2026-04-12T10:12:33.2014Z',
        details: { totals: { total: '65215', grand_total: '65215', currency_code: 'USD' } },
        payments: [{ status: 'captured', method_details: { type: 'card' } }],
      },
    });
    const driver = makeDriver();

    const payment = await driver.findPayment('txn_2');

    expect(payment).not.toBeNull();
    expect(payment?.amount).toEqual({ amount: 65215, currency: 'usd' });
    expect(payment?.status).toBe('paid');
    expect(payment?.method).toBe('card');
    expect(payment?.customerId).toBe('ctm_1');
    expect(payment?.subscriptionId).toBe('sub_1');
    expect(payment?.paidAt).toBe('2026-04-12T10:18:48.294633Z');
  });

  it('accepts a correctly signed webhook and reads externalReference back out', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(transactionCompleted);

    const event = driver.parseWebhook(raw, sign(raw));

    expect(event.id).toBe('evt_01hv8x2axb33yr5y238zfwcn5p');
    expect(event.type).toBe('payment.succeeded');
    expect(event.createdAt).toBe('2026-04-12T10:18:50.155553Z');
    const data = event.data as { externalReference: string; amount: number; currency: string };
    expect(data.externalReference).toBe('order:local_1');
    expect(data.amount).toBe(1990);
    expect(data.currency).toBe('usd');
  });

  it('rejects a webhook whose body was tampered with after signing', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(transactionCompleted);
    const headers = sign(raw);
    const tampered = raw.replace('"1990"', '"1"');

    expect(() => driver.parseWebhook(tampered, headers)).toThrow(
      /Invalid Paddle webhook signature/,
    );
  });

  it('rejects a webhook signed with the wrong secret', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(transactionCompleted);

    expect(() => driver.parseWebhook(raw, sign(raw, 'pdl_ntfset_forged'))).toThrow(
      /Invalid Paddle webhook signature/,
    );
  });

  it('rejects a webhook with a missing or malformed Paddle-Signature header', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(transactionCompleted);

    expect(() => driver.parseWebhook(raw, {})).toThrow(/Missing `Paddle-Signature`/);
    expect(() => driver.parseWebhook(raw, { 'paddle-signature': 'garbage' })).toThrow(
      /Malformed `Paddle-Signature`/,
    );
  });

  it('refuses to parse webhooks when no signing secret is configured', () => {
    // `vi.stubEnv(name, undefined)` actually removes the var (and restores it after),
    // which `process.env.PADDLE_WEBHOOK_SECRET = undefined` does not — it stores the
    // string "undefined", which reads as a perfectly good credential.
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', undefined);
    try {
      const driver = makeDriver({ webhookSecret: undefined });
      const raw = JSON.stringify(transactionCompleted);
      expect(() => driver.parseWebhook(raw, sign(raw))).toThrow(
        /requires the notification setting/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a replayed webhook when a max age is configured', () => {
    const driver = makeDriver({ webhookMaxAgeSeconds: 60 });
    const raw = JSON.stringify(transactionCompleted);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);

    expect(() => driver.parseWebhook(raw, sign(raw, WEBHOOK_SECRET, stale))).toThrow(
      /outside the accepted window/,
    );
  });

  it('maps subscription and adjustment events onto the canonical types', () => {
    const driver = makeDriver();

    const subscriptionRaw = JSON.stringify({
      event_id: 'evt_sub_1',
      event_type: 'subscription.canceled',
      data: {
        id: 'sub_1',
        status: 'canceled',
        customer_id: 'ctm_1',
        currency_code: 'USD',
        custom_data: { external_reference: 'sub:local_1' },
        items: [{ price: { id: 'pri_1', unit_price: { amount: '4990', currency_code: 'USD' } } }],
        canceled_at: '2026-05-01T00:00:00Z',
      },
    });
    const subscriptionEvent = driver.parseWebhook(subscriptionRaw, sign(subscriptionRaw));
    expect(subscriptionEvent.type).toBe('subscription.canceled');
    expect(subscriptionEvent.data).toMatchObject({
      gatewayId: 'sub_1',
      planId: 'pri_1',
      externalReference: 'sub:local_1',
    });

    const refundRaw = JSON.stringify({
      event_id: 'evt_adj_1',
      event_type: 'adjustment.created',
      data: {
        id: 'adj_1',
        action: 'refund',
        transaction_id: 'txn_1',
        status: 'approved',
        totals: { total: '1990', currency_code: 'USD' },
      },
    });
    const refundEvent = driver.parseWebhook(refundRaw, sign(refundRaw));
    expect(refundEvent.type).toBe('payment.refunded');
    expect(refundEvent.data).toMatchObject({ gatewayId: 'txn_1', amount: 1990, currency: 'usd' });

    // A credit is an adjustment too, and is deliberately not reported as a refund.
    const creditRaw = JSON.stringify({
      event_id: 'evt_adj_2',
      event_type: 'adjustment.created',
      data: { id: 'adj_2', action: 'credit', transaction_id: 'txn_1', status: 'approved' },
    });
    expect(driver.parseWebhook(creditRaw, sign(creditRaw)).type).toBe('payment.updated');
  });

  it('refuses every operation Paddle does not have', async () => {
    const driver = makeDriver();

    await expect(driver.charge({ amount: 1990 })).rejects.toThrow(/cannot charge server-side/);
    await expect(
      driver.createSubscription({ customerId: 'ctm_1', planId: 'pri_1' }),
    ).rejects.toThrow(/cannot create a subscription over the API/);
    await expect(driver.updateSubscription('sub_1', { amount: 4990 })).rejects.toThrow(
      /no editable amount on a subscription/,
    );
    await expect(driver.updateSubscription('sub_1', { description: 'Pro' })).rejects.toThrow(
      /no description field/,
    );
    await expect(
      driver.createCheckout({ amount: 1990, successUrl: 'https://a.test', trialDays: 14 }),
    ).rejects.toThrow(/configures trials on the price/);
    await expect(driver.updateCustomer('ctm_1', { taxId: '123' })).rejects.toThrow(
      /stores tax ids on a business/,
    );

    // No `planId` and no configured product: refuse rather than invent a catalog entry.
    const bare = makeDriver({ productId: undefined });
    await expect(
      bare.createCheckout({ amount: 1990, successUrl: 'https://a.test' }),
    ).rejects.toThrow(/needs a product for a non-catalog checkout/);
  });

  it('refunds fully without items, and refuses a partial refund it cannot address', async () => {
    const fullFetch = stubFetch({
      data: {
        id: 'adj_1',
        action: 'refund',
        transaction_id: 'txn_1',
        status: 'pending_approval',
        totals: { total: '1990', currency_code: 'USD' },
        created_at: '2026-04-12T10:18:48Z',
      },
    });
    const driver = makeDriver();

    const refund = await driver.refund('txn_1');
    expect(refund.status).toBe('pending');
    expect(refund.amount).toEqual({ amount: 1990, currency: 'usd' });
    const body = JSON.parse(String((fullFetch.mock.calls[0]! as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ action: 'refund', type: 'full', transaction_id: 'txn_1' });
    expect(body.items).toBeUndefined();

    vi.unstubAllGlobals();
    stubFetch({
      data: {
        id: 'txn_1',
        status: 'completed',
        currency_code: 'USD',
        details: { totals: { total: '1990' }, line_items: [{ id: 'a' }, { id: 'b' }] },
      },
    });
    await expect(driver.refund('txn_1', 500)).rejects.toThrow(/per transaction line item/);
  });

  it('sends a partial refund against the single line item it can address', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: 'txn_1',
            status: 'completed',
            currency_code: 'USD',
            details: {
              totals: { total: '1990' },
              line_items: [{ id: 'txnitm_1' }],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: 'adj_1',
            action: 'refund',
            transaction_id: 'txn_1',
            status: 'approved',
            totals: { total: '500', currency_code: 'USD' },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const refund = await makeDriver().refund('txn_1', 500);

    expect(refund.status).toBe('succeeded');
    const body = JSON.parse(String((fetchMock.mock.calls[1]! as [string, RequestInit])[1].body));
    expect(body.type).toBe('partial');
    // Paddle wants the amount as a string, in the same smallest unit.
    expect(body.items).toEqual([{ item_id: 'txnitm_1', type: 'partial', amount: '500' }]);
  });

  it('pins the API version and sends the key as a bearer token', async () => {
    const fetchMock = stubFetch({ data: { id: 'ctm_1', email: 'a@b.test' } });

    await makeDriver().createCustomer({ email: 'a@b.test', name: 'A' });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer pdl_sdbx_apikey_test');
    expect(headers['Paddle-Version']).toBe('1');
  });
});
