import { beforeEach, describe, expect, it, vi } from 'vitest';

const stripeMock = vi.hoisted(() => ({
  paymentIntents: { create: vi.fn(), retrieve: vi.fn() },
  refunds: { create: vi.fn() },
  customers: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  subscriptions: { create: vi.fn(), update: vi.fn(), cancel: vi.fn(), retrieve: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  invoices: { list: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
}));

vi.mock('stripe', () => ({ default: vi.fn(() => stripeMock) }));

import { StripeDriver } from '../src/drivers/stripe.js';

function makeDriver() {
  return new StripeDriver({ config: () => ({}) }, { apiKey: 'sk_test', currency: 'eur' });
}

/** A PaymentIntent with only the fields the driver's mapper reads. */
function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    amount: 1990,
    currency: 'brl',
    status: 'requires_action',
    payment_method_types: ['pix'],
    metadata: {},
    customer: 'cus_1',
    created: 1_767_225_600,
    ...overrides,
  };
}

describe('StripeDriver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to boot without a currency instead of guessing one', () => {
    // A multi-currency gateway has no safe default: the wrong guess charges and succeeds.
    expect(
      () =>
        new StripeDriver({ config: () => ({}) }, { apiKey: 'sk_test' } as unknown as {
          apiKey: string;
          currency: string;
        }),
    ).toThrow(/Driver "stripe" has no currency configured/);
  });

  it('charges in the configured currency', async () => {
    stripeMock.paymentIntents.create.mockResolvedValue(intent({ currency: 'eur' }));
    const driver = makeDriver();

    await driver.charge({ customerId: 'cus_1', amount: 1990 });

    expect(stripeMock.paymentIntents.create.mock.calls[0]![0].currency).toBe('eur');
  });

  it('sends the idempotency key as the request option, not only as metadata', async () => {
    stripeMock.paymentIntents.create.mockResolvedValue(intent());
    const driver = makeDriver();

    await driver.charge({ customerId: 'cus_1', amount: 1990, idempotencyKey: 'order:1' });

    const [params, options] = stripeMock.paymentIntents.create.mock.calls[0]!;
    // The header is what Stripe deduplicates on — metadata is only a trace.
    expect(options).toEqual({ idempotencyKey: 'order:1' });
    expect(params.metadata).toMatchObject({ idempotency_key: 'order:1' });
  });

  it('passes no request options when the charge has no idempotency key', async () => {
    stripeMock.paymentIntents.create.mockResolvedValue(intent());
    const driver = makeDriver();

    await driver.charge({ customerId: 'cus_1', amount: 1990 });

    expect(stripeMock.paymentIntents.create.mock.calls[0]![1]).toBeUndefined();
  });

  it('sends the idempotency key as the request option on a checkout session', async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      status: 'open',
      amount_total: 1990,
      currency: 'brl',
      subscription: null,
      customer: null,
    });
    const driver = makeDriver();

    await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://example.com/ok',
      idempotencyKey: 'checkout:1',
    });

    expect(stripeMock.checkout.sessions.create.mock.calls[0]![1]).toEqual({
      idempotencyKey: 'checkout:1',
    });
  });

  it('names the Stripe payment method type the charge asked for', async () => {
    const driver = makeDriver();

    for (const [method, type] of [
      ['pix', 'pix'],
      ['boleto', 'boleto'],
      ['credit_card', 'card'],
    ] as const) {
      stripeMock.paymentIntents.create.mockResolvedValue(intent({ payment_method_types: [type] }));
      await driver.charge({ customerId: 'cus_1', amount: 1990, method });
      const params = stripeMock.paymentIntents.create.mock.lastCall![0];
      expect(params.payment_method_types).toEqual([type]);
    }
  });

  it('leaves the method to the account defaults when the charge names none', async () => {
    stripeMock.paymentIntents.create.mockResolvedValue(intent());
    const driver = makeDriver();

    await driver.charge({ customerId: 'cus_1', amount: 1990 });

    expect(stripeMock.paymentIntents.create.mock.calls[0]![0]).not.toHaveProperty(
      'payment_method_types',
    );
  });

  it('maps the Pix QR code and instructions page off next_action', async () => {
    stripeMock.paymentIntents.create.mockResolvedValue(
      intent({
        next_action: {
          type: 'pix_display_qr_code',
          pix_display_qr_code: {
            data: '00020126BR.GOV.BCB.PIX',
            hosted_instructions_url: 'https://payments.stripe.com/pix/1',
            image_url_png: 'https://payments.stripe.com/pix/1.png',
          },
        },
      }),
    );
    const driver = makeDriver();

    const payment = await driver.charge({ customerId: 'cus_1', amount: 1990, method: 'pix' });

    expect(payment.method).toBe('pix');
    expect(payment.pixCode).toBe('00020126BR.GOV.BCB.PIX');
    expect(payment.pixCopiaECola).toBe('00020126BR.GOV.BCB.PIX');
    expect(payment.hostedUrl).toBe('https://payments.stripe.com/pix/1');
    // `image_url_png` is a URL; `pixQrCodeImage` promises a base64 PNG.
    expect(payment.pixQrCodeImage).toBeUndefined();
  });

  it('maps the boleto voucher page off next_action', async () => {
    stripeMock.paymentIntents.create.mockResolvedValue(
      intent({
        payment_method_types: ['boleto'],
        next_action: {
          type: 'boleto_display_details',
          boleto_display_details: {
            hosted_voucher_url: 'https://payments.stripe.com/boleto/1',
            number: '34191',
            pdf: 'https://payments.stripe.com/boleto/1.pdf',
            expires_at: 1_767_225_600,
          },
        },
      }),
    );
    const driver = makeDriver();

    const payment = await driver.charge({ customerId: 'cus_1', amount: 1990, method: 'boleto' });

    expect(payment.method).toBe('boleto');
    expect(payment.hostedUrl).toBe('https://payments.stripe.com/boleto/1');
  });
});

/**
 * The driver used to hand `event.type` and the raw Stripe object straight to the
 * processor, which switches on the canonical names and therefore recognized none of them:
 * every Stripe webhook was ledgered as processed and synced nothing. A chargeback cannot
 * move a row that was never written, so the dispute mapping starts here.
 */
describe('StripeDriver webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** `constructEvent` is what the driver calls; the signature itself is Stripe's business. */
  function webhook(type: string, object: Record<string, unknown>) {
    stripeMock.webhooks.constructEvent.mockReturnValue({
      id: 'evt_1',
      type,
      created: 1_767_225_600,
      data: { object },
    });
    return new StripeDriver(
      { config: () => ({}) },
      { apiKey: 'sk_test', currency: 'eur', webhookSecret: 'whsec_test' },
    ).parseWebhook('{}', { 'stripe-signature': 't=1,v1=x' });
  }

  it('normalizes a succeeded PaymentIntent onto payment.succeeded', () => {
    const event = webhook('payment_intent.succeeded', {
      id: 'pi_1',
      amount: 1990,
      currency: 'eur',
      customer: 'cus_1',
      metadata: { external_reference: 'order_7' },
    });
    expect(event.type).toBe('payment.succeeded');
    expect(event.data).toEqual({
      gatewayId: 'pi_1',
      amount: 1990,
      currency: 'eur',
      customerId: 'cus_1',
      externalReference: 'order_7',
    });
  });

  it('maps charge.dispute.created onto payment.disputed, keyed on the PaymentIntent', () => {
    const event = webhook('charge.dispute.created', {
      id: 'dp_1',
      charge: 'ch_1',
      payment_intent: 'pi_1',
      amount: 1990,
      currency: 'eur',
      reason: 'fraudulent',
    });
    expect(event.type).toBe('payment.disputed');
    // `pi_1`, not `ch_1`: the row the processor has to move is the one `charge()` wrote.
    expect(event.data).toEqual({ gatewayId: 'pi_1', amount: 1990, currency: 'eur' });
  });

  it('falls back to the charge id when the dispute has no PaymentIntent', () => {
    // `payment_intent` is nullable on the Dispute object — a legacy Charges-API charge has
    // none, and losing the dispute entirely would be worse than keying it on the charge.
    const event = webhook('charge.dispute.created', {
      id: 'dp_1',
      charge: 'ch_1',
      payment_intent: null,
      amount: 1990,
      currency: 'eur',
    });
    expect(event.data).toMatchObject({ gatewayId: 'ch_1' });
  });

  it('leaves the rest of the dispute family as payment.updated', () => {
    // Won, lost, funds pulled, funds returned: the resolution, which every gateway reports
    // differently and which this package deliberately does not name.
    for (const type of [
      'charge.dispute.closed',
      'charge.dispute.updated',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.funds_reinstated',
    ]) {
      const event = webhook(type, { charge: 'ch_1', amount: 1990, currency: 'eur' });
      expect(event.type, type).toBe('payment.updated');
    }
  });

  it('only calls a fully refunded charge refunded', () => {
    const partial = webhook('charge.refunded', {
      id: 'ch_1',
      payment_intent: 'pi_1',
      amount: 1990,
      amount_refunded: 500,
      currency: 'eur',
      refunded: false,
    });
    // A partial refund leaves the payment paid; marking the row `refunded` would write off
    // money the merchant kept.
    expect(partial.type).toBe('payment.updated');

    const full = webhook('charge.refunded', {
      id: 'ch_1',
      payment_intent: 'pi_1',
      amount: 1990,
      amount_refunded: 1990,
      currency: 'eur',
      refunded: true,
    });
    expect(full.type).toBe('payment.refunded');
    expect(full.data).toMatchObject({ gatewayId: 'pi_1' });
  });

  it('does not call a completed subscription checkout a payment', () => {
    // A subscription session completes with no payment at all; `payment_status` is the
    // only field that says whether money moved.
    const unpaid = webhook('checkout.session.completed', {
      id: 'cs_1',
      payment_status: 'unpaid',
      payment_intent: 'pi_1',
      amount_total: 1990,
      currency: 'eur',
    });
    expect(unpaid.type).toBe('payment.updated');

    const paid = webhook('checkout.session.completed', {
      id: 'cs_1',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      amount_total: 1990,
      currency: 'eur',
      client_reference_id: 'order_7',
    });
    expect(paid.type).toBe('payment.succeeded');
    expect(paid.data).toMatchObject({ gatewayId: 'pi_1', externalReference: 'order_7' });
  });

  it('normalizes the subscription lifecycle, including a paused one', () => {
    const created = webhook('customer.subscription.created', {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      items: { data: [{ price: { id: 'price_1' } }] },
    });
    expect(created.type).toBe('subscription.created');
    expect(created.data).toMatchObject({
      gatewayId: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      planId: 'price_1',
    });

    const paused = webhook('customer.subscription.updated', {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'paused',
      items: { data: [] },
    });
    expect(paused.type).toBe('subscription.updated');
    expect((paused.data as { status: string }).status).toBe('paused');

    const deleted = webhook('customer.subscription.deleted', {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'canceled',
      items: { data: [] },
    });
    expect(deleted.type).toBe('subscription.canceled');
  });

  it('passes an unmapped event through under its Stripe name', () => {
    const event = webhook('invoice.payment_succeeded', { id: 'in_1', total: 1990 });
    expect(event.type).toBe('invoice.payment_succeeded');
    expect(event.data).toMatchObject({ id: 'in_1' });
  });

  it('passes a canonical event through rather than emitting a payload the processor throws on', () => {
    // The built-in handlers throw on a malformed payload, and a throw inside the webhook
    // route is a 500 Stripe retries forever. An object with no amount is not a payment
    // event, whatever its type says.
    const event = webhook('payment_intent.succeeded', { id: 'pi_1' });
    expect(event.type).toBe('payment_intent.succeeded');
  });
});

describe('StripeDriver statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads requires_capture as authorized — held, not captured, and not failed', async () => {
    // It used to fall through to `failed`: a live authorization reported as a dead payment.
    stripeMock.paymentIntents.retrieve.mockResolvedValue(intent({ status: 'requires_capture' }));
    const payment = await makeDriver().findPayment('pi_1');
    expect(payment?.status).toBe('authorized');
    expect(payment?.paidAt).toBeUndefined();
  });

  it('reads requires_confirmation as pending, not failed', async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      intent({ status: 'requires_confirmation' }),
    );
    expect((await makeDriver().findPayment('pi_1'))?.status).toBe('pending');
  });

  it('reads a paused subscription as paused, not active', async () => {
    // `active` entitled a subscriber nobody is billing — Stripe pauses collection exactly
    // so the app can stop serving them.
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'paused',
      items: { data: [{ price: { id: 'price_1', unit_amount: 1990, currency: 'eur' } }] },
      trial_end: null,
      ended_at: null,
      cancel_at_period_end: false,
      created: 1_767_225_600,
    });
    expect((await makeDriver().findSubscription('sub_1'))?.status).toBe('paused');
  });

  it('names the payment method by category, not by brand', async () => {
    for (const [stripeType, method] of [
      ['sepa_debit', 'bank_debit'],
      ['us_bank_account', 'bank_debit'],
      ['ideal', 'bank_transfer'],
      ['paypal', 'wallet'],
      ['klarna', 'bnpl'],
      ['oxxo', 'voucher'],
    ] as const) {
      stripeMock.paymentIntents.retrieve.mockResolvedValue(
        intent({ payment_method_types: [stripeType] }),
      );
      expect((await makeDriver().findPayment('pi_1'))?.method, stripeType).toBe(method);
    }
  });
});

describe('StripeDriver idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the key as the request header on a refund', async () => {
    stripeMock.refunds.create.mockResolvedValue({
      id: 're_1',
      amount: 1990,
      currency: 'eur',
      status: 'succeeded',
      created: 1_767_225_600,
    });

    await makeDriver().refund('pi_1', 1990, { idempotencyKey: 'refund:1' });

    // A retried refund job without this creates a SECOND refund.
    expect(stripeMock.refunds.create.mock.calls[0]![1]).toEqual({ idempotencyKey: 'refund:1' });
  });

  it('sends the key on createCustomer, createSubscription and updateSubscription', async () => {
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_1', email: null, name: null });
    const subscription = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      items: { data: [{ price: { id: 'price_1', unit_amount: 1990, currency: 'eur' } }] },
      trial_end: null,
      ended_at: null,
      cancel_at_period_end: false,
      created: 1_767_225_600,
    };
    stripeMock.subscriptions.create.mockResolvedValue(subscription);
    stripeMock.subscriptions.update.mockResolvedValue(subscription);
    const driver = makeDriver();

    await driver.createCustomer({ email: 'a@b.c', idempotencyKey: 'cus:1' });
    await driver.createSubscription({
      customerId: 'cus_1',
      planId: 'price_1',
      idempotencyKey: 'sub:1',
    });
    await driver.updateSubscription('sub_1', { description: 'x', idempotencyKey: 'upd:1' });

    expect(stripeMock.customers.create.mock.calls[0]![1]).toEqual({ idempotencyKey: 'cus:1' });
    expect(stripeMock.subscriptions.create.mock.calls[0]![1]).toEqual({ idempotencyKey: 'sub:1' });
    expect(stripeMock.subscriptions.update.mock.calls[0]![2]).toEqual({ idempotencyKey: 'upd:1' });
  });
});
