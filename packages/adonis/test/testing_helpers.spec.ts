import { afterEach, describe, expect, it } from 'vitest';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { PaymentsManager } from '../src/payments_manager.js';
import {
  getBillingStore,
  getPayments,
  resetBillingStore,
  resetPayments,
  setWebhookDispatcher,
} from '../src/services/main.js';
import {
  fakePayments,
  flushWebhooks,
  swapBillingStore,
  swapPayments,
} from '../src/testing/fake_payments.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

afterEach(() => {
  resetPayments();
  resetBillingStore();
  setWebhookDispatcher(undefined);
});

/**
 * `./testing` shipped the fake DRIVER and no way to build a manager over it, so apps wrote
 * `setPayments({ driver: () => fake } as never)`. The `as never` is the tell: that object has
 * no `invoice()` and no `assertCapability()`, so the cast erased exactly the two methods
 * whose absence a test would want to catch.
 */
describe('fakePayments', () => {
  it('returns a REAL manager — the two methods the `as never` cast erased are there', () => {
    const manager = fakePayments(new FakePaymentsDriver({ capabilities: { refunds: false } }));
    expect(manager).toBeInstanceOf(PaymentsManager);
    // `invoice()` exists and says what it says when nothing is configured, instead of being
    // absent and throwing "manager.invoice is not a function" from inside a charge.
    expect(() => manager.invoice()).toThrow(/No invoice providers configured/);
    expect(() => manager.assertCapability(manager.driver(), 'refunds')).toThrow(
      /does not support refunds/,
    );
  });

  it('routes to the fake driver handed in, so the test can assert on the calls', async () => {
    const driver = new FakePaymentsDriver({ provider: 'fake' });
    const manager = fakePayments(driver);
    await manager.driver().charge({ amount: 1000, currency: 'brl', customerId: 'cus_1' });
    expect(driver.chargeCalls).toHaveLength(1);
  });
});

describe('swapPayments / swapBillingStore', () => {
  it('restores to NOTHING SET, which is what a test that never booted a provider had', () => {
    const restore = swapPayments(fakePayments());
    expect(getPayments()).toBeInstanceOf(PaymentsManager);
    restore();
    // Not "restores the previous manager" — there was none, and the hand-rolled save/restore
    // could not express that because saving meant calling a getter that throws.
    expect(() => getPayments()).toThrow(/not ready yet/);
  });

  it('restores a previously set manager rather than clearing it', () => {
    const first = fakePayments();
    swapPayments(first);
    const restore = swapPayments(fakePayments());
    restore();
    expect(getPayments()).toBe(first);
  });

  it('does the same for the billing store', () => {
    const restore = swapBillingStore(new InMemoryBillingStore());
    expect(getBillingStore()).toBeInstanceOf(InMemoryBillingStore);
    restore();
    expect(() => getBillingStore()).toThrow(/not ready yet/);
  });
});

/**
 * In durable mode `dispatchAll` resolves when the event is ACCEPTED, not processed. Every app
 * pairing `billing.dispatcher` with durable rewrites the same polling `waitFor` helper — and
 * then cannot write a NEGATIVE assertion at all, because "nothing happened" against a poll is
 * a timed sleep.
 */
describe('flushWebhooks', () => {
  /** An engine that behaves like durable: `start` accepts, the run happens out of band. */
  class DeferredEngine {
    #fns = new Map<string, (ctx: unknown, input: never) => Promise<void>>();
    register(name: string, _version: string, fn: (ctx: unknown, input: never) => Promise<void>) {
      this.#fns.set(name, fn);
    }
    async start(name: string, input: unknown, _runId: string) {
      const fn = this.#fns.get(name);
      if (!fn) throw new Error(`workflow ${name} is not registered`);
      setTimeout(() => void fn(undefined, input as never), 5);
    }
  }

  const event: WebhookEvent = {
    id: 'evt_1',
    provider: 'asaas',
    type: 'payment.succeeded',
    data: { gatewayId: 'pay_1', amount: 15000, currency: 'brl' },
    raw: {},
  };

  function durableDispatcher(store: InMemoryBillingStore): WebhookDispatcher {
    return new WebhookDispatcher({
      processor: new WebhookProcessor({ store }),
      mode: 'durable',
      durableEngine: async () => new DeferredEngine(),
    });
  }

  it('the gap it closes: the delivery resolves before anything has been processed', async () => {
    const store = new InMemoryBillingStore();
    await durableDispatcher(store).dispatchAll(event);
    expect(await store.findPaymentByGatewayId('pay_1')).toBeNull();
  });

  it('resolves only once the accepted event has actually been processed', async () => {
    const store = new InMemoryBillingStore();
    const dispatcher = durableDispatcher(store);
    await dispatcher.dispatchAll(event);
    await dispatcher.flushWebhooks();
    expect((await store.findPaymentByGatewayId('pay_1'))?.status).toBe('paid');
  });

  it('waits for the in-process background retries too', async () => {
    const store = new InMemoryBillingStore();
    let attempts = 0;
    const processor = new WebhookProcessor({ store });
    const original = processor.process.bind(processor);
    processor.process = async (e) => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return original(e);
    };
    const dispatcher = new WebhookDispatcher({
      processor,
      mode: 'in-process',
      retries: { max: 3, baseDelayMs: 5 },
    });
    await dispatcher.dispatchAll(event);
    await dispatcher.flushWebhooks();
    expect(attempts).toBe(2);
  });

  it('says so instead of hanging when the work runs in another process', async () => {
    const store = new InMemoryBillingStore();
    const dispatcher = new WebhookDispatcher({
      processor: new WebhookProcessor({ store }),
      mode: 'durable',
      // A worker-role deployment: the engine takes the run and this process never runs it.
      durableEngine: async () => ({ register() {}, async start() {} }),
    });
    await dispatcher.dispatchAll(event);
    await expect(dispatcher.flushWebhooks({ timeoutMs: 30 })).rejects.toThrow(
      /still in flight.*separate worker process/s,
    );
  });

  it('is reachable from ./testing and is a no-op when the billing layer is off', async () => {
    await expect(flushWebhooks()).resolves.toBeUndefined();
    const store = new InMemoryBillingStore();
    const dispatcher = durableDispatcher(store);
    setWebhookDispatcher(dispatcher);
    await dispatcher.dispatchAll(event);
    await flushWebhooks();
    expect((await store.findPaymentByGatewayId('pay_1'))?.status).toBe('paid');
  });
});
