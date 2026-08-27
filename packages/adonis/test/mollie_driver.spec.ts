import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MollieDriverConfig } from '../src/drivers/mollie.js';
import { MollieDriver } from '../src/drivers/mollie.js';

function makeDriver(overrides: Partial<MollieDriverConfig> = {}) {
  return new MollieDriver({ config: () => ({}) }, {
    apiKey: 'test_key',
    currency: 'eur',
    ...overrides,
  } as MollieDriverConfig);
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const paidPayment = {
  id: 'tr_1',
  status: 'paid',
  amount: { currency: 'EUR', value: '19.90' },
  metadata: { externalReference: 'order_local_1' },
  customerId: 'cst_1',
  createdAt: '2026-08-27T10:00:00+00:00',
  paidAt: '2026-08-27T10:01:00+00:00',
  method: 'creditcard',
};

/**
 * A next-gen Mollie webhook, as a byte-exact string: the HMAC is over the raw body, so
 * re-serializing it in the test would sign something other than what is asserted.
 */
const SIGNED_EVENT_BODY =
  '{"resource":"event","id":"event_abc","type":"payment.paid","entityId":"tr_1","createdAt":"2026-08-27T10:00:00+00:00"}';
const SIGNED_EVENT_SIGNATURE =
  'sha256=3634197554f18d73b9ecb0e0c8abc589626b05c4daf05c915b20e764ec2daba9';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MollieDriver — boot', () => {
  it('refuses to boot without an API key', () => {
    const key = process.env.MOLLIE_API_KEY;
    process.env.MOLLIE_API_KEY = '';
    try {
      expect(() => makeDriver({ apiKey: undefined })).toThrow(/requires apiKey/);
    } finally {
      process.env.MOLLIE_API_KEY = key;
    }
  });

  it('refuses to boot without a currency — a multi-currency gateway has no safe default', () => {
    expect(() => makeDriver({ currency: undefined })).toThrow(/no currency configured/);
  });
});

describe('MollieDriver — charge', () => {
  it('converts cents to a decimal string on the way out and back on the way in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...paidPayment,
        status: 'open',
        _links: { checkout: { href: 'https://www.mollie.com/checkout/tr_1' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const payment = await makeDriver().charge({
      customerId: 'cst_1',
      amount: 1990,
      description: 'Pro plan',
      externalReference: 'order_local_1',
      metadata: { redirectUrl: 'https://example.org/done' },
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.mollie.com/v2/payments');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test_key');
    // Mollie takes money as a decimal string; 1990 cents must go out as "19.90".
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: { currency: 'EUR', value: '19.90' },
      description: 'Pro plan',
      redirectUrl: 'https://example.org/done',
      customerId: 'cst_1',
      metadata: { externalReference: 'order_local_1' },
    });
    // …and "19.90" must come back as 1990, never 19.9.
    expect(payment).toMatchObject({
      gatewayId: 'tr_1',
      provider: 'mollie',
      status: 'pending',
      amount: { amount: 1990, currency: 'eur' },
      hostedUrl: 'https://www.mollie.com/checkout/tr_1',
    });
  });

  it('sends a zero-decimal currency with no decimals at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...paidPayment,
        amount: { currency: 'JPY', value: '1990' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // ¥1990 is 1990 yen, not ¥19.90 — a two-decimal conversion here bills a hundredth of
    // the charge, and Mollie accepts it.
    const payment = await makeDriver({ currency: 'jpy' }).charge({
      amount: 1990,
      metadata: { redirectUrl: 'https://example.org/done' },
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: { currency: 'JPY', value: '1990' },
    });
    expect(payment.amount).toEqual({ amount: 1990, currency: 'jpy' });
  });

  it('sends a three-decimal currency with three decimals', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ...paidPayment, amount: { currency: 'KWD', value: '1.990' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const payment = await makeDriver({ currency: 'kwd' }).charge({
      amount: 1990,
      metadata: { redirectUrl: 'https://example.org/done' },
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: { currency: 'KWD', value: '1.990' },
    });
    expect(payment.amount).toEqual({ amount: 1990, currency: 'kwd' });
  });

  it('asks Mollie for creditcard when the charge routes credit_card', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(paidPayment));
    vi.stubGlobal('fetch', fetchMock);
    await makeDriver().charge({
      amount: 1990,
      method: 'credit_card',
      metadata: { redirectUrl: 'https://example.org/done' },
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ method: 'creditcard' });
  });

  it('refuses a method Mollie has no name for rather than silently letting the shopper pick', async () => {
    await expect(
      makeDriver().charge({
        amount: 1990,
        method: 'pix',
        metadata: { redirectUrl: 'https://example.org/done' },
      }),
    ).rejects.toThrow(/no "pix" method/);
  });

  it('refuses a customer-facing charge with nowhere to redirect the payer', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeDriver().charge({ amount: 1990 })).rejects.toThrow(/requires a redirect URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('charges a stored mandate as a recurring sequence, with no redirect needed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(paidPayment));
    vi.stubGlobal('fetch', fetchMock);
    await makeDriver().charge({ customerId: 'cst_1', amount: 1990, paymentMethodId: 'mdt_1' });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      mandateId: 'mdt_1',
      sequenceType: 'recurring',
      customerId: 'cst_1',
    });
  });

  it('sends the idempotency key as the request header Mollie deduplicates on', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(paidPayment));
    vi.stubGlobal('fetch', fetchMock);

    await makeDriver().charge({
      amount: 1990,
      idempotencyKey: 'idem_1',
      metadata: { redirectUrl: 'https://example.org/done' },
    });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    // The header is the whole mechanism — Mollie deduplicates on nothing else, and a copy
    // in `metadata` would be echoed back while protecting nothing.
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem_1');
  });

  it('sends no idempotency header when the charge carries no key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(paidPayment));
    vi.stubGlobal('fetch', fetchMock);
    await makeDriver().charge({
      amount: 1990,
      metadata: { redirectUrl: 'https://example.org/done' },
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('refuses a percent-based split it cannot express', async () => {
    await expect(
      makeDriver().charge({
        amount: 1990,
        split: [{ walletId: 'org_1', percentualValue: 70 }],
        metadata: { redirectUrl: 'https://example.org/done' },
      }),
    ).rejects.toThrow(/Mollie Connect routes/);
  });

  it('reports a fully refunded payment as refunded, not paid', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ...paidPayment, amountRefunded: { currency: 'EUR', value: '19.90' } }),
        ),
    );
    const payment = await makeDriver().findPayment('tr_1');
    expect(payment?.status).toBe('refunded');
  });
});

describe('MollieDriver — checkout and refunds', () => {
  it('creates a hosted checkout and returns Mollie’s checkout link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...paidPayment,
        status: 'open',
        _links: { checkout: { href: 'https://www.mollie.com/checkout/tr_1' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const session = await makeDriver().createCheckout({
      amount: 1990,
      successUrl: 'https://example.org/ok',
      cancelUrl: 'https://example.org/cancel',
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      redirectUrl: 'https://example.org/ok',
      cancelUrl: 'https://example.org/cancel',
    });
    expect(session).toMatchObject({ url: 'https://www.mollie.com/checkout/tr_1', status: 'open' });
  });

  it('puts the checkout externalReference in metadata and reads it back off the webhook', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ...paidPayment,
          status: 'open',
          metadata: { externalReference: 'checkout_local_1' },
          _links: { checkout: { href: 'https://www.mollie.com/checkout/tr_1' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...paidPayment, metadata: { externalReference: 'checkout_local_1' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver();

    await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://example.org/ok',
      externalReference: 'checkout_local_1',
      idempotencyKey: 'idem_checkout_1',
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      metadata: { externalReference: 'checkout_local_1' },
    });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem_checkout_1');

    const event = await driver.parseWebhook('id=tr_1', {});
    expect((event.data as { externalReference: string }).externalReference).toBe(
      'checkout_local_1',
    );
  });

  it('refuses a subscription checkout instead of pretending Mollie has one', async () => {
    await expect(
      makeDriver().createCheckout({
        amount: 1990,
        successUrl: 'https://example.org/ok',
        planId: 'plan_pro',
      }),
    ).rejects.toThrow(/no subscription checkout/);
  });

  it('reads the payment first so a full refund uses the payment’s own currency', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ...paidPayment, amount: { currency: 'GBP', value: '19.90' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 're_1',
          amount: { currency: 'GBP', value: '19.90' },
          status: 'queued',
          createdAt: '2026-08-27T11:00:00+00:00',
          paymentId: 'tr_1',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const refund = await makeDriver().refund('tr_1');
    const [, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      amount: { currency: 'GBP', value: '19.90' },
    });
    expect(refund).toMatchObject({ status: 'pending', amount: { amount: 1990, currency: 'gbp' } });
  });
});

describe('MollieDriver — subscriptions', () => {
  it('creates a subscription under the customer and keeps the plan id in metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'sub_1',
        customerId: 'cst_1',
        status: 'active',
        amount: { currency: 'EUR', value: '49.90' },
        interval: '1 month',
        description: 'plan_pro',
        metadata: { planId: 'plan_pro', externalReference: 'sub_local_1' },
        createdAt: '2026-08-27T10:00:00+00:00',
        nextPaymentDate: '2026-09-27',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const subscription = await makeDriver().createSubscription({
      customerId: 'cst_1',
      planId: 'plan_pro',
      amount: 4990,
      cycle: 'MONTHLY',
      externalReference: 'sub_local_1',
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.mollie.com/v2/customers/cst_1/subscriptions');
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: { currency: 'EUR', value: '49.90' },
      interval: '1 month',
      description: 'plan_pro',
      metadata: { planId: 'plan_pro', externalReference: 'sub_local_1' },
    });
    expect(subscription).toMatchObject({
      gatewayId: 'sub_1',
      customerId: 'cst_1',
      status: 'active',
      planId: 'plan_pro',
      amount: { amount: 4990, currency: 'eur' },
    });
  });

  it('refuses a trial instead of faking one as a later first charge', async () => {
    await expect(
      makeDriver().createSubscription({
        customerId: 'cst_1',
        planId: 'plan_pro',
        amount: 4990,
        trialDays: 14,
      }),
    ).rejects.toThrow(/no trial period/);
  });

  it('cancels through the customer-scoped endpoint, using the customer it already saw', async () => {
    const created = {
      id: 'sub_1',
      customerId: 'cst_1',
      status: 'active',
      amount: { currency: 'EUR', value: '49.90' },
      interval: '1 month',
      createdAt: '2026-08-27T10:00:00+00:00',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(created))
      .mockResolvedValueOnce(
        jsonResponse({ ...created, status: 'canceled', canceledAt: '2026-08-28T10:00:00+00:00' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const driver = makeDriver();
    await driver.createSubscription({ customerId: 'cst_1', planId: 'p', amount: 4990 });
    const canceled = await driver.cancelSubscription('sub_1');

    const [url, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.mollie.com/v2/customers/cst_1/subscriptions/sub_1');
    expect(init.method).toBe('DELETE');
    expect(canceled.status).toBe('canceled');
  });

  it('refuses to guess the customer when the subscription is unknown to it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ _embedded: { subscriptions: [] } })),
    );
    await expect(makeDriver().updateSubscription('sub_unknown', { amount: 999 })).rejects.toThrow(
      /needs its customer/,
    );
  });

  it('accepts an explicit "customer/subscription" id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'sub_1',
        customerId: 'cst_9',
        status: 'active',
        amount: { currency: 'EUR', value: '9.90' },
        interval: '1 month',
        createdAt: '2026-08-27T10:00:00+00:00',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await makeDriver().updateSubscription('cst_9/sub_1', { amount: 990 });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.mollie.com/v2/customers/cst_9/subscriptions/sub_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: { currency: 'EUR', value: '9.90' },
    });
  });
});

describe('MollieDriver — invoices', () => {
  it('refuses listInvoices: Mollie’s invoices are the ones it issues to you', async () => {
    await expect(makeDriver().listInvoices('cst_1')).rejects.toThrow(/no customer invoices/);
  });
});

describe('MollieDriver — webhooks', () => {
  it('fetches the payment named by the classic form-encoded body and reports what it says', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(paidPayment));
    vi.stubGlobal('fetch', fetchMock);

    const event = await makeDriver().parseWebhook('id=tr_1', {});

    // The request body carried no status and no signature; everything asserted below came
    // back from an authenticated GET, which is what makes the notification trustworthy.
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.mollie.com/v2/payments/tr_1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test_key');
    expect(event.provider).toBe('mollie');
    expect(event.type).toBe('payment.succeeded');
    // Stable per transition, so a redelivery dedupes but the next status still lands.
    expect(event.id).toBe('mollie:tr_1:paid');
    expect(event.data).toMatchObject({
      gatewayId: 'tr_1',
      amount: 1990,
      currency: 'eur',
      customerId: 'cst_1',
      externalReference: 'order_local_1',
    });
  });

  it('maps a failed payment onto payment.failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ ...paidPayment, status: 'failed', paidAt: undefined })),
    );
    const event = await makeDriver().parseWebhook('id=tr_1', {});
    expect(event.type).toBe('payment.failed');
    expect(event.id).toBe('mollie:tr_1:failed');
  });

  it('maps a fully refunded payment onto payment.refunded', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ...paidPayment, amountRefunded: { currency: 'EUR', value: '19.90' } }),
        ),
    );
    expect((await makeDriver().parseWebhook('id=tr_1', {})).type).toBe('payment.refunded');
  });

  it('throws when the payment cannot be fetched, so the route 400s and Mollie retries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'upstream down' }),
    );
    // Reporting an event nobody could confirm would be worse than a retry.
    await expect(makeDriver().parseWebhook('id=tr_1', {})).rejects.toThrow(/HTTP request failed/);
  });

  it('throws rather than swallow a 404 on the payment the webhook named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' }),
    );
    await expect(makeDriver().parseWebhook('id=tr_gone', {})).rejects.toThrow(/404/);
  });

  it('rejects a classic webhook body with no id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeDriver().parseWebhook('', {})).rejects.toThrow(/carried no resource id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a next-gen webhook with a valid X-Mollie-Signature, then still fetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(paidPayment));
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver({ webhookSecret: 'mollie_secret' });

    const event = await driver.parseWebhook(SIGNED_EVENT_BODY, {
      'x-mollie-signature': SIGNED_EVENT_SIGNATURE,
    });

    // A signature proves who sent the event, not what the payment is worth — the built-in
    // billing sync needs the amount, so the fetch happens either way.
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.mollie.com/v2/payments/tr_1');
    expect(event.id).toBe('event_abc');
    expect(event.type).toBe('payment.succeeded');
    expect(event.data).toMatchObject({ amount: 1990, currency: 'eur' });
  });

  it('rejects a tampered body against the same signature, before fetching anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver({ webhookSecret: 'mollie_secret' });
    const tampered = SIGNED_EVENT_BODY.replace('tr_1', 'tr_evil');
    await expect(
      driver.parseWebhook(tampered, { 'x-mollie-signature': SIGNED_EVENT_SIGNATURE }),
    ).rejects.toThrow(/Invalid Mollie webhook signature/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature once a secret is configured', async () => {
    const driver = makeDriver({ webhookSecret: 'mollie_secret' });
    await expect(driver.parseWebhook(SIGNED_EVENT_BODY, {})).rejects.toThrow(
      /Missing X-Mollie-Signature/,
    );
  });

  it('skips verification when no secret is configured, so the classic flow works locally', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(paidPayment)));
    expect((await makeDriver().parseWebhook('id=tr_1', {})).type).toBe('payment.succeeded');
  });

  it('reports a next-gen event about a non-payment resource without inventing a fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const body =
      '{"resource":"event","id":"event_link","type":"payment-link.paid","entityId":"pl_1"}';
    const event = await makeDriver().parseWebhook(body, {});
    expect(event.id).toBe('event_link');
    expect((event.data as { gatewayId: string }).gatewayId).toBe('pl_1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
