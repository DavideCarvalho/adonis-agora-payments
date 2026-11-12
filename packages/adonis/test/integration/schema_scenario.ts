import { expect } from 'vitest';
import type { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';

/**
 * One pass over every kind of read and write the store does: upserts, finds, lists, counts,
 * aggregates (including the raw `SUM`), the payload substring scan, the capability probes and
 * the owner-scope subqueries.
 *
 * Shared by the Postgres and MySQL `billing.schema` specs. Both run it with the tables in a
 * schema (database) that is NOT the connection's default, so a statement that forgot to name
 * the schema fails here instead of quietly reading an empty table somewhere else.
 */
export async function exerciseStore(store: LucidBillingStore): Promise<void> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000);

  await store.saveCustomer({
    gatewayId: 'cus_schema',
    provider: 'stripe',
    ownerType: 'org',
    ownerId: 'org_1',
    email: 'schema@example.com',
  });
  expect((await store.findCustomerByGatewayId('cus_schema'))?.email).toBe('schema@example.com');
  expect(
    (
      await store.listCustomers({
        owners: { tenantOwnerTypes: ['org'], tenantIds: ['org_1'], includeNull: false },
      })
    ).length,
  ).toBe(1);

  await store.saveSubscription({
    gatewayId: 'sub_schema',
    provider: 'stripe',
    customerId: 'cus_schema',
    status: 'active',
    planId: 'pro',
  });
  expect((await store.findSubscriptionByGatewayId('sub_schema'))?.status).toBe('active');
  expect(await store.countActiveSubscriptions()).toBe(1);

  await store.savePayment({
    gatewayId: 'pay_schema',
    provider: 'stripe',
    status: 'paid',
    amount: 1500,
    currency: 'BRL',
    customerId: 'cus_schema',
    externalReference: 'order_schema',
    paidAt: now,
  });
  // A partial refund: the probe for `refunded_amount` must find the column in the schema.
  await store.savePayment({
    gatewayId: 'pay_schema',
    provider: 'stripe',
    status: 'paid',
    amount: 1500,
    currency: 'BRL',
    customerId: 'cus_schema',
    refundedAmount: 500,
  });
  expect((await store.findPaymentByExternalReference('order_schema'))?.gatewayId).toBe(
    'pay_schema',
  );
  expect((await store.listPayments({ externalReference: 'order_schema' })).length).toBe(1);
  expect(await store.revenue({ from: hourAgo })).toBe(1500);
  expect(await store.netRevenue({ from: hourAgo })).toBe(1000);
  expect(
    await store.countPayments({
      createdAfter: hourAgo,
      owners: { tenantOwnerTypes: ['org'], tenantIds: ['org_1'], includeNull: false },
    }),
  ).toBe(1);

  const event = await store.recordWebhookEvent({
    gatewayEventId: 'evt_schema',
    provider: 'stripe',
    type: 'payment.succeeded',
    payload: { id: 'evt_schema', data: 'pay_schema' },
    normalized: { gatewayId: 'pay_schema' },
  });
  expect(event).not.toBeNull();
  await store.markWebhookProcessed(String(event?.id));
  expect((await store.findWebhookEventByGatewayEventId('evt_schema'))?.status).toBe('processed');
  expect((await store.listWebhookEventsForPayment('pay_schema')).length).toBe(1);
  expect(await store.countWebhookEvents({ createdAfter: hourAgo })).toBe(1);

  expect(
    await store.saveDispute({
      gatewayId: 'dp_schema',
      paymentGatewayId: 'pay_schema',
      provider: 'stripe',
      status: 'open',
      evidenceDueBy: new Date(now.getTime() + 3_600_000),
    }),
  ).not.toBeNull();
  expect(
    (
      await store.listDisputes({
        owners: { tenantOwnerTypes: ['org'], tenantIds: ['org_1'], includeNull: false },
      })
    ).length,
  ).toBe(1);

  expect(await store.recordAuditEvent({ action: 'refund', actor: 'ops' })).not.toBeNull();
  expect(await store.countAuditEvents({ action: 'refund' })).toBe(1);

  await store.recordUsage({ subscriptionId: 'sub_schema', meter: 'api', quantity: 3 });
  expect(await store.usageReport({ subscriptionId: 'sub_schema' })).toEqual([
    { meter: 'api', quantity: 3 },
  ]);
}
