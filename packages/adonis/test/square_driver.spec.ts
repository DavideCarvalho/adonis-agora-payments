import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SquareDriver } from '../src/drivers/square.js';

const SIGNATURE_KEY = 'sq_sig_key';
const NOTIFICATION_URL = 'https://app.example.com/webhooks/square';

function makeDriver(config: Record<string, unknown> = {}) {
  return new SquareDriver(
    { config: () => ({}) },
    {
      accessToken: 'EAAA-token',
      locationId: 'L_MAIN',
      currency: 'usd',
      webhookSignatureKey: SIGNATURE_KEY,
      notificationUrl: NOTIFICATION_URL,
      ...config,
    },
  );
}

/**
 * The `x-square-hmacsha256-signature` Square would send: base64 HMAC-SHA256 over the
 * notification URL CONCATENATED with the raw body — not the body alone.
 */
function signature(rawBody: string, key = SIGNATURE_KEY, url = NOTIFICATION_URL): string {
  return createHmac('sha256', key).update(`${url}${rawBody}`, 'utf8').digest('base64');
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

const COMPLETED_PAYMENT = {
  id: 'pmt_1',
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:05Z',
  amount_money: { amount: 1990, currency: 'USD' },
  status: 'COMPLETED',
  source_type: 'CARD',
  card_details: { card: { card_type: 'CREDIT' } },
  location_id: 'L_MAIN',
  order_id: 'ord_1',
  customer_id: 'cus_1',
  reference_id: 'pay_local_1',
  receipt_url: 'https://squareup.com/receipt/preview/pmt_1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SquareDriver boot', () => {
  it('fails at boot without an access token', () => {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    // biome-ignore lint/performance/noDelete: the env fallback must be genuinely absent.
    delete process.env.SQUARE_ACCESS_TOKEN;
    try {
      expect(() => makeDriver({ accessToken: undefined })).toThrow(/requires accessToken/);
    } finally {
      if (token !== undefined) process.env.SQUARE_ACCESS_TOKEN = token;
    }
  });

  it('fails at boot without a location id — most calls are location-scoped', () => {
    const location = process.env.SQUARE_LOCATION_ID;
    // biome-ignore lint/performance/noDelete: same reason.
    delete process.env.SQUARE_LOCATION_ID;
    try {
      expect(() => makeDriver({ locationId: undefined })).toThrow(/requires locationId/);
    } finally {
      if (location !== undefined) process.env.SQUARE_LOCATION_ID = location;
    }
  });

  it('fails at boot without a currency — Square is multi-currency', () => {
    expect(() => makeDriver({ currency: undefined })).toThrow(/no currency configured/);
  });

  it('fails at boot when a signature key is set without the notification URL it is signed with', () => {
    const url = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
    // biome-ignore lint/performance/noDelete: same reason.
    delete process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
    try {
      expect(() => makeDriver({ notificationUrl: undefined })).toThrow(/no notificationUrl/);
    } finally {
      if (url !== undefined) process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = url;
    }
  });

  it('sends a Bearer token and a pinned Square-Version on every call', async () => {
    const fetchMock = stubFetch({ payment: COMPLETED_PAYMENT });
    await makeDriver().findPayment('pmt_1');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://connect.squareup.com/v2/payments/pmt_1');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer EAAA-token');
    expect(headers['Square-Version']).toBe('2026-08-19');
  });

  it('points at the sandbox host when asked', async () => {
    const fetchMock = stubFetch({ payment: COMPLETED_PAYMENT });
    await makeDriver({ sandbox: true }).findPayment('pmt_1');
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(String(url)).toContain('connect.squareupsandbox.com');
  });
});

describe('SquareDriver charge', () => {
  it('maps a completed payment onto the canonical Payment with minor units untouched', async () => {
    const fetchMock = stubFetch({ payment: COMPLETED_PAYMENT });
    const payment = await makeDriver().charge({
      amount: 1990,
      paymentMethodId: 'cnon:card-nonce',
      customerId: 'cus_1',
      description: 'Pro plan',
      externalReference: 'pay_local_1',
      idempotencyKey: 'idem_1',
    });

    // $19.90 is 1990 on both sides — the neighbouring BR drivers divide by 100, this one
    // must not, or Square happily bills 19 cents.
    expect(payment.amount).toEqual({ amount: 1990, currency: 'usd' });
    expect(payment.gatewayId).toBe('pmt_1');
    expect(payment.status).toBe('paid');
    expect(payment.method).toBe('card');
    expect(payment.customerId).toBe('cus_1');
    expect(payment.paidAt).toBe('2026-08-01T10:00:05Z');

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://connect.squareup.com/v2/payments');
    const body = JSON.parse(String(init.body));
    expect(body.amount_money).toEqual({ amount: 1990, currency: 'USD' });
    // `idempotency_key` is a BODY field on Square, not a header.
    expect(body.idempotency_key).toBe('idem_1');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
    expect(body.reference_id).toBe('pay_local_1');
    expect(body.location_id).toBe('L_MAIN');
    expect(body.source_id).toBe('cnon:card-nonce');
    expect(body.note).toBe('Pro plan');
  });

  it('generates an idempotency key when the caller gives none, because Square requires one', async () => {
    const fetchMock = stubFetch({ payment: COMPLETED_PAYMENT });
    await makeDriver().charge({ amount: 1990, paymentMethodId: 'cnon:x' });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body)).idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a charge with no source, a method Square has no name for, and a split', async () => {
    const driver = makeDriver();
    await expect(driver.charge({ amount: 100 })).rejects.toThrow(/needs a `source_id`/);
    await expect(
      driver.charge({ amount: 100, paymentMethodId: 'cnon:x', method: 'pix' }),
    ).rejects.toThrow(/no "pix" payment method/);
    await expect(
      driver.charge({
        amount: 100,
        paymentMethodId: 'cnon:x',
        split: [{ walletId: 'w', percentualValue: 5 }],
      }),
    ).rejects.toThrow(/does not split a payment/);
    await expect(
      driver.charge({ amount: 100, paymentMethodId: 'cnon:x', externalReference: 'x'.repeat(41) }),
    ).rejects.toThrow(/40 characters/);
    await expect(
      driver.charge({ amount: 100, paymentMethodId: 'cnon:x', idempotencyKey: 'x'.repeat(46) }),
    ).rejects.toThrow(/45 characters/);
  });

  it('names the source category instead of labelling everything a card', async () => {
    for (const [sourceType, method] of [
      ['WALLET', 'wallet'],
      ['SQUARE_ACCOUNT', 'wallet'],
      ['BANK_ACCOUNT', 'bank_debit'],
      ['BUY_NOW_PAY_LATER', 'bnpl'],
    ] as const) {
      stubFetch({ payment: { ...COMPLETED_PAYMENT, source_type: sourceType, card_details: null } });
      expect((await makeDriver().findPayment('pmt_1'))?.method).toBe(method);
      vi.unstubAllGlobals();
    }
  });

  it('leaves money taken outside Square unlabelled rather than guessing a category', async () => {
    // `CASH` and `EXTERNAL` are payments recorded, not rails this package has a name for.
    stubFetch({ payment: { ...COMPLETED_PAYMENT, source_type: 'CASH', card_details: null } });
    expect((await makeDriver().findPayment('pmt_1'))?.method).toBeUndefined();
  });

  it('reads a fully refunded payment as refunded even though Square still calls it COMPLETED', async () => {
    stubFetch({
      payment: {
        ...COMPLETED_PAYMENT,
        refunded_money: { amount: 1990, currency: 'USD' },
      },
    });
    expect((await makeDriver().findPayment('pmt_1'))?.status).toBe('refunded');
  });

  it('reads an APPROVED payment as authorized — funds held, nothing captured', async () => {
    // It used to read `pending`, which is the status of a payment nobody has attempted;
    // an APPROVED one has the buyer's money reserved and an expiry running against it.
    stubFetch({ payment: { ...COMPLETED_PAYMENT, status: 'APPROVED' } });
    const payment = await makeDriver().findPayment('pmt_1');
    expect(payment?.status).toBe('authorized');
    expect(payment?.paidAt).toBeUndefined();
  });

  it('still reads a PENDING payment as pending — Square has approved nothing yet', async () => {
    stubFetch({ payment: { ...COMPLETED_PAYMENT, status: 'PENDING' } });
    expect((await makeDriver().findPayment('pmt_1'))?.status).toBe('pending');
  });
});

describe('SquareDriver refund', () => {
  it('reads the payment first when no amount is given, because RefundPayment demands one', async () => {
    const fetchMock = stubFetch(
      { payment: COMPLETED_PAYMENT },
      {
        refund: {
          id: 'rfd_1',
          status: 'PENDING',
          amount_money: { amount: 1990, currency: 'USD' },
          payment_id: 'pmt_1',
          created_at: '2026-08-02T10:00:00Z',
        },
      },
    );
    const refund = await makeDriver().refund('pmt_1');
    expect(refund.amount).toEqual({ amount: 1990, currency: 'usd' });
    // PENDING is not "the money moved" — only `refund.updated` with COMPLETED is.
    expect(refund.status).toBe('pending');

    const [readUrl] = fetchMock.mock.calls[0]! as [string];
    expect(String(readUrl)).toContain('/payments/pmt_1');
    const [refundUrl, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(String(refundUrl)).toBe('https://connect.squareup.com/v2/refunds');
    expect(JSON.parse(String(init.body))).toMatchObject({
      payment_id: 'pmt_1',
      amount_money: { amount: 1990, currency: 'USD' },
    });
  });

  it('refunds the requested partial amount without reading the payment', async () => {
    const fetchMock = stubFetch({
      refund: {
        id: 'rfd_2',
        status: 'COMPLETED',
        amount_money: { amount: 500, currency: 'USD' },
        payment_id: 'pmt_1',
      },
    });
    const refund = await makeDriver().refund('pmt_1', 500);
    expect(refund.status).toBe('succeeded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('SquareDriver checkout', () => {
  it('creates an order-backed payment link carrying externalReference as reference_id', async () => {
    const fetchMock = stubFetch({
      payment_link: {
        id: 'plink_1',
        url: 'https://square.link/u/abc',
        order_id: 'ord_1',
        created_at: '2026-08-01T10:00:00Z',
      },
    });
    const session = await makeDriver().createCheckout({
      amount: 1990,
      successUrl: 'https://app.example.com/thanks',
      description: 'Pro plan',
      externalReference: 'order_local_9',
      customerId: 'cus_1',
    });
    expect(session.url).toBe('https://square.link/u/abc');
    expect(session.gatewayId).toBe('plink_1');
    expect(session.amount).toEqual({ amount: 1990, currency: 'usd' });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://connect.squareup.com/v2/online-checkout/payment-links');
    const body = JSON.parse(String(init.body));
    // A PaymentLink has no reference field of its own; the Order does.
    expect(body.order.reference_id).toBe('order_local_9');
    expect(body.order.metadata.external_reference).toBe('order_local_9');
    expect(body.order.location_id).toBe('L_MAIN');
    expect(body.order.line_items[0]).toEqual({
      name: 'Pro plan',
      quantity: '1',
      base_price_money: { amount: 1990, currency: 'USD' },
    });
    expect(body.checkout_options.redirect_url).toBe('https://app.example.com/thanks');
    // Also on the payment note, which is the one field a reference survives into on
    // `payment.created`.
    expect(body.payment_note).toBe('order_local_9');
  });

  it('passes a plan variation id through as a subscription checkout', async () => {
    const fetchMock = stubFetch({
      payment_link: { id: 'plink_2', url: 'https://square.link/u/def' },
    });
    await makeDriver().createCheckout({
      amount: 1990,
      successUrl: 'https://app.example.com/thanks',
      planId: 'VAR_123',
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body)).checkout_options.subscription_plan_id).toBe('VAR_123');
  });

  it('refuses a cancel URL and a trial the API has no field for', async () => {
    const driver = makeDriver();
    await expect(
      driver.createCheckout({ amount: 100, successUrl: 'https://a', cancelUrl: 'https://b' }),
    ).rejects.toThrow(/one redirect/);
    await expect(
      driver.createCheckout({ amount: 100, successUrl: 'https://a', trialDays: 14 }),
    ).rejects.toThrow(/free phase/);
  });
});

describe('SquareDriver customers', () => {
  it('refuses to silently drop an arbitrary tax id', async () => {
    await expect(makeDriver().createCustomer({ name: 'Ana', taxId: '12345' })).rejects.toThrow(
      /tax_ids.eu_vat/,
    );
  });

  it('maps an EU VAT number when the caller says that is what it is', async () => {
    const fetchMock = stubFetch({
      customer: {
        id: 'cus_1',
        given_name: 'Ana',
        email_address: 'ana@example.com',
        tax_ids: { eu_vat: 'IE1234567AB' },
      },
    });
    const customer = await makeDriver().createCustomer({
      name: 'Ana',
      email: 'ana@example.com',
      taxId: 'IE1234567AB',
      metadata: { taxIdType: 'eu_vat' },
    });
    expect(customer).toEqual({
      id: 'cus_1',
      name: 'Ana',
      email: 'ana@example.com',
      taxId: 'IE1234567AB',
    });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body)).tax_ids).toEqual({ eu_vat: 'IE1234567AB' });
  });
});

describe('SquareDriver subscriptions', () => {
  const ACTIVE_SUBSCRIPTION = {
    id: 'sub_1',
    location_id: 'L_MAIN',
    plan_variation_id: 'VAR_123',
    customer_id: 'cus_1',
    start_date: '2026-08-01',
    charged_through_date: '2026-09-01',
    status: 'ACTIVE',
    price_override_money: { amount: 1990, currency: 'USD' },
    created_at: '2026-08-01T10:00:00Z',
  };

  it('creates a subscription, mapping amount onto price_override_money in minor units', async () => {
    const fetchMock = stubFetch({ subscription: ACTIVE_SUBSCRIPTION });
    const subscription = await makeDriver().createSubscription({
      customerId: 'cus_1',
      planId: 'VAR_123',
      amount: 1990,
      startDate: '2026-08-01',
      metadata: { cardId: 'card_1' },
    });
    expect(subscription.status).toBe('active');
    expect(subscription.planId).toBe('VAR_123');
    expect(subscription.amount).toEqual({ amount: 1990, currency: 'usd' });
    expect(subscription.currentPeriodEnd).toBe('2026-09-01T00:00:00.000Z');

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.price_override_money).toEqual({ amount: 1990, currency: 'USD' });
    expect(body.plan_variation_id).toBe('VAR_123');
    expect(body.location_id).toBe('L_MAIN');
    expect(body.start_date).toBe('2026-08-01');
    expect(body.card_id).toBe('card_1');
  });

  it('refuses every subscription option Square cannot honour', async () => {
    const driver = makeDriver();
    const base = { customerId: 'cus_1', planId: 'VAR_123' };
    await expect(driver.createSubscription({ ...base, cycle: 'MONTHLY' })).rejects.toThrow(
      /billing cadence from the subscription plan variation/,
    );
    await expect(driver.createSubscription({ ...base, method: 'credit_card' })).rejects.toThrow(
      /no method to name/,
    );
    await expect(driver.createSubscription({ ...base, trialDays: 14 })).rejects.toThrow(
      /free phase/,
    );
    await expect(driver.createSubscription({ ...base, card: { token: 'cnon:x' } })).rejects.toThrow(
      /single-use/,
    );
    // The one that would otherwise be a silent drop: there is nowhere on a Square
    // subscription to put a reference, so it must not pretend to carry one.
    await expect(
      driver.createSubscription({ ...base, externalReference: 'sub_local_1' }),
    ).rejects.toThrow(/no reference or metadata field/);
  });

  it('cancels at period end and refuses an immediate cancel it cannot perform', async () => {
    await expect(makeDriver().cancelSubscription('sub_1', { atPeriodEnd: false })).rejects.toThrow(
      /cannot end a subscription mid-period/,
    );

    const fetchMock = stubFetch({
      subscription: { ...ACTIVE_SUBSCRIPTION, canceled_date: '2026-09-01' },
    });
    const subscription = await makeDriver().cancelSubscription('sub_1');
    expect(subscription.endsAt).toBe('2026-09-01T00:00:00.000Z');
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(String(url)).toContain('/subscriptions/sub_1/cancel');
  });

  it('refuses a reprice and a description, and swaps the plan variation when asked', async () => {
    const driver = makeDriver();
    await expect(driver.updateSubscription('sub_1', { amount: 2990 })).rejects.toThrow(
      /will not reprice a live subscription/,
    );
    await expect(driver.updateSubscription('sub_1', { description: 'x' })).rejects.toThrow(
      /no description field/,
    );
    await expect(driver.updateSubscription('sub_1', {})).rejects.toThrow(/Nothing to update/);

    const fetchMock = stubFetch({
      subscription: { ...ACTIVE_SUBSCRIPTION, plan_variation_id: 'VAR_456' },
    });
    const swapped = await driver.updateSubscription('sub_1', {
      metadata: { planVariationId: 'VAR_456' },
    });
    expect(swapped.planId).toBe('VAR_456');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('/subscriptions/sub_1/swap-plan');
    expect(JSON.parse(String(init.body)).new_plan_variation_id).toBe('VAR_456');
  });
});

describe('SquareDriver invoices', () => {
  it('searches by location and customer, because the list endpoint filters by location only', async () => {
    const fetchMock = stubFetch({
      invoices: [
        {
          id: 'inv_1',
          location_id: 'L_MAIN',
          primary_recipient: { customer_id: 'cus_1' },
          payment_requests: [{ computed_amount_money: { amount: 1990, currency: 'USD' } }],
          invoice_number: '000001',
          public_url: 'https://squareup.com/pay-invoice/inv_1',
          status: 'PAID',
          created_at: '2026-08-01T10:00:00Z',
        },
      ],
    });
    const invoices = await makeDriver().listInvoices('cus_1');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      gatewayId: 'inv_1',
      customerId: 'cus_1',
      status: 'paid',
      amount: { amount: 1990, currency: 'usd' },
      number: '000001',
    });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://connect.squareup.com/v2/invoices/search');
    expect(JSON.parse(String(init.body)).query.filter).toEqual({
      location_ids: ['L_MAIN'],
      customer_ids: ['cus_1'],
    });
  });
});

describe('SquareDriver webhooks', () => {
  const paymentEvent = {
    merchant_id: 'MERCH_1',
    type: 'payment.updated',
    event_id: 'evt_1',
    created_at: '2026-08-01T10:00:06Z',
    data: { type: 'payment', id: 'pmt_1', object: { payment: COMPLETED_PAYMENT } },
  };

  it('accepts a webhook signed over notificationUrl + body and reads externalReference back', () => {
    const raw = JSON.stringify(paymentEvent);
    const event = makeDriver().parseWebhook(raw, {
      'x-square-hmacsha256-signature': signature(raw),
    });
    expect(event.type).toBe('payment.succeeded');
    expect(event.id).toBe('evt_1');
    const data = event.data as {
      gatewayId: string;
      amount: number;
      currency: string;
      externalReference?: string;
    };
    expect(data.gatewayId).toBe('pmt_1');
    expect(data.amount).toBe(1990);
    expect(data.currency).toBe('usd');
    expect(data.externalReference).toBe('pay_local_1');
  });

  it('rejects a signature computed over the body alone — the URL is part of the payload', () => {
    const raw = JSON.stringify(paymentEvent);
    const bodyOnly = createHmac('sha256', SIGNATURE_KEY).update(raw, 'utf8').digest('base64');
    expect(() =>
      makeDriver().parseWebhook(raw, { 'x-square-hmacsha256-signature': bodyOnly }),
    ).toThrow(/Invalid Square webhook signature/);
  });

  it('rejects a signature made with the wrong key', () => {
    const raw = JSON.stringify(paymentEvent);
    expect(() =>
      makeDriver().parseWebhook(raw, {
        'x-square-hmacsha256-signature': signature(raw, 'other-key'),
      }),
    ).toThrow(/Invalid Square webhook signature/);
  });

  it('rejects a signature made for a different notification URL', () => {
    const raw = JSON.stringify(paymentEvent);
    expect(() =>
      makeDriver().parseWebhook(raw, {
        'x-square-hmacsha256-signature': signature(raw, SIGNATURE_KEY, 'https://evil.example.com/'),
      }),
    ).toThrow(/Invalid Square webhook signature/);
  });

  it('rejects a body whose bytes were altered after signing', () => {
    const raw = JSON.stringify(paymentEvent);
    const sig = signature(raw);
    expect(() =>
      makeDriver().parseWebhook(raw.replace('1990', '9990'), {
        'x-square-hmacsha256-signature': sig,
      }),
    ).toThrow(/Invalid Square webhook signature/);
  });

  it('rejects a webhook with no signature at all', () => {
    expect(() => makeDriver().parseWebhook(JSON.stringify(paymentEvent), {})).toThrow(
      /Missing x-square-hmacsha256-signature/,
    );
  });

  it('skips verification when no signature key is configured, so local dev works', () => {
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    // biome-ignore lint/performance/noDelete: the env fallback must be genuinely absent.
    delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    try {
      const driver = makeDriver({ webhookSignatureKey: undefined, notificationUrl: undefined });
      expect(driver.parseWebhook(JSON.stringify(paymentEvent), {}).type).toBe('payment.succeeded');
    } finally {
      if (key !== undefined) process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = key;
    }
  });

  it('falls back to the payment note when a link payment carries no reference_id', () => {
    const raw = JSON.stringify({
      ...paymentEvent,
      data: {
        type: 'payment',
        id: 'pmt_2',
        object: {
          payment: {
            ...COMPLETED_PAYMENT,
            id: 'pmt_2',
            reference_id: undefined,
            note: 'order_local_9',
          },
        },
      },
    });
    const event = makeDriver().parseWebhook(raw, {
      'x-square-hmacsha256-signature': signature(raw),
    });
    expect((event.data as { externalReference?: string }).externalReference).toBe('order_local_9');
  });

  it('does NOT call an APPROVED payment a success — the money is held, not moved', () => {
    const raw = JSON.stringify({
      ...paymentEvent,
      data: {
        type: 'payment',
        id: 'pmt_1',
        object: { payment: { ...COMPLETED_PAYMENT, status: 'APPROVED' } },
      },
    });
    const event = makeDriver().parseWebhook(raw, {
      'x-square-hmacsha256-signature': signature(raw),
    });
    expect(event.type).toBe('payment.updated');
  });

  it('records a refund only once Square says COMPLETED', () => {
    const build = (status: string) =>
      JSON.stringify({
        merchant_id: 'MERCH_1',
        type: 'refund.updated',
        event_id: `evt_${status}`,
        data: {
          type: 'refund',
          id: 'rfd_1',
          object: {
            refund: {
              id: 'rfd_1',
              status,
              amount_money: { amount: 1990, currency: 'USD' },
              payment_id: 'pmt_1',
            },
          },
        },
      });
    const driver = makeDriver();
    const pending = build('PENDING');
    expect(
      driver.parseWebhook(pending, { 'x-square-hmacsha256-signature': signature(pending) }).type,
    ).toBe('payment.updated');

    const completed = build('COMPLETED');
    const event = driver.parseWebhook(completed, {
      'x-square-hmacsha256-signature': signature(completed),
    });
    expect(event.type).toBe('payment.refunded');
    // Keyed on the PAYMENT, which is the row the refunded amount came off.
    expect((event.data as { gatewayId: string }).gatewayId).toBe('pmt_1');
  });

  it('maps subscription events, treating a CANCELED update as a cancellation', () => {
    const build = (type: string, status: string) =>
      JSON.stringify({
        merchant_id: 'MERCH_1',
        type,
        event_id: `evt_${status}`,
        data: {
          type: 'subscription',
          id: 'sub_1',
          object: {
            subscription: {
              id: 'sub_1',
              customer_id: 'cus_1',
              plan_variation_id: 'VAR_123',
              status,
            },
          },
        },
      });
    const driver = makeDriver();
    const created = build('subscription.created', 'ACTIVE');
    expect(
      driver.parseWebhook(created, { 'x-square-hmacsha256-signature': signature(created) }).type,
    ).toBe('subscription.created');

    const canceled = build('subscription.updated', 'CANCELED');
    const event = driver.parseWebhook(canceled, {
      'x-square-hmacsha256-signature': signature(canceled),
    });
    expect(event.type).toBe('subscription.canceled');
    expect((event.data as { status: string }).status).toBe('canceled');

    const paused = build('subscription.updated', 'PAUSED');
    expect(
      driver.parseWebhook(paused, { 'x-square-hmacsha256-signature': signature(paused) }).type,
    ).toBe('subscription.updated');
  });
});

describe('SquareDriver disputes', () => {
  /** Square's own published `dispute.created` shape, trimmed to what the driver reads. */
  const disputeEvent = (type: string, dispute: Record<string, unknown> = {}) => ({
    merchant_id: 'MERCHANT',
    type,
    event_id: 'evt_dispute_1',
    created_at: '2026-08-01T10:00:00Z',
    data: {
      type: 'dispute',
      id: 'ORSEVtZAJxb37RA1EiGw',
      object: {
        dispute: {
          id: 'ORSEVtZAJxb37RA1EiGw',
          amount_money: { amount: 1990, currency: 'USD' },
          // Nested, not a top-level `payment_id` — reading it off the dispute finds nothing.
          disputed_payment: { payment_id: 'pmt_1' },
          state: 'EVIDENCE_REQUIRED',
          reason: 'AMOUNT_DIFFERS',
          card_brand: 'VISA',
          due_at: '2026-09-01T00:00:00Z',
          ...dispute,
        },
      },
    },
  });

  const parse = (type: string, dispute: Record<string, unknown> = {}) => {
    const raw = JSON.stringify(disputeEvent(type, dispute));
    return makeDriver().parseWebhook(raw, { 'x-square-hmacsha256-signature': signature(raw) });
  };

  it('maps dispute.created onto payment.disputed, keyed on the disputed payment', () => {
    const event = parse('dispute.created');
    expect(event.type).toBe('payment.disputed');
    expect(event.data).toMatchObject({
      gatewayId: 'pmt_1',
      amount: 1990,
      currency: 'usd',
      disputeId: 'ORSEVtZAJxb37RA1EiGw',
      reason: 'AMOUNT_DIFFERS',
      // "The deadline by which the seller must respond to the dispute", already RFC 3339.
      actionableUntil: '2026-09-01T00:00:00Z',
    });
  });

  it('calls an INQUIRY-state dispute a warning, not a chargeback', () => {
    // Square's own enum descriptions call these "an inquiry" and keep them out of the
    // dispute states. Reporting one as `payment.disputed` moves a paid row.
    for (const state of ['INQUIRY_EVIDENCE_REQUIRED', 'INQUIRY_PROCESSING']) {
      const event = parse('dispute.created', { state });
      expect(event.type, state).toBe('payment.dispute_warning');
      expect(event.type, state).not.toBe('payment.disputed');
      expect(event.data, state).toMatchObject({
        gatewayId: 'pmt_1',
        disputeId: 'ORSEVtZAJxb37RA1EiGw',
        actionableUntil: '2026-09-01T00:00:00Z',
      });
    }
  });

  it('closes the dispute on the terminal states, with ACCEPTED counting as a loss', () => {
    const cases: Array<[string, string]> = [
      ['WON', 'won'],
      ['LOST', 'lost'],
      // "Square returns the disputed amount to the cardholder and updates the dispute state
      // to ACCEPTED. The dispute is now closed." The seller accepted liability.
      ['ACCEPTED', 'lost'],
    ];
    for (const [state, outcome] of cases) {
      const event = parse('dispute.state.updated', { state });
      expect(event.type, state).toBe('payment.dispute_closed');
      expect(event.data, state).toMatchObject({ gatewayId: 'pmt_1', outcome });
    }
  });

  it('reports a state change into a real dispute state as the chargeback', () => {
    // An inquiry escalating, or the bank asking for more evidence: Square is withholding
    // the funds either way, and this is the only event that says so.
    for (const state of ['EVIDENCE_REQUIRED', 'PROCESSING']) {
      expect(parse('dispute.state.updated', { state }).type, state).toBe('payment.disputed');
    }
  });

  it('leaves a closed inquiry and the evidence paperwork as payment.updated', () => {
    // `INQUIRY_CLOSED` is "the inquiry is complete" and names no winner, so there is no
    // outcome to report — the processor throws on a close carrying none.
    const closed = parse('dispute.state.updated', { state: 'INQUIRY_CLOSED' });
    expect(closed.type).toBe('payment.updated');
    expect(closed.data).not.toHaveProperty('outcome');

    for (const type of [
      'dispute.evidence.added',
      'dispute.evidence.created',
      'dispute.evidence.deleted',
      'dispute.evidence.removed',
    ]) {
      expect(parse(type).type, type).toBe('payment.updated');
    }
  });

  it('handles the deprecated dispute.state.changed spelling the same way', () => {
    expect(parse('dispute.state.changed', { state: 'WON' }).type).toBe('payment.dispute_closed');
  });

  it('keeps payment.disputed for a dispute.created with no state at all', () => {
    // Square marks `state` nullable; an unreadable one keeps the mapping it has always had.
    expect(parse('dispute.created', { state: undefined }).type).toBe('payment.disputed');
    expect(parse('dispute.state.updated', { state: undefined }).type).toBe('payment.updated');
  });
});

describe('SquareDriver idempotency', () => {
  it('sends the caller key as the refund body field instead of a generated one', async () => {
    const fetchMock = stubFetch({
      refund: {
        id: 'ref_1',
        status: 'PENDING',
        amount_money: { amount: 1990, currency: 'USD' },
        payment_id: 'pmt_1',
      },
    });

    await makeDriver().refund('pmt_1', 1990, { idempotencyKey: 'refund-1' });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      idempotency_key: string;
    };
    // A generated UUID makes Square's own retry safe and a retried JOB double-refund.
    expect(body.idempotency_key).toBe('refund-1');
  });

  it('sends the caller key on createCustomer and createSubscription', async () => {
    const customerFetch = stubFetch({ customer: { id: 'cus_1', given_name: 'Ana' } });
    await makeDriver().createCustomer({ name: 'Ana', idempotencyKey: 'customer-1' });
    expect(
      (JSON.parse(customerFetch.mock.calls[0]![1].body as string) as { idempotency_key: string })
        .idempotency_key,
    ).toBe('customer-1');
    vi.unstubAllGlobals();

    const subscriptionFetch = stubFetch({
      subscription: { id: 'sub_1', customer_id: 'cus_1', status: 'ACTIVE' },
    });
    await makeDriver().createSubscription({
      customerId: 'cus_1',
      planId: 'var_1',
      idempotencyKey: 'subscription-1',
    });
    expect(
      (
        JSON.parse(subscriptionFetch.mock.calls[0]![1].body as string) as {
          idempotency_key: string;
        }
      ).idempotency_key,
    ).toBe('subscription-1');
  });

  it('refuses an idempotency key on a subscription update rather than dropping it', async () => {
    // Neither `PUT /v2/subscriptions/{id}` nor `swap-plan` takes one, so accepting it would
    // turn the caller's retry guarantee into a second plan swap.
    await expect(
      makeDriver().updateSubscription('sub_1', {
        metadata: { planVariationId: 'var_2' },
        idempotencyKey: 'update-1',
      }),
    ).rejects.toThrow(/no idempotency key on a subscription update/);
  });

  it('still refuses a refund key longer than Square accepts', async () => {
    await expect(
      makeDriver().refund('pmt_1', 1990, { idempotencyKey: 'x'.repeat(46) }),
    ).rejects.toThrow(/45 characters/);
  });
});

describe('SquareDriver methods and paused subscriptions', () => {
  it('accepts the categories a Web Payments SDK token can actually be', async () => {
    const fetchMock = stubFetch({ payment: { ...COMPLETED_PAYMENT, source_type: 'WALLET' } });
    await expect(
      makeDriver().charge({ amount: 1990, paymentMethodId: 'wlt:x', method: 'wallet' }),
    ).resolves.toMatchObject({ method: 'wallet' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('still refuses a method Square cannot produce at all', async () => {
    await expect(
      makeDriver().charge({ amount: 1990, paymentMethodId: 'cnon:x', method: 'pix' }),
    ).rejects.toThrow(/Square has no "pix" payment method/);
  });

  it('reads a PAUSED subscription as paused, not past_due', async () => {
    // Nobody is in arrears: it bills nothing today and resumes later. Either way the
    // subscriber is entitled to nothing, which is the part that must not change.
    stubFetch({
      subscription: { id: 'sub_1', customer_id: 'cus_1', status: 'PAUSED', plan_variation_id: 'v' },
    });
    expect((await makeDriver().findSubscription('sub_1'))?.status).toBe('paused');
  });
});
