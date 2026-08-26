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
    expect(payment.pixQrCode).toBe('iVBORw0KGgo=');
    expect(payment.pixCopiaECola).toContain('00020126580014');
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
});
