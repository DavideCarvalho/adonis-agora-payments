import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * With eighteen gateways configurable at once, "what is failing on Asaas" is a different
 * question from "what is failing" — and without a provider filter the dashboard had to page
 * the whole table and filter in memory, which silently truncates on a large install.
 */
describe('provider filter', () => {
  let store: InMemoryBillingStore;

  beforeEach(async () => {
    store = new InMemoryBillingStore();
    for (const [gatewayId, provider, status] of [
      ['pi_1', 'stripe', 'paid'],
      ['pi_2', 'stripe', 'failed'],
      ['pay_1', 'asaas', 'failed'],
    ] as const) {
      await store.savePayment({ gatewayId, provider, status, amount: 100, currency: 'brl' });
    }
    for (const [gatewayId, provider, status] of [
      ['sub_1', 'stripe', 'active'],
      ['sub_2', 'asaas', 'past_due'],
    ] as const) {
      await store.saveSubscription({
        gatewayId,
        provider,
        customerId: 'cus_1',
        status,
        planId: 'p',
      });
    }
    for (const [id, provider] of [
      ['evt_1', 'stripe'],
      ['evt_2', 'asaas'],
    ] as const) {
      await store.recordWebhookEvent({
        gatewayEventId: id,
        provider,
        type: 'payment.succeeded',
        payload: {},
      });
    }
  });

  it('narrows payments to one gateway', async () => {
    expect(
      (await store.listPayments({ provider: 'stripe' })).map((r) => r.gatewayId).sort(),
    ).toEqual(['pi_1', 'pi_2']);
  });

  it('combines with the status filter rather than replacing it', async () => {
    const failed = await store.listPayments({ provider: 'stripe', status: 'failed' });
    expect(failed.map((r) => r.gatewayId)).toEqual(['pi_2']);
  });

  it('narrows subscriptions and ledger events too', async () => {
    expect((await store.listSubscriptions({ provider: 'asaas' })).map((r) => r.gatewayId)).toEqual([
      'sub_2',
    ]);
    expect(
      (await store.listWebhookEvents({ provider: 'asaas' })).map((r) => r.gatewayEventId),
    ).toEqual(['evt_2']);
  });

  it('returns every provider when the filter is absent', async () => {
    expect(await store.listPayments({})).toHaveLength(3);
  });
});
