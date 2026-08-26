import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AbacateDriver } from '../src/drivers/abacate.js';

const PUBLIC_KEY = 'test-public-key';

function makeDriver() {
  return new AbacateDriver({ config: () => ({}) }, { apiKey: 'test', publicKey: PUBLIC_KEY });
}

function sign(body: string): string {
  return createHmac('sha256', PUBLIC_KEY).update(body, 'utf8').digest('base64');
}

describe('AbacateDriver', () => {
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
