import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import type { BillingOwnerScope } from '../../src/billing/owner_scope.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * The organization (tenant) scope as SQL, against a real Postgres: the `owners` filter is a
 * subquery over `billing_customers`, and `NOT IN` over a subquery is exactly the kind of thing that
 * means something else in SQL than in the in-memory store.
 */
describe('tenant scope (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;
  const paidAt = new Date('2026-11-01T12:00:00.000Z');

  const scope = (ids: string[], includeNull = false): BillingOwnerScope => ({
    tenantOwnerTypes: ['Organization'],
    tenantIds: ids,
    includeNull,
  });

  beforeAll(async () => {
    database = await createIntegrationDatabase('tenant_scope_spec');
    store = new LucidBillingStore();
    for (const [customer, type, id] of [
      ['cus_a', 'Organization', 'a'],
      ['cus_b', 'Organization', 'b'],
      ['cus_user', 'User', '7'],
      ['cus_orphan', null, null],
    ] as const) {
      await store.saveCustomer({
        gatewayId: customer,
        provider: 'stripe',
        ownerType: type,
        ownerId: id,
      });
    }
    for (const [payment, customer] of [
      ['pay_a', 'cus_a'],
      ['pay_b', 'cus_b'],
      ['pay_user', 'cus_user'],
      ['pay_orphan', 'cus_orphan'],
      ['pay_nocustomer', null],
    ] as const) {
      await store.savePayment({
        gatewayId: payment,
        provider: 'stripe',
        status: 'paid',
        amount: 1000,
        currency: 'BRL',
        customerId: customer,
        paidAt,
      });
    }
    await store.saveSubscription({
      gatewayId: 'sub_a',
      provider: 'stripe',
      status: 'active',
      planId: 'pro',
      customerId: 'cus_a',
    });
    await store.saveSubscription({
      gatewayId: 'sub_b',
      provider: 'stripe',
      status: 'active',
      planId: 'pro',
      customerId: 'cus_b',
    });
    await store.saveDispute({
      gatewayId: 'dp_b',
      paymentGatewayId: 'pay_b',
      provider: 'stripe',
      status: 'open',
    });
    await store.recordUsage({ customerId: 'cus_a', meter: 'ai', quantity: 5 });
    await store.recordUsage({ customerId: 'cus_b', meter: 'ai', quantity: 9 });
  });

  afterAll(async () => {
    await database?.teardown();
  });

  const ids = (rows: Array<{ gatewayId: string | null }>) =>
    rows.map((row) => row.gatewayId).sort();

  it('a tenant sees its payments, subscriptions, customers, usage and revenue only', async () => {
    expect(ids(await store.listPayments({ owners: scope(['a']) }))).toEqual(['pay_a']);
    expect(ids(await store.listSubscriptions({ owners: scope(['a']) }))).toEqual(['sub_a']);
    expect(ids(await store.listCustomers({ owners: scope(['a']) }))).toEqual(['cus_a']);
    expect(await store.usageReport({ owners: scope(['a']) })).toEqual([
      { meter: 'ai', quantity: 5 },
    ]);
    expect(await store.revenue({ owners: scope(['a']) })).toBe(1000);
    expect(await store.netRevenue({ owners: scope(['a']) })).toBe(1000);
    expect(await store.countActiveSubscriptions({ owners: scope(['a']) })).toBe(1);
    expect(await store.countPayments({ owners: scope(['a']) })).toBe(1);
  });

  it('rows of no tenant: customers with no owner, a user owner, or no customer', async () => {
    expect(ids(await store.listPayments({ owners: scope([], true) }))).toEqual([
      'pay_nocustomer',
      'pay_orphan',
      'pay_user',
    ]);
    expect(ids(await store.listCustomers({ owners: scope([], true) }))).toEqual([
      'cus_orphan',
      'cus_user',
    ]);
    expect(ids(await store.listPayments({ owners: scope(['a'], true) }))).toEqual([
      'pay_a',
      'pay_nocustomer',
      'pay_orphan',
      'pay_user',
    ]);
  });

  it('disputes follow their payment’s customer', async () => {
    expect(ids(await store.listDisputes({ owners: scope(['b']) }))).toEqual(['dp_b']);
    expect(await store.listDisputes({ owners: scope(['a']) })).toEqual([]);
    expect(await store.countDisputes({ owners: scope(['a', 'b']) })).toBe(1);
  });

  it('an empty scope is empty, and no scope is everything', async () => {
    expect(await store.listPayments({ owners: scope([]) })).toEqual([]);
    expect(await store.listPayments({})).toHaveLength(5);
  });
});
