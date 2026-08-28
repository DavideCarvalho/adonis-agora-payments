import { describe, expect, it, vi } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { AsaasDriver } from '../src/drivers/asaas.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

function makeDriver(webhookToken?: string) {
  if (webhookToken !== undefined) process.env.ASAAS_WEBHOOK_TOKEN = webhookToken;
  return new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
}

/** An Asaas payment payload in whatever status the test needs. */
function paymentIn(status: string) {
  return {
    id: 'pay_cb',
    customer: 'cus_1',
    value: 19.9,
    billingType: 'CREDIT_CARD',
    status,
    dueDate: '2026-01-10',
    externalReference: 'order_local_1',
  };
}

/**
 * A driver with NO webhook token configured. `makeDriver(token)` writes the token into
 * `process.env`, where it outlives the test that asked for it — so the webhook tests below
 * build their own driver with the env cleared rather than inheriting a token from
 * whichever test ran first.
 */
function makeOpenDriver() {
  // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined".
  delete process.env.ASAAS_WEBHOOK_TOKEN;
  // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined".
  delete process.env.ASAAS_WEBHOOK_ACCESS_TOKEN;
  return new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('AsaasDriver', () => {
  it('maps PAYMENT_RECEIVED to payment.succeeded', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_1',
        customer: 'cus_1',
        value: 19.9,
        billingType: 'PIX',
        status: 'RECEIVED',
        dueDate: '2026-01-10',
      },
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
    expect(event.id).toContain('pay_1');
    const data = event.data as { gatewayId: string; amount: number };
    expect(data.gatewayId).toBe('pay_1');
    expect(data.amount).toBe(1990);
  });

  it('maps SUBSCRIPTION_CREATED to subscription.created', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({
      event: 'SUBSCRIPTION_CREATED',
      subscription: {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'ACTIVE',
        billingType: 'PIX',
        value: 49.9,
        cycle: 'MONTHLY',
        nextDueDate: '2026-02-01',
      },
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('subscription.created');
  });

  it('rejects a webhook with an invalid token', () => {
    const driver = makeDriver('secret-token');
    const raw = JSON.stringify({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'p', status: 'RECEIVED', value: 1, billingType: 'PIX', dueDate: '2026-01-01' },
    });
    expect(() => driver.parseWebhook(raw, { 'asaas-access-token': 'wrong' })).toThrow(/token/);
  });

  it('accepts a webhook with the correct token', () => {
    const driver = makeDriver('secret-token');
    const raw = JSON.stringify({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'p', status: 'RECEIVED', value: 1, billingType: 'PIX', dueDate: '2026-01-01' },
    });
    const event = driver.parseWebhook(raw, { 'asaas-access-token': 'secret-token' });
    expect(event.type).toBe('payment.succeeded');
  });

  it('posts a charge via fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'pay_1',
        customer: 'cus_1',
        value: 10,
        billingType: 'PIX',
        status: 'PENDING',
        dueDate: '2026-01-10',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const driver = makeDriver();
      const payment = await driver.charge({ customerId: 'cus_1', amount: 1000, method: 'pix' });
      expect(payment.gatewayId).toBe('pay_1');
      expect(payment.status).toBe('pending');
      expect(payment.amount).toEqual({ amount: 1000, currency: 'brl' });
      expect(payment.method).toBe('pix');
      // Verify the request used the sandbox URL and PIX billing type.
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toContain('api-sandbox.asaas.com');
      expect(JSON.parse(String(init.body))).toMatchObject({ billingType: 'PIX', value: 10 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps externalReference (preferred over idempotencyKey) to the Asaas externalReference field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'pay_2',
        customer: 'cus_1',
        value: 10,
        billingType: 'PIX',
        status: 'PENDING',
        dueDate: '2026-01-10',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const driver = makeDriver();
      await driver.charge({
        customerId: 'cus_1',
        amount: 1000,
        method: 'pix',
        externalReference: 'pay_local_1',
        idempotencyKey: 'idem_1',
      });
      const [_, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({ externalReference: 'pay_local_1' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('createSubscription sends card + externalReference for transparent checkout', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'sub_1',
        customer: 'cus_1',
        value: 49.9,
        billingType: 'CREDIT_CARD',
        status: 'PENDING',
        cycle: 'MONTHLY',
        nextDueDate: '2026-02-01',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const driver = makeDriver();
      await driver.createSubscription({
        customerId: 'cus_1',
        planId: 'tier:x',
        amount: 4990,
        method: 'credit_card',
        startDate: '2026-01-01',
        externalReference: 'sub:local_1',
        card: {
          token: 'tok_123',
          holder: {
            name: 'A',
            email: 'a@b.com',
            cpfCnpj: '123',
            postalCode: '000',
            addressNumber: '1',
            phone: '999',
          },
          remoteIp: '1.2.3.4',
        },
      });
      const [_, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        billingType: 'CREDIT_CARD',
        creditCardToken: 'tok_123',
        creditCardHolderInfo: { name: 'A', cpfCnpj: '123' },
        remoteIp: '1.2.3.4',
        externalReference: 'sub:local_1',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a marketplace split onto the charge', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'pay_3',
        customer: 'cus_1',
        value: 100,
        billingType: 'PIX',
        status: 'PENDING',
        dueDate: '2026-01-10',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const driver = makeDriver();
      await driver.charge({
        customerId: 'cus_1',
        amount: 10000,
        method: 'pix',
        split: [
          { walletId: 'wal_owner', percentualValue: 70 },
          { walletId: 'wal_partner', fixedValue: 3000 },
        ],
      });
      const [_, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        split: [
          { walletId: 'wal_owner', percentualValue: 70 },
          { walletId: 'wal_partner', fixedValue: 30 },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Disputes ───────────────────────────────────────────────────────────────────────

  it('maps PAYMENT_CHARGEBACK_REQUESTED to payment.disputed', () => {
    const event = makeOpenDriver().parseWebhook(
      JSON.stringify({
        event: 'PAYMENT_CHARGEBACK_REQUESTED',
        payment: paymentIn('CHARGEBACK_REQUESTED'),
      }),
      {},
    );
    expect(event.type).toBe('payment.disputed');
    // The processor needs the money and the id; `externalReference` routes it back.
    expect(event.data).toMatchObject({
      gatewayId: 'pay_cb',
      amount: 1990,
      currency: 'brl',
      externalReference: 'order_local_1',
    });
  });

  it('carries the chargeback deadline, id and reason onto the dispute', () => {
    // `deadlineToSendDisputeDocuments` is the only response deadline Asaas publishes
    // anywhere, and it was sitting unread on the payment's `chargeback` object. A dispute
    // answered after it is a dispute lost by default.
    const event = makeOpenDriver().parseWebhook(
      JSON.stringify({
        event: 'PAYMENT_CHARGEBACK_REQUESTED',
        payment: {
          ...paymentIn('CHARGEBACK_REQUESTED'),
          chargeback: {
            id: 'chb_1',
            status: 'REQUESTED',
            reason: 'FRAUD',
            disputeStartDate: '2026-02-01',
            deadlineToSendDisputeDocuments: '2026-02-11',
            value: 19.9,
          },
        },
      }),
      {},
    );
    expect(event.data).toMatchObject({
      gatewayId: 'pay_cb',
      disputeId: 'chb_1',
      reason: 'FRAUD',
      actionableUntil: new Date('2026-02-11').toISOString(),
    });
  });

  it('still normalizes a chargeback whose payload carries no chargeback object', () => {
    // No published Asaas webhook example shows the `chargeback` object, so its absence is
    // an event without a deadline — never a malformed one the processor throws on.
    const data = makeOpenDriver().parseWebhook(
      JSON.stringify({
        event: 'PAYMENT_CHARGEBACK_REQUESTED',
        payment: paymentIn('CHARGEBACK_REQUESTED'),
      }),
      {},
    ).data as Record<string, unknown>;
    expect(data.actionableUntil).toBeUndefined();
    expect(data.disputeId).toBeUndefined();
  });

  it('leaves the contested step as payment.updated, not as a second dispute', () => {
    // Documents submitted: movement inside an open dispute, not a resolution.
    const event = makeOpenDriver().parseWebhook(
      JSON.stringify({
        event: 'PAYMENT_CHARGEBACK_DISPUTE',
        payment: {
          ...paymentIn('CHARGEBACK_DISPUTE'),
          chargeback: { id: 'chb_1', deadlineToSendDisputeDocuments: '2026-02-11' },
        },
      }),
      {},
    );
    expect(event.type).toBe('payment.updated');
    expect((event.raw as { event: string }).event).toBe('PAYMENT_CHARGEBACK_DISPUTE');
    // An update is not a dispute event, so it announces neither an outcome nor a deadline.
    expect(event.data).not.toHaveProperty('outcome');
    expect(event.data).not.toHaveProperty('actionableUntil');
  });

  it('closes the dispute as won on PAYMENT_AWAITING_CHARGEBACK_REVERSAL', () => {
    // Asaas' own words: "Disputa vencida, aguardando repasse da adquirente" — in the
    // English docs, "Dispute won, awaiting acquirer settlement". That is an outcome.
    const event = makeOpenDriver().parseWebhook(
      JSON.stringify({
        event: 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
        payment: {
          ...paymentIn('AWAITING_CHARGEBACK_REVERSAL'),
          chargeback: { id: 'chb_1', status: 'REVERSED' },
        },
      }),
      {},
    );
    expect(event.type).toBe('payment.dispute_closed');
    expect(event.data).toMatchObject({ gatewayId: 'pay_cb', disputeId: 'chb_1', outcome: 'won' });
  });

  it('returns a won dispute to paid through the processor', async () => {
    const driver = makeOpenDriver();
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_cb',
      provider: 'asaas',
      status: 'disputed',
      amount: 1990,
      currency: 'brl',
      customerId: 'cus_1',
    });
    await new WebhookProcessor({ store, driver }).process(
      driver.parseWebhook(
        JSON.stringify({
          event: 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
          payment: paymentIn('AWAITING_CHARGEBACK_REVERSAL'),
        }),
        {},
      ),
    );
    // `revenue()` sums rows that are `paid`; leaving a won dispute at `disputed` writes off
    // money that is coming back.
    expect((await store.findPaymentByGatewayId('pay_cb'))?.status).toBe('paid');
  });

  it('sends no dispute warning, because Asaas has no pre-chargeback event', () => {
    // Asaas' payment event list has no fraud alert, no retrieval request and no
    // "chargeback incoming" notification: the first you hear of one is the chargeback.
    const driver = makeOpenDriver();
    for (const name of [
      'PAYMENT_CHARGEBACK_REQUESTED',
      'PAYMENT_CHARGEBACK_DISPUTE',
      'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
    ]) {
      const event = driver.parseWebhook(
        JSON.stringify({ event: name, payment: paymentIn('CHARGEBACK_REQUESTED') }),
        {},
      );
      expect(event.type, name).not.toBe('payment.dispute_warning');
    }
  });

  it('does not mistake a negativação for a dispute', () => {
    // `PAYMENT_DUNNING_*` is Serasa-style credit-bureau registration of a defaulting
    // payer — the opposite end of the story from money being taken back.
    const event = makeOpenDriver().parseWebhook(
      JSON.stringify({ event: 'PAYMENT_DUNNING_RECEIVED', payment: paymentIn('DUNNING_RECEIVED') }),
      {},
    );
    expect(event.type).not.toBe('payment.disputed');
  });

  it('flips a stored paid payment to disputed through the processor', async () => {
    const driver = makeOpenDriver();
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_cb',
      provider: 'asaas',
      status: 'paid',
      amount: 1990,
      currency: 'brl',
      customerId: 'cus_1',
    });
    const event = driver.parseWebhook(
      JSON.stringify({
        event: 'PAYMENT_CHARGEBACK_REQUESTED',
        payment: paymentIn('CHARGEBACK_REQUESTED'),
      }),
      {},
    );
    await new WebhookProcessor({ store, driver }).process(event);

    const row = await store.findPaymentByGatewayId('pay_cb');
    expect(row?.status).toBe('disputed');
    // The dispute payload has no customer; the row must keep the one it had.
    expect(row?.customerId).toBe('cus_1');
  });

  it('reports a charged-back payment as disputed rather than pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(paymentIn('CHARGEBACK_REQUESTED'))),
    );
    try {
      expect((await makeDriver().findPayment('pay_cb'))?.status).toBe('disputed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a won-but-unsettled chargeback the same way its webhook does', async () => {
    // `AWAITING_CHARGEBACK_REVERSAL` is Asaas saying the dispute was won and the acquirer
    // has not transferred yet. The webhook closes it as `won`, which puts the row back to
    // `paid`; a `findPayment` that answered `disputed` for the same state would contradict
    // the driver's own webhook.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(paymentIn('AWAITING_CHARGEBACK_REVERSAL'))),
    );
    try {
      expect((await makeDriver().findPayment('pay_cb'))?.status).toBe('paid');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── Authorization vs capture ───────────────────────────────────────────────────────

  it('reports an authorizeOnly card payment as authorized, not paid and not pending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(paymentIn('AUTHORIZED'))));
    try {
      // The money is held for three days and captured through
      // `POST /payments/{id}/captureAuthorizedPayment`. `pending` understated it; `paid`
      // would grant access against a hold that expires.
      expect((await makeDriver().findPayment('pay_cb'))?.status).toBe('authorized');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps PAYMENT_AUTHORIZED to payment.updated — there is no canonical authorization event', () => {
    const event = makeOpenDriver().parseWebhook(
      JSON.stringify({ event: 'PAYMENT_AUTHORIZED', payment: paymentIn('AUTHORIZED') }),
      {},
    );
    expect(event.type).toBe('payment.updated');
  });

  // ── Statuses Asaas has and the driver did not ──────────────────────────────────────

  /**
   * Every one of these fell through to the `pending` default. Two of them are money that
   * ARRIVED, which is the expensive direction: a customer who paid in cash at the counter,
   * or who settled through the credit bureau after being negativado, read as never having
   * paid — and stayed locked out of what they had bought.
   */
  it.each([
    ['RECEIVED_IN_CASH', 'paid'],
    ['DUNNING_RECEIVED', 'paid'],
    ['REFUND_REQUESTED', 'paid'],
    ['REFUND_IN_PROGRESS', 'paid'],
    ['DUNNING_REQUESTED', 'failed'],
    ['AWAITING_RISK_ANALYSIS', 'pending'],
  ])('reports an Asaas %s payment as %s', async (asaasStatus, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(paymentIn(asaasStatus))));
    try {
      expect((await makeDriver().findPayment('pay_cb'))?.status).toBe(expected);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('syncs a negativação payment through to paid, not just to a known event name', async () => {
    const driver = makeOpenDriver();
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_cb',
      provider: 'asaas',
      status: 'pending',
      amount: 1990,
      currency: 'brl',
      customerId: 'cus_1',
    });

    const event = driver.parseWebhook(
      JSON.stringify({
        event: 'PAYMENT_DUNNING_RECEIVED',
        payment: paymentIn('DUNNING_RECEIVED'),
      }),
      {},
    );
    await new WebhookProcessor({ store, driver }).process(event);

    expect((await store.findPaymentByGatewayId('pay_cb'))?.status).toBe('paid');
  });

  it.each([
    ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'FAILED'],
    ['PAYMENT_REPROVED_BY_RISK_ANALYSIS', 'FAILED'],
  ])('maps %s to payment.failed', (event, status) => {
    expect(
      makeOpenDriver().parseWebhook(JSON.stringify({ event, payment: paymentIn(status) }), {}).type,
    ).toBe('payment.failed');
  });

  it('does not report a partial refund as a refund', () => {
    // `payment.refunded` overwrites the stored row's status with `refunded` AND its amount
    // with the refunded amount, and `revenue()` sums rows that are `paid` — so routing a
    // R$10 refund on a R$100 charge here would drop R$90 of revenue rather than subtract
    // R$10. Until the tables carry a refunded amount, an update is the arithmetic-safe half.
    const event = makeOpenDriver().parseWebhook(
      JSON.stringify({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: paymentIn('RECEIVED') }),
      {},
    );
    expect(event.type).toBe('payment.updated');
  });

  // ── Idempotency ────────────────────────────────────────────────────────────────────

  it('refuses an idempotencyKey on every operation Asaas cannot deduplicate', async () => {
    const driver = makeDriver();
    // Asaas documents no idempotency header or body field on any endpoint. Accepting the
    // key and dropping it would turn a caller's retry guarantee into a second refund.
    await expect(driver.refund('pay_1', 500, { idempotencyKey: 'k' })).rejects.toThrow(
      /Asaas has no idempotency mechanism.*`refund`/s,
    );
    await expect(driver.createCustomer({ idempotencyKey: 'k', name: 'A' })).rejects.toThrow(
      /`createCustomer`/,
    );
    await expect(
      driver.createSubscription({ idempotencyKey: 'k', customerId: 'cus_1', planId: 'p' }),
    ).rejects.toThrow(/`createSubscription`/);
    await expect(driver.updateSubscription('sub_1', { idempotencyKey: 'k' })).rejects.toThrow(
      /`updateSubscription`/,
    );
  });

  it('refuses before it reaches the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(makeDriver().refund('pay_1', 500, { idempotencyKey: 'k' })).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still refunds when no key is given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...paymentIn('REFUNDED'), value: 19.9 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const refund = await makeDriver().refund('pay_cb');
      expect(refund.status).toBe('succeeded');
      expect(refund.amount).toEqual({ amount: 1990, currency: 'brl' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
