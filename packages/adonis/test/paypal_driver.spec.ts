import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayPalDriver } from '../src/drivers/paypal.js';

const WEBHOOK_ID = 'WH-CONFIGURED-ID';

function makeDriver(config: { currency?: string; webhookId?: string } = {}) {
  return new PayPalDriver(
    { config: () => ({}) },
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      currency: config.currency ?? 'usd',
      sandbox: true,
      ...(config.webhookId !== undefined ? { webhookId: config.webhookId } : {}),
    },
  );
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** PayPal answers the OAuth call first; every driver call is preceded by one. */
function tokenResponse(expiresIn = 32400) {
  return jsonResponse({ access_token: 'A21AA-token', token_type: 'Bearer', expires_in: expiresIn });
}

function capturedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ORDER-1',
    status: 'COMPLETED',
    purchase_units: [
      {
        custom_id: 'order_42',
        payments: {
          captures: [
            {
              id: 'CAPTURE-1',
              status: 'COMPLETED',
              amount: { currency_code: 'USD', value: '19.90' },
              custom_id: 'order_42',
              create_time: '2026-03-25T10:00:00Z',
              update_time: '2026-03-25T10:00:05Z',
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

function captureEvent(customId = 'order_42') {
  return JSON.stringify({
    id: 'WH-EVENT-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    create_time: '2026-03-25T10:00:06Z',
    resource_type: 'capture',
    resource: {
      id: 'CAPTURE-1',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '19.90' },
      custom_id: customId,
    },
  });
}

const SIGNATURE_HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'TRANSMISSION-1',
  'paypal-transmission-sig': 'c2ln',
  'paypal-transmission-time': '2026-03-25T10:00:06Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('PayPalDriver', () => {
  it('refuses to boot without client credentials', () => {
    vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
    expect(
      () => new PayPalDriver({ config: () => ({}) }, { clientId: 'client-id', currency: 'usd' }),
    ).toThrow(/requires clientSecret/);
  });

  it('refuses to boot without a currency instead of guessing one', () => {
    expect(
      () =>
        new PayPalDriver({ config: () => ({}) }, {
          clientId: 'client-id',
          clientSecret: 'client-secret',
        } as unknown as { clientId: string; clientSecret: string; currency: string }),
    ).toThrow(/Driver "paypal" has no currency configured/);
  });

  it('charges a vaulted payment method and maps the capture onto a Payment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(capturedOrder()));
    vi.stubGlobal('fetch', fetchMock);

    const payment = await makeDriver().charge({
      amount: 1990,
      paymentMethodId: '2w915838hr181240m',
      externalReference: 'order_42',
      idempotencyKey: 'idem-1',
    });

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(tokenUrl)).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(String(tokenInit.body)).toBe('grant_type=client_credentials');

    const [orderUrl, orderInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(String(orderUrl)).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect((orderInit.headers as Record<string, string>)['PayPal-Request-Id']).toBe('idem-1');
    expect(JSON.parse(String(orderInit.body))).toMatchObject({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: '19.90' }, custom_id: 'order_42' }],
      payment_source: { paypal: { vault_id: '2w915838hr181240m' } },
    });

    expect(payment.gatewayId).toBe('CAPTURE-1');
    expect(payment.status).toBe('paid');
    expect(payment.amount).toEqual({ amount: 1990, currency: 'usd' });
    expect(payment.paidAt).toBe('2026-03-25T10:00:05Z');
  });

  it('sends a zero-decimal currency without a decimal point: ¥1990 is "1990"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          capturedOrder({
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: 'CAPTURE-JPY',
                      status: 'COMPLETED',
                      amount: { currency_code: 'JPY', value: '1990' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const payment = await makeDriver({ currency: 'jpy' }).charge({
      amount: 1990,
      paymentMethodId: 'vault-1',
      idempotencyKey: 'idem-jpy',
    });

    const [, orderInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
    // "19.90" here would bill a hundredth of the intended amount — and PayPal would take it.
    expect(JSON.parse(String(orderInit.body)).purchase_units[0].amount).toEqual({
      currency_code: 'JPY',
      value: '1990',
    });
    expect(payment.amount).toEqual({ amount: 1990, currency: 'jpy' });
  });

  it('reuses the OAuth token until it expires, then fetches a new one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:00:00Z'));
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          String(url).endsWith('/v1/oauth2/token')
            ? tokenResponse(3600)
            : jsonResponse({ id: 'CAPTURE-1', status: 'COMPLETED' }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver();

    await driver.findPayment('CAPTURE-1');
    await driver.findPayment('CAPTURE-1');
    const tokenCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/oauth2/token')).length;
    expect(tokenCalls()).toBe(1);

    // Past PayPal's own `expires_in`, the cached token is dead — a cache that outlives it
    // is a deploy that works for an hour and then 401s on every charge.
    vi.setSystemTime(new Date('2026-03-25T11:05:00Z'));
    await driver.findPayment('CAPTURE-1');
    expect(tokenCalls()).toBe(2);
  });

  it('verifies a webhook with PayPal and reads the externalReference back out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ verification_status: 'SUCCESS' }));
    vi.stubGlobal('fetch', fetchMock);

    const event = await makeDriver({ webhookId: WEBHOOK_ID }).parseWebhook(
      captureEvent(),
      SIGNATURE_HEADERS,
    );

    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(String(verifyUrl)).toBe(
      'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature',
    );
    expect(JSON.parse(String(verifyInit.body))).toMatchObject({
      auth_algo: 'SHA256withRSA',
      transmission_id: 'TRANSMISSION-1',
      transmission_sig: 'c2ln',
      transmission_time: '2026-03-25T10:00:06Z',
      webhook_id: WEBHOOK_ID,
      webhook_event: { id: 'WH-EVENT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
    });

    expect(event.id).toBe('WH-EVENT-1');
    expect(event.type).toBe('payment.succeeded');
    expect(event.data).toMatchObject({
      gatewayId: 'CAPTURE-1',
      amount: 1990,
      currency: 'usd',
      externalReference: 'order_42',
    });
  });

  it('rejects a webhook PayPal did not verify', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ verification_status: 'FAILURE' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeDriver({ webhookId: WEBHOOK_ID }).parseWebhook(captureEvent(), SIGNATURE_HEADERS),
    ).rejects.toThrow(/Invalid PayPal webhook signature/);
  });

  it('parses without verifying only when no webhookId is configured', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('verified against nothing');
    });
    vi.stubGlobal('fetch', fetchMock);
    // No webhookId means there is nothing to verify against — the same "unconfigured is
    // unenforced" rule the other drivers use, so local development works.
    const event = await makeDriver().parseWebhook(captureEvent(), SIGNATURE_HEADERS);
    expect(event.type).toBe('payment.succeeded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('round-trips a checkout externalReference onto custom_id and back off the webhook', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'ORDER-9',
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-9' },
            { rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=ORDER-9' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ verification_status: 'SUCCESS' }));
    vi.stubGlobal('fetch', fetchMock);

    const driver = makeDriver({ webhookId: WEBHOOK_ID });
    const session = await driver.createCheckout({
      amount: 1990,
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
      externalReference: 'order_42',
    });
    expect(session.url).toBe('https://www.paypal.com/checkoutnow?token=ORDER-9');
    const [, orderInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(JSON.parse(String(orderInit.body)).purchase_units[0].custom_id).toBe('order_42');

    const event = await driver.parseWebhook(captureEvent('order_42'), SIGNATURE_HEADERS);
    expect((event.data as { externalReference?: string }).externalReference).toBe('order_42');
  });

  it('maps a subscription charge (a sale, not a capture) back to its subscription', async () => {
    const raw = JSON.stringify({
      id: 'WH-EVENT-2',
      event_type: 'PAYMENT.SALE.COMPLETED',
      resource: {
        id: 'SALE-1',
        state: 'completed',
        custom: 'sub_local_1',
        billing_agreement_id: 'I-BW452GLLEP1G',
        amount: { total: '49.90', currency: 'USD' },
      },
    });
    const event = await makeDriver().parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
    expect(event.data).toMatchObject({
      gatewayId: 'SALE-1',
      amount: 4990,
      currency: 'usd',
      subscriptionId: 'I-BW452GLLEP1G',
      externalReference: 'sub_local_1',
    });
  });

  it('reprices the REGULAR billing cycle, not the trial one', async () => {
    const subscription = {
      id: 'I-SUB',
      status: 'ACTIVE',
      plan_id: 'P-5ML4271244454362WXNWU5NQ',
      subscriber: { payer_id: 'PAYER-1' },
      plan: {
        billing_cycles: [
          {
            sequence: 1,
            tenure_type: 'TRIAL',
            pricing_scheme: { fixed_price: { currency_code: 'USD', value: '0.00' } },
          },
          {
            sequence: 2,
            tenure_type: 'REGULAR',
            pricing_scheme: { fixed_price: { currency_code: 'USD', value: '19.90' } },
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(subscription))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined })
      .mockResolvedValueOnce(jsonResponse(subscription));
    vi.stubGlobal('fetch', fetchMock);

    await makeDriver().updateSubscription('I-SUB', { amount: 2990 });

    const [patchUrl, patchInit] = fetchMock.mock.calls[2]! as [string, RequestInit];
    expect(String(patchUrl)).toBe(
      'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-SUB',
    );
    expect(patchInit.method).toBe('PATCH');
    expect(JSON.parse(String(patchInit.body))).toEqual([
      {
        op: 'replace',
        path: '/plan/billing_cycles/@sequence==2/pricing_scheme/fixed_price',
        value: { currency_code: 'USD', value: '29.90' },
      },
    ]);
  });

  describe('what it refuses', () => {
    it('refuses a charge with nobody to approve it', async () => {
      await expect(makeDriver().charge({ amount: 1990 })).rejects.toThrow(
        /cannot charge without the payer approving/,
      );
    });

    it('refuses a vaulted charge with no idempotency key', async () => {
      await expect(
        makeDriver().charge({ amount: 1990, paymentMethodId: 'vault-1' }),
      ).rejects.toThrow(/requires an idempotency key/);
    });

    it('refuses to invent a customer resource PayPal does not have', async () => {
      await expect(makeDriver().createCustomer({ email: 'a@b.com' })).rejects.toThrow(
        /no customer resource to create/,
      );
      await expect(makeDriver().findCustomer('cus_1')).rejects.toThrow(/cannot look a customer up/);
      await expect(makeDriver().updateCustomer('cus_1', {})).rejects.toThrow(
        /no customer resource to update/,
      );
    });

    it('refuses to list invoices for a customer', async () => {
      await expect(makeDriver().listInvoices('cus_1')).rejects.toThrow(/cannot list invoices/);
    });

    it('refuses subscription fields that live on the PayPal plan', async () => {
      await expect(
        makeDriver().createSubscription({
          customerId: 'cus_1',
          planId: 'P-5ML4271244454362WXNWU5NQ',
          amount: 4990,
          cycle: 'MONTHLY',
        }),
      ).rejects.toThrow(/prices subscriptions on the plan/);
    });

    it('refuses a cancel-at-period-end it cannot perform', async () => {
      await expect(makeDriver().cancelSubscription('I-SUB', { atPeriodEnd: true })).rejects.toThrow(
        /cancels a subscription immediately/,
      );
    });

    it('refuses a subscription description it cannot store', async () => {
      await expect(
        makeDriver().updateSubscription('I-SUB', { description: 'Pro' }),
      ).rejects.toThrow(/no description/);
    });
  });
});

describe('PayPalDriver disputes', () => {
  const disputeEvent = (eventType: string, resource: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'WH-DISPUTE-1',
      event_type: eventType,
      create_time: '2026-03-26T10:00:00Z',
      resource_type: 'dispute',
      resource: {
        dispute_id: 'PP-D-1',
        dispute_amount: { currency_code: 'USD', value: '19.90' },
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        status: 'OPEN',
        dispute_life_cycle_stage: 'CHARGEBACK',
        seller_response_due_date: '2026-04-09T00:00:00.000Z',
        disputed_transactions: [
          {
            // The SELLER's side of the transaction is the capture id this driver keys
            // payments on; `buyer_transaction_id` would find no row here.
            seller_transaction_id: 'CAPTURE-1',
            buyer_transaction_id: 'BUYER-1',
            custom: 'order_42',
          },
        ],
        ...resource,
      },
    });

  it('maps a CHARGEBACK-stage CUSTOMER.DISPUTE.CREATED onto payment.disputed', async () => {
    const event = await makeDriver().parseWebhook(
      disputeEvent('CUSTOMER.DISPUTE.CREATED'),
      SIGNATURE_HEADERS,
    );
    expect(event.type).toBe('payment.disputed');
    expect(event.data).toMatchObject({
      gatewayId: 'CAPTURE-1',
      amount: 1990,
      currency: 'usd',
      disputeId: 'PP-D-1',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      actionableUntil: '2026-04-09T00:00:00.000Z',
      externalReference: 'order_42',
    });
  });

  it('calls an INQUIRY-stage dispute a warning, not a chargeback', async () => {
    // PayPal's own sandbox guide has you assert `dispute_life_cycle_stage` is INQUIRY for
    // one CUSTOMER.DISPUTE.CREATED test and CHARGEBACK for the next. An inquiry is the
    // buyer and seller talking in the Resolution Center with nothing adjudicated and
    // nothing debited — calling it `payment.disputed` moves a paid row over money still in
    // the account.
    const event = await makeDriver().parseWebhook(
      disputeEvent('CUSTOMER.DISPUTE.CREATED', { dispute_life_cycle_stage: 'INQUIRY' }),
      SIGNATURE_HEADERS,
    );
    expect(event.type).toBe('payment.dispute_warning');
    expect(event.type).not.toBe('payment.disputed');
    // The deadline is the whole value of the alert: PayPal closes an unanswered dispute in
    // the customer's favour once it passes.
    expect(event.data).toMatchObject({
      gatewayId: 'CAPTURE-1',
      disputeId: 'PP-D-1',
      actionableUntil: '2026-04-09T00:00:00.000Z',
    });
  });

  it('also recognizes the deprecated RISK.DISPUTE.CREATED spelling', async () => {
    // PayPal's reference says CUSTOMER.DISPUTE.CREATED supersedes it — an account still
    // subscribed to the old one should not silently miss the chargeback.
    const event = await makeDriver().parseWebhook(
      disputeEvent('RISK.DISPUTE.CREATED'),
      SIGNATURE_HEADERS,
    );
    expect(event.type).toBe('payment.disputed');
  });

  it('reads the escalation off CUSTOMER.DISPUTE.UPDATED, which is the only place it lands', async () => {
    // PayPal has no dedicated "escalated to a claim" webhook. A dispute that opened as an
    // inquiry would otherwise never move the row.
    const escalated = await makeDriver().parseWebhook(
      disputeEvent('CUSTOMER.DISPUTE.UPDATED', {
        dispute_life_cycle_stage: 'CHARGEBACK',
        status: 'UNDER_REVIEW',
      }),
      SIGNATURE_HEADERS,
    );
    expect(escalated.type).toBe('payment.disputed');

    // Still in the inquiry, or already resolved: nothing to move.
    for (const resource of [
      { dispute_life_cycle_stage: 'INQUIRY' },
      { dispute_life_cycle_stage: 'CHARGEBACK', status: 'RESOLVED' },
    ]) {
      const event = await makeDriver().parseWebhook(
        disputeEvent('CUSTOMER.DISPUTE.UPDATED', resource),
        SIGNATURE_HEADERS,
      );
      expect(event.type, JSON.stringify(resource)).toBe('payment.updated');
    }
  });

  it('closes a RESOLVED dispute with the outcome PayPal names', async () => {
    const cases: Array<[string, string]> = [
      ['RESOLVED_SELLER_FAVOUR', 'won'],
      ['RESOLVED_BUYER_FAVOUR', 'lost'],
      ['CANCELED_BY_BUYER', 'canceled'],
    ];
    for (const [outcomeCode, outcome] of cases) {
      const event = await makeDriver().parseWebhook(
        disputeEvent('CUSTOMER.DISPUTE.RESOLVED', {
          status: 'RESOLVED',
          dispute_outcome: { outcome_code: outcomeCode },
        }),
        SIGNATURE_HEADERS,
      );
      expect(event.type, outcomeCode).toBe('payment.dispute_closed');
      expect(event.data, outcomeCode).toMatchObject({ gatewayId: 'CAPTURE-1', outcome });
    }
  });

  it('leaves a RESOLVED whose outcome does not name a winner as payment.updated', async () => {
    // `RESOLVED_WITH_PAYOUT` is "PayPal provided the merchant OR customer with protection";
    // `ACCEPTED`/`DENIED` are deprecated and name the dispute rather than the party; `NONE`
    // is a previous dispute "closed without any decision". The processor throws on a close
    // with no outcome precisely so a driver that cannot read one emits an update instead.
    for (const outcomeCode of ['RESOLVED_WITH_PAYOUT', 'ACCEPTED', 'DENIED', 'NONE']) {
      const event = await makeDriver().parseWebhook(
        disputeEvent('CUSTOMER.DISPUTE.RESOLVED', {
          status: 'RESOLVED',
          dispute_outcome: { outcome_code: outcomeCode },
        }),
        SIGNATURE_HEADERS,
      );
      expect(event.type, outcomeCode).toBe('payment.updated');
      expect(event.data, outcomeCode).not.toHaveProperty('outcome');
    }

    // And with no `dispute_outcome` at all.
    const bare = await makeDriver().parseWebhook(
      disputeEvent('CUSTOMER.DISPUTE.RESOLVED'),
      SIGNATURE_HEADERS,
    );
    expect(bare.type).toBe('payment.updated');
  });
});

describe('PayPalDriver authorization and wallets', () => {
  it('reports an authorization as an update carrying `authorized`, not as a success', async () => {
    // PayPal holds an authorization for about 29 days and voids it if nobody captures.
    const raw = JSON.stringify({
      id: 'WH-AUTH-1',
      event_type: 'PAYMENT.AUTHORIZATION.CREATED',
      create_time: '2026-03-25T10:00:00Z',
      resource_type: 'authorization',
      resource: {
        id: 'AUTH-1',
        status: 'CREATED',
        amount: { currency_code: 'USD', value: '19.90' },
        custom_id: 'order_42',
      },
    });
    const event = await makeDriver().parseWebhook(raw, SIGNATURE_HEADERS);
    expect(event.type).toBe('payment.updated');
    expect(event.data).toMatchObject({
      gatewayId: 'AUTH-1',
      amount: 1990,
      currency: 'usd',
      status: 'authorized',
    });
  });

  it('names a vaulted charge a wallet payment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ ...capturedOrder(), payment_source: { paypal: { account_id: 'ACC-1' } } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const payment = await makeDriver().charge({
      amount: 1990,
      paymentMethodId: '2w915838hr181240m',
      externalReference: 'order_42',
      idempotencyKey: 'charge-1',
    });

    // `charge()` sends `payment_source.paypal.vault_id` and nothing else, so the money came
    // out of a PayPal account — which is what `wallet` means.
    expect(payment.method).toBe('wallet');
  });

  it('still calls it a wallet payment when PayPal echoes no payment_source', async () => {
    // The order was created with `payment_source.paypal.vault_id`, so the funding source is
    // known from the request even when the response does not repeat it. Leaving `method`
    // unset here would report a PayPal charge as an instrument nobody can name.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(capturedOrder()));
    vi.stubGlobal('fetch', fetchMock);

    const payment = await makeDriver().charge({
      amount: 1990,
      paymentMethodId: '2w915838hr181240m',
      externalReference: 'order_42',
      idempotencyKey: 'charge-1',
    });

    expect(payment.method).toBe('wallet');
  });

  it('refuses a charge routed as anything but the wallet', async () => {
    await expect(
      makeDriver().charge({
        amount: 1990,
        paymentMethodId: '2w915838hr181240m',
        idempotencyKey: 'charge-1',
        method: 'credit_card',
      }),
    ).rejects.toThrow(/charges the vaulted PayPal account/);
  });

  it('reads a SUSPENDED subscription as paused, not past_due', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ id: 'I-SUB1', status: 'SUSPENDED', plan_id: 'P-1', subscriber: {} }),
      );
    vi.stubGlobal('fetch', fetchMock);

    // Suspension is PayPal's pause: nothing is owed, nothing bills today, `/activate`
    // restarts it — and the subscriber is entitled to nothing either way.
    expect((await makeDriver().findSubscription('I-SUB1'))?.status).toBe('paused');
  });
});

describe('PayPalDriver idempotency', () => {
  it('sends PayPal-Request-Id on a refund', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'REFUND-1',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '19.90' },
          create_time: '2026-03-26T10:00:00Z',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await makeDriver().refund('CAPTURE-1', 1990, { idempotencyKey: 'refund-1' });

    const headers = fetchMock.mock.calls[1]![1].headers as Record<string, string>;
    // Without it a retried refund job refunds the capture twice.
    expect(headers['PayPal-Request-Id']).toBe('refund-1');
  });

  it('sends PayPal-Request-Id on createSubscription', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ id: 'I-SUB1', status: 'APPROVAL_PENDING', plan_id: 'P-1', subscriber: {} }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await makeDriver().createSubscription({
      customerId: 'cus_1',
      planId: 'P-1',
      idempotencyKey: 'subscription-1',
    });

    const headers = fetchMock.mock.calls[1]![1].headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('subscription-1');
  });

  it('refuses an idempotency key on a subscription update, which PayPal does not deduplicate', async () => {
    await expect(
      makeDriver().updateSubscription('I-SUB1', { amount: 2990, idempotencyKey: 'update-1' }),
    ).rejects.toThrow(/does not deduplicate a subscription update/);
  });

  it('refuses a request id longer than PayPal documents', async () => {
    await expect(
      makeDriver().charge({
        amount: 1990,
        paymentMethodId: '2w915838hr181240m',
        idempotencyKey: 'x'.repeat(39),
      }),
    ).rejects.toThrow(/38 single-byte characters/);
  });
});
