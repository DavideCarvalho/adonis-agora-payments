import { describe, expect, it, vi } from 'vitest';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';

/**
 * `saveSubscription` must WRITE what its contract accepts.
 *
 * This exists because of a bug that got all the way to a release: `externalReference` was
 * added to the `BillingStore` contract, to `SubscriptionListItem`, to the `listSubscriptions`
 * filter and to `InMemoryBillingStore` — but not to the Lucid store's `saveSubscription`.
 * The type-checked surface was complete and the write was missing, so every subscription
 * persisted with a null reference and became unfindable by the app that created it, through
 * the very query added to find it.
 *
 * Nothing caught it: the store's own tests mock the model, the in-memory store had the field,
 * and no test round-tripped a save through the real Lucid path. So this asserts the thing a
 * mock cannot lie about — what got ASSIGNED to the row.
 */

/** A stand-in row that records assignments, so the test sees the write, not a query result. */
function fakeModel() {
  const rows: Array<Record<string, unknown>> = [];
  class FakeSubscription {
    saved = false;
    async save(): Promise<void> {
      this.saved = true;
    }
    constructor() {
      rows.push(this as unknown as Record<string, unknown>);
    }
  }
  return { FakeSubscription, rows };
}

function storeWith(FakeSubscription: unknown): LucidBillingStore {
  const store = new LucidBillingStore({
    subscriptionModel: FakeSubscription as never,
  });
  // The schema gate would try to touch a database; this test is about field assignment.
  vi.spyOn(store, 'ensureSchema').mockResolvedValue(undefined);
  vi.spyOn(store, 'findSubscriptionByGatewayId').mockResolvedValue(null as never);
  return store;
}

describe('LucidBillingStore.saveSubscription writes what it accepts', () => {
  it('persists externalReference — the id the app routes on', async () => {
    const { FakeSubscription, rows } = fakeModel();
    const store = storeWith(FakeSubscription);

    await store.saveSubscription({
      gatewayId: 'sub_1',
      provider: 'asaas',
      customerId: 'cus_1',
      status: 'active',
      planId: 'essencial',
      externalReference: 'clinic-42',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalReference).toBe('clinic-42');
  });

  it('leaves a stored reference alone when a later save omits it', async () => {
    // `subscription.canceled` carries no external reference. Writing `null` through would
    // erase the only key the row can be found by, right when someone is looking for it.
    const { FakeSubscription, rows } = fakeModel();
    const store = new LucidBillingStore({ subscriptionModel: FakeSubscription as never });
    vi.spyOn(store, 'ensureSchema').mockResolvedValue(undefined);

    const existing = { externalReference: 'clinic-42' } as Record<string, unknown>;
    existing.save = async () => {};
    vi.spyOn(store, 'findSubscriptionByGatewayId').mockResolvedValue(existing as never);

    await store.saveSubscription({
      gatewayId: 'sub_1',
      provider: 'asaas',
      customerId: 'cus_1',
      status: 'canceled',
      planId: 'essencial',
    });

    expect(existing.externalReference).toBe('clinic-42');
    expect(rows).toHaveLength(0);
  });

  it('clears it on an explicit null', async () => {
    const { FakeSubscription } = fakeModel();
    const store = new LucidBillingStore({ subscriptionModel: FakeSubscription as never });
    vi.spyOn(store, 'ensureSchema').mockResolvedValue(undefined);

    const existing = { externalReference: 'clinic-42' } as Record<string, unknown>;
    existing.save = async () => {};
    vi.spyOn(store, 'findSubscriptionByGatewayId').mockResolvedValue(existing as never);

    await store.saveSubscription({
      gatewayId: 'sub_1',
      provider: 'asaas',
      customerId: 'cus_1',
      status: 'active',
      planId: 'essencial',
      externalReference: null,
    });

    expect(existing.externalReference).toBeNull();
  });
});
