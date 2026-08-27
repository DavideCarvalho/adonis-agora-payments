import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { InfinitePayDriver } from '../src/drivers/infinitepay.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

function makeDriver(config: Record<string, unknown> = {}) {
  return new InfinitePayDriver({ config: () => ({}) }, { handle: 'minha_loja', ...config });
}

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

const webhookBody = {
  invoice_slug: 'abc123',
  amount: 1000,
  paid_amount: 1010,
  installments: 1,
  capture_method: 'pix',
  transaction_nsu: 'tx-uuid',
  order_nsu: 'order_local_1',
  receipt_url: 'https://comprovante.example/123',
};

describe('InfinitePayDriver', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to boot without a handle, naming both places to set it', () => {
    vi.stubEnv('INFINITEPAY_HANDLE', '');
    try {
      expect(() => new InfinitePayDriver({ config: () => ({}) })).toThrow(
        /requires handle.*INFINITEPAY_HANDLE.*payments\.infinitepay/s,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('creates a checkout link with the handle and no auth header', async () => {
    const fetchMock = stubFetch({ url: 'https://checkout.infinitepay.com.br/minha_loja?lenc=x' });
    try {
      const session = await makeDriver({
        webhookUrl: 'https://app.example.com/payments/webhook/infinitepay',
      }).createCheckout({
        amount: 1500,
        successUrl: 'https://app.example.com/thanks',
        cancelUrl: 'https://app.example.com/cancel',
        description: 'Curso',
        idempotencyKey: 'order_local_1',
      });

      const { url, headers, body } = lastCall(fetchMock);
      expect(url).toBe('https://api.checkout.infinitepay.io/links');
      // The endpoint is public: the handle is the identity, and no credential is sent.
      expect(headers.Authorization).toBeUndefined();
      expect(body).toMatchObject({
        handle: 'minha_loja',
        order_nsu: 'order_local_1',
        redirect_url: 'https://app.example.com/thanks',
        webhook_url: 'https://app.example.com/payments/webhook/infinitepay',
      });
      // Prices are integer centavos, exactly like Money — no decimal conversion.
      expect(body.items).toEqual([{ quantity: 1, price: 1500, description: 'Curso' }]);
      // The API has no cancel destination; nothing may be invented for cancelUrl.
      expect(JSON.stringify(body)).not.toContain('app.example.com/cancel');

      // The response carries only a url, so order_nsu is the id we can actually track.
      expect(session.gatewayId).toBe('order_local_1');
      expect(session.url).toBe('https://checkout.infinitepay.com.br/minha_loja?lenc=x');
      expect(session.amount).toEqual({ amount: 1500, currency: 'brl' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('round-trips externalReference through order_nsu: in on the link, out of the webhook', async () => {
    const fetchMock = stubFetch({ url: 'https://checkout.infinitepay.com.br/minha_loja?lenc=x' });
    let session: Awaited<ReturnType<InfinitePayDriver['createCheckout']>>;
    let sent: Record<string, unknown>;
    try {
      session = await makeDriver().createCheckout({
        amount: 1500,
        successUrl: 'https://app.example.com/thanks',
        externalReference: 'order:42',
        // The reference wins over both of these — it is the field that routes.
        idempotencyKey: 'idem_1',
        metadata: { orderNsu: 'ignored' },
      });
      sent = lastCall(fetchMock).body;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.order_nsu).toBe('order:42');
    expect(session.gatewayId).toBe('order:42');

    // Out: order_nsu is the only field InfinitePay echoes, and it lands on externalReference.
    const event = makeDriver().parseWebhook(
      JSON.stringify({ ...webhookBody, order_nsu: 'order:42' }),
      {},
    );
    expect((event.data as { externalReference?: string }).externalReference).toBe('order:42');
  });

  it('refuses a cart whose lines do not add up to the checkout amount', async () => {
    await expect(
      makeDriver().createCheckout({
        amount: 1500,
        successUrl: 'https://app.example.com/thanks',
        metadata: {
          items: [
            { quantity: 1, price: 1000, description: 'Curso' },
            { quantity: 1, price: 400, description: 'Frete' },
          ],
        },
      }),
    ).rejects.toThrow(/add up to 1400 but the checkout amount is 1500/);
  });

  it('refuses a subscription checkout: InfinitePay has no recurring API', async () => {
    await expect(
      makeDriver().createCheckout({
        amount: 1500,
        successUrl: 'https://app.example.com/thanks',
        planId: 'plan_pro',
      }),
    ).rejects.toThrow(/no documented subscription API/);
  });

  it('throws from every operation the gateway does not expose', async () => {
    const driver = makeDriver();
    await expect(driver.charge({ amount: 100, method: 'pix' })).rejects.toThrow(
      /no documented server-side charge API/,
    );
    await expect(driver.refund('tx-1')).rejects.toThrow(/no documented refund API/);
    await expect(driver.createCustomer({ name: 'A' })).rejects.toThrow(/no customer API/);
    await expect(driver.findCustomer('cus_1')).rejects.toThrow(/no customer API/);
    await expect(driver.updateCustomer('cus_1', {})).rejects.toThrow(/no customer API/);
    await expect(driver.createSubscription({ customerId: 'c', planId: 'p' })).rejects.toThrow(
      /no documented subscription API/,
    );
    await expect(driver.cancelSubscription('sub_1')).rejects.toThrow(/subscription API/);
    await expect(driver.updateSubscription('sub_1', {})).rejects.toThrow(/subscription API/);
    await expect(driver.findSubscription('sub_1')).rejects.toThrow(/subscription API/);
    await expect(driver.listInvoices('cus_1')).rejects.toThrow(/no invoice or listing API/);
  });

  it('refuses findPayment and names the three ids payment_check needs', async () => {
    await expect(makeDriver().findPayment('order_local_1')).rejects.toThrow(
      /order_nsu \+ transaction_nsu \+ slug/,
    );
  });

  it('declares no refunds, invoices or subscriptions', () => {
    expect(makeDriver().capabilities).toEqual({
      refunds: false,
      invoices: false,
      subscriptions: false,
    });
  });

  it('confirms a payment through payment_check with all four ids', async () => {
    const fetchMock = stubFetch({
      success: true,
      paid: true,
      amount: 1500,
      paid_amount: 1510,
      installments: 1,
      capture_method: 'credit_card',
    });
    try {
      const payment = await makeDriver().checkPayment({
        orderNsu: 'order_local_1',
        transactionNsu: 'tx-uuid',
        slug: 'abc123',
      });
      const { url, body } = lastCall(fetchMock);
      expect(url).toBe('https://api.checkout.infinitepay.io/payment_check');
      expect(body).toEqual({
        handle: 'minha_loja',
        order_nsu: 'order_local_1',
        transaction_nsu: 'tx-uuid',
        slug: 'abc123',
      });
      expect(payment?.status).toBe('paid');
      expect(payment?.method).toBe('card');
      expect(payment?.amount).toEqual({ amount: 1510, currency: 'brl' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an unpaid check as pending rather than paid', async () => {
    stubFetch({ success: true, paid: false, amount: 1500 });
    try {
      const payment = await makeDriver().checkPayment({
        orderNsu: 'order_local_1',
        transactionNsu: 'tx-uuid',
        slug: 'abc123',
      });
      expect(payment?.status).toBe('pending');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns null when payment_check does not know the payment', async () => {
    stubFetch({ success: false, message: 'Not found' });
    try {
      const payment = await makeDriver().checkPayment({
        orderNsu: 'nope',
        transactionNsu: 'nope',
        slug: 'nope',
      });
      expect(payment).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('normalizes the approval webhook, keying on the transaction and echoing order_nsu', () => {
    const event = makeDriver().parseWebhook(JSON.stringify(webhookBody), {});
    expect(event.type).toBe('payment.succeeded');
    // No event id exists in the payload; the transaction is the idempotency key.
    expect(event.id).toBe('tx-uuid');
    const data = event.data as { gatewayId: string; amount: number; externalReference?: string };
    expect(data.gatewayId).toBe('tx-uuid');
    // paid_amount wins over amount, and both are already centavos.
    expect(data.amount).toBe(1010);
    expect(data.externalReference).toBe('order_local_1');
  });

  it('accepts an unsigned webhook — there is nothing to verify — whatever headers arrive', () => {
    // Documented reality, pinned deliberately: InfinitePay sends no signature header, so an
    // event out of parseWebhook is a claim, not proof. Confirm it with checkPayment().
    const driver = makeDriver();
    const withoutHeaders = driver.parseWebhook(JSON.stringify(webhookBody), {});
    const withGarbage = driver.parseWebhook(JSON.stringify(webhookBody), {
      'x-webhook-signature': 'nonsense',
    });
    expect(withoutHeaders.type).toBe('payment.succeeded');
    expect(withGarbage.type).toBe('payment.succeeded');
  });

  it('feeds the processor a row the billing store can save (driver → processor contract)', async () => {
    const driver = makeDriver();
    const event = driver.parseWebhook(JSON.stringify(webhookBody), {});
    const store = new InMemoryBillingStore();
    await new WebhookProcessor({ store, driver }).process(event);

    const row = await store.findPaymentByGatewayId('tx-uuid');
    expect(row?.status).toBe('paid');
    expect(row?.amount).toBe(1010);
    expect(row?.currency).toBe('brl');
  });
});
