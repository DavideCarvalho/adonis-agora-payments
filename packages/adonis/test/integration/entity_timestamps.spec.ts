import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * `createdAt` / `updatedAt` on the mutable billing rows, against a real Postgres: created is
 * stamped once, updated starts equal to it and moves on every write. Run on the default tables and
 * on a schema-qualified store (`billing.schema`), which names the schema in every statement.
 */
describe('entity timestamps (integration)', () => {
  let database: IntegrationDatabase;

  const T0 = new Date('2026-11-20T10:00:00.000Z');
  const T1 = new Date('2026-11-20T10:01:00.000Z');

  beforeAll(async () => {
    database = await createIntegrationDatabase('entity_timestamps_spec');
  });

  afterAll(async () => {
    vi.useRealTimers();
    await database?.db.rawQuery('DROP SCHEMA IF EXISTS "billing_ts_qualified" CASCADE');
    await database?.teardown();
  });

  for (const [label, makeStore] of [
    ['default tables', () => new LucidBillingStore()],
    ['billing.schema', () => new LucidBillingStore({}, { schema: 'billing_ts_qualified' })],
  ] as const) {
    it(`round-trips created/updated on every mutable row (${label})`, async () => {
      const store = makeStore();
      const iso = (d: Date | null | undefined) => d?.toISOString();

      vi.setSystemTime(T0);
      await store.saveCustomer({ gatewayId: 'cus_ts', provider: 'asaas', email: 'a@x.test' });
      await store.savePayment({
        gatewayId: 'pay_ts',
        provider: 'asaas',
        status: 'pending',
        amount: 1000,
        currency: 'BRL',
      });
      await store.saveSubscription({
        gatewayId: 'sub_ts',
        provider: 'asaas',
        customerId: 'cus_ts',
        planId: 'pro',
        status: 'active',
      });
      await store.saveDispute({
        gatewayId: 'dp_ts',
        paymentGatewayId: 'pay_ts',
        provider: 'asaas',
        status: 'open',
      });
      const managed = await store.createManagedSubscription({
        provider: 'asaas',
        customerId: 'cus_ts',
        status: 'active',
        planId: 'pro',
        amount: 4900,
        currency: 'BRL',
        cycle: 'MONTHLY',
        currentPeriodStart: T0,
        currentPeriodEnd: T1,
        nextChargeAt: T1,
      });

      const read = async () => ({
        customer: (await store.listCustomers({ gatewayId: 'cus_ts' }))[0],
        payment: (await store.listPayments({ gatewayId: 'pay_ts' }))[0],
        subscription: (await store.listSubscriptions({ gatewayId: 'sub_ts' }))[0],
        managed: (await store.listSubscriptions({ id: String(managed.id) }))[0],
        dispute: (await store.listDisputes({ paymentGatewayId: 'pay_ts' }))[0],
      });

      for (const row of Object.values(await read())) {
        expect(iso(row?.createdAt)).toBe(T0.toISOString());
        expect(iso(row?.updatedAt)).toBe(T0.toISOString());
      }

      vi.setSystemTime(T1);
      await store.saveCustomer({ gatewayId: 'cus_ts', provider: 'asaas', email: 'b@x.test' });
      await store.savePayment({
        gatewayId: 'pay_ts',
        provider: 'asaas',
        status: 'paid',
        amount: 1000,
        currency: 'BRL',
        paidAt: T1,
      });
      await store.saveSubscription({
        gatewayId: 'sub_ts',
        provider: 'asaas',
        customerId: 'cus_ts',
        planId: 'pro',
        status: 'canceled',
      });
      await store.saveDispute({
        gatewayId: 'dp_ts',
        paymentGatewayId: 'pay_ts',
        provider: 'asaas',
        status: 'lost',
        outcome: 'lost',
      });
      await store.updateManagedSubscription(String(managed.id), { amount: 5900 });

      for (const row of Object.values(await read())) {
        expect(iso(row?.createdAt)).toBe(T0.toISOString());
        expect(iso(row?.updatedAt)).toBe(T1.toISOString());
      }
    });
  }
});
