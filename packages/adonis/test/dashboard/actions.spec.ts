import { describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../../src/billing/webhook_processor.js';
import type { RefundCapableDriver, ReplayableWebhookEvent } from '../../src/dashboard/actions.js';
import { createRefundAction, createReplayAction } from '../../src/dashboard/actions.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

/**
 * The dashboard's two WRITE actions.
 *
 * Everything else this console does is a read, and a read that misbehaves shows the wrong number.
 * These two move money and re-run business logic, so their failure modes are tested one at a time
 * — including the two that are easy to get silently wrong: a refund attempted against a gateway
 * that has no refund API, and a retry that claims the ledger row in a way that makes the processor
 * skip the very work it was asked to do.
 */

function fakeDriver(overrides: Partial<RefundCapableDriver> = {}): RefundCapableDriver {
  return {
    provider: 'stripe',
    capabilities: { refunds: true },
    refund: async (gatewayId, amount) => ({
      gatewayId: `re_${gatewayId}`,
      provider: 'stripe',
      amount: { amount: amount ?? 5000, currency: 'BRL' },
      status: 'succeeded',
      createdAt: '2026-08-27T12:00:00.000Z',
    }),
    ...overrides,
  };
}

describe('createRefundAction', () => {
  it('refunds through the driver and reports the amount the GATEWAY confirmed', async () => {
    const refund = createRefundAction(() => fakeDriver());
    const outcome = await refund({ provider: 'stripe', gatewayId: 'pi_1', amount: 1999 });
    expect(outcome).toEqual({
      kind: 'ok',
      refund: { gatewayId: 're_pi_1', amount: 1999, currency: 'BRL', status: 'succeeded' },
    });
  });

  it('omits the amount entirely for a full refund rather than sending a computed one', async () => {
    const seen: Array<number | undefined> = [];
    const refund = createRefundAction(() =>
      fakeDriver({
        refund: async (_id, amount) => {
          seen.push(amount);
          return {
            gatewayId: 're_1',
            provider: 'stripe',
            amount: { amount: 5000, currency: 'BRL' },
            status: 'succeeded',
            createdAt: '',
          };
        },
      }),
    );
    await refund({ provider: 'stripe', gatewayId: 'pi_1' });
    expect(seen).toEqual([undefined]);
  });

  it('refuses BEFORE calling a gateway that has no refund API', async () => {
    // Woovi/OpenPix implements `refund()` only to throw. Discovering that from a round-trip reads
    // to the operator like a network failure.
    let called = false;
    const refund = createRefundAction(() =>
      fakeDriver({
        provider: 'woovi',
        capabilities: { refunds: false },
        refund: async () => {
          called = true;
          throw new Error('unreachable');
        },
      }),
    );
    const outcome = await refund({ provider: 'woovi', gatewayId: 'ch_1' });
    expect(outcome.kind).toBe('unsupported');
    expect(called).toBe(false);
  });

  it('treats a driver that declares no capabilities at all as unable to refund', async () => {
    const refund = createRefundAction(() => fakeDriver({ capabilities: undefined }));
    expect((await refund({ provider: 'stripe', gatewayId: 'pi_1' })).kind).toBe('unsupported');
  });

  it('surfaces the manager’s message when the provider is no longer configured', async () => {
    // Which drivers ARE configured is the next thing the operator needs, and the manager's own
    // error already says it.
    const refund = createRefundAction(() => {
      throw new Error('[payments] Driver "asaas" is not configured. Available drivers: stripe.');
    });
    const outcome = await refund({ provider: 'asaas', gatewayId: 'pay_1' });
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.message).toContain(
      'Available drivers: stripe',
    );
  });

  it('surfaces the gateway’s refusal verbatim', async () => {
    const refund = createRefundAction(() =>
      fakeDriver({
        refund: async () => {
          throw new Error('charge_already_refunded');
        },
      }),
    );
    const outcome = await refund({ provider: 'stripe', gatewayId: 'pi_1' });
    expect(outcome).toEqual({ kind: 'gateway-error', message: 'charge_already_refunded' });
  });
});

describe('createReplayAction', () => {
  const PAYLOAD = { id: 'evt_1', object: 'event', data: { amount: 4200 } };

  /** A store with one failed ledger row carrying a real payload and a real handler error. */
  async function ledger(): Promise<InMemoryBillingStore> {
    const store = new InMemoryBillingStore();
    const row = await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: PAYLOAD,
    });
    await store.markWebhookFailed(row?.id ?? '', 'TypeError: Cannot read properties of null');
    return store;
  }

  const input = {
    gatewayEventId: 'evt_1',
    provider: 'stripe',
    type: 'payment.succeeded',
    previousError: 'TypeError: Cannot read properties of null',
  };

  function event(): ReplayableWebhookEvent {
    return {
      id: 'evt_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      data: { gatewayId: 'pi_1', amount: 4200, currency: 'BRL' },
      raw: PAYLOAD,
    };
  }

  it('hands the driver the payload the ledger recorded, not an empty one', async () => {
    // `recordWebhookEvent` is the ONLY way to read a stored payload back through the store
    // contract, and the re-claim path must not overwrite it with the `{}` we pass in.
    const seen: string[] = [];
    const replay = createReplayAction({
      store: await ledger(),
      parse: async (_provider, rawBody) => {
        seen.push(rawBody);
        return event();
      },
      process: async () => undefined,
    });
    await replay(input);
    expect(JSON.parse(seen[0] ?? '{}')).toEqual(PAYLOAD);
  });

  it('actually re-runs the handlers through a REAL processor and lands the row processed', async () => {
    // The whole point of the button. This is also the test that pins the subtle part: the
    // processor claims through `recordWebhookEvent` itself, so the row has to be handed back to
    // `failed` first — a row left at `received` reads to it as in-flight and it runs NOTHING.
    const store = await ledger();
    const ran: string[] = [];
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'payment.succeeded': (e) => {
          ran.push(e.id);
        },
      },
    });
    const replay = createReplayAction({
      store,
      parse: async () => event(),
      process: (e) => processor.process(e as never),
    });

    const outcome = await replay(input);

    expect(outcome).toEqual({ kind: 'processed' });
    expect(ran).toEqual(['evt_1']);
    const row = await store.findWebhookEventByGatewayEventId('evt_1');
    expect(row?.status).toBe('processed');
    expect(row?.error).toBeNull();
    // And the built-in sync ran too: the payment the event described now exists.
    expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('paid');
  });

  it('leaves the ledger EXACTLY as it was when the driver cannot rebuild the event', async () => {
    // A gateway that signs its webhooks has no signature to check here. Stamping that over the
    // handler's original message would destroy the only record of why the event failed.
    const store = await ledger();
    const replay = createReplayAction({
      store,
      parse: async () => {
        throw new Error('Missing `stripe-signature` header on webhook request.');
      },
      process: async () => {
        throw new Error('must not run');
      },
    });

    const outcome = await replay(input);

    expect(outcome.kind).toBe('undeliverable');
    expect(outcome.kind === 'undeliverable' && outcome.message).toContain('stripe-signature');
    const row = await store.findWebhookEventByGatewayEventId('evt_1');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('TypeError: Cannot read properties of null');
  });

  it('refuses to touch an event the ledger will not re-claim', async () => {
    const store = new InMemoryBillingStore();
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: PAYLOAD,
    });
    const replay = createReplayAction({
      store,
      parse: async () => {
        throw new Error('must not run');
      },
      process: async () => undefined,
    });
    // Still `received` — in flight, not ours to re-run.
    expect(await replay(input)).toEqual({ kind: 'conflict' });
  });

  it('reports a handler that threw again, with the ledger carrying the NEW error', async () => {
    const store = await ledger();
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'payment.succeeded': () => {
          throw new Error('still broken');
        },
      },
    });
    const replay = createReplayAction({
      store,
      parse: async () => event(),
      process: (e) => processor.process(e as never),
    });

    const outcome = await replay(input);

    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.message).toContain('still broken');
    const row = await store.findWebhookEventByGatewayEventId('evt_1');
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('still broken');
  });
});
