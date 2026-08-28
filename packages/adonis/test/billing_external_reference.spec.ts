import { describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * `external_reference` — the app's OWN id for a charge — end to end through the store contract
 * and the processor that fills it.
 *
 * The column exists because it is the only thing tying a gateway confirmation back to an app's
 * row: drivers map it, `parseWebhook` surfaces it, the processor published it on the diagnostics
 * bus — and then dropped it, so nothing could look a payment up by the id the app actually
 * knows it by. These tests pin the two behaviours that are easy to get silently wrong: that a
 * later event does not blank a stored reference, and that the lookup answers with the row.
 */

const payment = (over: Record<string, unknown> = {}) => ({
  gatewayId: 'pi_1',
  provider: 'stripe',
  status: 'paid' as const,
  amount: 4200,
  currency: 'BRL',
  ...over,
});

function event(type: string, data: Record<string, unknown>) {
  return {
    id: `evt_${type}`,
    provider: 'stripe',
    type,
    data,
    raw: { id: `evt_${type}` },
  } as never;
}

describe('InMemoryBillingStore external reference', () => {
  it('stores the reference and finds the payment by it', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment(payment({ externalReference: 'order-1042' }));

    const found = await store.findPaymentByExternalReference('order-1042');
    expect(found?.gatewayId).toBe('pi_1');
    expect(found?.externalReference).toBe('order-1042');
  });

  it('answers null for a reference nothing carries', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment(payment({ externalReference: 'order-1042' }));
    expect(await store.findPaymentByExternalReference('order-9999')).toBeNull();
    // A payment with no reference at all is not matched by an empty one either.
    await store.savePayment(payment({ gatewayId: 'pi_2' }));
    expect(await store.findPaymentByExternalReference('')).toBeNull();
  });

  it('does NOT blank a stored reference when a later save omits it', async () => {
    // The failure this guards: `payment.succeeded` carries the reference, `payment.refunded`
    // does not, and a store that wrote `undefined` through would destroy the only key the app
    // routes on — at the exact moment an operator is trying to find the charge.
    const store = new InMemoryBillingStore();
    await store.savePayment(payment({ externalReference: 'order-1042' }));
    await store.savePayment(payment({ status: 'refunded' }));

    expect((await store.findPaymentByGatewayId('pi_1'))?.externalReference).toBe('order-1042');
    expect((await store.findPaymentByExternalReference('order-1042'))?.status).toBe('refunded');
  });

  it('clears the reference when null is passed explicitly', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment(payment({ externalReference: 'order-1042' }));
    await store.savePayment(payment({ externalReference: null }));
    expect((await store.findPaymentByGatewayId('pi_1'))?.externalReference).toBeNull();
    expect(await store.findPaymentByExternalReference('order-1042')).toBeNull();
  });

  it('returns the newest row when a reference was reused across charges', async () => {
    const store = new InMemoryBillingStore();
    let clock = new Date('2026-08-27T12:00:00.000Z');
    store.now = () => clock;
    await store.savePayment(payment({ gatewayId: 'pi_first', externalReference: 'order-1042' }));
    clock = new Date('2026-08-27T12:05:00.000Z');
    await store.savePayment(payment({ gatewayId: 'pi_retry', externalReference: 'order-1042' }));

    expect((await store.findPaymentByExternalReference('order-1042'))?.gatewayId).toBe('pi_retry');
  });

  it('carries the reference on the normalized list item', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment(payment({ externalReference: 'order-1042' }));
    await store.savePayment(payment({ gatewayId: 'pi_2' }));

    const listed = await store.listPayments({});
    expect(listed.map((row) => row.externalReference)).toEqual([null, 'order-1042']);
  });
});

describe('WebhookProcessor external reference', () => {
  it('persists the reference the succeeded event carried', async () => {
    const store = new InMemoryBillingStore();
    await new WebhookProcessor({ store }).process(
      event('payment.succeeded', {
        gatewayId: 'pi_1',
        amount: 4200,
        currency: 'BRL',
        externalReference: 'order-1042',
      }),
    );
    expect((await store.findPaymentByExternalReference('order-1042'))?.status).toBe('paid');
  });

  it('persists the reference a FAILED payment carried', async () => {
    // A charge that failed is exactly the one an app needs to find by its own id.
    const store = new InMemoryBillingStore();
    await new WebhookProcessor({ store }).process(
      event('payment.failed', {
        gatewayId: 'pi_1',
        amount: 4200,
        currency: 'BRL',
        externalReference: 'order-1042',
      }),
    );
    expect((await store.findPaymentByExternalReference('order-1042'))?.status).toBe('failed');
  });

  it('keeps the reference through a refund and a dispute that do not echo one', async () => {
    // The realistic sequence, and the one that used to lose the key: succeeded carries the
    // reference, refunded/disputed usually do not.
    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store });
    await processor.process(
      event('payment.succeeded', {
        gatewayId: 'pi_1',
        amount: 4200,
        currency: 'BRL',
        externalReference: 'order-1042',
      }),
    );
    await processor.process(
      event('payment.refunded', { gatewayId: 'pi_1', amount: 4200, currency: 'BRL' }),
    );
    expect((await store.findPaymentByExternalReference('order-1042'))?.status).toBe('refunded');

    await processor.process(
      event('payment.disputed', { gatewayId: 'pi_1', amount: 4200, currency: 'BRL' }),
    );
    expect((await store.findPaymentByExternalReference('order-1042'))?.status).toBe('disputed');
  });

  it('records the NORMALIZED event in the ledger, and keeps it across a re-claim', async () => {
    // What makes the dashboard's retry able to replay a signed gateway at all.
    const store = new InMemoryBillingStore();
    const data = { gatewayId: 'pi_1', amount: 4200, currency: 'BRL', externalReference: 'o-1' };
    await new WebhookProcessor({ store }).process(event('payment.succeeded', data));

    const row = store.webhookEvents.get('evt_payment.succeeded');
    expect(row?.normalized).toEqual(data);

    await store.markWebhookFailed(row?.id ?? '', 'boom');
    const reclaimed = await store.recordWebhookEvent({
      gatewayEventId: 'evt_payment.succeeded',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: {},
    });
    expect(reclaimed?.normalized).toEqual(data);
    expect(reclaimed?.payload).toEqual({ id: 'evt_payment.succeeded' });
  });
});
