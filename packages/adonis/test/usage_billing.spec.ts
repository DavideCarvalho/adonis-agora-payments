import { describe, expect, it } from 'vitest';
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
