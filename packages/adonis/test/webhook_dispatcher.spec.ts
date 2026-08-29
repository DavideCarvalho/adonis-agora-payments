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

/**
 * The durable path, against an engine that enforces durable's ACTUAL rule: a run can only
 * be started for a workflow NAME the engine has been told about.
 *
 * This is the shape of the bug it exists to catch. The dispatcher used to build an
 * anonymous `class PaymentsWebhookWorkflow extends BaseWorkflow` on the fly and call its
 * inherited static `dispatch`. That class declared no `static workflow = { name }` and was
 * never registered anywhere, so `@adonis-agora/durable` answered
 *
 *   workflow class PaymentsWebhookWorkflow has no registered name
 *
 * for every event. `dispatchAll` collected it as a failed event and the route answered 500,
 * so the gateway redelivered forever and no payment was ever processed — in every app with
 * durable installed, which is exactly what the default `'auto'` mode selects.
 *
 * Nothing caught it because nothing here had ever driven the durable branch: 1125 unit
 * tests passed over a path that could not work in an application. A fake engine is enough
 * to encode the rule that was broken, and the entre-textos integration proved it against
 * the real one.
 */
describe('WebhookDispatcher — durable', () => {
  /** An engine with durable's registry semantics: `start` an unregistered name and it throws. */
  class FakeEngine {
    registered = new Map<string, (ctx: unknown, input: never) => Promise<void>>();
    started: Array<{ name: string; input: unknown; runId: string }> = [];

    register(name: string, _version: string, fn: (ctx: unknown, input: never) => Promise<void>) {
      this.registered.set(name, fn);
    }

    async start(name: string, input: unknown, runId: string) {
      const fn = this.registered.get(name);
      if (!fn) throw new Error(`workflow ${name} is not registered`);
      this.started.push({ name, input, runId });
      // Durable runs the body out of band; running it here is what lets the test assert the
      // event actually reached the processor rather than merely being accepted.
      await fn(undefined, input as never);
    }
  }

  const event = (id: string): WebhookEvent => ({
    id,
    provider: 'asaas',
    type: 'payment.succeeded',
    data: { gatewayId: 'pay_1', amount: 15000, currency: 'brl' },
    raw: {},
  });

  it('registers the workflow before starting a run', async () => {
    const store = new InMemoryBillingStore();
    const engine = new FakeEngine();
    const dispatcher = new WebhookDispatcher({
      processor: new WebhookProcessor({ store }),
      mode: 'durable',
      durableEngine: async () => engine,
    });

    const result = await dispatcher.dispatchAll(event('evt_1'));

    expect(result.failures.map((failure) => failure.error.message)).toEqual([]);
    expect(result.dispatched).toBe(1);
    expect([...engine.registered.keys()]).toEqual(['payments-webhook']);
    expect(engine.started).toHaveLength(1);
  });

  it('runs the event through the processor and writes the ledger', async () => {
    const store = new InMemoryBillingStore();
    const engine = new FakeEngine();
    const dispatcher = new WebhookDispatcher({
      processor: new WebhookProcessor({ store }),
      mode: 'durable',
      durableEngine: async () => engine,
    });

    await dispatcher.dispatchAll(event('evt_2'));

    const recorded = await store.findWebhookEventByGatewayEventId('evt_2');
    expect(recorded, 'the run accepted the event but never processed it').not.toBeNull();
  });

  it('registers once across many deliveries', async () => {
    const engine = new FakeEngine();
    const registerSpy = vi.spyOn(engine, 'register');
    const dispatcher = new WebhookDispatcher({
      processor: new WebhookProcessor({ store: new InMemoryBillingStore() }),
      mode: 'durable',
      durableEngine: async () => engine,
    });

    await dispatcher.dispatchAll([event('evt_3'), event('evt_4')]);
    await dispatcher.dispatchAll(event('evt_5'));

    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it('gives each delivery its own run id', async () => {
    // Not cosmetic: `engine.start` is idempotent by run id and returns the prior run's
    // state for a repeat, so a run id derived from the event would turn the gateway's
    // redelivery of a FAILED event into a silent no-op — the one case redelivery is for.
    const engine = new FakeEngine();
    const dispatcher = new WebhookDispatcher({
      processor: new WebhookProcessor({ store: new InMemoryBillingStore() }),
      mode: 'durable',
      durableEngine: async () => engine,
    });

    await dispatcher.dispatchAll(event('evt_6'));
    await dispatcher.dispatchAll(event('evt_6'));

    expect(new Set(engine.started.map((run) => run.runId)).size).toBe(2);
  });

  it('says so when durable is asked for and no engine was wired', async () => {
    const dispatcher = new WebhookDispatcher({
      processor: new WebhookProcessor({ store: new InMemoryBillingStore() }),
      mode: 'durable',
    });

    const result = await dispatcher.dispatchAll(event('evt_7'));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error.message).toMatch(/no durable engine was provided/);
  });
});
