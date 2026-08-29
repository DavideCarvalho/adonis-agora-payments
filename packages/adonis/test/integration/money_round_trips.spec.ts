import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { WebhookProcessor } from '../../src/billing/webhook_processor.js';
import type { WebhookEvent } from '../../src/types.js';
import { type IntegrationDatabase, createIntegrationDatabase } from './harness.js';

/**
 * The two money round trips, against a real Postgres and the real published migration.
 *
 * Both are invisible to the unit suite for the same reason: they are about what SQL a
 * windowed aggregate emits and what the database does with a `NULL` in it. `revenue()`
 * filters `status = 'paid' AND paid_at >= from AND paid_at < to`, and NULL satisfies neither
 * comparison — so a payment restored to `paid` with `paid_at` cleared is not "slightly off",
 * it is gone from every windowed figure. The in-memory store can only ever agree with itself.
 */
describe('paid_at and refunded_amount (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  const JANUARY = new Date('2026-01-15T10:00:00.000Z');
  const JAN_START = new Date('2026-01-01T00:00:00.000Z');
  const FEB_START = new Date('2026-02-01T00:00:00.000Z');

  const event = (type: string, data: Record<string, unknown>): WebhookEvent => ({
    id: `evt_${type}_${Math.random().toString(16).slice(2)}`,
    provider: 'asaas',
    type,
    data,
    raw: {},
  });

  beforeAll(async () => {
    database = await createIntegrationDatabase('money_round_trips_spec');
    store = new LucidBillingStore();
  });

  afterAll(async () => {
    await database?.teardown();
  });

  it('keeps a won dispute inside the ORIGINAL revenue window', async () => {
    await store.savePayment({
      gatewayId: 'pay_dispute',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
      customerId: 'cus_1',
      paidAt: JANUARY,
    });
    const processor = new WebhookProcessor({ store });

    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(10_000);

    await processor.process(
      event('payment.disputed', { gatewayId: 'pay_dispute', amount: 10_000, currency: 'brl' }),
    );
    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(0);

    await processor.process(
      event('payment.dispute_closed', { gatewayId: 'pay_dispute', outcome: 'won' }),
    );

    const row = await store.findPaymentByGatewayId('pay_dispute');
    expect(row?.status).toBe('paid');
    // The assertion the whole column exists for: neither event carried a settlement date, and
    // neither erased the one that was there.
    expect(row?.paidAt?.toJSDate()).toEqual(JANUARY);
    expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(10_000);
    expect(await store.revenue({ from: FEB_START })).toBe(0);
  });

  it('a paid row with no paid_at is in no window at all', async () => {
    // Not a curiosity — it is the shape the bug produced, and the reason it was silent: the
    // row reads `paid` in the dashboard while contributing nothing to any monthly figure.
    await store.savePayment({
      gatewayId: 'pay_undated',
      provider: 'asaas',
      status: 'paid',
      amount: 7_000,
      currency: 'brl',
    });

    const windowed = await store.revenue({ from: JAN_START, to: FEB_START });
    const unwindowed = await store.revenue({});
    expect(windowed).toBe(10_000);
    expect(unwindowed).toBe(17_000);
  });

  it('stores a partial refund as minor units on the real column', async () => {
    await store.savePayment({
      gatewayId: 'pay_partial',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
      paidAt: JANUARY,
    });
    await new WebhookProcessor({ store }).process(
      event('payment.updated', {
        gatewayId: 'pay_partial',
        amount: 10_000,
        currency: 'brl',
        status: 'paid',
        refundedAmount: 1_000,
      }),
    );

    const row = await store.findPaymentByGatewayId('pay_partial');
    // BIGINT comes back as a string from node-postgres unless the model consumes it.
    expect(row?.refundedAmount).toBe(1_000);
    expect(typeof row?.refundedAmount).toBe('number');
    expect(row?.amount).toBe(10_000);
    expect(row?.status).toBe('paid');
    // And it survives the next write that says nothing about refunds — the leave-alone rule.
    await store.savePayment({
      gatewayId: 'pay_partial',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
    });
    expect((await store.findPaymentByGatewayId('pay_partial'))?.refundedAmount).toBe(1_000);
  });

  it('reads the refunded amount back through listPayments', async () => {
    // No raw SQL at the edge: the figure has to be reachable through the store's own read.
    const rows = await store.listPayments({ status: 'paid' });
    const partial = rows.find((row) => row.gatewayId === 'pay_partial');
    expect(partial?.refundedAmount).toBe(1_000);
    const undated = rows.find((row) => row.gatewayId === 'pay_undated');
    expect(undated?.refundedAmount).toBeNull();
  });

  /**
   * Net revenue, against the real column and the real `NULL`s.
   *
   * By this point the table holds exactly the mix that matters: `pay_dispute` and
   * `pay_undated` have `refunded_amount = NULL` (nothing ever refunded them), `pay_partial`
   * has `1000`. That is not a contrived fixture — it is what every upgraded install looks
   * like — and it is the mix that decides whether `SUM(amount - refunded_amount)` is a figure
   * or a `NULL`, which is a question the in-memory store is structurally unable to ask.
   */
  describe('netRevenue', () => {
    it('subtracts the refunded part while revenue stays gross', async () => {
      // pay_dispute 10000 (nothing back) + pay_partial 10000 − 1000.
      expect(await store.netRevenue({ from: JAN_START, to: FEB_START })).toBe(19_000);
      expect(await store.revenue({ from: JAN_START, to: FEB_START })).toBe(20_000);
    });

    it('does not let a NULL refunded_amount poison the whole window', async () => {
      // Postgres propagates `NULL` through arithmetic and through `SUM`: without
      // `COALESCE(refunded_amount, 0)` the two untouched rows would drag the entire window to
      // `NULL`, and the store would report zero for an install that took R$200. The assertion
      // that matters is that the two NULL rows are IN the figure at full value.
      const net = await store.netRevenue({ from: JAN_START, to: FEB_START });
      expect(net).not.toBe(0);
      expect(net).toBe(19_000);
      // Unwindowed, `pay_undated` (7000, NULL) joins them.
      expect(await store.netRevenue({})).toBe(26_000);
      expect(await store.revenue({})).toBe(27_000);
    });

    it('comes back as a NUMBER — a BIGINT sum arrives from Postgres as a string', async () => {
      // `amount` is `BIGINT`, so `SUM(...)` is `numeric` and node-postgres hands it over as
      // `'19000'`. Un-consumed it would cross the dashboard API as a string and be divided by
      // the SPA's formatter, which is exactly the class of bug this file exists for.
      const net = await store.netRevenue({ from: JAN_START, to: FEB_START });
      expect(typeof net).toBe('number');
      expect(Number.isInteger(net)).toBe(true);
    });

    it('answers what revenue answers on an install whose table has no such column', async () => {
      // The upgrade order nobody controls: the package is newer than the schema. Asking for a
      // column Postgres does not have raises `column "refunded_amount" does not exist` — on an
      // overview endpoint a browser is merely polling. And the honest answer there is gross:
      // no refund was ever recorded on that install, so there is nothing to subtract.
      await database.db.rawQuery('ALTER TABLE billing_payments DROP COLUMN refunded_amount');
      // A fresh store, so the column probe is not answered from the memo — and one that will
      // NOT put the column back underneath the test.
      const legacy = new LucidBillingStore({}, { autoCreateSchema: false });

      const net = await legacy.netRevenue({});
      expect(net).toBe(await legacy.revenue({}));
      expect(net).toBe(27_000);

      await database.db.rawQuery('ALTER TABLE billing_payments ADD COLUMN refunded_amount BIGINT');
    });

    it('is zero, not NULL, over a window holding nothing', async () => {
      // `SUM` over no rows is `NULL` in SQL, and `NULL` reaching a money tile renders as blank
      // or as `NaN`, never as "you earned nothing".
      const net = await store.netRevenue({
        from: new Date('2020-01-01T00:00:00.000Z'),
        to: new Date('2020-02-01T00:00:00.000Z'),
      });
      expect(net).toBe(0);
    });
  });
});
