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

describe('retry after a failed attempt', () => {
  /**
   * The idempotency ledger is claimed BEFORE any work runs, so a retry has to be
   * able to claim a failed event again. When it cannot, every retry — in-process
   * or durable — short-circuits on the ledger and silently does nothing, which
   * looks exactly like a webhook that was never delivered.
   */
  it('re-runs the handler instead of short-circuiting on the ledger', async () => {
    const store = new InMemoryBillingStore();
    let attempts = 0;
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'payment.succeeded': () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient gateway timeout');
        },
      },
    });

    const event = {
      id: 'evt_retry_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      data: { gatewayId: 'pi_retry_1', amount: 1990, currency: 'brl' },
      raw: {},
    };

    await expect(processor.process(event)).rejects.toThrow('transient gateway timeout');
    expect(store.webhookEvents.get('evt_retry_1')?.status).toBe('failed');

    // The retry the dispatcher performs.
    await expect(processor.process(event)).resolves.toBe(true);
    expect(attempts).toBe(2);
    expect(store.webhookEvents.get('evt_retry_1')?.status).toBe('processed');
  });

  it('still treats a redelivery of a processed event as a no-op', async () => {
    const store = new InMemoryBillingStore();
    let calls = 0;
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'payment.succeeded': () => {
          calls += 1;
        },
      },
    });

    const event = {
      id: 'evt_redelivery_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      data: { gatewayId: 'pi_redelivery_1', amount: 1990, currency: 'brl' },
      raw: {},
    };

    expect(await processor.process(event)).toBe(true);
    expect(await processor.process(event)).toBe(false);
    expect(calls).toBe(1);
  });
});
