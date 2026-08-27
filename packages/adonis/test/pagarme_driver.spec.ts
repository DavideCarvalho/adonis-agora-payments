import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { PagarmeDriver } from '../src/drivers/pagarme.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

function makeDriver(config: Record<string, unknown> = {}) {
  return new PagarmeDriver({ config: () => ({}) }, { secretKey: 'sk_test_123', ...config });
}

/** A fetch double returning one JSON body; exposes the single call it received. */
function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
  return {
    url: String(url),
    init,
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    headers: init.headers as Record<string, string>,
  };
}

const paidCharge = {
  id: 'ch_1',
  code: 'order_local_1',
  status: 'paid',
  amount: 1990,
  currency: 'BRL',
  payment_method: 'pix',
  customer: { id: 'cus_1' },
  created_at: '2026-01-10T12:00:00Z',
  paid_at: '2026-01-10T12:05:00Z',
  metadata: { external_reference: 'order_local_1' },
  last_transaction: {
    transaction_type: 'Pix',
    status: 'waiting_payment',
    qr_code: '00020101BR.GOV.BCB.PIX',
    qr_code_url: 'https://api.pagar.me/qr.png',
  },
};

describe('PagarmeDriver', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to boot without a secret key, naming both places to set it', () => {
    vi.stubEnv('PAGARME_SECRET_KEY', '');
    try {
      expect(() => new PagarmeDriver({ config: () => ({}) })).toThrow(
        /requires secretKey.*PAGARME_SECRET_KEY.*payments\.pagarme/s,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('authenticates with HTTP Basic: the secret key as the user, empty password', async () => {
    const fetchMock = stubFetch({ id: 'cus_1', name: 'Tony' });
    try {
      await makeDriver().createCustomer({ name: 'Tony', taxId: '930.951.352-70' });
      const { url, headers, body } = lastCall(fetchMock);
      expect(url).toBe('https://api.pagar.me/core/v5/customers');
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from('sk_test_123:', 'utf8').toString('base64')}`,
      );
      // CPF is sent digits-only, with the document type the length implies.
      expect(body).toMatchObject({
        document: '93095135270',
        document_type: 'CPF',
        type: 'individual',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends amounts as integer centavos — no decimal conversion', async () => {
    const fetchMock = stubFetch({
      id: 'or_1',
      amount: 1990,
      status: 'pending',
      charges: [paidCharge],
    });
    try {
      const payment = await makeDriver().charge({
        customerId: 'cus_1',
        amount: 1990,
        method: 'pix',
      });
      const { url, body } = lastCall(fetchMock);
      expect(url).toBe('https://api.pagar.me/core/v5/orders');
      // 1990 centavos, not 19.90 reais — the Asaas-style toDecimal() must NOT happen here.
      expect(body.items[0].amount).toBe(1990);
      expect(payment.amount).toEqual({ amount: 1990, currency: 'brl' });
      expect(payment.gatewayId).toBe('ch_1');
      expect(payment.method).toBe('pix');
      expect(payment.pixCode).toBe('00020101BR.GOV.BCB.PIX');
      expect(payment.pixQrCodeImage).toBe('https://api.pagar.me/qr.png');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('always sends the mandatory Pix expires_in', async () => {
    const fetchMock = stubFetch({
      id: 'or_1',
      amount: 100,
      status: 'pending',
      charges: [paidCharge],
    });
    try {
      await makeDriver().charge({ customerId: 'cus_1', amount: 100, method: 'pix' });
      expect(lastCall(fetchMock).body.payments[0]).toMatchObject({
        payment_method: 'pix',
        pix: { expires_in: 86_400 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('propagates externalReference to the order code and metadata', async () => {
    const fetchMock = stubFetch({
      id: 'or_1',
      amount: 100,
      status: 'pending',
      charges: [paidCharge],
    });
    try {
      await makeDriver().charge({
        customerId: 'cus_1',
        amount: 100,
        method: 'boleto',
        externalReference: 'order_local_1',
        idempotencyKey: 'idem_1',
      });
      const { body } = lastCall(fetchMock);
      expect(body.code).toBe('order_local_1');
      expect(body.metadata.external_reference).toBe('order_local_1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a charge with no method, because an order must name one', async () => {
    await expect(makeDriver().charge({ customerId: 'cus_1', amount: 100 })).rejects.toThrow(
      /explicit `method`/,
    );
  });

  it('refuses a card charge with no token', async () => {
    await expect(
      makeDriver().charge({ customerId: 'cus_1', amount: 100, method: 'credit_card' }),
    ).rejects.toThrow(/tokenized card/);
  });

  it('refuses a split rule that names both a percent and a fixed value', async () => {
    await expect(
      makeDriver().charge({
        customerId: 'cus_1',
        amount: 100,
        method: 'pix',
        split: [{ walletId: 'rp_1', percentualValue: 50, fixedValue: 50 }],
      }),
    ).rejects.toThrow(/never both/);
  });

  it('sends a fixed split share in centavos, unconverted', async () => {
    const fetchMock = stubFetch({
      id: 'or_1',
      amount: 100,
      status: 'pending',
      charges: [paidCharge],
    });
    try {
      await makeDriver().charge({
        customerId: 'cus_1',
        amount: 1000,
        method: 'pix',
        split: [{ walletId: 'rp_1', fixedValue: 250 }],
      });
      expect(lastCall(fetchMock).body.payments[0].split).toEqual([
        { recipient_id: 'rp_1', type: 'flat', amount: 250 },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refunds through DELETE /charges/{id}', async () => {
    const fetchMock = stubFetch({
      id: 'ch_1',
      status: 'canceled',
      amount: 1490,
      canceled_amount: 1490,
      canceled_at: '2026-01-11T10:00:00Z',
    });
    try {
      const refund = await makeDriver().refund('ch_1', 1490);
      const { url, init, body } = lastCall(fetchMock);
      expect(url).toBe('https://api.pagar.me/core/v5/charges/ch_1');
      expect(init.method).toBe('DELETE');
      expect(body).toEqual({ amount: 1490 });
      expect(refund.status).toBe('succeeded');
      expect(refund.amount).toEqual({ amount: 1490, currency: 'brl' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates a payment link with the success URL and returns its URL', async () => {
    const fetchMock = stubFetch({
      id: 'pl_1',
      url: 'https://payment-link.pagar.me/pl_1',
      status: 'active',
      cart_settings: { total_cost: 12000 },
    });
    try {
      const session = await makeDriver().createCheckout({
        amount: 12000,
        successUrl: 'https://app.example.com/thanks',
        cancelUrl: 'https://app.example.com/cancel',
        description: 'Banner',
      });
      const { url, body } = lastCall(fetchMock);
      expect(url).toBe('https://api.pagar.me/core/v5/paymentlinks');
      expect(body.type).toBe('order');
      expect(body.flow_settings).toEqual({ success_url: 'https://app.example.com/thanks' });
      expect(body.cart_settings.items).toEqual([
        { name: 'Banner', amount: 12000, default_quantity: 1 },
      ]);
      // No cancel destination exists in the API — nothing must be invented for cancelUrl.
      expect(JSON.stringify(body)).not.toContain('app.example.com/cancel');
      expect(session.url).toBe('https://payment-link.pagar.me/pl_1');
      expect(session.status).toBe('open');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('round-trips externalReference through a payment link: in on order_code, out of the webhook', async () => {
    const fetchMock = stubFetch({
      id: 'pl_1',
      url: 'https://payment-link.pagar.me/pl_1',
      status: 'active',
    });
    let sent: Record<string, unknown>;
    try {
      await makeDriver().createCheckout({
        amount: 12000,
        successUrl: 'https://app.example.com/thanks',
        externalReference: 'order:42',
      });
      sent = lastCall(fetchMock).body;
    } finally {
      vi.unstubAllGlobals();
    }
    // In: the link's correlation id, which the gateway stamps on every order it generates.
    expect(sent.order_code).toBe('order:42');

    // Out: an order.paid for that link comes back with the same value as the order `code`.
    const event = makeDriver().parseWebhook(
      JSON.stringify({
        id: 'hook_9',
        type: 'order.paid',
        data: {
          id: 'or_9',
          code: sent.order_code,
          amount: 12000,
          status: 'paid',
          customer: { id: 'cus_1' },
          charges: [{ ...paidCharge, code: sent.order_code, metadata: {} }],
        },
      }),
      {},
    );
    expect((event.data as { externalReference?: string }).externalReference).toBe('order:42');
  });

  it('creates a plan subscription when planId names a Pagar.me plan', async () => {
    const fetchMock = stubFetch({
      id: 'sub_1',
      status: 'active',
      customer: { id: 'cus_1' },
      plan: { id: 'plan_abc' },
      items: [{ pricing_scheme: { price: 4990 } }],
    });
    try {
      const subscription = await makeDriver().createSubscription({
        customerId: 'cus_1',
        planId: 'plan_abc',
        card: { token: 'tok_1' },
      });
      const { body } = lastCall(fetchMock);
      expect(body.plan_id).toBe('plan_abc');
      expect(body.card_token).toBe('tok_1');
      expect(body.items).toBeUndefined();
      expect(subscription.amount).toEqual({ amount: 4990, currency: 'brl' });
      expect(subscription.status).toBe('active');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates a plan-less subscription from amount and cycle', async () => {
    const fetchMock = stubFetch({
      id: 'sub_1',
      status: 'active',
      customer: { id: 'cus_1' },
      items: [{ pricing_scheme: { price: 4990 } }],
    });
    try {
      await makeDriver().createSubscription({
        customerId: 'cus_1',
        planId: 'pro',
        amount: 4990,
        cycle: 'QUARTERLY',
        method: 'credit_card',
        card: { token: 'tok_1' },
      });
      const { body } = lastCall(fetchMock);
      expect(body.plan_id).toBeUndefined();
      expect(body.interval).toBe('month');
      expect(body.interval_count).toBe(3);
      expect(body.items[0].pricing_scheme).toEqual({ price: 4990 });
      expect(body.code).toBe('pro');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a plan-less subscription with no amount', async () => {
    await expect(
      makeDriver().createSubscription({ customerId: 'cus_1', planId: 'pro' }),
    ).rejects.toThrow(/needs an `amount`/);
  });

  it('cancels immediately, and atPeriodEnd only spares the pending invoices', async () => {
    const fetchMock = stubFetch({ id: 'sub_1', status: 'canceled', customer: { id: 'cus_1' } });
    try {
      await makeDriver().cancelSubscription('sub_1', { atPeriodEnd: true });
      const { init, body } = lastCall(fetchMock);
      expect(init.method).toBe('DELETE');
      expect(body).toEqual({ cancel_pending_invoices: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to update a subscription instead of faking one', async () => {
    await expect(makeDriver().updateSubscription('sub_1', { amount: 100 })).rejects.toThrow(
      /price lives on its items/,
    );
  });

  it('maps charge.paid to payment.succeeded, with the metadata reference', () => {
    const event = makeDriver().parseWebhook(
      JSON.stringify({
        id: 'hook_1',
        type: 'charge.paid',
        created_at: '2026-01-10T12:05:00Z',
        data: paidCharge,
      }),
      {},
    );
    expect(event.id).toBe('hook_1');
    expect(event.type).toBe('payment.succeeded');
    const data = event.data as { gatewayId: string; amount: number; externalReference?: string };
    expect(data.gatewayId).toBe('ch_1');
    expect(data.amount).toBe(1990);
    expect(data.externalReference).toBe('order_local_1');
  });

  it('normalizes order.paid onto the order first charge', () => {
    const event = makeDriver().parseWebhook(
      JSON.stringify({
        id: 'hook_2',
        type: 'order.paid',
        data: {
          id: 'or_1',
          code: 'order_local_1',
          amount: 1990,
          status: 'paid',
          customer: { id: 'cus_1' },
          charges: [paidCharge],
        },
      }),
      {},
    );
    expect(event.type).toBe('payment.succeeded');
    const data = event.data as { gatewayId: string; customerId?: string };
    expect(data.gatewayId).toBe('ch_1');
    expect(data.customerId).toBe('cus_1');
  });

  it('maps a chargeback onto payment.updated rather than a type nothing reads', () => {
    const event = makeDriver().parseWebhook(
      JSON.stringify({ id: 'hook_3', type: 'charge.chargedback', data: paidCharge }),
      {},
    );
    expect(event.type).toBe('payment.updated');
    expect((event.raw as { type: string }).type).toBe('charge.chargedback');
  });

  it('rejects a webhook without the configured Basic credentials', () => {
    const driver = makeDriver({ webhookUser: 'hook', webhookPassword: 's3cret' });
    const raw = JSON.stringify({ id: 'hook_1', type: 'charge.paid', data: paidCharge });
    expect(() => driver.parseWebhook(raw, {})).toThrow(/Missing webhook Basic credentials/);
    const wrong = `Basic ${Buffer.from('hook:nope', 'utf8').toString('base64')}`;
    expect(() => driver.parseWebhook(raw, { authorization: wrong })).toThrow(/password/);
  });

  it('accepts a webhook carrying the configured Basic credentials', () => {
    const driver = makeDriver({ webhookUser: 'hook', webhookPassword: 's3cret' });
    const raw = JSON.stringify({ id: 'hook_1', type: 'charge.paid', data: paidCharge });
    const header = `Basic ${Buffer.from('hook:s3cret', 'utf8').toString('base64')}`;
    expect(driver.parseWebhook(raw, { authorization: header }).type).toBe('payment.succeeded');
  });

  it('feeds the processor a row the billing store can save (driver → processor contract)', async () => {
    const driver = makeDriver();
    const event = driver.parseWebhook(
      JSON.stringify({ id: 'hook_1', type: 'charge.paid', data: paidCharge }),
      {},
    );
    const store = new InMemoryBillingStore();
    await new WebhookProcessor({ store, driver }).process(event);

    const row = await store.findPaymentByGatewayId('ch_1');
    expect(row?.status).toBe('paid');
    expect(row?.amount).toBe(1990);
    expect(row?.currency).toBe('brl');
  });
});
