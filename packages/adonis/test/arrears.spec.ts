import { describe, expect, it } from 'vitest';
import { arrears } from '../src/billing/arrears.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * "Is this payer behind, and since when?" — for a subscription the GATEWAY drives.
 *
 * The three fields that would answer this directly (`renewalFailureCount`, `lastRenewalError`,
 * `lastRenewalAttemptAt`) are written by this library's renewal pass, which only runs in
 * `managed` mode. In `gateway` mode — the default — they stay null forever and the answer has
 * to be walked out of `billing_payments`. These tests pin the part that is easy to get wrong
 * and expensive when wrong: which END of the failure run dates the arrears.
 */

function storeAt(): { store: InMemoryBillingStore; at: (iso: string) => void } {
  const store = new InMemoryBillingStore();
  let clock = new Date('2026-01-01T00:00:00Z');
  store.now = () => clock;
  return { store, at: (iso: string) => (clock = new Date(iso)) };
}

const charge = (over: Record<string, unknown> = {}) => ({
  gatewayId: `pay_${Math.random().toString(36).slice(2)}`,
  provider: 'asaas',
  status: 'paid' as const,
  amount: 34_500,
  currency: 'BRL',
  externalReference: 'clinic-1',
  ...over,
});

describe('arrears', () => {
  it('a payer with no charges at all is up to date, not overdue', async () => {
    const { store } = storeAt();
    // A subscription created minutes ago has generated nothing yet. Reporting it as overdue
    // would dun a customer on their first day.
    expect(await arrears({ store, externalReference: 'clinic-1' })).toEqual({
      inArrears: false,
      since: null,
      failedCount: 0,
      lastPaidAt: null,
    });
  });

  it('dates the arrears from the START of the failure run, not the latest retry', async () => {
    const { store, at } = storeAt();
    at('2026-01-05T00:00:00Z');
    await store.savePayment(charge({ paidAt: new Date('2026-01-05T00:00:00Z') }));
    // The gateway's dunning: one bill, retried for three weeks. Each attempt is another row.
    at('2026-02-05T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));
    at('2026-02-12T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));
    at('2026-02-26T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));

    const status = await arrears({ store, externalReference: 'clinic-1' });
    expect(status.inArrears).toBe(true);
    expect(status.failedCount).toBe(3);
    // 05 Feb, not 26 Feb. Dating from the newest attempt resets the clock on exactly the payer
    // who is furthest behind — the customer a dunning rule most needs to catch.
    expect(status.since?.toISOString()).toBe('2026-02-05T00:00:00.000Z');
    expect(status.lastPaidAt?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('a payment after the failures clears the arrears', async () => {
    const { store, at } = storeAt();
    at('2026-02-05T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));
    at('2026-02-12T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));
    at('2026-02-14T00:00:00Z');
    await store.savePayment(charge({ paidAt: new Date('2026-02-14T00:00:00Z') }));

    const status = await arrears({ store, externalReference: 'clinic-1' });
    expect(status.inArrears).toBe(false);
    expect(status.failedCount).toBe(0);
    expect(status.since).toBeNull();
    expect(status.lastPaidAt?.toISOString()).toBe('2026-02-14T00:00:00.000Z');
  });

  it('counts only the CURRENT run, not every failure in history', async () => {
    const { store, at } = storeAt();
    // An old rough patch that was settled...
    at('2026-01-05T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));
    at('2026-01-08T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));
    at('2026-01-10T00:00:00Z');
    await store.savePayment(charge({ paidAt: new Date('2026-01-10T00:00:00Z') }));
    // ...and a new one, unrelated.
    at('2026-03-05T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));

    const status = await arrears({ store, externalReference: 'clinic-1' });
    expect(status.failedCount).toBe(1);
    expect(status.since?.toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });

  it('does not mix payers: the reference match is exact', async () => {
    const { store, at } = storeAt();
    at('2026-02-05T00:00:00Z');
    await store.savePayment(charge({ externalReference: 'clinic-1', status: 'failed' }));
    await store.savePayment(charge({ externalReference: 'clinic-12', status: 'failed' }));

    const status = await arrears({ store, externalReference: 'clinic-1' });
    expect(status.failedCount).toBe(1);
    // `clinic-1` must not swallow `clinic-12`'s failures via a prefix match.
    expect(await arrears({ store, externalReference: 'clinic-12' })).toMatchObject({
      failedCount: 1,
    });
  });

  it('a pending charge is not a failed one', async () => {
    const { store, at } = storeAt();
    at('2026-02-05T00:00:00Z');
    await store.savePayment(charge({ status: 'failed' }));
    // Pix issued, waiting on the payer. Overdue by the due date, maybe — but not FAILED, and
    // this helper answers only what the ledger says.
    at('2026-02-20T00:00:00Z');
    await store.savePayment(charge({ status: 'pending' }));

    const status = await arrears({ store, externalReference: 'clinic-1' });
    expect(status.inArrears).toBe(false);
  });
});

describe('payments.arrears', () => {
  it('resolves the configured store so callers never handle one', async () => {
    // The Adonis-facing path: an application asks the manager, not a free function it has
    // to feed a store into.
    const store = new InMemoryBillingStore();
    store.now = () => new Date('2026-02-05T00:00:00Z');
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'failed',
      amount: 39_000,
      currency: 'BRL',
      externalReference: 'clinic-1',
    });

    const manager = new PaymentsManager({ drivers: new Map(), store: () => store });
    const status = await manager.arrears({ externalReference: 'clinic-1' });
    expect(status.inArrears).toBe(true);
    expect(status.failedCount).toBe(1);
  });

  it('says which config knob is missing when billing is off', async () => {
    const manager = new PaymentsManager({ drivers: new Map() });
    await expect(manager.arrears({ externalReference: 'clinic-1' })).rejects.toThrow(
      /billing store/i,
    );
  });
});
