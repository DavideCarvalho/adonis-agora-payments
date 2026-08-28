import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MercadoPagoDriver } from '../src/drivers/mercadopago.js';

const SECRET = 'whsec-mercadopago';
const REQUEST_ID = '2066ca19-c6f1-498a-be75-1923005edd06';
const TS = '1704908010';

function makeDriver(config: { currency?: string; webhookSecret?: string } = {}) {
  return new MercadoPagoDriver(
    { config: () => ({}) },
    {
      accessToken: 'TEST-token',
      currency: config.currency ?? 'brl',
      ...(config.webhookSecret !== undefined ? { webhookSecret: config.webhookSecret } : {}),
    },
  );
}

/** The manifest Mercado Pago signs: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. */
function sign(dataId: string, requestId: string = REQUEST_ID, ts: string = TS): string {
  return createHmac('sha256', SECRET)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
}

function notification(dataId: string, type = 'payment') {
  return JSON.stringify({
    id: 12345,
    live_mode: true,
    type,
    date_created: '2026-03-25T10:04:58.396-04:00',
    user_id: 44444,
    api_version: 'v1',
    action: `${type}.updated`,
    data: { id: dataId },
  });
}

/**
 * A `topic_chargebacks_wh` notification: `data.id` is the chargeback CASE id (what the
 * signature covers), and the payment it is about travels separately in `data.payment_id`.
 */
function chargebackNotification(caseId: string, paymentId?: string) {
  return JSON.stringify({
    id: 67890,
    live_mode: true,
    type: 'topic_chargebacks_wh',
    date_created: '2026-03-25T10:04:58.396-04:00',
    user_id: 44444,
    actions: ['changed_case_status'],
    data: {
      id: caseId,
      ...(paymentId !== undefined ? { payment_id: paymentId } : {}),
      checkout: 'cho-pro',
      site_id: 'MLB',
    },
  });
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('MercadoPagoDriver', () => {
  it('refuses to boot without an access token', () => {
    vi.stubEnv('MERCADOPAGO_ACCESS_TOKEN', '');
    expect(() => new MercadoPagoDriver({ config: () => ({}) }, { currency: 'brl' })).toThrow(
      /requires accessToken/,
    );
  });

  it('refuses to boot without a currency instead of guessing one', () => {
    expect(
      () =>
        new MercadoPagoDriver({ config: () => ({}) }, {
          accessToken: 'TEST-token',
        } as unknown as { accessToken: string; currency: string }),
    ).toThrow(/Driver "mercadopago" has no currency configured/);
  });

  it('creates a Pix charge with a decimal transaction_amount and maps it back to cents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 20359978,
        status: 'approved',
        transaction_amount: 19.9,
        currency_id: 'BRL',
        payment_method_id: 'pix',
        payment_type_id: 'bank_transfer',
        date_created: '2026-03-25T10:00:00.000-03:00',
        date_approved: '2026-03-25T10:01:00.000-03:00',
        external_reference: 'payment_local_1',
        point_of_interaction: {
          transaction_data: {
            qr_code: '00020126BR.GOV.BCB.PIX',
            qr_code_base64: 'aGVsbG8=',
            ticket_url: 'https://www.mercadopago.com.br/payments/1/ticket',
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const payment = await makeDriver().charge({
      amount: 1990,
      method: 'pix',
      externalReference: 'payment_local_1',
      idempotencyKey: 'idem-1',
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.mercadopago.com/v1/payments');
    expect(JSON.parse(String(init.body))).toMatchObject({
      transaction_amount: 19.9,
      payment_method_id: 'pix',
      external_reference: 'payment_local_1',
    });
    // The idempotency key is a header, not a body field — the body is not deduplicated on.
    expect((init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('idem-1');

    expect(payment.gatewayId).toBe('20359978');
    expect(payment.status).toBe('paid');
    expect(payment.amount).toEqual({ amount: 1990, currency: 'brl' });
    expect(payment.method).toBe('pix');
    expect(payment.pixCode).toBe('00020126BR.GOV.BCB.PIX');
    expect(payment.pixQrCodeImage).toBe('aGVsbG8=');
    expect(payment.paidAt).toBe('2026-03-25T10:01:00.000-03:00');
  });

  it('does not divide a zero-decimal currency: 1990 CLP is 1990, not 19.90', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 7,
        status: 'pending',
        transaction_amount: 1990,
        currency_id: 'CLP',
        payment_method_id: 'pix',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const payment = await makeDriver({ currency: 'clp' }).charge({ amount: 1990, method: 'pix' });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body)).transaction_amount).toBe(1990);
    // …and back: a 100× error here would report 199_000.
    expect(payment.amount).toEqual({ amount: 1990, currency: 'clp' });
  });

  it('refuses an externalReference Mercado Pago would reject', async () => {
    await expect(
      makeDriver().charge({ amount: 100, method: 'pix', externalReference: 'order #1 (paid)' }),
    ).rejects.toThrow(/externalReference/);
  });

  /** A mock that fails the test if the driver reaches the network at all. */
  function fetchMustNotBeCalled() {
    const fetchMock = vi.fn(() => {
      throw new Error('the driver fetched before verifying the signature');
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('rejects a webhook whose body was tampered with after signing, before fetching anything', async () => {
    const fetchMock = fetchMustNotBeCalled();
    const driver = makeDriver({ webhookSecret: SECRET });
    // Signature made for payment 999999999, body now claims a different payment.
    await expect(
      driver.parseWebhook(notification('111111111'), {
        'x-signature': `ts=${TS},v1=${sign('999999999')}`,
        'x-request-id': REQUEST_ID,
      }),
    ).rejects.toThrow(/Invalid Mercado Pago webhook signature/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a forged signature and a missing header', async () => {
    fetchMustNotBeCalled();
    const driver = makeDriver({ webhookSecret: SECRET });
    await expect(
      driver.parseWebhook(notification('999999999'), {
        'x-signature': `ts=${TS},v1=${'0'.repeat(64)}`,
        'x-request-id': REQUEST_ID,
      }),
    ).rejects.toThrow(/Invalid Mercado Pago webhook signature/);
    await expect(driver.parseWebhook(notification('999999999'), {})).rejects.toThrow(
      /Missing `x-signature`/,
    );
  });

  it('signs the lowercased data.id, as the docs require for alphanumeric ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ id: 1, status: 'approved', transaction_amount: 1, currency_id: 'BRL' }),
        ),
    );
    const driver = makeDriver({ webhookSecret: SECRET });
    const event = await driver.parseWebhook(notification('ORD01JQ4S4KY8HWQ6NA5PXB65B3D3'), {
      'x-signature': `ts=${TS},v1=${sign('ord01jq4s4ky8hwq6na5pxb65b3d3')}`,
      'x-request-id': REQUEST_ID,
    });
    expect(event.type).toBe('payment.succeeded');
  });

  it('throws when the payment fetch fails, rather than reporting a status it could not confirm', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }),
    );
    const driver = makeDriver({ webhookSecret: SECRET });
    // The route turns this into a 400 and Mercado Pago retries — the right outcome. A
    // `payment.updated` here would mark a settled payment as merely seen.
    await expect(
      driver.parseWebhook(notification('999999999'), {
        'x-signature': `ts=${TS},v1=${sign('999999999')}`,
        'x-request-id': REQUEST_ID,
      }),
    ).rejects.toThrow(/HTTP request failed \(500\)/);
  });

  it('leaves a subscription charge as payment.updated instead of guessing an unverified shape', async () => {
    const fetchMock = fetchMustNotBeCalled();
    const driver = makeDriver({ webhookSecret: SECRET });
    const event = await driver.parseWebhook(
      notification('999999999', 'subscription_authorized_payment'),
      {
        'x-signature': `ts=${TS},v1=${sign('999999999')}`,
        'x-request-id': REQUEST_ID,
      },
    );
    expect(event.type).toBe('payment.updated');
    expect(event.data).toEqual({ gatewayId: '999999999' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the payment to produce payment.succeeded with the externalReference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 999999999,
        status: 'approved',
        transaction_amount: 19.9,
        currency_id: 'BRL',
        payment_method_id: 'pix',
        payment_type_id: 'bank_transfer',
        external_reference: 'payment_local_1',
        payer: { id: 'cus_1' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const driver = makeDriver({ webhookSecret: SECRET });
    const event = await driver.parseWebhook(notification('999999999'), {
      'x-signature': `ts=${TS},v1=${sign('999999999')}`,
      'x-request-id': REQUEST_ID,
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.mercadopago.com/v1/payments/999999999',
    );
    expect(event.id).toBe('12345');
    expect(event.type).toBe('payment.succeeded');
    expect(event.data).toMatchObject({
      gatewayId: '999999999',
      amount: 1990,
      currency: 'brl',
      customerId: 'cus_1',
      externalReference: 'payment_local_1',
    });
  });

  it('round-trips a checkout externalReference onto the preference and back off the webhook', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'pref_1',
          init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref_1',
          external_reference: 'order_42',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 999999999,
          status: 'approved',
          transaction_amount: 19.9,
          currency_id: 'BRL',
          payment_method_id: 'pix',
          external_reference: 'order_42',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const driver = makeDriver({ webhookSecret: SECRET });
    const session = await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://example.com/ok',
      externalReference: 'order_42',
    });
    expect(session.url).toContain('mercadopago.com.br/checkout');
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body)).external_reference).toBe('order_42');

    const event = await driver.parseWebhook(notification('999999999'), {
      'x-signature': `ts=${TS},v1=${sign('999999999')}`,
      'x-request-id': REQUEST_ID,
    });
    expect((event.data as { externalReference?: string }).externalReference).toBe('order_42');
  });

  it('updates a subscription amount at the gateway instead of locally', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'pre_1',
        status: 'authorized',
        payer_id: 55,
        reason: 'Pro plan',
        auto_recurring: { transaction_amount: 79.9, currency_id: 'BRL' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const subscription = await makeDriver().updateSubscription('pre_1', { amount: 7990 });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.mercadopago.com/preapproval/pre_1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({
      auto_recurring: { transaction_amount: 79.9, currency_id: 'BRL' },
    });
    expect(subscription.amount).toEqual({ amount: 7990, currency: 'brl' });
    expect(subscription.status).toBe('active');
  });

  describe('what it refuses', () => {
    it('refuses to list invoices for a customer', async () => {
      await expect(makeDriver().listInvoices('cus_1')).rejects.toThrow(
        /no invoices for a customer/,
      );
    });

    it('refuses a cancel-at-period-end it cannot perform', async () => {
      await expect(makeDriver().cancelSubscription('pre_1', { atPeriodEnd: true })).rejects.toThrow(
        /immediately and irreversibly/,
      );
    });

    it('refuses a charge with no payment method', async () => {
      await expect(makeDriver().charge({ amount: 100 })).rejects.toThrow(
        /requires a payment method on every charge/,
      );
    });

    it('refuses a card charge without the brand Mercado Pago identifies it by', async () => {
      await expect(
        makeDriver().charge({ amount: 100, method: 'credit_card', card: { token: 'tok_1' } }),
      ).rejects.toThrow(/by its brand/);
    });

    it('refuses a startDate Mercado Pago would silently ignore', async () => {
      await expect(
        makeDriver().createSubscription({
          customerId: 'cus_1',
          planId: 'plan_1',
          amount: 4990,
          startDate: '2026-09-01T00:00:00.000-03:00',
          metadata: { backUrl: 'https://example.com/back' },
        }),
      ).rejects.toThrow(/ignores a subscription `start_date`/);
    });
  });

  // ── Disputes ───────────────────────────────────────────────────────────────────────

  it('turns a chargeback notification into payment.disputed against the PAYMENT id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 999999999,
        status: 'charged_back',
        status_detail: 'in_process',
        transaction_amount: 19.9,
        currency_id: 'BRL',
        payment_method_id: 'master',
        payment_type_id: 'credit_card',
        external_reference: 'payment_local_1',
        payer: { id: 'cus_1' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const driver = makeDriver({ webhookSecret: SECRET });
    const event = await driver.parseWebhook(
      chargebackNotification('233000061680860000', '999999999'),
      {
        'x-signature': `ts=${TS},v1=${sign('233000061680860000')}`,
        'x-request-id': REQUEST_ID,
      },
    );

    // The case id (`233…`) is not a payment id; the fetch and the row both key off
    // `data.payment_id`, or the dispute would be filed under something nothing reconciles.
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.mercadopago.com/v1/payments/999999999',
    );
    expect(event.type).toBe('payment.disputed');
    expect(event.data).toMatchObject({
      gatewayId: '999999999',
      amount: 1990,
      currency: 'brl',
      externalReference: 'payment_local_1',
    });
  });

  it('does not invent a payment when the chargeback names no payment id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver({ webhookSecret: SECRET });
    const event = await driver.parseWebhook(chargebackNotification('233000061680860000'), {
      'x-signature': `ts=${TS},v1=${sign('233000061680860000')}`,
      'x-request-id': REQUEST_ID,
    });
    expect(event.type).toBe('payment.updated');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a charged-back payment as disputed, not as a refund', async () => {
    // It used to arrive as `payment.refunded`, which says the seller gave the money back
    // — indistinguishable from a real refund, and the row read `refunded` either way.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 999999999,
          status: 'charged_back',
          transaction_amount: 19.9,
          currency_id: 'BRL',
        }),
      ),
    );
    const driver = makeDriver({ webhookSecret: SECRET });
    const event = await driver.parseWebhook(notification('999999999'), {
      'x-signature': `ts=${TS},v1=${sign('999999999')}`,
      'x-request-id': REQUEST_ID,
    });
    expect(event.type).toBe('payment.disputed');
    expect((await driver.findPayment('999999999'))?.status).toBe('disputed');
  });

  it('treats a mediation as a dispute too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 999999999,
          status: 'in_mediation',
          transaction_amount: 19.9,
          currency_id: 'BRL',
        }),
      ),
    );
    const event = await makeDriver({ webhookSecret: SECRET }).parseWebhook(
      notification('999999999'),
      { 'x-signature': `ts=${TS},v1=${sign('999999999')}`, 'x-request-id': REQUEST_ID },
    );
    expect(event.type).toBe('payment.disputed');
  });

  // ── Authorization and pause ────────────────────────────────────────────────────────

  it('reports an authorized card payment as authorized — held, not captured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 999999999,
          status: 'authorized',
          status_detail: 'pending_capture',
          transaction_amount: 19.9,
          currency_id: 'BRL',
          payment_type_id: 'credit_card',
        }),
      ),
    );
    const payment = await makeDriver().findPayment('999999999');
    // Not `pending` (understates a hold the issuer granted) and not `paid` (grants access
    // against money that evaporates if the authorization is never captured).
    expect(payment?.status).toBe('authorized');
  });

  it('does not report an authorization as a settled payment on the webhook', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ id: 999999999, status: 'authorized', transaction_amount: 19.9 }),
        ),
    );
    const event = await makeDriver({ webhookSecret: SECRET }).parseWebhook(
      notification('999999999'),
      { 'x-signature': `ts=${TS},v1=${sign('999999999')}`, 'x-request-id': REQUEST_ID },
    );
    expect(event.type).toBe('payment.updated');
  });

  it('reports a paused preapproval as paused, not past_due', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'preapproval_1',
          status: 'paused',
          reason: 'Plano Pro',
          payer_id: 12345,
          auto_recurring: { transaction_amount: 49.9, currency_id: 'BRL' },
        }),
      ),
    );
    // Billing has stopped and the subscription is alive — it must not entitle the payer,
    // and nothing failed, so `past_due` was the wrong word for it.
    expect((await makeDriver().findSubscription('preapproval_1'))?.status).toBe('paused');
  });

  // ── Idempotency ────────────────────────────────────────────────────────────────────

  it('sends the caller idempotencyKey on a refund instead of a generated one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 1, amount: 19.9, status: 'approved' }));
    vi.stubGlobal('fetch', fetchMock);
    await makeDriver().refund('999999999', 1990, { idempotencyKey: 'idem-refund-1' });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('idem-refund-1');
  });

  it('still generates a random refund key when the caller gives none', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 1, amount: 19.9, status: 'approved' }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver();
    await driver.refund('999999999', 1990);
    await driver.refund('999999999', 1990);
    const keyOf = (call: number) =>
      ((fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<string, string>)[
        'X-Idempotency-Key'
      ];
    // Mercado Pago requires the header, so one has to be invented — but deriving it from
    // the payment id would collapse two deliberate partial refunds of the same amount
    // into one and report a success for a refund never made.
    expect(keyOf(0)).toBeDefined();
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('refuses an idempotencyKey on the calls Mercado Pago documents none for', async () => {
    const driver = makeDriver();
    // `X-Idempotency-Key` is documented — and required — on payments and refunds only.
    // On `/v1/customers` and `/preapproval` the reference lists `Authorization` and
    // nothing else, so sending it would be harmless, unspecified, and a false promise.
    await expect(driver.createCustomer({ idempotencyKey: 'k', email: 'a@b.com' })).rejects.toThrow(
      /documents `X-Idempotency-Key` only for payments and refunds.*`createCustomer`/s,
    );
    await expect(
      driver.createSubscription({ idempotencyKey: 'k', customerId: 'c', planId: 'p' }),
    ).rejects.toThrow(/`createSubscription`/);
    await expect(
      driver.updateSubscription('preapproval_1', { idempotencyKey: 'k' }),
    ).rejects.toThrow(/`updateSubscription`/);
  });

  it('refuses before it reaches the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeDriver().createCustomer({ idempotencyKey: 'k' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
