import { describe, expect, it, vi } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { AsaasDriver } from '../src/drivers/asaas.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

/**
 * The four Asaas behaviours that were quietly wrong about money: an unpaginated invoice
 * listing reported as a whole customer, an `idempotencyKey` accepted and dropped on the one
 * call that moves money, a synthesized webhook event id that deduplicated legitimate repeat
 * events away forever, and a partial refund that reached a `default:` and did nothing.
 */

function driver() {
  // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined".
  delete process.env.ASAAS_WEBHOOK_TOKEN;
  // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined".
  delete process.env.ASAAS_WEBHOOK_ACCESS_TOKEN;
  return new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** One Asaas payment resource, in whatever shape the test needs. */
function asaasPayment(over: Record<string, unknown> = {}) {
  return {
    id: 'pay_1',
    customer: 'cus_1',
    value: 100,
    billingType: 'BOLETO',
    status: 'RECEIVED',
    dueDate: '2026-01-10',
    paymentDate: '2026-01-15',
    ...over,
  };
}

describe('AsaasDriver listInvoices paging', () => {
  it('follows every page instead of reporting the first one as the whole customer', async () => {
    // `GET /payments` is paged. Asking for it with no `limit`/`offset` and no loop returned
    // the newest page, and `payments:sync` printed a confident "N invoice(s) synced" over it.
    const page = (ids: string[], hasMore: boolean) =>
      json({ hasMore, data: ids.map((id) => asaasPayment({ id })) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(['pay_1', 'pay_2'], true))
      .mockResolvedValueOnce(page(['pay_3'], false));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const invoices = await driver().listInvoices('cus_1');

      expect(invoices.map((invoice) => invoice.gatewayId)).toEqual(['pay_1', 'pay_2', 'pay_3']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('offset=0');
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('offset=100');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops on a short page when the envelope states no hasMore', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: [asaasPayment()] }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await driver().listInvoices('cus_1')).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AsaasDriver charge idempotency', () => {
  it('returns the existing charge instead of creating a second one', async () => {
    // The failure this closes: an app passes `idempotencyKey: order.id` on the call that
    // moves money, believing it is protected, and the driver silently used the key as an
    // `externalReference` fallback and charged again.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [asaasPayment({ id: 'pay_first' })] }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const payment = await driver().charge({
        customerId: 'cus_1',
        amount: 10_000,
        method: 'boleto',
        idempotencyKey: 'order-1042',
      });

      expect(payment.gatewayId).toBe('pay_first');
      // ONE request, and it is the lookup. Nothing was POSTed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
      expect(String(url)).toContain('externalReference=order-1042');
      expect(String(url)).toContain('customer=cus_1');
      expect(init?.method ?? 'GET').toBe('GET');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates the charge when the key matches nothing yet', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json(asaasPayment({ id: 'pay_new', status: 'PENDING' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const payment = await driver().charge({
        customerId: 'cus_1',
        amount: 10_000,
        method: 'boleto',
        idempotencyKey: 'order-1042',
      });

      expect(payment.gatewayId).toBe('pay_new');
      const post = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      // The key travels as the external reference, which is what makes the lookup possible.
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({
        externalReference: 'order-1042',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not look anything up when no key was passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(asaasPayment({ status: 'PENDING' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await driver().charge({ customerId: 'cus_1', amount: 10_000, method: 'boleto' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AsaasDriver webhook event id', () => {
  it("uses Asaas' own event id", async () => {
    const event = driver().parseWebhook(
      JSON.stringify({
        id: 'evt_05b708f961d739ea7eba7e4db318f621&368604920',
        event: 'PAYMENT_UPDATED',
        payment: asaasPayment(),
      }),
      {},
    );
    expect(event.id).toBe('evt_05b708f961d739ea7eba7e4db318f621&368604920');
  });

  it('gives two different notifications about the SAME payment different ids', () => {
    // The bug, exactly: the id was `${event}-${paymentId}`, so the ledger treated the second
    // `PAYMENT_UPDATED` for a payment as a replay of the first and dropped it. A PARTIAL
    // REFUND arrives as that type.
    const asaas = driver();
    const first = asaas.parseWebhook(
      JSON.stringify({ event: 'PAYMENT_UPDATED', payment: asaasPayment({ value: 100 }) }),
      {},
    );
    const second = asaas.parseWebhook(
      JSON.stringify({ event: 'PAYMENT_UPDATED', payment: asaasPayment({ value: 90 }) }),
      {},
    );
    expect(first.id).not.toBe(second.id);
  });

  it('gives a redelivery of the same notification the same id, and never a random one', () => {
    const asaas = driver();
    const body = JSON.stringify({ event: 'PAYMENT_UPDATED', payment: asaasPayment() });
    expect(asaas.parseWebhook(body, {}).id).toBe(asaas.parseWebhook(body, {}).id);

    // Including the payload that names neither a payment nor a subscription — where the old
    // `Math.random()` fallback turned deduplication OFF entirely.
    const bare = JSON.stringify({ event: 'MYSTERY_EVENT' });
    const id = asaas.parseWebhook(bare, {}).id;
    expect(id).toBe(asaas.parseWebhook(bare, {}).id);
    expect(id).toMatch(/^asaas:MYSTERY_EVENT:[0-9a-f]{32}$/);
  });
});

describe('a partial refund end to end', () => {
  /**
   * `PAYMENT_PARTIALLY_REFUNDED` → `payment.updated` → a `default:` that returned a resolved
   * promise. The ledger row went to `processed`, the payment row was untouched, and revenue
   * stayed overstated by the refunded part forever.
   */
  it('records the refunded amount and leaves the charge standing', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
      paidAt: new Date('2026-01-15T00:00:00.000Z'),
    });

    const event = driver().parseWebhook(
      JSON.stringify({
        id: 'evt_partial',
        event: 'PAYMENT_PARTIALLY_REFUNDED',
        payment: asaasPayment({
          refunds: [
            { value: 10, status: 'DONE' },
            // Asked for and not settled — counting it would write off money still in the
            // account, and Asaas can deny a refund outright.
            { value: 25, status: 'PENDING' },
          ],
        }),
      }),
      {},
    );

    expect(event.type).toBe('payment.updated');
    await new WebhookProcessor({ store }).process(event as WebhookEvent);

    const row = await store.findPaymentByGatewayId('pay_1');
    // Integer minor units, and never divided: R$10 of a R$100 charge.
    expect(row?.refundedAmount).toBe(1000);
    // The charge itself is untouched — that is the whole reason this is not `payment.refunded`.
    expect(row?.amount).toBe(10_000);
    expect(row?.status).toBe('paid');
    expect(row?.paidAt).toEqual(new Date('2026-01-15T00:00:00.000Z'));
  });

  it('keeps a full refund at the whole amount', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
    });
    const event = driver().parseWebhook(
      JSON.stringify({
        id: 'evt_full',
        event: 'PAYMENT_REFUNDED',
        payment: asaasPayment({ status: 'REFUNDED' }),
      }),
      {},
    );
    await new WebhookProcessor({ store }).process(event as WebhookEvent);

    const row = await store.findPaymentByGatewayId('pay_1');
    expect(row?.status).toBe('refunded');
    expect(row?.refundedAmount).toBe(10_000);
  });

  it('an update never moves a row out of `disputed`', async () => {
    // Only `payment.dispute_closed` — which carries an outcome — resolves a chargeback. The
    // gateway's payment resource goes on saying RECEIVED while the bank holds the money.
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'disputed',
      amount: 10_000,
      currency: 'brl',
    });
    const event = driver().parseWebhook(
      JSON.stringify({ id: 'evt_restored', event: 'PAYMENT_RESTORED', payment: asaasPayment() }),
      {},
    );
    await new WebhookProcessor({ store }).process(event as WebhookEvent);

    expect((await store.findPaymentByGatewayId('pay_1'))?.status).toBe('disputed');
  });

  it('creates nothing for an update about a charge this install never recorded', async () => {
    const store = new InMemoryBillingStore();
    const event = driver().parseWebhook(
      JSON.stringify({ id: 'evt_unknown', event: 'PAYMENT_UPDATED', payment: asaasPayment() }),
      {},
    );
    await new WebhookProcessor({ store }).process(event as WebhookEvent);
    expect(await store.findPaymentByGatewayId('pay_1')).toBeNull();
  });
});
