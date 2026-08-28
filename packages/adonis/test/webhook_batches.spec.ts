import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { handleWebhookDelivery } from '../providers/payments_provider.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { PaymentsDriver } from '../src/driver.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

/**
 * One webhook DELIVERY can carry several events — Adyen's `notificationItems` and Efí's
 * `pix` are both arrays. What has to hold, and what these tests pin:
 *
 * 1. every event gets its own ledger row, because idempotency is per event;
 * 2. a redelivered batch runs only the events that have not been processed;
 * 3. an event that throws does not cancel its siblings, AND the response tells the gateway
 *    to redeliver — a 2xx over a failed event is how a payment is lost for good;
 * 4. a driver that returns a single event behaves exactly as it did before.
 */

function paymentEvent(id: string, gatewayId: string, amount = 1000): WebhookEvent {
  return {
    id,
    provider: 'batchy',
    type: 'payment.succeeded',
    data: { gatewayId, amount, currency: 'brl' },
    raw: { id },
  };
}

/** A driver that returns whatever `parseWebhook` is told to return for the given body. */
function makeDriver(reply: (rawBody: string) => WebhookEvent | WebhookEvent[]): PaymentsDriver {
  return {
    provider: 'batchy',
    supportedMethods: ['pix'],
    parseWebhook: (rawBody: string) => reply(rawBody),
  } as unknown as PaymentsDriver;
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
}

/** The minimum of an `HttpContext` the delivery handler touches. */
function makeCtx(rawBody: string, provider = 'batchy'): { ctx: HttpContext; sent: FakeResponse } {
  const sent: FakeResponse = { statusCode: 0, body: undefined };
  const response = {
    status(code: number) {
      sent.statusCode = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return body;
    },
  };
  const ctx = {
    params: { provider },
    request: { raw: () => rawBody, headers: () => ({}) },
    response,
  } as unknown as HttpContext;
  return { ctx, sent };
}

function makeDispatcher(store: InMemoryBillingStore, handlers?: Record<string, () => void>) {
  const processor = new WebhookProcessor({
    store,
    ...(handlers !== undefined ? { handlers } : {}),
  });
  // `in-process` so a failure is observable synchronously — durable/queue only report that
  // the event was accepted, which cannot answer "did event 2 fail".
  return new WebhookDispatcher({
    processor,
    mode: 'in-process',
    retries: { max: 1 },
  });
}

describe('a delivery carrying several events', () => {
  it('gives every event in the batch its own ledger row', async () => {
    const store = new InMemoryBillingStore();
    const dispatcher = makeDispatcher(store);
    const events = [
      paymentEvent('evt_1', 'pay_1', 1000),
      paymentEvent('evt_2', 'pay_2', 2000),
      paymentEvent('evt_3', 'pay_3', 3000),
    ];

    const result = await dispatcher.dispatchAll(events);

    expect(result).toMatchObject({ total: 3, dispatched: 3 });
    expect(result.failures).toHaveLength(0);
    // Three ledger rows, not one. The ledger is keyed on the gateway event id, so one row
    // per delivery would make events 2 and 3 look like redeliveries of event 1.
    expect(store.webhookEvents.size).toBe(3);
    for (const id of ['evt_1', 'evt_2', 'evt_3']) {
      expect(store.webhookEvents.get(id)?.status).toBe('processed');
    }
    // ...and all three payments actually landed.
    expect((await store.findPaymentByGatewayId('pay_1'))?.amount).toBe(1000);
    expect((await store.findPaymentByGatewayId('pay_2'))?.amount).toBe(2000);
    expect((await store.findPaymentByGatewayId('pay_3'))?.amount).toBe(3000);
  });

  it('runs only the unprocessed events when the batch is redelivered', async () => {
    const store = new InMemoryBillingStore();
    const seen: string[] = [];
    const dispatcher = makeDispatcher(store, {
      'payment.succeeded': ((event: WebhookEvent) => {
        seen.push(event.id);
      }) as unknown as () => void,
    });
    const batch = [
      paymentEvent('evt_1', 'pay_1'),
      paymentEvent('evt_2', 'pay_2'),
      paymentEvent('evt_3', 'pay_3'),
      paymentEvent('evt_4', 'pay_4'),
    ];

    // The gateway delivered three of the four before something went wrong at its end.
    await dispatcher.dispatchAll(batch.slice(0, 3));
    expect(seen).toEqual(['evt_1', 'evt_2', 'evt_3']);
    seen.length = 0;

    // It now redelivers the WHOLE batch. Only the fourth may run.
    const result = await dispatcher.dispatchAll(batch);

    expect(seen).toEqual(['evt_4']);
    expect(result.failures).toHaveLength(0);
    expect(store.webhookEvents.size).toBe(4);
  });
});

describe('an event failing in the middle of a batch', () => {
  it('still attempts the events after it, and reports every failure', async () => {
    const store = new InMemoryBillingStore();
    const seen: string[] = [];
    const dispatcher = makeDispatcher(store, {
      'payment.succeeded': ((event: WebhookEvent) => {
        seen.push(event.id);
        if (event.id === 'evt_2') throw new Error('handler blew up on evt_2');
      }) as unknown as () => void,
    });

    const result = await dispatcher.dispatchAll([
      paymentEvent('evt_1', 'pay_1'),
      paymentEvent('evt_2', 'pay_2'),
      paymentEvent('evt_3', 'pay_3'),
      paymentEvent('evt_4', 'pay_4'),
    ]);

    // Events 3 and 4 are different payments. A sibling's failure is not a reason to refuse
    // them — that loses money for a reason unrelated to them.
    expect(seen).toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4']);
    expect(result.total).toBe(4);
    expect(result.dispatched).toBe(3);
    expect(result.failures.map((failure) => failure.event.id)).toEqual(['evt_2']);
    // The failed one is `failed` in the ledger — which is what lets a redelivery claim it
    // again — while its siblings are `processed` and a redelivery will skip them.
    expect(store.webhookEvents.get('evt_2')?.status).toBe('failed');
    expect(store.webhookEvents.get('evt_3')?.status).toBe('processed');
  });

  it('answers the gateway with a non-2xx so the failed event is redelivered', async () => {
    const store = new InMemoryBillingStore();
    const dispatcher = makeDispatcher(store, {
      'payment.succeeded': ((event: WebhookEvent) => {
        if (event.id === 'evt_2') throw new Error('handler blew up on evt_2');
      }) as unknown as () => void,
    });
    const batch = [
      paymentEvent('evt_1', 'pay_1'),
      paymentEvent('evt_2', 'pay_2'),
      paymentEvent('evt_3', 'pay_3'),
    ];
    const manager = new PaymentsManager({
      drivers: new Map([['batchy', makeDriver(() => batch)]]),
    });

    const { ctx, sent } = makeCtx('{"batch":true}');
    await handleWebhookDelivery(ctx, { manager, dispatcher });

    // A 2xx promises the gateway it never has to send this again — over an event that
    // failed, that is the payment lost. Adyen queues a non-2xx for up to 30 days of
    // retries; Efí makes 9 attempts. Both only start if the answer is not a 2xx.
    expect(sent.statusCode).toBe(500);
    expect(sent.body).toMatchObject({ processed: 2, failed: ['evt_2'] });
    expect((sent.body as { error: string }).error).toMatch(/evt_2/);
  });

  it('keeps a rejected signature a 400, which must NOT be redelivered', async () => {
    const store = new InMemoryBillingStore();
    const manager = new PaymentsManager({
      drivers: new Map([
        [
          'batchy',
          makeDriver(() => {
            throw new Error('[payments] Invalid webhook HMAC signature.');
          }),
        ],
      ]),
    });

    const { ctx, sent } = makeCtx('{"forged":true}');
    await handleWebhookDelivery(ctx, { manager, dispatcher: makeDispatcher(store) });

    // A forged or unparsable delivery fails identically on every retry, and answering it
    // with "please send that again" is an invitation, not a fix.
    expect(sent.statusCode).toBe(400);
    expect(sent.body).toMatchObject({ error: '[payments] Invalid webhook HMAC signature.' });
    expect(store.webhookEvents.size).toBe(0);
  });

  it('files the refusal in the audit trail, the only trace it can leave', async () => {
    // A refused delivery is the ONE webhook outcome with no ledger row — it is rejected
    // before an event exists to record. Without this row a rotated webhook token looks
    // exactly like a quiet gateway from the inside: no events, no failures, every health
    // check green, and revenue simply stops arriving.
    const store = new InMemoryBillingStore();
    const manager = new PaymentsManager({
      drivers: new Map([
        [
          'batchy',
          makeDriver(() => {
            throw new Error('[payments] Invalid webhook HMAC signature.');
          }),
        ],
      ]),
    });

    const { ctx, sent } = makeCtx('{"forged":true}');
    await handleWebhookDelivery(ctx, { manager, dispatcher: makeDispatcher(store), store });

    expect(sent.statusCode).toBe(400);
    const audit = await store.listAuditEvents({ action: 'webhook.rejected' });
    expect(audit, 'a refused delivery left no trace anywhere').toHaveLength(1);
    expect(audit[0]?.provider).toBe('batchy');
    expect(audit[0]?.message).toContain('HMAC');
  });

  it('still answers 400 when the billing layer is off and there is nowhere to file it', async () => {
    // `store` is absent whenever `billing.enabled` is false. Refusing the delivery is the
    // job; recording it is the extra — the extra must never change the status the gateway
    // sees.
    const manager = new PaymentsManager({
      drivers: new Map([
        [
          'batchy',
          makeDriver(() => {
            throw new Error('[payments] Invalid webhook HMAC signature.');
          }),
        ],
      ]),
    });

    const { ctx, sent } = makeCtx('{"forged":true}');
    await handleWebhookDelivery(ctx, { manager });
    expect(sent.statusCode).toBe(400);
  });
});

describe('a driver that returns one event', () => {
  it('is dispatched exactly as before — one ledger row, 200, {received: true}', async () => {
    const store = new InMemoryBillingStore();
    const dispatcher = makeDispatcher(store);
    const manager = new PaymentsManager({
      drivers: new Map([['batchy', makeDriver(() => paymentEvent('evt_solo', 'pay_solo', 4200))]]),
    });

    const { ctx, sent } = makeCtx('{"single":true}');
    await handleWebhookDelivery(ctx, { manager, dispatcher });

    expect(sent.statusCode).toBe(200);
    expect(sent.body).toEqual({ received: true });
    expect(store.webhookEvents.size).toBe(1);
    expect(store.webhookEvents.get('evt_solo')?.status).toBe('processed');
    expect((await store.findPaymentByGatewayId('pay_solo'))?.amount).toBe(4200);
  });

  it('is accepted by dispatchAll without being wrapped in an array by the caller', async () => {
    const store = new InMemoryBillingStore();
    const result = await makeDispatcher(store).dispatchAll(paymentEvent('evt_solo', 'pay_solo'));
    expect(result).toMatchObject({ total: 1, dispatched: 1 });
    expect(result.failures).toHaveLength(0);
  });
});
