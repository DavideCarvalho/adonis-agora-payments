import { describe, expect, it } from 'vitest';
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
});
