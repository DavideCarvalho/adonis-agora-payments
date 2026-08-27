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
