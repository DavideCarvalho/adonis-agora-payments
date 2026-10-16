import { describe, expect, it } from 'vitest';
import type { BillingStore } from '../src/billing/billing_store.js';
import type { SubscriptionRow } from '../src/billing/mixins/with_subscription.js';
import { usagePeriodFor, usageRemaining, usageTotal } from '../src/billing/usage.js';
import { PaymentsManager } from '../src/payments_manager.js';
import {
  InMemoryBillingStore,
  type InMemorySubscriptionRow,
} from '../src/testing/in_memory_billing_store.js';

const at = (iso: string) => new Date(iso);

/** A free-plan row: a subscription the app tracks, with nothing behind it at any gateway. */
function freeRow(overrides: Partial<InMemorySubscriptionRow> = {}): InMemorySubscriptionRow {
  return {
    id: 'sub_free',
    gatewayId: null,
    provider: 'local',
    customerId: 'cus_free',
    status: 'active',
    planId: 'free',
    trialEndsAt: null,
    endsAt: null,
    payload: {},
    createdAt: at('2026-01-31T00:00:00.000Z'),
    managed: false,
    cycle: 'MONTHLY',
    ...overrides,
  };
}

describe('usage scoped to an application resource', () => {
  it('records the scope and filters on both halves of it', async () => {
    const store = new InMemoryBillingStore();
    const project = { type: 'project', id: 'p1' };

    const row = await store.recordUsage({ scope: project, meter: 'ai_chat', quantity: 2 });
    expect(row).toMatchObject({ scopeType: 'project', scopeId: 'p1', subscriptionId: null });

    await store.recordUsage({ scope: project, meter: 'ai_chat', quantity: 3 });
    await store.recordUsage({ scope: project, meter: 'exports', quantity: 1 });
    // Same id under another type, and an unscoped row: neither is the project's.
    await store.recordUsage({
      scope: { type: 'workspace', id: 'p1' },
      meter: 'ai_chat',
      quantity: 50,
    });
    await store.recordUsage({ meter: 'ai_chat', quantity: 100 });

    expect(await store.usageReport({ scope: project })).toEqual([
      { meter: 'ai_chat', quantity: 5 },
      { meter: 'exports', quantity: 1 },
    ]);
  });

  it('narrows a subscription rather than replacing it', async () => {
    // One owner subscription, several projects under it.
    const store = new InMemoryBillingStore();
    await store.recordUsage({
      subscriptionId: 'sub_owner',
      scope: { type: 'project', id: 'p1' },
      meter: 'ai_chat',
      quantity: 4,
    });
    await store.recordUsage({
      subscriptionId: 'sub_owner',
      scope: { type: 'project', id: 'p2' },
      meter: 'ai_chat',
      quantity: 6,
    });

    expect(await usageTotal(store, { meter: 'ai_chat', subscriptionId: 'sub_owner' })).toBe(10);
    expect(
      await usageTotal(store, {
        meter: 'ai_chat',
        subscriptionId: 'sub_owner',
        scope: { type: 'project', id: 'p2' },
      }),
    ).toBe(6);
  });

  it('answers what is left under a limit over an explicit window', async () => {
    const store = new InMemoryBillingStore();
    const scope = { type: 'project', id: 'p1' };
    await store.recordUsage({
      scope,
      meter: 'ai_chat',
      quantity: 30,
      recordedAt: at('2026-09-02T00:00:00Z'),
    });
    await store.recordUsage({
      scope,
      meter: 'ai_chat',
      quantity: 99,
      recordedAt: at('2026-08-20T00:00:00Z'),
    });

    const window = { from: at('2026-09-01T00:00:00Z'), to: at('2026-10-01T00:00:00Z') };
    expect(
      await usageRemaining(store, { meter: 'ai_chat', scope, limit: 50, period: window }),
    ).toEqual({
      meter: 'ai_chat',
      used: 30,
      limit: 50,
      remaining: 20,
      exceeded: false,
      ...window,
    });
    // Past the limit: `remaining` floors at zero and `exceeded` says so.
    expect(await usageRemaining(store, { meter: 'ai_chat', scope, limit: 100 })).toMatchObject({
      used: 129,
      remaining: 0,
      exceeded: true,
      from: null,
      to: null,
    });
  });
});

describe('usagePeriodFor — the billing cycle a usage quota resets on', () => {
  it('uses the stored period when it is current', () => {
    const period = usagePeriodFor(
      {
        cycle: 'MONTHLY',
        currentPeriodStart: at('2026-09-10T00:00:00Z'),
        currentPeriodEnd: at('2026-10-10T00:00:00Z'),
      },
      at('2026-09-20T00:00:00Z'),
    );
    expect(period).toEqual({ from: at('2026-09-10T00:00:00Z'), to: at('2026-10-10T00:00:00Z') });
  });

  it('steps a stale period forward by the cycle, from the anchor, without clamp drift', () => {
    // A free row nothing renews: its stored period ended months ago. Anchored on 31 January,
    // the April cycle runs 31 March → 30 April, not 28 March → 28 April.
    const period = usagePeriodFor(
      {
        cycle: 'MONTHLY',
        currentPeriodStart: at('2026-01-31T00:00:00Z'),
        currentPeriodEnd: at('2026-02-28T00:00:00Z'),
      },
      at('2026-04-15T00:00:00Z'),
    );
    expect(period).toEqual({ from: at('2026-03-31T00:00:00Z'), to: at('2026-04-30T00:00:00Z') });
  });

  it('anchors on createdAt when no period was ever stored, accepting Luxon-like dates', () => {
    const period = usagePeriodFor(
      { cycle: 'WEEKLY', createdAt: { toJSDate: () => at('2024-01-01T00:00:00Z') } },
      at('2026-09-17T12:00:00Z'),
    );
    expect(period).toEqual({ from: at('2026-09-14T00:00:00Z'), to: at('2026-09-21T00:00:00Z') });
  });

  it('refuses to guess a window from a row with no cycle and no period', () => {
    expect(() => usagePeriodFor({ createdAt: at('2026-01-01T00:00:00Z') })).toThrow(
      /Cannot derive a usage period/,
    );
  });
});

describe('free plan — a subscription row with no gateway id', () => {
  it('types gatewayId as nullable on the mixin row', () => {
    const row: Pick<SubscriptionRow, 'gatewayId'> = { gatewayId: null };
    expect(row.gatewayId).toBeNull();
  });

  it('meters a project against the free row’s cycle through payments.usage()', async () => {
    const store = new InMemoryBillingStore();
    const free = freeRow();
    store.managedSubscriptions.set(free.id, free);
    const payments = new PaymentsManager({
      drivers: new Map(),
      store: () => store as unknown as BillingStore,
    });
    const usage = payments.usage();
    const scope = { type: 'project', id: 'p_free' };

    await usage.record({
      scope,
      meter: 'ai_chat',
      quantity: 3,
      recordedAt: at('2026-09-30T23:00:00Z'),
    });
    await usage.record({
      scope,
      meter: 'ai_chat',
      quantity: 4,
      recordedAt: at('2026-10-01T00:00:00Z'),
    });

    const now = at('2026-10-16T00:00:00Z');
    // Anchored on 31 January: the October cycle starts on the 31st clamped to 30 September.
    expect(await usage.period(free.id, now)).toEqual({
      from: at('2026-09-30T00:00:00Z'),
      to: at('2026-10-31T00:00:00Z'),
    });
    expect(
      await usage.remaining({
        meter: 'ai_chat',
        scope,
        limit: 5,
        period: { subscription: free.id, at: now },
      }),
    ).toMatchObject({ used: 7, remaining: 0, exceeded: true });
  });

  it('says which subscription is missing rather than summing all time', async () => {
    const store = new InMemoryBillingStore();
    await expect(
      usageTotal(store, { meter: 'ai_chat', period: { subscription: 'nope' } }),
    ).rejects.toThrow(/No subscription nope/);
  });

  it('fails loudly when no billing store is configured', async () => {
    const payments = new PaymentsManager({ drivers: new Map() });
    await expect(payments.usage().total({ meter: 'ai_chat' })).rejects.toThrow(
      /needs the billing store/,
    );
  });
});
