import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { type IntegrationDatabase, createIntegrationDatabase } from './harness.js';

/**
 * `LucidBillingStore` against a real Postgres, on the real published migration.
 *
 * The unit suite covers the billing layer through the in-memory store, which is a
 * hand-written reimplementation of this contract — so it can only ever prove that the
 * CALLERS are right. Whether the SQL this store emits is valid, whether an aggregate comes
 * back where the code reads it, and whether the columns it writes exist in the migration
 * apps actually run: none of that is observable without a database.
 */
describe('LucidBillingStore (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  const hour = 60 * 60 * 1000;
  const now = new Date('2026-08-27T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  beforeAll(async () => {
    database = await createIntegrationDatabase('billing_store_spec');
    store = new LucidBillingStore();
  });

  afterAll(async () => {
    await database?.teardown();
  });

  describe('payments', () => {
    it('upserts by gateway id rather than inserting twice', async () => {
      await store.savePayment({
        gatewayId: 'pay_upsert',
        provider: 'stripe',
        status: 'pending',
        amount: 1000,
        currency: 'BRL',
      });
      await store.savePayment({
        gatewayId: 'pay_upsert',
        provider: 'stripe',
        status: 'paid',
        amount: 1000,
        currency: 'BRL',
        paidAt: now,
      });

      const found = await store.findPaymentByGatewayId('pay_upsert');
      expect(found?.status).toBe('paid');
      expect(await store.countPayments({})).toBe(1);
    });

    it('sums revenue over the paid window', async () => {
      await store.savePayment({
        gatewayId: 'pay_in_window',
        provider: 'stripe',
        status: 'paid',
        amount: 2500,
        currency: 'BRL',
        paidAt: ago(2 * hour),
      });
      await store.savePayment({
        gatewayId: 'pay_out_of_window',
        provider: 'stripe',
        status: 'paid',
        amount: 9999,
        currency: 'BRL',
        paidAt: ago(48 * hour),
      });
      await store.savePayment({
        gatewayId: 'pay_unpaid',
        provider: 'stripe',
        status: 'pending',
        amount: 700,
        currency: 'BRL',
      });

      // 1000 (pay_upsert, paid at `now`) + 2500 — never the unpaid one, never the old one.
      const revenue = await store.revenue({
        from: ago(24 * hour),
        to: new Date(now.getTime() + 1),
      });
      expect(revenue).toBe(3500);
    });

    it('counts unconfirmed charges older than a cutoff', async () => {
      const pending = await store.countPayments({
        status: 'pending',
        createdBefore: new Date(Date.now() + hour),
      });
      expect(pending).toBe(1);

      // The same filter with a cutoff BEFORE the rows exist must find nothing — otherwise
      // `createdBefore` is being ignored and every staleness alert is a false positive.
      expect(await store.countPayments({ status: 'pending', createdBefore: ago(72 * hour) })).toBe(
        0,
      );
    });
  });

  describe('subscriptions', () => {
    it('counts only active and trialing subscriptions', async () => {
      const base = { provider: 'stripe', customerId: 'cus_1', planId: 'plan_1' };
      await store.saveSubscription({ ...base, gatewayId: 'sub_active', status: 'active' });
      await store.saveSubscription({ ...base, gatewayId: 'sub_trial', status: 'trialing' });
      await store.saveSubscription({ ...base, gatewayId: 'sub_dead', status: 'canceled' });

      expect(await store.countActiveSubscriptions()).toBe(2);
      expect((await store.findSubscriptionByGatewayId('sub_trial'))?.status).toBe('trialing');
    });
  });

  describe('webhook ledger', () => {
    const event = (gatewayEventId: string, type: string) => ({
      gatewayEventId,
      provider: 'stripe',
      type,
      payload: { id: gatewayEventId },
    });

    it('claims an event once, refuses the redelivery, and reclaims a failed one', async () => {
      const first = await store.recordWebhookEvent(event('evt_retry', 'payment.succeeded'));
      expect(first).not.toBeNull();
      expect(await store.recordWebhookEvent(event('evt_retry', 'payment.succeeded'))).toBeNull();

      await store.markWebhookFailed(String(first?.id), 'handler exploded');
      const reclaimed = await store.recordWebhookEvent(event('evt_retry', 'payment.succeeded'));
      expect(
        reclaimed,
        'a failed event must be claimable again or retries do nothing',
      ).not.toBeNull();

      await store.markWebhookProcessed(String(reclaimed?.id));
      expect(await store.recordWebhookEvent(event('evt_retry', 'payment.succeeded'))).toBeNull();
    });

    it('finds a ledger row by the gateway event id and carries the handler error', async () => {
      const row = await store.recordWebhookEvent(event('evt_failed', 'payment.failed'));
      await store.markWebhookFailed(String(row?.id), 'card declined downstream');

      const found = await store.findWebhookEventByGatewayEventId('evt_failed');
      expect(found?.status).toBe('failed');
      expect(found?.error).toBe('card declined downstream');
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(await store.findWebhookEventByGatewayEventId('evt_nope')).toBeNull();
    });

    it('counts and groups the ledger by provider and type', async () => {
      await store.markWebhookFailed(
        String((await store.recordWebhookEvent(event('evt_failed_2', 'payment.failed')))?.id),
        'again',
      );

      expect(await store.countWebhookEvents({ status: 'failed' })).toBe(2);
      expect(await store.countWebhookEvents({ status: 'processed' })).toBe(1);

      const breakdown = await store.webhookEventBreakdown({ status: 'failed' });
      expect(breakdown).toEqual([{ provider: 'stripe', type: 'payment.failed', count: 2 }]);

      // A window that predates every row must group to nothing.
      expect(
        await store.webhookEventBreakdown({
          status: 'failed',
          createdAfter: new Date(Date.now() + hour),
        }),
      ).toEqual([]);
    });

    it('pages the ledger newest first', async () => {
      const page = await store.listWebhookEvents({ limit: 2 });
      expect(page).toHaveLength(2);
      expect(page[0]?.createdAt?.getTime()).toBeGreaterThanOrEqual(
        page[1]?.createdAt?.getTime() ?? 0,
      );
    });
  });

  describe('metered usage', () => {
    it('aggregates per meter inside the recorded window', async () => {
      await store.recordUsage({
        subscriptionId: 'sub_1',
        meter: 'api_calls',
        quantity: 3,
        recordedAt: ago(2 * hour),
      });
      await store.recordUsage({
        subscriptionId: 'sub_1',
        meter: 'api_calls',
        quantity: 4,
        recordedAt: ago(1 * hour),
      });
      await store.recordUsage({
        subscriptionId: 'sub_1',
        meter: 'storage_gb',
        quantity: 9,
        recordedAt: ago(1 * hour),
      });
      await store.recordUsage({
        subscriptionId: 'sub_1',
        meter: 'api_calls',
        quantity: 100,
        recordedAt: ago(96 * hour),
      });

      const report = await store.usageReport({
        subscriptionId: 'sub_1',
        from: ago(24 * hour),
        to: now,
      });
      expect(report.sort((a, b) => a.meter.localeCompare(b.meter))).toEqual([
        { meter: 'api_calls', quantity: 7 },
        { meter: 'storage_gb', quantity: 9 },
      ]);
    });
  });
});
