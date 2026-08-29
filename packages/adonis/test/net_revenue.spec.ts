import { describe, expect, it } from 'vitest';
import { billingOverview } from '../src/billing/billing_overview.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

/**
 * Gross and net revenue — two figures, both true, and for two releases only one of them
 * existed.
 *
 * `billing_payments.refunded_amount` was added so a PARTIAL refund could be recorded without
 * mangling `amount` or `status`: a R$10 refund on a R$100 charge leaves the row `paid` at
 * `amount: 10000, refundedAmount: 1000`. Every aggregate then went on summing `amount` alone,
 * so the half-refunded charge counted at full value in the console's headline number and
 * nothing on screen said the number was gross.
 *
 * The fix is not to redefine `revenue()`. Gross answers "what did we collect", net answers
 * "what did we keep", an app may be reading either, and silently swapping one for the other in
 * a release is how the second bug gets written. So `revenue()` stays gross to the cent and
 * `netRevenue()` is added beside it — which means the assertions below come in PAIRS, because
 * "net subtracts" is only half the contract and "gross still does not" is the other half.
 */

const JANUARY = new Date('2026-01-15T10:00:00.000Z');
const JAN_START = new Date('2026-01-01T00:00:00.000Z');
const FEB_START = new Date('2026-02-01T00:00:00.000Z');
const MARCH = new Date('2026-03-10T10:00:00.000Z');

function event(type: string, data: Record<string, unknown>): WebhookEvent {
  return { id: `evt_${type}`, provider: 'asaas', type, data, raw: { id: `evt_${type}` } };
}

async function januaryCharge(store: InMemoryBillingStore, gatewayId: string, amount: number) {
  await store.savePayment({
    gatewayId,
    provider: 'asaas',
    status: 'paid',
    amount,
    currency: 'brl',
    customerId: 'cus_1',
    paidAt: JANUARY,
  });
}

describe('netRevenue', () => {
  it('subtracts a partial refund while revenue stays gross', async () => {
    const store = new InMemoryBillingStore();
    await januaryCharge(store, 'pay_1', 10_000);
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
      refundedAmount: 1_000,
    });

    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(10_000);
    expect(await store.netRevenue({ from: JAN_START, to: FEB_START })).toBe(9_000);
  });

  it('reads a NULL refunded_amount as zero rather than poisoning the sum', async () => {
    // The row shape of every install that took money before the column existed, and of every
    // charge no refund has ever touched. In SQL `amount - NULL` is `NULL` and `SUM` carries
    // that `NULL` across the whole window, so one legacy row next to a refunded one is the
    // case that decides whether net revenue is a figure or a zero.
    const store = new InMemoryBillingStore();
    await januaryCharge(store, 'pay_legacy', 10_000);
    await januaryCharge(store, 'pay_refunded', 10_000);
    await store.savePayment({
      gatewayId: 'pay_refunded',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
      refundedAmount: 2_500,
    });
    expect((await store.findPaymentByGatewayId('pay_legacy'))?.refundedAmount).toBeNull();

    expect(await store.netRevenue({ from: JAN_START, to: FEB_START })).toBe(17_500);
    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(20_000);
  });

  it('answers in integer minor units — a partial refund of an odd amount is never divided', async () => {
    const store = new InMemoryBillingStore();
    await januaryCharge(store, 'pay_odd', 12_345);
    await store.savePayment({
      gatewayId: 'pay_odd',
      provider: 'asaas',
      status: 'paid',
      amount: 12_345,
      currency: 'brl',
      refundedAmount: 4_567,
    });

    const net = await store.netRevenue({ from: JAN_START, to: FEB_START });
    expect(net).toBe(7_778);
    expect(Number.isInteger(net)).toBe(true);
  });

  it('a fully refunded charge is out of BOTH figures — status, not the column, removes it', async () => {
    // `payment.refunded` writes the row off whole: status `refunded`, and both aggregates sum
    // `paid` rows only. The refunded amount is still recorded, so the row does not have to be
    // subtracted twice.
    const store = new InMemoryBillingStore();
    await januaryCharge(store, 'pay_full', 10_000);
    await new WebhookProcessor({ store }).process(
      event('payment.refunded', { gatewayId: 'pay_full', amount: 10_000, currency: 'brl' }),
    );

    expect((await store.findPaymentByGatewayId('pay_full'))?.status).toBe('refunded');
    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(0);
    expect(await store.netRevenue({ from: JAN_START, to: FEB_START })).toBe(0);
  });

  it('windows on paid_at exactly as revenue does', async () => {
    // Same rows, same window, one subtraction — the ONLY difference between the two must be
    // the figure summed. A net revenue that quietly counted a different set of rows would be a
    // second bug wearing the fix's name.
    const store = new InMemoryBillingStore();
    await januaryCharge(store, 'pay_jan', 10_000);
    await store.savePayment({
      gatewayId: 'pay_mar',
      provider: 'asaas',
      status: 'paid',
      amount: 8_000,
      currency: 'brl',
      paidAt: MARCH,
      refundedAmount: 1_000,
    });
    // Paid, but with no settlement date: in no window at all, in either figure.
    await store.savePayment({
      gatewayId: 'pay_undated',
      provider: 'asaas',
      status: 'paid',
      amount: 5_000,
      currency: 'brl',
      refundedAmount: 500,
    });

    expect(await store.netRevenue({ from: JAN_START, to: FEB_START })).toBe(10_000);
    expect(await store.netRevenue({ from: FEB_START })).toBe(7_000);
    // Unwindowed, the undated row counts — it is revenue, it just cannot be filed in a month.
    expect(await store.netRevenue({})).toBe(21_500);
    expect(await store.revenue({})).toBe(23_000);
  });

  it('is zero, not NaN, over a window with nothing in it', async () => {
    const store = new InMemoryBillingStore();
    expect(await store.netRevenue({ from: JAN_START, to: FEB_START })).toBe(0);
  });
});

describe('billingOverview revenue metrics', () => {
  async function overviewOf(store: InMemoryBillingStore) {
    const result = await billingOverview(store, { from: JAN_START, to: FEB_START });
    return new Map(result.metrics.map((metric) => [metric.key, metric]));
  }

  it('publishes gross AND net as separate metrics', async () => {
    const store = new InMemoryBillingStore();
    await januaryCharge(store, 'pay_1', 10_000);
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
      refundedAmount: 1_000,
    });

    const metrics = await overviewOf(store);
    expect(metrics.get('revenue')?.value).toBe(10_000);
    expect(metrics.get('net_revenue')?.value).toBe(9_000);
  });

  it('labels both so a reader cannot mistake one for the other', async () => {
    // The tile that said "Revenue" over a gross figure is the whole bug at the display layer:
    // the number was right and the word was not. Either label naming its figure is the fix, so
    // both are asserted — and asserted as distinct, because two tiles labelled the same way
    // would be worse than one.
    const metrics = await overviewOf(new InMemoryBillingStore());
    const gross = metrics.get('revenue')?.label ?? '';
    const net = metrics.get('net_revenue')?.label ?? '';

    expect(gross).toMatch(/gross/i);
    expect(net).toMatch(/net/i);
    expect(gross).not.toBe(net);
  });
});
