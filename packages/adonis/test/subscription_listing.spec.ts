import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * `countActiveSubscriptions()` answers "how many", which is the wrong question on any day
 * something is wrong. The operational questions are WHICH subscriptions are `past_due` and
 * which are `paused` — a count cannot name a customer to email.
 */
describe('listSubscriptions', () => {
  let store: InMemoryBillingStore;
  const NOW = new Date('2026-08-27T12:00:00.000Z');

  const save = (gatewayId: string, status: string, customerId = 'cus_1') =>
    store.saveSubscription({
      gatewayId,
      provider: 'stripe',
      customerId,
      status,
      planId: 'plan_pro',
    });

  beforeEach(() => {
    store = new InMemoryBillingStore();
    store.now = () => NOW;
  });

  it('names the subscriptions in a status, not just their number', async () => {
    await save('sub_ok', 'active');
    await save('sub_late', 'past_due', 'cus_2');
    await save('sub_late_2', 'past_due', 'cus_3');

    const late = await store.listSubscriptions({ status: 'past_due' });
    expect(late.map((row) => row.customerId).sort()).toEqual(['cus_2', 'cus_3']);
    expect(late[0]?.planId).toBe('plan_pro');
  });

  it('distinguishes paused from active', async () => {
    await save('sub_a', 'active');
    await save('sub_p', 'paused');

    // The whole reason SubscriptionStatus gained `paused`: a paused subscriber is not
    // paying and must not be entitled, so they must not read back as active either.
    expect((await store.listSubscriptions({ status: 'active' })).map((r) => r.gatewayId)).toEqual([
      'sub_a',
    ]);
    expect((await store.listSubscriptions({ status: 'paused' })).map((r) => r.gatewayId)).toEqual([
      'sub_p',
    ]);
  });

  it('returns everything when no status is given, newest first', async () => {
    await save('sub_1', 'active');
    await save('sub_2', 'canceled');
    const all = await store.listSubscriptions({});
    expect(all).toHaveLength(2);
    expect(all[0]?.gatewayId).toBe('sub_2');
  });

  it('pages', async () => {
    for (let i = 0; i < 5; i++) await save(`sub_${i}`, 'active');
    expect(await store.listSubscriptions({ limit: 2 })).toHaveLength(2);
    expect(await store.listSubscriptions({ limit: 2, offset: 4 })).toHaveLength(1);
  });

  it('keeps the original creation time across an upsert', async () => {
    await save('sub_1', 'trialing');
    store.now = () => new Date(NOW.getTime() + 86_400_000);
    await save('sub_1', 'active');

    // A subscription's creation time is when it was first recorded, not when its status
    // last changed — otherwise every webhook reorders the list.
    const [row] = await store.listSubscriptions({});
    expect(row?.createdAt).toEqual(NOW);
    expect(row?.status).toBe('active');
  });

  it('counts by status and window', async () => {
    await save('sub_1', 'active');
    await save('sub_2', 'past_due');
    expect(await store.countSubscriptions({})).toBe(2);
    expect(await store.countSubscriptions({ status: 'past_due' })).toBe(1);
    expect(
      await store.countSubscriptions({ status: 'active', createdBefore: NOW }),
      'createdBefore is strictly before — a row written AT the cutoff is not older than it',
    ).toBe(0);
  });
});
