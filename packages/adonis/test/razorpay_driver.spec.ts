import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RazorpayDriver } from '../src/drivers/razorpay.js';

const WEBHOOK_SECRET = 'whsec_test';

function makeDriver(config: Record<string, unknown> = {}) {
  return new RazorpayDriver(
    { config: () => ({}) },
    {
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      currency: 'inr',
      webhookSecret: WEBHOOK_SECRET,
      ...config,
    },
  );
}

/** The `X-Razorpay-Signature` Razorpay would send for this body: hex HMAC-SHA256. */
function signature(rawBody: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(...responses: unknown[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(jsonResponse(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RazorpayDriver boot', () => {
  it('fails at boot without a key id', () => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_ID = undefined;
    // biome-ignore lint/performance/noDelete: an empty string would satisfy `??` but not the check.
    delete process.env.RAZORPAY_KEY_ID;
    try {
      expect(() => makeDriver({ keyId: undefined })).toThrow(/requires keyId/);
    } finally {
      if (keyId !== undefined) process.env.RAZORPAY_KEY_ID = keyId;
    }
  });

  it('fails at boot without a key secret', () => {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    // biome-ignore lint/performance/noDelete: same reason.
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      expect(() => makeDriver({ keySecret: undefined })).toThrow(/requires keySecret/);
    } finally {
      if (keySecret !== undefined) process.env.RAZORPAY_KEY_SECRET = keySecret;
    }
  });

  it('fails at boot without a currency — Razorpay is multi-currency, there is no safe default', () => {
    expect(() => makeDriver({ currency: undefined })).toThrow(/no currency configured/);
  });

  it('authenticates with HTTP Basic over key id and key secret', async () => {
    const fetchMock = stubFetch({
      id: 'order_1',
      entity: 'order',
      amount: 1990,
      amount_paid: 0,
      amount_due: 1990,
      currency: 'INR',
      status: 'created',
      created_at: 1767225600,
    });
    await makeDriver().charge({ amount: 1990 });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.razorpay.com/v1/orders');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:secret', 'utf8').toString('base64')}`,
    );
  });
});

describe('RazorpayDriver charge', () => {
  it('creates an order and maps it onto a pending Payment with paise straight through', async () => {
    const fetchMock = stubFetch({
      id: 'order_1',
      entity: 'order',
      amount: 199000,
      amount_paid: 0,
      amount_due: 199000,
      currency: 'INR',
      receipt: 'idem_1',
      status: 'created',
      notes: { external_reference: 'pay_local_1' },
      created_at: 1767225600,
    });
    const payment = await makeDriver().charge({
      amount: 199000,
      description: 'Pro plan',
      idempotencyKey: 'idem_1',
      externalReference: 'pay_local_1',
      customerId: 'cust_1',
    });

    // ₹1990.00 is 199000 paise on both sides. A divide-by-100 here would send ₹19.90.
    expect(payment.amount).toEqual({ amount: 199000, currency: 'inr' });
    expect(payment.gatewayId).toBe('order_1');
    expect(payment.status).toBe('pending');
    expect(payment.customerId).toBe('cust_1');

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.amount).toBe(199000);
    expect(body.currency).toBe('INR');
    expect(body.receipt).toBe('idem_1');
    expect(body.notes.external_reference).toBe('pay_local_1');
  });

  it('refuses a card token, a named method, a split and an over-long receipt', async () => {
    const driver = makeDriver();
    await expect(driver.charge({ amount: 100, card: { token: 'tok' } })).rejects.toThrow(
      /card token server-side/,
    );
    await expect(driver.charge({ amount: 100, paymentMethodId: 'pm_1' })).rejects.toThrow(
      /card token server-side/,
    );
    await expect(driver.charge({ amount: 100, method: 'credit_card' })).rejects.toThrow(
      /cannot pin a payment method/,
    );
    await expect(
      driver.charge({ amount: 100, split: [{ walletId: 'w_1', percentualValue: 10 }] }),
    ).rejects.toThrow(/Route transfers/);
    await expect(driver.charge({ amount: 100, idempotencyKey: 'x'.repeat(41) })).rejects.toThrow(
      /40 characters/,
    );
  });

  it('refunds a payment id and refuses an order id', async () => {
    stubFetch({
      id: 'rfnd_1',
      entity: 'refund',
      amount: 199000,
      currency: 'INR',
      payment_id: 'pay_1',
      status: 'processed',
      created_at: 1767225600,
    });
    const refund = await makeDriver().refund('pay_1', 199000);
    expect(refund.amount).toEqual({ amount: 199000, currency: 'inr' });
    expect(refund.status).toBe('succeeded');

    await expect(makeDriver().refund('order_1')).rejects.toThrow(/refunds a payment/);
  });
});

describe('RazorpayDriver checkout and subscriptions', () => {
  it('creates a payment link carrying externalReference as reference_id', async () => {
    const fetchMock = stubFetch({
      id: 'plink_1',
      amount: 199000,
      currency: 'INR',
      short_url: 'https://rzp.io/i/abc',
      status: 'created',
      reference_id: 'order_local_9',
      created_at: 1767225600,
    });
    const session = await makeDriver().createCheckout({
      amount: 199000,
      successUrl: 'https://app.example.com/thanks',
      externalReference: 'order_local_9',
    });
    expect(session.url).toBe('https://rzp.io/i/abc');
    expect(session.status).toBe('open');
    expect(session.amount).toEqual({ amount: 199000, currency: 'inr' });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.reference_id).toBe('order_local_9');
    expect(body.amount).toBe(199000);
    expect(body.callback_url).toBe('https://app.example.com/thanks');
  });

  it('refuses a cancelUrl and a plan on a payment link', async () => {
    const driver = makeDriver();
    await expect(
      driver.createCheckout({ amount: 100, successUrl: 'https://a', cancelUrl: 'https://b' }),
    ).rejects.toThrow(/one redirect/);
    await expect(
      driver.createCheckout({ amount: 100, successUrl: 'https://a', planId: 'plan_1' }),
    ).rejects.toThrow(/createSubscription/);
  });

  it('creates a subscription only when the number of cycles is given', async () => {
    const driver = makeDriver();
    await expect(
      driver.createSubscription({ customerId: 'cust_1', planId: 'plan_1' }),
    ).rejects.toThrow(/number of billing cycles/);
    await expect(
      driver.createSubscription({ customerId: 'c', planId: 'p', amount: 100 }),
    ).rejects.toThrow(/prices a subscription from its plan/);
    await expect(
      driver.createSubscription({ customerId: 'c', planId: 'p', cycle: 'MONTHLY' }),
    ).rejects.toThrow(/billing cycle from the plan/);
    await expect(
      driver.createSubscription({ customerId: 'c', planId: 'p', method: 'credit_card' }),
    ).rejects.toThrow(/pin the mandate method/);
    await expect(
      driver.createSubscription({ customerId: 'c', planId: 'p', card: { token: 'tok' } }),
    ).rejects.toThrow(/its own hosted link/);

    stubFetch({
      id: 'sub_1',
      entity: 'subscription',
      plan_id: 'plan_1',
      status: 'created',
      created_at: 1767225600,
    });
    const subscription = await driver.createSubscription({
      customerId: 'cust_1',
      planId: 'plan_1',
      metadata: { totalCount: 12 },
    });
    expect(subscription.gatewayId).toBe('sub_1');
    expect(subscription.status).toBe('incomplete');
    expect(subscription.customerId).toBe('cust_1');
  });

  it('refuses a subscription update the gateway cannot make, and applies one it can', async () => {
    const driver = makeDriver();
    await expect(driver.updateSubscription('sub_1', { amount: 100 })).rejects.toThrow(
      /plans are immutable/,
    );
    await expect(driver.updateSubscription('sub_1', { description: 'x' })).rejects.toThrow(
      /no description/,
    );
    await expect(driver.updateSubscription('sub_1', {})).rejects.toThrow(/Nothing to update/);

    const fetchMock = stubFetch({
      id: 'sub_1',
      entity: 'subscription',
      plan_id: 'plan_2',
      status: 'active',
      created_at: 1767225600,
    });
    const updated = await driver.updateSubscription('sub_1', { metadata: { planId: 'plan_2' } });
    expect(updated.planId).toBe('plan_2');
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toMatchObject({
      plan_id: 'plan_2',
      schedule_change_at: 'now',
    });
  });
});

describe('RazorpayDriver webhooks', () => {
  const capturedPayment = {
    entity: 'event',
    account_id: 'acc_1',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: 'pay_1',
          entity: 'payment',
          amount: 199000,
          currency: 'INR',
          status: 'captured',
          order_id: 'order_1',
          method: 'upi',
          customer_id: 'cust_1',
          notes: { external_reference: 'pay_local_1' },
          created_at: 1767225600,
        },
      },
    },
    created_at: 1767225601,
  };

  it('accepts a correctly signed webhook and reads externalReference back out', () => {
    const raw = JSON.stringify(capturedPayment);
    const event = makeDriver().parseWebhook(raw, {
      'x-razorpay-signature': signature(raw),
      'x-razorpay-event-id': 'evt_1',
    });

    expect(event.type).toBe('payment.succeeded');
    expect(event.id).toBe('evt_1');
    const data = event.data as {
      gatewayId: string;
      amount: number;
      currency: string;
      externalReference?: string;
    };
    expect(data.gatewayId).toBe('pay_1');
    // Paise straight through on the way back in, too.
    expect(data.amount).toBe(199000);
    expect(data.currency).toBe('inr');
    expect(data.externalReference).toBe('pay_local_1');
  });

  it('rejects a forged signature', () => {
    const raw = JSON.stringify(capturedPayment);
    expect(() =>
      makeDriver().parseWebhook(raw, { 'x-razorpay-signature': signature(raw, 'other-secret') }),
    ).toThrow(/Invalid Razorpay webhook signature/);
  });

  it('rejects a body whose bytes were altered after signing', () => {
    const raw = JSON.stringify(capturedPayment);
    const sig = signature(raw);
    const tampered = raw.replace('199000', '199');
    expect(() => makeDriver().parseWebhook(tampered, { 'x-razorpay-signature': sig })).toThrow(
      /Invalid Razorpay webhook signature/,
    );
  });

  it('rejects a webhook with no signature at all when a secret is configured', () => {
    expect(() => makeDriver().parseWebhook(JSON.stringify(capturedPayment), {})).toThrow(
      /Missing X-Razorpay-Signature/,
    );
  });

  it('skips verification when no webhook secret is configured, so local dev works', () => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    // biome-ignore lint/performance/noDelete: the fallback must be genuinely absent.
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
      const driver = makeDriver({ webhookSecret: undefined });
      expect(driver.parseWebhook(JSON.stringify(capturedPayment), {}).type).toBe(
        'payment.succeeded',
      );
    } finally {
      if (secret !== undefined) process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    }
  });

  it('reads externalReference off a payment link reference_id', () => {
    const raw = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: {
            id: 'plink_1',
            amount: 199000,
            currency: 'INR',
            short_url: 'https://rzp.io/i/abc',
            status: 'paid',
            reference_id: 'order_local_9',
            created_at: 1767225600,
          },
        },
      },
      created_at: 1767225601,
    });
    const event = makeDriver().parseWebhook(raw, { 'x-razorpay-signature': signature(raw) });
    expect(event.type).toBe('payment.succeeded');
    expect((event.data as { externalReference?: string }).externalReference).toBe('order_local_9');
  });

  it('does NOT call an authorized payment a success — money is held, not moved', () => {
    const raw = JSON.stringify({
      event: 'payment.authorized',
      payload: {
        payment: {
          entity: {
            id: 'pay_2',
            entity: 'payment',
            amount: 199000,
            currency: 'INR',
            status: 'authorized',
            created_at: 1767225600,
          },
        },
      },
    });
    const event = makeDriver().parseWebhook(raw, { 'x-razorpay-signature': signature(raw) });
    expect(event.type).toBe('payment.updated');
    expect((event.data as { status?: string }).status).toBeUndefined();
  });

  it('maps subscription lifecycle events onto the canonical names', () => {
    const build = (event: string, status: string) =>
      JSON.stringify({
        event,
        payload: {
          subscription: {
            entity: {
              id: 'sub_1',
              entity: 'subscription',
              plan_id: 'plan_1',
              customer_id: 'cust_1',
              status,
              created_at: 1767225600,
            },
          },
        },
      });
    const driver = makeDriver();
    const authenticated = build('subscription.authenticated', 'authenticated');
    expect(
      driver.parseWebhook(authenticated, { 'x-razorpay-signature': signature(authenticated) }).type,
    ).toBe('subscription.created');

    const cancelled = build('subscription.cancelled', 'cancelled');
    expect(
      driver.parseWebhook(cancelled, { 'x-razorpay-signature': signature(cancelled) }).type,
    ).toBe('subscription.canceled');

    const halted = build('subscription.halted', 'halted');
    const event = driver.parseWebhook(halted, { 'x-razorpay-signature': signature(halted) });
    expect(event.type).toBe('subscription.updated');
    expect((event.data as { status: string }).status).toBe('past_due');
  });
});

describe('RazorpayDriver payment method mapping', () => {
  it('leaves UPI unlabelled rather than borrowing a name from another country', async () => {
    stubFetch({
      id: 'pay_1',
      entity: 'payment',
      amount: 199000,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
      created_at: 1767225600,
    });
    const payment = await makeDriver().findPayment('pay_1');
    expect(payment?.status).toBe('paid');
    // `PaymentMethodType` has no `upi`; calling it `pix` because both are instant bank
    // rails would put a Brazilian label on an Indian payment.
    expect(payment?.method).toBeUndefined();
  });

  it('maps a debit card to debit_card and a credit card to card', async () => {
    stubFetch(
      {
        id: 'pay_2',
        entity: 'payment',
        amount: 100,
        currency: 'INR',
        status: 'captured',
        method: 'card',
        card: { type: 'debit' },
        created_at: 1767225600,
      },
      {
        id: 'pay_3',
        entity: 'payment',
        amount: 100,
        currency: 'INR',
        status: 'captured',
        method: 'card',
        card: { type: 'credit' },
        created_at: 1767225600,
      },
    );
    const driver = makeDriver();
    expect((await driver.findPayment('pay_2'))?.method).toBe('debit_card');
    expect((await driver.findPayment('pay_3'))?.method).toBe('card');
  });
});
