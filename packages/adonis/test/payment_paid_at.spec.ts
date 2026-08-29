import { describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

/**
 * `paid_at` — the only record of WHEN a charge landed — and the writes that used to destroy it.
 *
 * `savePayment` wrote `payment.paidAt ? DateTime.fromJSDate(...) : null` unconditionally, so
 * every save that omitted the field cleared the column. Three of the processor's own handlers
 * omit it (`payment.refunded`, `payment.disputed`, `payment.dispute_closed`) because a refund
 * or dispute payload carries no settlement date. `revenue()` filters
 * `status = 'paid' AND paid_at >= from AND paid_at < to`, so a dispute closed as WON restored
 * `status = 'paid'` with `paid_at = NULL` — and the recovered money dropped out of every
 * windowed revenue figure, permanently and silently.
 */

const JANUARY = new Date('2026-01-15T10:00:00.000Z');
const JAN_START = new Date('2026-01-01T00:00:00.000Z');
const FEB_START = new Date('2026-02-01T00:00:00.000Z');

function event(type: string, data: Record<string, unknown>): WebhookEvent {
  return { id: `evt_${type}`, provider: 'asaas', type, data, raw: { id: `evt_${type}` } };
}

async function storeWithJanuaryCharge() {
  const store = new InMemoryBillingStore();
  await store.savePayment({
    gatewayId: 'pay_1',
    provider: 'asaas',
    status: 'paid',
    amount: 10_000,
    currency: 'brl',
    customerId: 'cus_1',
    externalReference: 'order-1042',
    paidAt: JANUARY,
  });
  return store;
}

describe('savePayment paidAt', () => {
  it('does NOT blank a stored paid_at when a later save omits it', async () => {
    const store = await storeWithJanuaryCharge();

    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'disputed',
      amount: 10_000,
      currency: 'brl',
    });

    expect((await store.findPaymentByGatewayId('pay_1'))?.paidAt).toEqual(JANUARY);
  });

  it('still clears it when `null` is passed explicitly', async () => {
    // The escape hatch has to escape: absent means "not stated", `null` means "clear it".
    const store = await storeWithJanuaryCharge();

    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'pending',
      amount: 10_000,
      currency: 'brl',
      paidAt: null,
    });

    expect((await store.findPaymentByGatewayId('pay_1'))?.paidAt).toBeNull();
  });

  it('leaves a row with no paid_at out of a windowed revenue figure', async () => {
    // Mirrors SQL: `paid_at >= from` is not true of NULL. Without this the in-memory store
    // would report revenue the database cannot, and would hide the bug above.
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_undated',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
    });

    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(0);
    // Unwindowed, it is still revenue — it just cannot be filed in a month.
    expect(await store.revenue({})).toBe(10_000);
  });
});

describe('a dispute won end to end', () => {
  /**
   * paid (January) → chargeback → dispute closed as `won`, and the money has to still be
   * January's. This is the round trip that was broken: both later events save the payment
   * without a `paidAt`, so the row came back to `paid` with `paid_at = NULL` and January's
   * revenue was permanently short by the disputed amount.
   */
  it('keeps the recovered money in the ORIGINAL revenue window', async () => {
    const store = await storeWithJanuaryCharge();
    const processor = new WebhookProcessor({ store });

    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(10_000);

    await processor.process(
      event('payment.disputed', {
        gatewayId: 'pay_1',
        amount: 10_000,
        currency: 'brl',
        disputeId: 'cb_1',
      }),
    );
    // A chargeback takes the money: it is out of January while the dispute is open.
    expect(await store.findPaymentByGatewayId('pay_1')).toMatchObject({ status: 'disputed' });
    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(0);

    await processor.process(
      event('payment.dispute_closed', {
        gatewayId: 'pay_1',
        disputeId: 'cb_1',
        outcome: 'won',
      }),
    );

    const row = await store.findPaymentByGatewayId('pay_1');
    expect(row?.status).toBe('paid');
    // The point of the whole test: the settlement date survived both events.
    expect(row?.paidAt).toEqual(JANUARY);
    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(10_000);
    // And it did NOT move into the month the dispute closed in.
    expect(await store.revenue({ from: FEB_START })).toBe(0);
  });

  it('keeps the external reference too, which is the same rule', async () => {
    const store = await storeWithJanuaryCharge();
    const processor = new WebhookProcessor({ store });
    await processor.process(
      event('payment.disputed', { gatewayId: 'pay_1', amount: 10_000, currency: 'brl' }),
    );
    expect((await store.findPaymentByGatewayId('pay_1'))?.externalReference).toBe('order-1042');
  });
});
