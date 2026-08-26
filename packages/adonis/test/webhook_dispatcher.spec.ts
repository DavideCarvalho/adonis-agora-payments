import { describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

function makeEvent(): WebhookEvent {
  return {
    id: 'evt_1',
    provider: 'stripe',
    type: 'payment.succeeded',
    data: { gatewayId: 'pi_1', amount: 1000, currency: 'brl' },
    raw: { id: 'evt_1' },
  };
}

describe('WebhookDispatcher', () => {
  it('processes in-process by default (auto mode without durable)', async () => {
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
    const dispatcher = new WebhookDispatcher({
      processor,
      durableAvailable: async () => false,
    });
    const result = await dispatcher.dispatch(makeEvent());
    expect(result.runId).toBeUndefined();
    const payment = await store.findPaymentByGatewayId('pi_1');
    expect(payment?.status).toBe('paid');
  });

  it('retries in the background with exponential backoff after a failure', async () => {
    const store = new InMemoryBillingStore();
    let attempts = 0;
    const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
    // Fail the first call, succeed the retry.
    const original = processor.process.bind(processor);
    const spy = vi.spyOn(processor, 'process').mockImplementation(async (event) => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return original(event);
    });
    const dispatcher = new WebhookDispatcher({
      processor,
      retries: { max: 3, baseDelayMs: 5 },
      durableAvailable: async () => false,
    });
    await dispatcher.dispatch(makeEvent());
    expect(attempts).toBe(1); // first attempt failed
    // Wait for the background retry to land.
    await vi.waitFor(() => {
      expect(attempts).toBeGreaterThanOrEqual(2);
    });
    expect(spy).toHaveBeenCalled();
  });

  it('forces in-process when mode is set', async () => {
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
    const dispatcher = new WebhookDispatcher({ processor, mode: 'in-process' });
    expect(dispatcher.mode).toBe('in-process');
    await dispatcher.dispatch(makeEvent());
    const payment = await store.findPaymentByGatewayId('pi_1');
    expect(payment?.status).toBe('paid');
  });
});
