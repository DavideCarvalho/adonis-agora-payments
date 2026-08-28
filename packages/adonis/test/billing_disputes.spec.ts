import { describe, expect, it } from 'vitest';
import { OPEN_DISPUTE_STATUSES } from '../src/billing/billing_store.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * The `billing_disputes` contract, driven through the in-memory store.
 *
 * A dispute is the one piece of billing state with a price tag on its absence: the response
 * deadline arrives on a webhook, and before this table it was published once on the
 * diagnostics bus and then gone. An operator asking "which windows close this week" had to
 * open every gateway's own dashboard, and a window that closes unanswered loses the money by
 * default rather than on the merits.
 *
 * The Lucid implementation is exercised against a real Postgres in
 * `test/integration/lucid_billing_store.spec.ts`; these cover the behaviour both
 * implementations must share.
 */

const T0 = new Date('2026-08-27T12:00:00.000Z');
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(T0.getTime() + h * HOUR);

function storeWithClock(): InMemoryBillingStore {
  const store = new InMemoryBillingStore();
  let tick = 0;
  store.now = () => new Date(T0.getTime() + 1000 * tick++);
  return store;
}

const open = (
  store: InMemoryBillingStore,
  gatewayId: string,
  extra: Partial<{
    paymentGatewayId: string;
    provider: string;
    status: string;
    reason: string | null;
    amount: number | null;
    currency: string | null;
    evidenceDueBy: Date | null;
  }> = {},
) =>
  store.saveDispute({
    gatewayId,
    paymentGatewayId: `pi_${gatewayId}`,
    provider: 'stripe',
    status: 'open',
    ...extra,
  });

describe('saveDispute', () => {
  it('upserts on the dispute gateway id rather than inserting twice', async () => {
    const store = storeWithClock();
    await open(store, 'dp_1', { status: 'warning' });
    await open(store, 'dp_1', { status: 'open' });

    expect(await store.countDisputes({})).toBe(1);
    expect((await store.findDisputeByGatewayId('dp_1'))?.status).toBe('open');
  });

  it('keeps the deadline a later event does not carry', async () => {
    const store = storeWithClock();
    // The event that OPENS a dispute carries the deadline; the one that CLOSES it carries
    // nothing but the outcome. Blanking the window on the close would destroy the only
    // record of what was answered — and the deadline is why the table exists.
    await open(store, 'dp_1', { evidenceDueBy: inHours(48), reason: 'fraudulent' });
    await store.saveDispute({
      gatewayId: 'dp_1',
      paymentGatewayId: 'pi_dp_1',
      provider: 'stripe',
      status: 'lost',
      outcome: 'lost',
      closedAt: inHours(50),
    });

    const row = await store.findDisputeByGatewayId('dp_1');
    expect(row?.evidenceDueBy).toEqual(inHours(48));
    expect(row?.reason).toBe('fraudulent');
    expect(row?.outcome).toBe('lost');
    expect(row?.closedAt).toEqual(inHours(50));
  });

  it('still clears a field passed explicitly as null', async () => {
    const store = storeWithClock();
    await open(store, 'dp_1', { evidenceDueBy: inHours(48) });
    await open(store, 'dp_1', { evidenceDueBy: null });
    expect((await store.findDisputeByGatewayId('dp_1'))?.evidenceDueBy).toBeNull();
  });

  it('never moves openedAt once the dispute has been recorded', async () => {
    const store = storeWithClock();
    const first = await store.saveDispute({
      gatewayId: 'dp_1',
      paymentGatewayId: 'pi_1',
      provider: 'stripe',
      status: 'warning',
      openedAt: T0,
    });
    await store.saveDispute({
      gatewayId: 'dp_1',
      paymentGatewayId: 'pi_1',
      provider: 'stripe',
      status: 'open',
      openedAt: inHours(9),
    });
    // Re-stamping it would make every dispute look brand new and destroy the only measure
    // of how long one has been open.
    expect((await store.findDisputeByGatewayId('dp_1'))?.openedAt).toEqual(first.openedAt);
    expect(first.openedAt).toEqual(T0);
  });
});

describe('findOpenDisputeByPayment', () => {
  it('finds the unresolved dispute against a payment', async () => {
    const store = storeWithClock();
    await open(store, 'dp_1', { paymentGatewayId: 'pi_1', status: 'warning' });
    expect((await store.findOpenDisputeByPayment('pi_1'))?.gatewayId).toBe('dp_1');
  });

  it.each(['won', 'lost', 'canceled', 'expired'])('skips a %s dispute', async (status) => {
    const store = storeWithClock();
    await open(store, 'dp_1', { paymentGatewayId: 'pi_1', status });
    // A fresh chargeback on a payment whose earlier dispute is finished must start its own
    // row, not resurrect the closed one.
    expect(await store.findOpenDisputeByPayment('pi_1')).toBeNull();
  });

  it('answers null for a payment with no dispute', async () => {
    expect(await storeWithClock().findOpenDisputeByPayment('pi_none')).toBeNull();
  });
});

describe('listDisputes', () => {
  it('returns the normalized shape with amount left as integer minor units', async () => {
    const store = storeWithClock();
    await open(store, 'dp_1', {
      paymentGatewayId: 'pi_1',
      amount: 123456,
      currency: 'BRL',
      reason: 'fraudulent',
      evidenceDueBy: inHours(24),
    });
    const [row] = await store.listDisputes({});
    expect(row).toMatchObject({
      gatewayId: 'dp_1',
      paymentGatewayId: 'pi_1',
      provider: 'stripe',
      status: 'open',
      reason: 'fraudulent',
      // NOT 1234.56 — the store never divides.
      amount: 123456,
      currency: 'BRL',
      outcome: null,
    });
    expect(row?.evidenceDueBy).toEqual(inHours(24));
  });

  it('orders newest first and filters by status and provider', async () => {
    const store = storeWithClock();
    await open(store, 'dp_1', { status: 'open' });
    await open(store, 'dp_2', { status: 'warning', provider: 'adyen' });
    await open(store, 'dp_3', { status: 'open' });

    expect((await store.listDisputes({})).map((row) => row.gatewayId)).toEqual([
      'dp_3',
      'dp_2',
      'dp_1',
    ]);
    expect((await store.listDisputes({ status: 'warning' })).map((r) => r.gatewayId)).toEqual([
      'dp_2',
    ]);
    expect((await store.listDisputes({ provider: 'adyen' })).map((r) => r.gatewayId)).toEqual([
      'dp_2',
    ]);
  });

  it('pages', async () => {
    const store = storeWithClock();
    for (const id of ['dp_1', 'dp_2', 'dp_3']) await open(store, id);
    expect((await store.listDisputes({ limit: 1, offset: 1 })).map((r) => r.gatewayId)).toEqual([
      'dp_2',
    ]);
  });
});

describe('countDisputes', () => {
  it('counts by status and creation window', async () => {
    const store = new InMemoryBillingStore();
    store.now = () => new Date(T0.getTime() - 48 * HOUR);
    await open(store, 'dp_old', { status: 'lost' });
    store.now = () => T0;
    await open(store, 'dp_new', { status: 'open' });

    expect(await store.countDisputes({})).toBe(2);
    expect(await store.countDisputes({ status: 'open' })).toBe(1);
    expect(await store.countDisputes({ createdAfter: new Date(T0.getTime() - HOUR) })).toBe(1);
    expect(await store.countDisputes({ createdBefore: new Date(T0.getTime() - HOUR) })).toBe(1);
  });
});

describe('listDisputesDueWithin', () => {
  it('returns the windows closing inside the horizon, soonest first', async () => {
    const store = storeWithClock();
    await open(store, 'dp_far', { evidenceDueBy: inHours(50) });
    await open(store, 'dp_soon', { evidenceDueBy: inHours(6) });
    await open(store, 'dp_mid', { evidenceDueBy: inHours(20) });

    const due = await store.listDisputesDueWithin({ withinHours: 24, now: T0 });
    // Priority order, not arrival order: the window that closes tomorrow outranks the
    // dispute that arrived today.
    expect(due.map((row) => row.gatewayId)).toEqual(['dp_soon', 'dp_mid']);
  });

  it('includes a deadline that has already passed', async () => {
    const store = storeWithClock();
    await open(store, 'dp_overdue', { evidenceDueBy: inHours(-30) });
    const due = await store.listDisputesDueWithin({ withinHours: 1, now: T0 });
    // Dropping it the moment it expires would make the alert go quiet at exactly the moment
    // it became true, and an operator reads silence as resolved.
    expect(due.map((row) => row.gatewayId)).toEqual(['dp_overdue']);
  });

  it('excludes a dispute with no deadline at all', async () => {
    const store = storeWithClock();
    await open(store, 'dp_no_deadline', { evidenceDueBy: null });
    expect(await store.listDisputesDueWithin({ withinHours: 24 * 365, now: T0 })).toEqual([]);
  });

  it.each(['won', 'lost', 'canceled', 'expired'])(
    'excludes a %s dispute even inside the window',
    async (status) => {
      const store = storeWithClock();
      await open(store, 'dp_closed', { status, evidenceDueBy: inHours(1) });
      expect(await store.listDisputesDueWithin({ withinHours: 24, now: T0 })).toEqual([]);
    },
  );

  it.each(OPEN_DISPUTE_STATUSES)('includes a %s dispute', async (status) => {
    const store = storeWithClock();
    await open(store, 'dp_open', { status, evidenceDueBy: inHours(1) });
    expect(
      (await store.listDisputesDueWithin({ withinHours: 24, now: T0 })).map((r) => r.gatewayId),
    ).toEqual(['dp_open']);
  });

  it('filters by provider and pages', async () => {
    const store = storeWithClock();
    await open(store, 'dp_a', { evidenceDueBy: inHours(1) });
    await open(store, 'dp_b', { provider: 'adyen', evidenceDueBy: inHours(2) });
    expect(
      (await store.listDisputesDueWithin({ withinHours: 24, now: T0, provider: 'adyen' })).map(
        (r) => r.gatewayId,
      ),
    ).toEqual(['dp_b']);
    expect(
      (await store.listDisputesDueWithin({ withinHours: 24, now: T0, limit: 1, offset: 1 })).map(
        (r) => r.gatewayId,
      ),
    ).toEqual(['dp_b']);
  });
});

describe('countDisputesDueWithin', () => {
  it('counts the same rows the list returns, unbounded by any page', async () => {
    const store = storeWithClock();
    for (let i = 0; i < 5; i++) await open(store, `dp_${i}`, { evidenceDueBy: inHours(i + 1) });
    await open(store, 'dp_far', { evidenceDueBy: inHours(99) });
    await open(store, 'dp_closed', { status: 'won', evidenceDueBy: inHours(1) });

    // The count decides the exit code of `payments:health`, so it must not saturate at the
    // page size the report happens to print.
    expect(await store.countDisputesDueWithin({ withinHours: 24, now: T0 })).toBe(5);
    expect(
      await store.countDisputesDueWithin({ withinHours: 24, now: T0, provider: 'adyen' }),
    ).toBe(0);
  });
});
