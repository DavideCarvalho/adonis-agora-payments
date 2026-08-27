import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DodoDriver } from '../src/drivers/dodo.js';

/** A Standard Webhooks secret: base64 payload behind a `whsec_` prefix. */
const SECRET = `whsec_${Buffer.from('dodo-webhook-signing-key').toString('base64')}`;

function makeDriver(overrides: Record<string, unknown> = {}) {
  return new DodoDriver(
    { config: () => ({}) },
    {
      apiKey: 'dodo_test_key',
      currency: 'usd',
      sandbox: true,
      billingCountry: 'US',
      ...overrides,
    },
  );
}

/**
 * Sign like Dodo does: the HMAC key is the secret with `whsec_` stripped and the rest
 * base64-DECODED — the Standard Webhooks default that `dodopayments`' own `unwrap()` uses.
 */
function signedHeaders(body: string, options: { secret?: string; id?: string; at?: number } = {}) {
  const secret = options.secret ?? SECRET;
  const id = options.id ?? 'evt_01';
  const at = options.at ?? Math.floor(Date.now() / 1000);
  const key = Buffer.from(
    secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
    'base64',
  );
  const signature = createHmac('sha256', key)
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

const PAYMENT = {
  payload_type: 'Payment',
  payment_id: 'pay_1',
  business_id: 'bus_1',
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:05:00Z',
  currency: 'USD',
  total_amount: 1990,
  status: 'succeeded',
  payment_method: 'card',
  payment_method_type: 'visa',
  subscription_id: 'sub_1',
  customer: { customer_id: 'cus_1', email: 'a@b.com', name: 'A' },
  metadata: { external_reference: 'order:local_1' },
};

const SUBSCRIPTION = {
  payload_type: 'Subscription',
  subscription_id: 'sub_1',
  created_at: '2026-08-01T10:00:00Z',
  status: 'active',
  currency: 'USD',
  recurring_pre_tax_amount: 4990,
  product_id: 'prod_pro',
  quantity: 1,
  trial_period_days: 0,
  cancel_at_next_billing_date: false,
  next_billing_date: '2026-09-01T10:00:00Z',
  previous_billing_date: '2026-08-01T10:00:00Z',
  customer: { customer_id: 'cus_1', email: 'a@b.com', name: 'A' },
  metadata: { external_reference: 'sub:local_1' },
};

describe('DodoDriver', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // biome-ignore lint/performance/noDelete: the driver reads the env, so it must be absent.
    delete process.env.DODO_PAYMENTS_API_KEY;
    // biome-ignore lint/performance/noDelete: same.
    delete process.env.DODO_PAYMENTS_WEBHOOK_KEY;
    // biome-ignore lint/performance/noDelete: same.
    delete process.env.DODO_PAYMENTS_BILLING_COUNTRY;
  });

  // ── Boot ──────────────────────────────────────────────────────────────────────────

  it('refuses to boot without an API key', () => {
    expect(() => new DodoDriver({ config: () => ({}) }, { currency: 'usd' })).toThrow(
      /DODO_PAYMENTS_API_KEY/,
    );
  });

  it('refuses to boot without a currency', () => {
    expect(
      () => new DodoDriver({ config: () => ({}) }, { apiKey: 'dodo_test_key', currency: '' }),
    ).toThrow(/no currency configured/);
  });

  // ── Charge ────────────────────────────────────────────────────────────────────────

  it('posts a charge in minor units with the product, billing country and reference', async () => {
    const fetchMock = stubFetch({
      payment_id: 'pay_1',
      total_amount: 1990,
      customer: { customer_id: 'cus_1', email: 'a@b.com', name: 'A' },
      payment_link: 'https://test.checkout.dodopayments.com/pay_1',
      client_secret: 'cs_1',
    });
    try {
      const payment = await makeDriver().charge({
        customerId: 'cus_1',
        amount: 1990,
        method: 'credit_card',
        externalReference: 'order:local_1',
        metadata: { productId: 'prod_basic' },
      });
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toBe('https://test.dodopayments.com/payments');
      expect(JSON.parse(String(init.body))).toMatchObject({
        // Integer minor units, straight through — not 19.9.
        product_cart: [{ product_id: 'prod_basic', quantity: 1, amount: 1990 }],
        customer: { customer_id: 'cus_1' },
        billing: { country: 'US' },
        billing_currency: 'USD',
        payment_link: true,
        allowed_payment_method_types: ['credit'],
        metadata: { external_reference: 'order:local_1' },
      });
      // `productId` is an argument to this driver, not metadata to store on the record.
      expect(JSON.parse(String(init.body)).metadata.productId).toBeUndefined();
      expect(payment).toMatchObject({
        gatewayId: 'pay_1',
        provider: 'dodo',
        // Nothing has settled: the customer still has to pay on the link.
        status: 'pending',
        customerId: 'cus_1',
        hostedUrl: 'https://test.checkout.dodopayments.com/pay_1',
      });
      expect(payment.amount).toEqual({ amount: 1990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a charge with no product', async () => {
    await expect(makeDriver().charge({ customerId: 'cus_1', amount: 1990 })).rejects.toThrow(
      /no amount-only charge/,
    );
  });

  it('refuses a charge with no billing country', async () => {
    const driver = makeDriver({ billingCountry: undefined });
    await expect(
      driver.charge({ customerId: 'cus_1', amount: 1990, metadata: { productId: 'prod_basic' } }),
    ).rejects.toThrow(/requires a billing country/);
  });

  it('restricts the checkout to Pix when the charge asks for it', async () => {
    const fetchMock = stubFetch({
      payment_id: 'pay_2',
      total_amount: 1990,
      customer: { customer_id: 'cus_1', email: 'a@b.com', name: 'A' },
    });
    try {
      await makeDriver({ currency: 'brl', billingCountry: 'BR' }).charge({
        customerId: 'cus_1',
        amount: 1990,
        method: 'pix',
        metadata: { productId: 'prod_basic' },
      });
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        allowed_payment_method_types: ['pix', 'credit', 'debit'],
        billing_currency: 'BRL',
        billing: { country: 'BR' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a fetched payment onto the canonical Payment in minor units', async () => {
    stubFetch(PAYMENT);
    try {
      const payment = await makeDriver().findPayment('pay_1');
      expect(payment).toMatchObject({
        gatewayId: 'pay_1',
        status: 'paid',
        method: 'card',
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
        paidAt: '2026-08-01T10:05:00Z',
      });
      expect(payment?.amount).toEqual({ amount: 1990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Refunds ───────────────────────────────────────────────────────────────────────

  it('refuses a partial refund by amount instead of refunding everything', async () => {
    await expect(makeDriver().refund('pay_1', 500)).rejects.toThrow(/per line item/);
  });

  it('issues a full refund', async () => {
    const fetchMock = stubFetch({
      refund_id: 'ref_1',
      payment_id: 'pay_1',
      status: 'succeeded',
      created_at: '2026-08-02T10:00:00Z',
      is_partial: false,
      amount: 1990,
      currency: 'USD',
      customer: { customer_id: 'cus_1', email: 'a@b.com', name: 'A' },
    });
    try {
      const refund = await makeDriver().refund('pay_1');
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ payment_id: 'pay_1' });
      expect(refund.status).toBe('succeeded');
      expect(refund.amount).toEqual({ amount: 1990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Checkout ──────────────────────────────────────────────────────────────────────

  it('creates a checkout session carrying externalReference into metadata', async () => {
    const fetchMock = stubFetch({
      session_id: 'cks_1',
      checkout_url: 'https://test.checkout.dodopayments.com/cks_1',
    });
    try {
      const session = await makeDriver().createCheckout({
        planId: 'prod_pro',
        amount: 4990,
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/cancel',
        customerId: 'cus_1',
        externalReference: 'order:local_2',
      });
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toBe('https://test.dodopayments.com/checkouts');
      expect(JSON.parse(String(init.body))).toMatchObject({
        product_cart: [{ product_id: 'prod_pro', quantity: 1, amount: 4990 }],
        return_url: 'https://app.test/ok',
        cancel_url: 'https://app.test/cancel',
        billing_currency: 'USD',
        metadata: { external_reference: 'order:local_2' },
      });
      expect(session.url).toBe('https://test.checkout.dodopayments.com/cks_1');
      expect(session.amount).toEqual({ amount: 4990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Subscriptions: what it refuses ────────────────────────────────────────────────

  it('refuses a subscription amount, cycle or card rather than dropping them', async () => {
    const driver = makeDriver();
    await expect(
      driver.createSubscription({ customerId: 'cus_1', planId: 'prod_pro', amount: 4990 }),
    ).rejects.toThrow(/`amount` cannot be set/);
    await expect(
      driver.createSubscription({ customerId: 'cus_1', planId: 'prod_pro', cycle: 'MONTHLY' }),
    ).rejects.toThrow(/`cycle` cannot be set/);
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

  it('refuses a customer tax id, which Dodo has nowhere to put', async () => {
    await expect(makeDriver().updateCustomer('cus_1', { taxId: '123' })).rejects.toThrow(
      /carry no tax id/,
    );
  });

  it('cancels at period end with the flag and immediately with the status', async () => {
    const fetchMock = stubFetch(SUBSCRIPTION);
    try {
      const driver = makeDriver();
      await driver.cancelSubscription('sub_1');
      const [, atPeriodEnd] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(atPeriodEnd.method).toBe('PATCH');
      expect(JSON.parse(String(atPeriodEnd.body))).toEqual({ cancel_at_next_billing_date: true });

      await driver.cancelSubscription('sub_1', { atPeriodEnd: false });
      const [, immediate] = fetchMock.mock.calls[1]! as [string, RequestInit];
      // Dodo has no DELETE — an immediate cancel is a status change.
      expect(immediate.method).toBe('PATCH');
      expect(JSON.parse(String(immediate.body))).toMatchObject({ status: 'cancelled' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('switches plans through change-plan and reads the subscription back', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => SUBSCRIPTION });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const subscription = await makeDriver().updateSubscription('sub_1', {
        metadata: { productId: 'prod_enterprise' },
      });
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toContain('/subscriptions/sub_1/change-plan');
      expect(JSON.parse(String(init.body))).toEqual({
        product_id: 'prod_enterprise',
        quantity: 1,
        proration_billing_mode: 'prorated_immediately',
      });
      expect(subscription.planId).toBe('prod_pro');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────────────

  it('accepts a correctly signed webhook and normalizes payment.succeeded', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    const body = JSON.stringify({
      business_id: 'bus_1',
      type: 'payment.succeeded',
      timestamp: '2026-08-01T10:05:00Z',
      data: PAYMENT,
    });
    const event = driver.parseWebhook(body, signedHeaders(body));
    expect(event.type).toBe('payment.succeeded');
    // The event id is the `webhook-id` header — Dodo puts no id in the body.
    expect(event.id).toBe('evt_01');
    const data = event.data as { gatewayId: string; amount: number; externalReference: string };
    expect(data.gatewayId).toBe('pay_1');
    expect(data.amount).toBe(1990);
    expect(data.externalReference).toBe('order:local_1');
  });

  it('maps subscription.active onto subscription.created with its reference', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    const body = JSON.stringify({ type: 'subscription.active', data: SUBSCRIPTION });
    const event = driver.parseWebhook(body, signedHeaders(body));
    // Dodo has no `subscription.created`; `active` is the first event a subscription gets.
    expect(event.type).toBe('subscription.created');
    expect(event.data).toMatchObject({
      gatewayId: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      planId: 'prod_pro',
      externalReference: 'sub:local_1',
    });
  });

  it('maps subscription.cancelled (double l) onto subscription.canceled', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    const body = JSON.stringify({ type: 'subscription.cancelled', data: SUBSCRIPTION });
    expect(driver.parseWebhook(body, signedHeaders(body)).type).toBe('subscription.canceled');
  });

  it('rejects a webhook whose body was tampered with after signing', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    const signed = JSON.stringify({ type: 'payment.succeeded', data: PAYMENT });
    const headers = signedHeaders(signed);
    const tampered = JSON.stringify({
      type: 'payment.succeeded',
      data: { ...PAYMENT, total_amount: 999999 },
    });
    expect(() => driver.parseWebhook(tampered, headers)).toThrow(
      /Invalid Dodo Payments webhook signature/,
    );
  });

  it('rejects a webhook signed with the wrong secret', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    const body = JSON.stringify({ type: 'payment.succeeded', data: PAYMENT });
    const other = `whsec_${Buffer.from('another-key').toString('base64')}`;
    expect(() => driver.parseWebhook(body, signedHeaders(body, { secret: other }))).toThrow(
      /Invalid Dodo Payments webhook signature/,
    );
  });

  it('rejects a webhook signed with the raw secret string (the Polar derivation)', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    const body = JSON.stringify({ type: 'payment.succeeded', data: PAYMENT });
    const id = 'evt_01';
    const at = Math.floor(Date.now() / 1000);
    // Dodo base64-decodes the secret; signing with its raw UTF-8 bytes must not verify.
    const signature = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
      .update(`${id}.${at}.${body}`, 'utf8')
      .digest('base64');
    expect(() =>
      driver.parseWebhook(body, {
        'webhook-id': id,
        'webhook-timestamp': String(at),
        'webhook-signature': `v1,${signature}`,
      }),
    ).toThrow(/Invalid Dodo Payments webhook signature/);
  });

  it('rejects a replayed webhook outside the timestamp window', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    const body = JSON.stringify({ type: 'payment.succeeded', data: PAYMENT });
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    // The signature itself is valid — it is the ±5 minute window that rejects this, and
    // the shared verifier reports a failed window the same way it reports a bad HMAC.
    expect(() => driver.parseWebhook(body, signedHeaders(body, { at: stale }))).toThrow(
      /Invalid Dodo Payments webhook signature/,
    );
  });

  it('rejects a webhook with no signature headers', () => {
    const driver = makeDriver({ webhookKey: SECRET });
    expect(() => driver.parseWebhook('{}', {})).toThrow(/Missing Standard Webhooks headers/);
  });

  it('refuses to parse a webhook when no key is configured', () => {
    const driver = makeDriver();
    const body = JSON.stringify({ type: 'payment.succeeded', data: PAYMENT });
    expect(() => driver.parseWebhook(body, signedHeaders(body))).toThrow(
      /DODO_PAYMENTS_WEBHOOK_KEY/,
    );
  });

  // ── Invoices ──────────────────────────────────────────────────────────────────────

  it('lists a customer payments as invoices with their PDF url', async () => {
    stubFetch({ items: [{ ...PAYMENT, invoice_id: 'inv_1', invoice_url: 'https://pdf.test/1' }] });
    try {
      const invoices = await makeDriver().listInvoices('cus_1');
      expect(invoices[0]).toMatchObject({
        gatewayId: 'pay_1',
        status: 'paid',
        number: 'inv_1',
        hostedPdfUrl: 'https://pdf.test/1',
      });
      expect(invoices[0]?.amount).toEqual({ amount: 1990, currency: 'usd' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
