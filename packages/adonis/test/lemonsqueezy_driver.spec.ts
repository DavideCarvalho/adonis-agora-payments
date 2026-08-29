import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LemonSqueezyDriver } from '../src/drivers/lemonsqueezy.js';

const WEBHOOK_SECRET = 'ls_signing_secret';

function makeDriver(overrides: Record<string, unknown> = {}) {
  return new LemonSqueezyDriver({ config: () => ({}) }, {
    apiKey: 'ls_test_key',
    storeId: 42,
    webhookSecret: WEBHOOK_SECRET,
    ...overrides,
  } as never);
}

/** Sign a body exactly the way Lemon Squeezy does: HMAC-SHA256 over the raw body, hex. */
function sign(body: string, secret = WEBHOOK_SECRET) {
  return { 'x-signature': createHmac('sha256', secret).update(body, 'utf8').digest('hex') };
}

function stubFetch(json: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => json });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const orderCreated = {
  meta: {
    event_name: 'order_created',
    custom_data: { external_reference: 'order:local_1' },
    test_mode: true,
  },
  data: {
    type: 'orders',
    id: '1',
    attributes: {
      store_id: 42,
      customer_id: 7,
      order_number: 1,
      currency: 'USD',
      subtotal: 999,
      tax: 200,
      // Lemon Squeezy money is already an integer of the smallest unit.
      total: 1199,
      status: 'paid',
      refunded: false,
      urls: { receipt: 'https://app.lemonsqueezy.com/my-orders/abc' },
      created_at: '2026-08-17T09:45:53.000000Z',
      updated_at: '2026-08-17T09:45:53.000000Z',
      test_mode: true,
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LemonSqueezyDriver', () => {
  it('refuses to boot without an API key', () => {
    // `vi.stubEnv(name, undefined)` actually removes the var (and restores it after),
    // which `process.env.LEMONSQUEEZY_API_KEY = undefined` does not — it stores the
    // string "undefined", which reads as a perfectly good credential.
    vi.stubEnv('LEMONSQUEEZY_API_KEY', undefined);
    try {
      expect(() => makeDriver({ apiKey: undefined })).toThrow(/requires apiKey/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('creates a JSON:API checkout with the amount as custom_price in cents', async () => {
    const fetchMock = stubFetch({
      data: {
        type: 'checkouts',
        id: '5e8b546c',
        attributes: {
          store_id: 42,
          variant_id: 11,
          custom_price: 1990,
          url: 'https://my-store.lemonsqueezy.com/checkout/custom/5e8b546c',
          test_mode: true,
        },
      },
    });
    const driver = makeDriver();

    const session = await driver.createCheckout({
      amount: 1990,
      planId: '11',
      successUrl: 'https://app.example/thanks',
      description: 'Pro plan',
      externalReference: 'order:local_1',
      metadata: { email: 'a@b.test', taxNumber: 'GB123' },
    });

    expect(session.gatewayId).toBe('5e8b546c');
    expect(session.url).toBe('https://my-store.lemonsqueezy.com/checkout/custom/5e8b546c');
    expect(session.status).toBe('open');
    // No currency is stated on a checkout response, so no amount is invented.
    expect(session.amount).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.lemonsqueezy.com/v1/checkouts');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.api+json');
    expect(headers['Content-Type']).toBe('application/vnd.api+json');
    expect(headers.Authorization).toBe('Bearer ls_test_key');

    const body = JSON.parse(String(init.body));
    expect(body.data.type).toBe('checkouts');
    expect(body.data.attributes.custom_price).toBe(1990);
    expect(body.data.attributes.product_options.redirect_url).toBe('https://app.example/thanks');
    expect(body.data.attributes.checkout_data).toMatchObject({
      email: 'a@b.test',
      tax_number: 'GB123',
      custom: { external_reference: 'order:local_1' },
    });
    expect(body.data.relationships).toEqual({
      store: { data: { type: 'stores', id: '42' } },
      variant: { data: { type: 'variants', id: '11' } },
    });
  });

  it('round-trips externalReference from the session into the webhook', async () => {
    const fetchMock = stubFetch({
      data: { type: 'checkouts', id: 'chk_rt', attributes: { url: 'https://s.test/c/chk_rt' } },
    });
    const driver = makeDriver();

    await driver.createCheckout({
      amount: 1990,
      planId: '11',
      successUrl: 'https://app.example/thanks',
      externalReference: 'order:local_7',
    });

    const sent = JSON.parse(String((fetchMock.mock.calls[0]! as [string, RequestInit])[1].body));
    expect(sent.data.attributes.checkout_data.custom).toEqual({
      external_reference: 'order:local_7',
    });

    // Lemon Squeezy echoes `checkout_data.custom` as `meta.custom_data` on the order's
    // webhook — the only thing tying the confirmation to the app's row.
    const raw = JSON.stringify({
      ...orderCreated,
      meta: { ...orderCreated.meta, custom_data: sent.data.attributes.checkout_data.custom },
    });
    const event = driver.parseWebhook(raw, sign(raw));
    expect((event.data as { externalReference: string }).externalReference).toBe('order:local_7');
  });

  it('still honours metadata.externalReference for callers written before the field existed', async () => {
    const fetchMock = stubFetch({
      data: { type: 'checkouts', id: 'chk_m', attributes: { url: 'https://s.test/c/chk_m' } },
    });

    await makeDriver().createCheckout({
      amount: 1990,
      planId: '11',
      successUrl: 'https://app.example/thanks',
      metadata: { externalReference: 'order:legacy' },
    });

    const sent = JSON.parse(String((fetchMock.mock.calls[0]! as [string, RequestInit])[1].body));
    expect(sent.data.attributes.checkout_data.custom).toEqual({
      external_reference: 'order:legacy',
    });
  });

  it('maps a JSON:API order onto the canonical Payment', async () => {
    stubFetch({ data: orderCreated.data });
    const driver = makeDriver();

    const payment = await driver.findPayment('1');

    expect(payment).not.toBeNull();
    // `total` is read straight through — no decimal conversion on this gateway.
    expect(payment?.amount).toEqual({ amount: 1199, currency: 'usd' });
    expect(payment?.status).toBe('paid');
    expect(payment?.customerId).toBe('7');
    expect(payment?.hostedUrl).toBe('https://app.lemonsqueezy.com/my-orders/abc');
    expect(payment?.paidAt).toBe('2026-08-17T09:45:53.000000Z');
  });

  it('accepts a correctly signed webhook and reads externalReference back out', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(orderCreated);

    const event = driver.parseWebhook(raw, sign(raw));

    expect(event.type).toBe('payment.succeeded');
    expect(event.id).toBe('order_created:orders:1:2026-08-17T09:45:53.000000Z');
    const data = event.data as {
      externalReference: string;
      amount: number;
      currency: string;
      testMode: boolean;
    };
    expect(data.externalReference).toBe('order:local_1');
    expect(data.amount).toBe(1199);
    expect(data.currency).toBe('usd');
    expect(data.testMode).toBe(true);
  });

  it('rejects a webhook whose body was tampered with after signing', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(orderCreated);
    const headers = sign(raw);
    const tampered = raw.replace('"total":1199', '"total":1');

    expect(() => driver.parseWebhook(tampered, headers)).toThrow(
      /Invalid Lemon Squeezy webhook signature/,
    );
  });

  it('rejects a webhook signed with the wrong secret, or with no signature at all', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(orderCreated);

    expect(() => driver.parseWebhook(raw, sign(raw, 'forged'))).toThrow(
      /Invalid Lemon Squeezy webhook signature/,
    );
    expect(() => driver.parseWebhook(raw, {})).toThrow(/Missing `X-Signature`/);
  });

  it('refuses to parse webhooks when no signing secret is configured', () => {
    // `vi.stubEnv(name, undefined)` actually removes the var (and restores it after),
    // which `process.env.LEMONSQUEEZY_WEBHOOK_SECRET = undefined` does not — it stores the
    // string "undefined", which reads as a perfectly good credential.
    vi.stubEnv('LEMONSQUEEZY_WEBHOOK_SECRET', undefined);
    try {
      const driver = makeDriver({ webhookSecret: undefined });
      const raw = JSON.stringify(orderCreated);
      expect(() => driver.parseWebhook(raw, sign(raw))).toThrow(/requires the signing secret/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads the order status rather than trusting the order_created event name', () => {
    const driver = makeDriver();
    const failed = JSON.stringify({
      ...orderCreated,
      data: {
        ...orderCreated.data,
        attributes: { ...orderCreated.data.attributes, status: 'failed' },
      },
    });

    expect(driver.parseWebhook(failed, sign(failed)).type).toBe('payment.failed');
  });

  it('maps subscription and subscription-invoice events onto the canonical types', () => {
    const driver = makeDriver();

    const subscriptionRaw = JSON.stringify({
      meta: { event_name: 'subscription_cancelled', custom_data: { external_reference: 'sub:1' } },
      data: {
        type: 'subscriptions',
        id: '9',
        attributes: {
          customer_id: 7,
          variant_id: 11,
          status: 'cancelled',
          renews_at: '2026-09-17T09:45:53.000000Z',
          ends_at: '2026-09-17T09:45:53.000000Z',
          created_at: '2026-08-17T09:45:53.000000Z',
          updated_at: '2026-08-20T09:45:53.000000Z',
        },
      },
    });
    const subscriptionEvent = driver.parseWebhook(subscriptionRaw, sign(subscriptionRaw));
    expect(subscriptionEvent.type).toBe('subscription.canceled');
    expect(subscriptionEvent.data).toMatchObject({
      gatewayId: '9',
      customerId: '7',
      planId: '11',
      externalReference: 'sub:1',
    });

    const invoiceRaw = JSON.stringify({
      meta: { event_name: 'subscription_payment_success' },
      data: {
        type: 'subscription-invoices',
        id: '3',
        attributes: {
          subscription_id: 9,
          customer_id: 7,
          currency: 'EUR',
          status: 'paid',
          total: 4990,
          created_at: '2026-09-17T09:45:53.000000Z',
        },
      },
    });
    const invoiceEvent = driver.parseWebhook(invoiceRaw, sign(invoiceRaw));
    expect(invoiceEvent.type).toBe('payment.succeeded');
    expect(invoiceEvent.data).toMatchObject({
      gatewayId: '3',
      amount: 4990,
      currency: 'eur',
      subscriptionId: '9',
    });
  });

  it('refuses every operation Lemon Squeezy does not have', async () => {
    const driver = makeDriver();

    await expect(driver.charge({ amount: 1990 })).rejects.toThrow(/cannot charge server-side/);
    await expect(driver.createSubscription({ customerId: '7', planId: '11' })).rejects.toThrow(
      /cannot create a subscription over the API/,
    );
    await expect(driver.cancelSubscription('9', { atPeriodEnd: false })).rejects.toThrow(
      /no immediate cancellation/,
    );
    await expect(driver.updateSubscription('9', { amount: 4990 })).rejects.toThrow(
      /no editable amount on a subscription/,
    );
    await expect(driver.updateSubscription('9', { description: 'Pro' })).rejects.toThrow(
      /no description field/,
    );
    await expect(driver.updateSubscription('9', {})).rejects.toThrow(/only accepts a plan swap/);
    await expect(
      driver.createCheckout({
        amount: 1990,
        planId: '11',
        successUrl: 'https://a.test',
        trialDays: 7,
      }),
    ).rejects.toThrow(/configures trials on the variant/);
    await expect(
      driver.createCheckout({ amount: 1990, successUrl: 'https://a.test' }),
    ).rejects.toThrow(/always sell a catalog variant/);
    await expect(
      driver.createCustomer({ name: 'A', email: 'a@b.test', taxId: 'GB123' }),
    ).rejects.toThrow(/no tax id on a customer/);
    await expect(driver.createCustomer({ email: 'a@b.test' })).rejects.toThrow(
      /both a name and an email/,
    );
  });

  it('refunds an order with the amount in cents and cancels at period end', async () => {
    const refundFetch = stubFetch({
      data: {
        type: 'orders',
        id: '1',
        attributes: {
          currency: 'USD',
          total: 1199,
          status: 'refunded',
          refunded: true,
          refunded_at: '2026-08-18T09:45:53.000000Z',
        },
      },
    });
    const driver = makeDriver();

    const refund = await driver.refund('1', 500);
    expect(refund.status).toBe('succeeded');
    expect(refund.amount).toEqual({ amount: 500, currency: 'usd' });
    const [url, init] = refundFetch.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.lemonsqueezy.com/v1/orders/1/refund');
    expect(JSON.parse(String(init.body))).toEqual({
      data: { type: 'orders', id: '1', attributes: { amount: 500 } },
    });

    vi.unstubAllGlobals();
    const cancelFetch = stubFetch({
      data: {
        type: 'subscriptions',
        id: '9',
        attributes: {
          customer_id: 7,
          variant_id: 11,
          status: 'cancelled',
          ends_at: '2026-09-17T09:45:53.000000Z',
          created_at: '2026-08-17T09:45:53.000000Z',
        },
      },
    });
    const subscription = await driver.cancelSubscription('9');
    expect(subscription.status).toBe('canceled');
    expect(subscription.endsAt).toBe('2026-09-17T09:45:53.000000Z');
    const [cancelUrl, cancelInit] = cancelFetch.mock.calls[0]! as [string, RequestInit];
    expect(String(cancelUrl)).toBe('https://api.lemonsqueezy.com/v1/subscriptions/9');
    expect(cancelInit.method).toBe('DELETE');
  });

  it('swaps the plan through metadata.variantId', async () => {
    const fetchMock = stubFetch({
      data: {
        type: 'subscriptions',
        id: '9',
        attributes: { customer_id: 7, variant_id: 12, status: 'active' },
      },
    });

    const subscription = await makeDriver().updateSubscription('9', {
      metadata: { variantId: '12', invoiceImmediately: true },
    });

    expect(subscription.planId).toBe('12');
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body)).data.attributes).toEqual({
      variant_id: 12,
      invoice_immediately: true,
    });
  });

  it('lists a customer orders as invoices, since no list endpoint filters by customer', async () => {
    const fetchMock = stubFetch({ data: [orderCreated.data] });

    const invoices = await makeDriver().listInvoices('7');

    expect(String((fetchMock.mock.calls[0]! as [string])[0])).toBe(
      'https://api.lemonsqueezy.com/v1/customers/7/orders',
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      gatewayId: '1',
      status: 'paid',
      amount: { amount: 1199, currency: 'usd' },
      number: '1',
    });
  });
});

describe('LemonSqueezyDriver — the widened contract', () => {
  it('reports a paused subscription as paused, not active', async () => {
    stubFetch({
      data: {
        type: 'subscriptions',
        id: '9',
        attributes: { customer_id: 7, variant_id: 3, status: 'paused', renews_at: null },
      },
    });

    // A paused subscriber is not paying. Reporting `active` handed them entitlement.
    expect((await makeDriver().findSubscription('9'))?.status).toBe('paused');
  });

  it('carries `paused` through the webhook so the billing layer stores it', () => {
    const body = JSON.stringify({
      meta: { event_name: 'subscription_paused' },
      data: {
        type: 'subscriptions',
        id: '9',
        attributes: { customer_id: 7, variant_id: 3, status: 'paused' },
      },
    });
    const event = makeDriver().parseWebhook(body, sign(body));

    expect(event.type).toBe('subscription.updated');
    expect(event.data).toMatchObject({ gatewayId: '9', status: 'paused' });
  });

  it('has no dispute event to map, and does not invent one', () => {
    // Lemon Squeezy is a merchant of record: the chargeback is raised against Lemon
    // Squeezy, which absorbs it, so there is genuinely no dispute webhook. Forcing an
    // unrelated event into `payment.disputed` would invent a notification.
    const driver = makeDriver();
    const typeOf = (eventName: string) => {
      const body = JSON.stringify({
        meta: { event_name: eventName },
        data: {
          type: 'orders',
          id: '1',
          attributes: { currency: 'USD', total: 999, status: 'paid' },
        },
      });
      return driver.parseWebhook(body, sign(body)).type;
    };
    // Nothing Lemon Squeezy sends maps to a dispute — the closest events stay what they are.
    expect(typeOf('order_refunded')).toBe('payment.refunded');
    expect(typeOf('subscription_payment_failed')).toBe('payment.failed');
    expect(typeOf('license_key_created')).toBe('license_key_created');
  });

  it('refuses an idempotency key rather than accepting one it cannot honour', async () => {
    // Lemon Squeezy deduplicates NOTHING — no header, no request-id field. Accepting the
    // key and dropping it turns a caller's retry guarantee into a second refund.
    const driver = makeDriver();
    await expect(driver.refund('1', 500, { idempotencyKey: 'k1' })).rejects.toThrow(
      /no idempotency mechanism.*refund\(\)/s,
    );
    await expect(
      driver.createCustomer({ name: 'A', email: 'a@b.test', idempotencyKey: 'k1' }),
    ).rejects.toThrow(/no idempotency mechanism/);
    await expect(
      driver.createCheckout({
        amount: 1990,
        planId: '3',
        successUrl: 'https://a.test',
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/no idempotency mechanism/);
    await expect(driver.updateSubscription('9', { idempotencyKey: 'k1' })).rejects.toThrow(
      /no idempotency mechanism/,
    );
  });

  it('refuses the key before it does anything else, so nothing reaches Lemon Squeezy', async () => {
    const fetchMock = stubFetch({ data: {} });
    await expect(
      makeDriver().createCustomer({ name: 'A', email: 'a@b.test', idempotencyKey: 'k1' }),
    ).rejects.toThrow(/no idempotency mechanism/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Lemon Squeezy has NO dispute vocabulary. Its whole webhook catalogue is the sixteen
   * names below — there is not even an `order_updated`, so the `fraudulent` order status
   * Lemon Squeezy uses for a charged-back order can never reach a webhook handler. That is
   * the merchant-of-record bargain: Lemon Squeezy is the seller on the buyer's statement and
   * manages the dispute itself, deducting the amount plus a $15 fee from the next payout.
   *
   * This test exists to stop a well-meaning mapping from inventing one.
   */
  it('emits no dispute event for any Lemon Squeezy event, because none exists', () => {
    const driver = makeDriver();
    const events = [
      'order_created',
      'order_refunded',
      'subscription_created',
      'subscription_updated',
      'subscription_cancelled',
      'subscription_resumed',
      'subscription_expired',
      'subscription_paused',
      'subscription_unpaused',
      'subscription_payment_success',
      'subscription_payment_failed',
      'subscription_payment_recovered',
      'subscription_payment_refunded',
      'subscription_plan_changed',
      'license_key_created',
      'license_key_updated',
    ];
    const disputeTypes = ['payment.disputed', 'payment.dispute_warning', 'payment.dispute_closed'];

    for (const event_name of events) {
      // `fraudulent` is Lemon Squeezy's own status for a charged-back order. Even carrying
      // it, no event may become a dispute — the driver has no way to know money moved.
      const body = JSON.stringify({
        meta: { event_name },
        data: {
          type: 'orders',
          id: '1',
          attributes: { status: 'fraudulent', total: 1990, currency: 'USD' },
        },
      });
      expect(disputeTypes, event_name).not.toContain(driver.parseWebhook(body, sign(body)).type);
    }
  });

  it('never claims a dispute API it does not have', () => {
    const driver = makeDriver();
    expect(driver.capabilities.disputes).toBe(false);
    expect(driver.submitDisputeEvidence).toBeUndefined();
    expect(driver.findDispute).toBeUndefined();
  });
});
