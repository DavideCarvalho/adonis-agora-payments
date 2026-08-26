import { describe, expect, it } from 'vitest';
import { billingOverview } from '../src/billing/billing_overview.js';
import { meteredBill, meteredBillForSubscription } from '../src/billing/metered_bill.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

describe('metered usage (usage-based billing)', () => {
  it('records usage events and aggregates them by meter', async () => {
    const store = new InMemoryBillingStore();
    const now = new Date('2026-09-01T12:00:00.000Z');

    await store.recordUsage({
      subscriptionId: 'sub_1',
      meter: 'api_calls',
      quantity: 3,
      recordedAt: now,
    });
    await store.recordUsage({
      subscriptionId: 'sub_1',
      meter: 'api_calls',
      quantity: 2,
      recordedAt: now,
    });
    await store.recordUsage({
      subscriptionId: 'sub_1',
      meter: 'storage_gb',
      quantity: 1,
      recordedAt: now,
    });
    await store.recordUsage({
      subscriptionId: 'sub_2',
      meter: 'api_calls',
      quantity: 10,
      recordedAt: now,
    });

    const report = await store.usageReport({ subscriptionId: 'sub_1' });
    expect(report).toEqual([
      { meter: 'api_calls', quantity: 5 },
      { meter: 'storage_gb', quantity: 1 },
    ]);
  });

  it('filters by meter and by a time window', async () => {
    const store = new InMemoryBillingStore();
    await store.recordUsage({
      customerId: 'cus_1',
      meter: 'api_calls',
      quantity: 2,
      recordedAt: new Date('2026-09-01T10:00:00Z'),
    });
    await store.recordUsage({
      customerId: 'cus_1',
      meter: 'api_calls',
      quantity: 4,
      recordedAt: new Date('2026-09-03T10:00:00Z'),
    });
    await store.recordUsage({
      customerId: 'cus_1',
      meter: 'messages',
      quantity: 7,
      recordedAt: new Date('2026-09-02T10:00:00Z'),
    });

    const windowed = await store.usageReport({
      customerId: 'cus_1',
      meter: 'api_calls',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-02T00:00:00Z'),
    });
    expect(windowed).toEqual([{ meter: 'api_calls', quantity: 2 }]);
  });
});

describe('billingOverview (dashboard foundation)', () => {
  it('aggregates revenue, active subscriptions and usage per meter over a window', async () => {
    const store = new InMemoryBillingStore();
    await store.saveSubscription({
      gatewayId: 'sub_1',
      provider: 'asaas',
      customerId: 'cus_1',
      status: 'active',
      planId: 'pro',
    });
    await store.saveSubscription({
      gatewayId: 'sub_2',
      provider: 'asaas',
      customerId: 'cus_2',
      status: 'canceled',
      planId: 'free',
    });
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'paid',
      amount: 10000,
      currency: 'brl',
      paidAt: new Date('2026-09-02T10:00:00Z'),
    });
    await store.savePayment({
      gatewayId: 'pay_2',
      provider: 'asaas',
      status: 'paid',
      amount: 5000,
      currency: 'brl',
      paidAt: new Date('2026-09-10T10:00:00Z'),
    });
    await store.recordUsage({
      subscriptionId: 'sub_1',
      meter: 'api_calls',
      quantity: 7,
      recordedAt: new Date('2026-09-05T10:00:00Z'),
    });

    const overview = await billingOverview(store, {
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
    });

    const byKey = new Map(overview.metrics.map((m) => [m.key, m.value]));
    expect(byKey.get('revenue')).toBe(15000);
    expect(byKey.get('active_subscriptions')).toBe(1);
    expect(byKey.get('meter:api_calls')).toBe(7);
  });
});

describe('metered bill (period rollup)', () => {
  it('prices usage beyond the included allowance per meter', () => {
    const bill = meteredBill(
      [
        { meter: 'api_calls', quantity: 2500 },
        { meter: 'storage_gb', quantity: 3 },
      ],
      [
        { meter: 'api_calls', rate: 0.5, included: 1000 }, // 1500 billable × 0.5 = 750
        { meter: 'storage_gb', rate: 200 }, // 3 × 200 = 600
      ],
    );
    expect(bill.lines).toEqual([
      { meter: 'api_calls', quantity: 2500, billable: 1500, amount: 750 },
      { meter: 'storage_gb', quantity: 3, billable: 3, amount: 600 },
    ]);
    expect(bill.total).toBe(1350);
  });

  it('does not charge for usage under the included allowance', () => {
    const bill = meteredBill(
      [{ meter: 'api_calls', quantity: 500 }],
      [{ meter: 'api_calls', rate: 1, included: 1000 }],
    );
    expect(bill.lines[0]).toMatchObject({ billable: 0, amount: 0 });
    expect(bill.total).toBe(0);
  });

  it('prices a subscription period straight from the store', async () => {
    const store = new InMemoryBillingStore();
    await store.recordUsage({
      subscriptionId: 'sub_1',
      meter: 'api_calls',
      quantity: 300,
      recordedAt: new Date('2026-09-05T10:00:00Z'),
    });
    await store.recordUsage({
      subscriptionId: 'sub_1',
      meter: 'api_calls',
      quantity: 900,
      recordedAt: new Date('2026-09-20T10:00:00Z'),
    });

    const bill = await meteredBillForSubscription(store, {
      subscriptionId: 'sub_1',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
      rates: [{ meter: 'api_calls', rate: 0.5, included: 1000 }],
    });

    expect(bill.usage).toEqual([{ meter: 'api_calls', quantity: 1200 }]);
    expect(bill.total).toBe(100); // 200 billable × 0.5
  });
});
