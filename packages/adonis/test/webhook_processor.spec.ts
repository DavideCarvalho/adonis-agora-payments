import { describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'evt_1',
    provider: 'stripe',
    type: 'payment.succeeded',
    data: { gatewayId: 'pi_1', amount: 1000, currency: 'brl' },
    raw: { id: 'evt_1' },
    ...overrides,
  };
}

describe('WebhookProcessor', () => {
  it('persists a succeeded payment', async () => {
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
    const result = await processor.process(makeEvent());
    expect(result).toBe(true);
    const payment = await store.findPaymentByGatewayId('pi_1');
    expect(payment?.status).toBe('paid');
    expect(payment?.amount).toBe(1000);
    expect(payment?.currency).toBe('brl');
  });

  it('is idempotent — replays are skipped', async () => {
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
    await processor.process(makeEvent());
    const second = await processor.process(makeEvent());
    expect(second).toBe(false);
    expect(store.payments.size).toBe(1);
  });

  it('persists a failed payment', async () => {
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
    await processor.process(makeEvent({ type: 'payment.failed' }));
    const payment = await store.findPaymentByGatewayId('pi_1');
    expect(payment?.status).toBe('failed');
  });

  it('syncs subscription.created into the store', async () => {
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
    await processor.process(
      makeEvent({
        type: 'subscription.created',
        data: { gatewayId: 'sub_1', customerId: 'cus_1', status: 'active', planId: 'price_x' },
      }),
    );
    const subscription = await store.findSubscriptionByGatewayId('sub_1');
    expect(subscription?.status).toBe('active');
    expect(subscription?.planId).toBe('price_x');
  });

  it('marks the ledger failed and rethrows when a handler throws', async () => {
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({
      store,
      driver: new FakePaymentsDriver(),
      handlers: {
        'payment.succeeded': () => {
          throw new Error('boom');
        },
      },
    });
    await expect(processor.process(makeEvent())).rejects.toThrow('boom');
    const ledger = [...store.webhookEvents.values()][0]!;
    expect(ledger.status).toBe('failed');
    expect(ledger.error).toBe('boom');
  });

  it('runs app-registered handlers after the built-in sync', async () => {
    const store = new InMemoryBillingStore();
    const calls: string[] = [];
    const processor = new WebhookProcessor({
      store,
      driver: new FakePaymentsDriver(),
      handlers: {
        'payment.succeeded': () => {
          calls.push('handler');
        },
      },
    });
    await processor.process(makeEvent());
    expect(calls).toEqual(['handler']);
  });
});
