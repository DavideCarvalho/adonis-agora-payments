import { describe, expect, it, vi } from 'vitest';
import { AsaasDriver } from '../src/drivers/asaas.js';

function makeDriver(webhookToken?: string) {
  if (webhookToken !== undefined) process.env.ASAAS_WEBHOOK_TOKEN = webhookToken;
  return new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
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
});
