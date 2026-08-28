import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbacateDriver } from '../src/drivers/abacate.js';

const PUBLIC_KEY = 'test-public-key';

function makeDriver() {
  return new AbacateDriver({ config: () => ({}) }, { apiKey: 'test', publicKey: PUBLIC_KEY });
}

function sign(body: string): string {
  return createHmac('sha256', PUBLIC_KEY).update(body, 'utf8').digest('base64');
}

afterEach(() => vi.unstubAllGlobals());

describe('AbacateDriver', () => {
  it('charges via transparent checkout (POST /v2/transparents/create) and maps the PIX QR', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'tr_1',
        brCodeBase64: 'iVBORw0KGgo=',
        brCode: '00020126580014br.gov.bcb.pix0136a1f5f34a',
        url: 'https://pay.abacatepay.com/tr_1',
        expiresAt: '2026-09-02T12:00:00.000Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const driver = makeDriver();

    const payment = await driver.charge({
      customerId: 'cus_1',
      amount: 1990,
      method: 'pix',
      customer: { name: 'Jane Doe', taxId: '123.456.789-00' },
      externalReference: 'pay_1',
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('/v2/transparents/create');
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe('PIX');
    expect(body.data.amount).toBe(1990);
    expect(body.data.customer).toEqual({ name: 'Jane Doe', taxId: '123.456.789-00' });
    expect(body.data.externalId).toBe('pay_1');

    expect(payment.gatewayId).toBe('tr_1');
    expect(payment.pixQrCodeImage).toBe('iVBORw0KGgo=');
    expect(payment.pixCode).toContain('00020126580014');
    // Deprecated aliases stay populated with the same values for existing consumers.
    expect(payment.pixQrCode).toBe(payment.pixQrCodeImage);
    expect(payment.pixCopiaECola).toBe(payment.pixCode);
    expect(payment.hostedUrl).toBe('https://pay.abacatepay.com/tr_1');
    expect(payment.status).toBe('pending');
  });

  it('throws a clear error when transparent checkout lacks the payer name/taxId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'c1', name: 'X', email: 'x@y.com' }),
      }),
    );
    const driver = makeDriver();
    await expect(
      driver.charge({ customerId: 'cus_1', amount: 1990, method: 'pix' }),
    ).rejects.toThrow(/name \+ taxId/);
  });
  it('maps a completed checkout webhook to payment.succeeded', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({
      id: 'log_abc',
      event: 'checkout.completed',
      apiVersion: 2,
      data: { id: 'bill_1', status: 'PAID' },
    });
    const event = driver.parseWebhook(raw, { 'x-webhook-signature': sign(raw) });
    expect(event.id).toBe('log_abc');
    expect(event.type).toBe('payment.succeeded');
    expect(event.provider).toBe('abacate');
  });

  it('maps subscription.cancelled to subscription.canceled', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({ id: 'log_2', event: 'subscription.cancelled', data: {} });
    const event = driver.parseWebhook(raw, { 'x-webhook-signature': sign(raw) });
    expect(event.type).toBe('subscription.canceled');
  });

  it('rejects an invalid signature', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({ id: 'log_3', event: 'checkout.completed', data: {} });
    expect(() => driver.parseWebhook(raw, { 'x-webhook-signature': 'bad' })).toThrow(/signature/);
  });

  it('throws when the signature header is missing and a public key is set', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({ id: 'log_4', event: 'checkout.completed', data: {} });
    expect(() => driver.parseWebhook(raw, {})).toThrow(/signature/);
  });

  // ── Disputes ───────────────────────────────────────────────────────────────────────

  it('maps checkout.disputed and transparent.disputed to payment.disputed', () => {
    const driver = makeDriver();
    // "Disputa/chargeback aberta" — both spellings are real AbacatePay v2 events, one per
    // charge flow. They used to arrive as `payment.failed`, which files a chargeback as a
    // payment that never went through.
    for (const name of ['checkout.disputed', 'transparent.disputed']) {
      const raw = JSON.stringify({ id: `log_${name}`, event: name, data: { id: 'bill_1' } });
      const event = driver.parseWebhook(raw, { 'x-webhook-signature': sign(raw) });
      expect(event.type, name).toBe('payment.disputed');
    }
  });

  it('does not report a refund as a dispute, or a dispute as a refund', () => {
    const driver = makeDriver();
    const refund = JSON.stringify({ id: 'log_r', event: 'checkout.refunded', data: {} });
    expect(driver.parseWebhook(refund, { 'x-webhook-signature': sign(refund) }).type).toBe(
      'payment.refunded',
    );
    const dispute = JSON.stringify({ id: 'log_d', event: 'checkout.disputed', data: {} });
    expect(driver.parseWebhook(dispute, { 'x-webhook-signature': sign(dispute) }).type).toBe(
      'payment.disputed',
    );
  });

  it('has no dispute vocabulary beyond "opened", and invents none', () => {
    // AbacatePay's published event list is `checkout.*`, `transparent.*`, `subscription.*`,
    // `transfer.*` and `payout.*`. Nothing in it announces a dispute BEFORE it is filed and
    // nothing reports how one ended — so no AbacatePay event may become a
    // `payment.dispute_warning` or a `payment.dispute_closed`. The outcome of a dispute is
    // reconciliation work, not a webhook, and this test is what keeps a later edit from
    // quietly inventing one.
    const driver = makeDriver();
    for (const name of [
      'checkout.completed',
      'checkout.refunded',
      'checkout.disputed',
      'transparent.completed',
      'transparent.refunded',
      'transparent.disputed',
      'subscription.completed',
      'subscription.renewed',
      'subscription.cancelled',
    ]) {
      const raw = JSON.stringify({ id: `log_${name}`, event: name, data: { id: 'bill_1' } });
      const { type } = driver.parseWebhook(raw, { 'x-webhook-signature': sign(raw) });
      expect(type, name).not.toBe('payment.dispute_warning');
      expect(type, name).not.toBe('payment.dispute_closed');
    }
  });

  // ── Idempotency ────────────────────────────────────────────────────────────────────

  it('refuses an idempotencyKey on every operation AbacatePay cannot deduplicate', async () => {
    const driver = makeDriver();
    // AbacatePay documents no idempotency header or field on any endpoint — the only
    // request header on any of them is `Authorization`.
    await expect(driver.refund('bill_1', 500, { idempotencyKey: 'k' })).rejects.toThrow(
      /AbacatePay has no idempotency mechanism.*`refund`/s,
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
    await expect(makeDriver().refund('bill_1', 500, { idempotencyKey: 'k' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * AbacatePay's own words: "valores monetários são sempre em centavos (ex.: 10000 = R$
   * 100,00)". The driver passed the integer straight through on `charge()` — the v2
   * transparent endpoint — and ran `toDecimal` on `createCheckout` and `createSubscription`,
   * so a R$19,90 checkout was created for **19 centavos**.
   *
   * It disagreed with itself, on two code paths nobody compared. Pinned in both directions
   * and on every operation that sends money.
   */
  it.each([
    [
      'createCheckout',
      async (d: ReturnType<typeof makeDriver>) =>
        d.createCheckout({ customerId: 'cus_1', amount: 1990, successUrl: 'https://x' }),
    ],
    [
      'createSubscription',
      async (d: ReturnType<typeof makeDriver>) =>
        d.createSubscription({ customerId: 'cus_1', amount: 1990 }),
    ],
  ])('sends centavos to AbacatePay from %s', async (_name, call) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'bill_1', status: 'PENDING', amount: 1990, currency: 'brl' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await call(makeDriver());
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
      expect(body.amount).toBe(1990);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still refunds when no key is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // Centavos. AbacatePay documents every monetary value that way; this fixture said
      // `19.9` and the driver divided, so the two agreed with each other and with nothing else.
      json: async () => ({ id: 'bill_1', status: 'REFUNDED', amount: 1990, currency: 'brl' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const refund = await makeDriver().refund('bill_1');
    expect(refund.status).toBe('succeeded');
    expect(refund.amount).toEqual({ amount: 1990, currency: 'brl' });
  });
});
