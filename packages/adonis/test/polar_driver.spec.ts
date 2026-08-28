import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PolarDriver } from '../src/drivers/polar.js';

const SECRET = 'whsec_ovyN6cPrTv56AApvzCaJno08SSmGJmgbWilb33N2JuK';

function makeDriver(overrides: Record<string, unknown> = {}) {
  return new PolarDriver(
    { config: () => ({}) },
    { accessToken: 'polar_oat_test', currency: 'usd', sandbox: true, ...overrides },
  );
}

/**
 * Sign like Polar does: the HMAC key is the RAW UTF-8 bytes of the secret, `whsec_`
 * prefix included — Polar base64-encodes the secret before handing it to the Standard
 * Webhooks library, which decodes it straight back.
 */
function signedHeaders(body: string, options: { secret?: string; id?: string; at?: number } = {}) {
  const id = options.id ?? 'evt_01';
  const at = options.at ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', Buffer.from(options.secret ?? SECRET, 'utf8'))
    .update(`${id}.${at}.${body}`, 'utf8')
    .digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(at),
    'webhook-signature': `v1,${signature}`,
  };
}

function stubFetch(json: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => json });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ORDER = {
  id: 'ord_1',
  created_at: '2026-08-01T10:00:00Z',
  status: 'paid',
  paid: true,
  total_amount: 1990,
  refunded_amount: 0,
  refundable_amount: 1800,
  currency: 'USD',
  customer_id: 'cus_1',
  subscription_id: 'sub_1',
  metadata: { external_reference: 'order:local_1' },
};

const SUBSCRIPTION = {
  id: 'sub_1',
  created_at: '2026-08-01T10:00:00Z',
  status: 'active',
  amount: 4990,
  currency: 'USD',
  recurring_interval: 'month',
  current_period_start: '2026-08-01T10:00:00Z',
  current_period_end: '2026-09-01T10:00:00Z',
  cancel_at_period_end: false,
  customer_id: 'cus_1',
  product_id: 'prod_pro',
  metadata: { external_reference: 'sub:local_1' },
};

describe('PolarDriver', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env.POLAR_ACCESS_TOKEN = undefined;
    // biome-ignore lint/performance/noDelete: the driver reads the env, so it must be absent.
    delete process.env.POLAR_ACCESS_TOKEN;
    // biome-ignore lint/performance/noDelete: same.
    delete process.env.POLAR_WEBHOOK_SECRET;
  });

  // ── Boot ──────────────────────────────────────────────────────────────────────────

  it('refuses to boot without an access token', () => {
    expect(() => new PolarDriver({ config: () => ({}) }, { currency: 'usd' })).toThrow(
      /POLAR_ACCESS_TOKEN/,
    );
  });

  it('refuses to boot without a currency', () => {
    expect(
      () =>
        new PolarDriver(
          { config: () => ({}) },
          {
            accessToken: 'polar_oat_test',
            currency: '',
          },
        ),
    ).toThrow(/no currency configured/);
  });

  // ── Charge ────────────────────────────────────────────────────────────────────────

  it('refuses a direct charge and points at the checkout flow', async () => {
    const driver = makeDriver();
    await expect(driver.charge({ amount: 1990 })).rejects.toThrow(
      /does not expose a direct charge endpoint/,
    );
  });

  // ── Checkout ──────────────────────────────────────────────────────────────────────

  it('creates a checkout in cents and carries externalReference into metadata', async () => {
    const fetchMock = stubFetch({
      id: 'chk_1',
      url: 'https://buy.polar.sh/chk_1',
      status: 'open',
      total_amount: 1990,
      currency: 'USD',
      customer_id: 'cus_1',
      subscription_id: null,
    });
    try {
      const driver = makeDriver();
      const session = await driver.createCheckout({
        planId: 'prod_pro',
        amount: 1990,
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/back',
        customerId: 'cus_1',
        externalReference: 'order:local_1',
      });
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
      expect(JSON.parse(String(init.body))).toMatchObject({
        products: ['prod_pro'],
        success_url: 'https://app.test/ok',
        // Polar has no cancel_url; `return_url` is the back button.
        return_url: 'https://app.test/back',
        // Integer minor units, straight through — not 19.9.
        amount: 1990,
        customer_id: 'cus_1',
        metadata: { external_reference: 'order:local_1' },
      });
      expect(session.url).toBe('https://buy.polar.sh/chk_1');
      expect(session.status).toBe('open');
      expect(session.amount).toEqual({ amount: 1990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pins the API version on every request', async () => {
    const fetchMock = stubFetch(ORDER);
    try {
      await makeDriver().findPayment('ord_1');
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      // Polar defaults to this version when the header is absent, so the pin only earns
      // its keep on the day Polar promotes a new default.
      expect(headers['Polar-Version']).toBe('2026-04');
      expect(headers.Authorization).toBe('Bearer polar_oat_test');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a checkout with no product', async () => {
    const driver = makeDriver();
    await expect(
      driver.createCheckout({ amount: 1990, successUrl: 'https://app.test/ok' }),
    ).rejects.toThrow(/needs a product/);
  });

  // ── Payments and refunds ──────────────────────────────────────────────────────────

  it('maps an order onto the canonical Payment in cents', async () => {
    stubFetch(ORDER);
    try {
      const payment = await makeDriver().findPayment('ord_1');
      expect(payment).toMatchObject({
        gatewayId: 'ord_1',
        provider: 'polar',
        status: 'paid',
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
        paidAt: '2026-08-01T10:00:00Z',
      });
      expect(payment?.amount).toEqual({ amount: 1990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves a full refund from the order refundable amount', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ORDER })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'ref_1',
          created_at: '2026-08-02T10:00:00Z',
          status: 'succeeded',
          amount: 1800,
          currency: 'USD',
          order_id: 'ord_1',
          customer_id: 'cus_1',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const refund = await makeDriver().refund('ord_1');
      const [, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        order_id: 'ord_1',
        amount: 1800,
        reason: 'other',
        revoke_benefits: false,
      });
      expect(refund.amount).toEqual({ amount: 1800, currency: 'usd' });
      expect(refund.status).toBe('succeeded');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Subscriptions: what it refuses ────────────────────────────────────────────────

  it('refuses a subscription amount, cycle, trial or card rather than dropping them', async () => {
    const driver = makeDriver();
    await expect(
      driver.createSubscription({ customerId: 'cus_1', planId: 'prod_pro', amount: 4990 }),
    ).rejects.toThrow(/`amount` cannot be set/);
    await expect(
      driver.createSubscription({ customerId: 'cus_1', planId: 'prod_pro', cycle: 'MONTHLY' }),
    ).rejects.toThrow(/`cycle` cannot be set/);
    await expect(
      driver.createSubscription({ customerId: 'cus_1', planId: 'prod_pro', trialDays: 14 }),
    ).rejects.toThrow(/trials on the checkout/);
    await expect(
      driver.createSubscription({
        customerId: 'cus_1',
        planId: 'prod_pro',
        card: { token: 'tok_1' },
      }),
    ).rejects.toThrow(/no tokenized-card input/);
  });

  it('refuses a subscription amount or description update instead of faking one', async () => {
    const driver = makeDriver();
    await expect(driver.updateSubscription('sub_1', { amount: 5990 })).rejects.toThrow(
      /no subscription amount to update/,
    );
    await expect(driver.updateSubscription('sub_1', { description: 'Pro' })).rejects.toThrow(
      /carry no description/,
    );
    await expect(driver.updateSubscription('sub_1', {})).rejects.toThrow(/Nothing to update/);
  });

  it('cancels at period end with PATCH and immediately with DELETE', async () => {
    const fetchMock = stubFetch(SUBSCRIPTION);
    try {
      const driver = makeDriver();
      await driver.cancelSubscription('sub_1');
      const [, atPeriodEnd] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(atPeriodEnd.method).toBe('PATCH');
      expect(JSON.parse(String(atPeriodEnd.body))).toEqual({ cancel_at_period_end: true });

      await driver.cancelSubscription('sub_1', { atPeriodEnd: false });
      const [, immediate] = fetchMock.mock.calls[1]! as [string, RequestInit];
      expect(immediate.method).toBe('DELETE');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────────────

  it('accepts a correctly signed webhook and normalizes order.paid', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    const body = JSON.stringify({
      type: 'order.paid',
      timestamp: '2026-08-01T10:00:00Z',
      data: ORDER,
    });
    const event = driver.parseWebhook(body, signedHeaders(body));
    expect(event.type).toBe('payment.succeeded');
    // The event id is the `webhook-id` header — Polar puts no id in the body.
    expect(event.id).toBe('evt_01');
    const data = event.data as { gatewayId: string; amount: number; externalReference: string };
    expect(data.gatewayId).toBe('ord_1');
    expect(data.amount).toBe(1990);
    expect(data.externalReference).toBe('order:local_1');
  });

  it('reads externalReference back off a subscription event', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    const body = JSON.stringify({ type: 'subscription.canceled', data: SUBSCRIPTION });
    const event = driver.parseWebhook(body, signedHeaders(body));
    expect(event.type).toBe('subscription.canceled');
    const data = event.data as { gatewayId: string; status: string; externalReference: string };
    expect(data).toMatchObject({
      gatewayId: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      planId: 'prod_pro',
      externalReference: 'sub:local_1',
    });
  });

  it('rejects a webhook whose body was tampered with after signing', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    const signed = JSON.stringify({ type: 'order.paid', data: ORDER });
    const headers = signedHeaders(signed);
    const tampered = JSON.stringify({
      type: 'order.paid',
      data: { ...ORDER, total_amount: 999999 },
    });
    expect(() => driver.parseWebhook(tampered, headers)).toThrow(/Invalid Polar webhook signature/);
  });

  it('rejects a webhook signed with the wrong secret', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    const body = JSON.stringify({ type: 'order.paid', data: ORDER });
    expect(() => driver.parseWebhook(body, signedHeaders(body, { secret: 'whsec_other' }))).toThrow(
      /Invalid Polar webhook signature/,
    );
  });

  it('rejects a webhook whose secret was base64-decoded (the Dodo/Svix derivation)', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    const body = JSON.stringify({ type: 'order.paid', data: ORDER });
    const id = 'evt_01';
    const at = Math.floor(Date.now() / 1000);
    // Sign with the spec-default key derivation instead of Polar's: strip `whsec_`, then
    // base64-decode. Polar does NOT do this, so it must not verify.
    const wrongKey = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', wrongKey)
      .update(`${id}.${at}.${body}`, 'utf8')
      .digest('base64');
    expect(() =>
      driver.parseWebhook(body, {
        'webhook-id': id,
        'webhook-timestamp': String(at),
        'webhook-signature': `v1,${signature}`,
      }),
    ).toThrow(/Invalid Polar webhook signature/);
  });

  it('rejects a replayed webhook outside the timestamp window', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    const body = JSON.stringify({ type: 'order.paid', data: ORDER });
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    // The signature itself is valid — it is the ±5 minute window that rejects this, and
    // the shared verifier reports a failed window the same way it reports a bad HMAC.
    expect(() => driver.parseWebhook(body, signedHeaders(body, { at: stale }))).toThrow(
      /Invalid Polar webhook signature/,
    );
  });

  it('rejects a webhook with no signature headers', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    expect(() => driver.parseWebhook('{}', {})).toThrow(/Missing Standard Webhooks headers/);
  });

  it('refuses to parse a webhook when no secret is configured', () => {
    const driver = makeDriver();
    const body = JSON.stringify({ type: 'order.paid', data: ORDER });
    expect(() => driver.parseWebhook(body, signedHeaders(body))).toThrow(/POLAR_WEBHOOK_SECRET/);
  });

  it('accepts one matching signature out of a rotated pair', () => {
    const driver = makeDriver({ webhookSecret: SECRET });
    const body = JSON.stringify({ type: 'order.paid', data: ORDER });
    const good = signedHeaders(body)['webhook-signature'];
    const headers = {
      ...signedHeaders(body),
      'webhook-signature': `v1,YWJj ${good}`,
    };
    expect(driver.parseWebhook(body, headers).type).toBe('payment.succeeded');
  });

  // ── Invoices ──────────────────────────────────────────────────────────────────────

  it('lists a customer orders as invoices', async () => {
    stubFetch({ items: [ORDER], pagination: { total_count: 1, max_page: 1 } });
    try {
      const invoices = await makeDriver().listInvoices('cus_1');
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        gatewayId: 'ord_1',
        status: 'paid',
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
      });
      expect(invoices[0]?.amount).toEqual({ amount: 1990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PolarDriver — the widened contract', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // biome-ignore lint/performance/noDelete: the driver reads the env, so it must be absent.
    delete process.env.POLAR_ACCESS_TOKEN;
    // biome-ignore lint/performance/noDelete: same.
    delete process.env.POLAR_WEBHOOK_SECRET;
  });

  it('reports a paused subscription as paused, not active', async () => {
    stubFetch({ ...SUBSCRIPTION, status: 'paused' });

    // A paused subscriber is not paying. Reporting `active` handed them entitlement.
    expect((await makeDriver().findSubscription('sub_1'))?.status).toBe('paused');
  });

  it('carries `paused` through the webhook so the billing layer stores it', () => {
    const body = JSON.stringify({
      type: 'subscription.paused',
      timestamp: '2026-08-02T10:00:00Z',
      data: { ...SUBSCRIPTION, status: 'paused' },
    });
    const event = makeDriver({ webhookSecret: SECRET }).parseWebhook(body, signedHeaders(body));

    expect(event.type).toBe('subscription.updated');
    expect(event.data).toMatchObject({ gatewayId: 'sub_1', status: 'paused' });
  });

  it('has no dispute event to map, and does not invent one', () => {
    // Polar is a merchant of record: the chargeback is raised against Polar, which absorbs
    // it, so its event catalogue genuinely has no dispute or chargeback event. Forcing an
    // unrelated event into `payment.disputed` would invent a notification.
    const driver = makeDriver({ webhookSecret: SECRET });
    const typeOf = (type: string, data: Record<string, unknown>) => {
      const body = JSON.stringify({ type, data });
      return driver.parseWebhook(body, signedHeaders(body)).type;
    };
    expect(typeOf('order.refunded', ORDER)).toBe('payment.refunded');
    expect(typeOf('order.updated', ORDER)).toBe('payment.updated');
    // A Polar event nobody has mapped stays under its own name for an app handler.
    expect(typeOf('customer.state_changed', { id: 'cus_1' })).toBe('customer.state_changed');
  });

  it('sends the idempotency key as the header Polar deduplicates on', async () => {
    const headerOf = (mock: ReturnType<typeof stubFetch>) =>
      ((mock.mock.calls[0]! as [string, RequestInit])[1].headers as Record<string, string>)[
        'Idempotency-Key'
      ];

    let mock = stubFetch({ id: 'cus_1', email: 'a@b.test' });
    await makeDriver().createCustomer({ email: 'a@b.test', idempotencyKey: 'k-customer' });
    expect(headerOf(mock)).toBe('k-customer');

    mock = stubFetch({
      id: 'ref_1',
      created_at: '2026-08-01T10:00:00Z',
      status: 'succeeded',
      amount: 500,
      currency: 'USD',
      order_id: 'ord_1',
      customer_id: 'cus_1',
    });
    await makeDriver().refund('ord_1', 500, { idempotencyKey: 'k-refund' });
    expect(headerOf(mock)).toBe('k-refund');

    mock = stubFetch(SUBSCRIPTION);
    await makeDriver().createSubscription({
      customerId: 'cus_1',
      planId: 'prod_pro',
      idempotencyKey: 'k-sub',
    });
    expect(headerOf(mock)).toBe('k-sub');

    // Polar documents the header for PATCH too, so a plan swap is covered as well.
    mock = stubFetch(SUBSCRIPTION);
    await makeDriver().updateSubscription('sub_1', {
      metadata: { productId: 'prod_other' },
      idempotencyKey: 'k-update',
    });
    expect(headerOf(mock)).toBe('k-update');
  });

  it('leaves the header off entirely when no key was given', async () => {
    const mock = stubFetch({ id: 'cus_1', email: 'a@b.test' });
    await makeDriver().createCustomer({ email: 'a@b.test' });
    const headers = (mock.mock.calls[0]! as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers['Idempotency-Key']).toBeUndefined();
    // The version pin must survive the merge that added the idempotency header.
    expect(headers['Polar-Version']).toBe('2026-04');
  });
});
