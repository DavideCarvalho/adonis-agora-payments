import { describe, expect, it, vi } from 'vitest';

const createClientMock = vi.hoisted(() => ({
  create: vi.fn(),
  subscription: { create: vi.fn(), get: vi.fn() },
  charge: { create: vi.fn() },
  customer: { create: vi.fn() },
}));

vi.mock('@woovi/node-sdk', () => ({
  createClient: () => createClientMock,
}));

import { WooviDriver } from '../src/drivers/woovi.js';

describe('WooviDriver', () => {
  it('maps PIX_AUTOMATIC_APPROVED to subscription.created', () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({
      event: 'PIX_AUTOMATIC_APPROVED',
      correlationID: '6f4131ea',
      value: 100,
      status: 'ACTIVE',
      globalID: 'UGF5bWVudFN1YnNjcmlwdGlvbjox',
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('subscription.created');
    expect(event.id).toBe('UGF5bWVudFN1YnNjcmlwdGlvbjox');
    const data = event.data as { correlationID: string };
    expect(data.correlationID).toBe('6f4131ea');
  });

  it('maps PIX_AUTOMATIC_COBR_COMPLETED to payment.succeeded', () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({
      event: 'PIX_AUTOMATIC_COBR_COMPLETED',
      installmentNumber: 1,
      value: 100,
      status: 'COMPLETED',
      globalID: 'UGF5bWVudFN1YnNjcmlwdGlvbkluc3RhbGxtZW50OjE=',
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
  });

  it('maps CHARGE_COMPLETED to payment.succeeded', () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({ event: 'CHARGE_COMPLETED', id: 'charge_1' });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.succeeded');
  });

  it('rejects a webhook with a mismatched app id', () => {
    process.env.WOOVI_APP_ID = 'app-real';
    try {
      const driver = new WooviDriver({ config: () => ({}) }, { appId: 'app-real' });
      const raw = JSON.stringify({ event: 'CHARGE_COMPLETED' });
      expect(() => driver.parseWebhook(raw, { app_id: 'app-other' })).toThrow(/app id/);
    } finally {
      process.env.WOOVI_APP_ID = undefined;
    }
  });

  it('creates a Pix Automático subscription with the payer customer and pay-on-approval (DYNAMIC)', async () => {
    createClientMock.subscription.create.mockResolvedValue({
      subscription: {
        globalID: 'UGF5bWVudFN1YnNjcmlwdGlvbjox',
        status: 'ACTIVE',
        value: 49.9,
        dayGenerateCharge: 1,
      },
    });
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });

    const subscription = await driver.createSubscription({
      customerId: 'cus_1',
      amount: 4990,
      cycle: 'MONTHLY',
      startDate: '2026-09-15',
      customer: { name: 'Jane Doe', email: 'jane@example.com', taxId: '123.456.789-00' },
    });

    const payload = createClientMock.subscription.create.mock.calls[0]![0];
    expect(payload).toMatchObject({
      customer: { name: 'Jane Doe', email: 'jane@example.com', taxID: '12345678900' },
      value: 49.9,
      chargeType: 'DYNAMIC',
      frequency: 'MONTHLY',
    });
    expect(payload.dayGenerateCharge).toBeGreaterThanOrEqual(1);
    expect(subscription.gatewayId).toBe('UGF5bWVudFN1YnNjcmlwdGlvbjox');
  });

  it('throws a clear error when a Woovi subscription lacks the payer name/taxId', async () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    await expect(driver.createSubscription({ customerId: 'cus_1', amount: 4990 })).rejects.toThrow(
      /name \+ taxId/,
    );
  });
});
