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

/** A payment already sitting at `disputed`, which is where a chargeback leaves it. */
async function storeWithDisputedPayment() {
  const store = new InMemoryBillingStore();
  await store.savePayment({
    gatewayId: 'pi_1',
    provider: 'stripe',
    status: 'disputed',
    amount: 1000,
    currency: 'brl',
    customerId: 'cus_1',
  });
  return store;
}

describe('WebhookProcessor disputes', () => {
  /**
   * A won dispute returns the money, and the row has been at `disputed` since the chargeback
   * arrived. `revenue()` sums rows that are `paid`, so leaving it there writes off money that
   * came back.
   */
  it('puts a won dispute back to paid', async () => {
    const store = await storeWithDisputedPayment();
    await new WebhookProcessor({ store, driver: new FakePaymentsDriver() }).process(
      makeEvent({
        id: 'evt_won',
        type: 'payment.dispute_closed',
        data: { gatewayId: 'pi_1', disputeId: 'dp_1', outcome: 'won' },
      }),
    );
    const row = await store.findPaymentByGatewayId('pi_1');
    expect(row?.status).toBe('paid');
    // The row keeps what it had; a dispute payload names no customer.
    expect(row?.customerId).toBe('cus_1');
    expect(row?.amount).toBe(1000);
  });

  /**
   * A lost close must move the row even when no `payment.disputed` ever arrived, and on
   * several gateways it never does: Razorpay documents that it does not debit provisionally
   * at all, PayPal opens at an inquiry that takes nothing, Woovi only blocks the balance. On
   * those the sequence is warning -> closed(lost), so a payment whose money is definitively
   * gone would sit at `paid` forever.
   */
  it('takes a paid payment to disputed when the dispute is lost', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pi_1',
      provider: 'razorpay',
      status: 'paid',
      amount: 1000,
      currency: 'brl',
      customerId: 'cus_1',
    });
    await new WebhookProcessor({ store, driver: new FakePaymentsDriver() }).process(
      makeEvent({
        id: 'evt_lost_no_open',
        provider: 'razorpay',
        type: 'payment.dispute_closed',
        data: { gatewayId: 'pi_1', outcome: 'lost' },
      }),
    );
    const row = await store.findPaymentByGatewayId('pi_1');
    expect(row?.status).toBe('disputed');
    expect(row?.customerId).toBe('cus_1');
  });

  it.each(['expired', 'canceled'])(
    'moves nothing when a %s close says nothing about the money',
    async (outcome) => {
      // Expired means the window closed with no verdict published; canceled means the
      // cardholder withdrew, and on Stripe a withdrawn dispute still has to be closed in
      // your favour with evidence. Neither states where the money ended up.
      const store = new InMemoryBillingStore();
      await store.savePayment({
        gatewayId: 'pi_1',
        provider: 'stripe',
        status: 'paid',
        amount: 1000,
        currency: 'brl',
      });
      await new WebhookProcessor({ store, driver: new FakePaymentsDriver() }).process(
        makeEvent({
          id: `evt_${outcome}_paid`,
          type: 'payment.dispute_closed',
          data: { gatewayId: 'pi_1', outcome },
        }),
      );
      expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('paid');
    },
  );

  it.each(['lost', 'expired', 'canceled'])(
    'leaves a %s dispute where the chargeback left it',
    async (outcome) => {
      // `canceled` is the cardholder withdrawing, and on Stripe a withdrawn dispute still has
      // to be closed in your favour with evidence — counting it as settled would book revenue
      // the acquirer has not returned.
      const store = await storeWithDisputedPayment();
      await new WebhookProcessor({ store, driver: new FakePaymentsDriver() }).process(
        makeEvent({
          id: `evt_${outcome}`,
          type: 'payment.dispute_closed',
          data: { gatewayId: 'pi_1', outcome },
        }),
      );
      expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('disputed');
    },
  );

  it('refuses a close that carries no outcome', async () => {
    // A driver that cannot read the outcome is supposed to emit `payment.updated`. Defaulting
    // here would report a result the gateway never sent.
    const store = await storeWithDisputedPayment();
    await expect(
      new WebhookProcessor({ store, driver: new FakePaymentsDriver() }).process(
        makeEvent({
          id: 'evt_nooutcome',
          type: 'payment.dispute_closed',
          data: { gatewayId: 'pi_1' },
        }),
      ),
    ).rejects.toThrow(/carries no outcome/);
    expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('disputed');
  });

  it('writes nothing for a warning — no money has moved', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pi_1',
      provider: 'stripe',
      status: 'paid',
      amount: 1000,
      currency: 'brl',
    });
    const processed = await new WebhookProcessor({
      store,
      driver: new FakePaymentsDriver(),
    }).process(
      makeEvent({
        id: 'evt_warn',
        type: 'payment.dispute_warning',
        data: { gatewayId: 'pi_1', reason: 'fraudulent', actionableUntil: '2026-09-18T00:00:00Z' },
      }),
    );
    expect(processed).toBe(true);
    // A payment that says `paid` while an inquiry is open is telling the truth.
    expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('paid');
  });

  it('does not resurrect a won dispute on a payment that was never stored', async () => {
    const store = new InMemoryBillingStore();
    await new WebhookProcessor({ store, driver: new FakePaymentsDriver() }).process(
      makeEvent({
        id: 'evt_won_unknown',
        type: 'payment.dispute_closed',
        data: { gatewayId: 'pi_unknown', outcome: 'won' },
      }),
    );
    expect(await store.findPaymentByGatewayId('pi_unknown')).toBeNull();
  });
});

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

  it('publishes payment.succeeded on the diagnostics channel with the externalReference', async () => {
    const { channel } = await import('node:diagnostics_channel');
    // Seed the structural emit slot as the loaded `@adonis-agora/diagnostics` would.
    const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
    const previous = (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => {
      channel(`agora:${lib}:${event}`).publish({ v: 1, lib, event, payload });
    };
    const received: Array<{ gatewayId: string; externalReference?: string }> = [];
    const handler = (msg: unknown) => {
      const envelope = msg as { payload?: { gatewayId: string; externalReference?: string } };
      if (envelope?.payload) received.push(envelope.payload);
    };
    channel('agora:payments:payment.succeeded').subscribe(handler);
    try {
      const store = new InMemoryBillingStore();
      const processor = new WebhookProcessor({ store, driver: new FakePaymentsDriver() });
      await processor.process(
        makeEvent({
          data: {
            gatewayId: 'pi_1',
            amount: 1000,
            currency: 'brl',
            externalReference: 'pay_local_1',
          },
        }),
      );
      expect(received).toEqual([
        {
          gatewayId: 'pi_1',
          provider: 'stripe',
          amount: 1000,
          currency: 'brl',
          externalReference: 'pay_local_1',
        },
      ]);
    } finally {
      channel('agora:payments:payment.succeeded').unsubscribe(handler);
      if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
      else (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = previous;
    }
  });
});
