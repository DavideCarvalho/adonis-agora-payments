import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { WebhookProcessor } from '../../src/billing/webhook_processor.js';
import { createReplayAction } from '../../src/dashboard/actions.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

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

  /**
   * Managed subscriptions against real SQL, which is the only place this can be checked.
   * The in-memory store filters an array in JavaScript; here the same question is a WHERE
   * over a boolean and a timestamp, on the columns the published migration actually creates.
   */
  describe('managed subscriptions', () => {
    const base = {
      provider: 'woovi',
      customerId: 'cus_managed',
      status: 'active',
      planId: 'plan_managed',
      amount: 9900,
      currency: 'brl',
      cycle: 'MONTHLY',
      method: 'pix',
      externalReference: 'sub:local-1',
    };

    it('stores a subscription with no gateway id at all', async () => {
      const row = await store.createManagedSubscription({
        ...base,
        currentPeriodStart: new Date('2026-01-10T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-02-10T00:00:00.000Z'),
        nextChargeAt: new Date('2026-02-10T00:00:00.000Z'),
      });

      // `gateway_id` is UNIQUE and was typed `string` — a managed row has none, and more than
      // one of them has to be able to coexist. A NULL does not collide in a unique index; an
      // invented placeholder would have, on the second subscription.
      expect(row.gatewayId).toBeNull();
      const reread = await store.findSubscriptionById(row.id);
      expect(reread?.amount).toBe(9900);
      expect(reread?.externalReference).toBe('sub:local-1');

      const second = await store.createManagedSubscription({
        ...base,
        currentPeriodStart: new Date('2026-01-11T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-02-11T00:00:00.000Z'),
        nextChargeAt: new Date('2026-02-11T00:00:00.000Z'),
      });
      expect(second.id).not.toBe(row.id);
    });

    it('returns only what is due, oldest first, and never a gateway-owned row', async () => {
      const due = await store.createManagedSubscription({
        ...base,
        currentPeriodStart: new Date('2026-02-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-03-01T00:00:00.000Z'),
        nextChargeAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      const notYet = await store.createManagedSubscription({
        ...base,
        currentPeriodStart: new Date('2026-02-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'),
        nextChargeAt: new Date('2027-01-01T00:00:00.000Z'),
      });
      // A gateway-owned subscription renews itself; charging it here would double-bill.
      await store.saveSubscription({
        provider: 'asaas',
        customerId: 'cus_gw',
        planId: 'plan_gw',
        gatewayId: 'sub_gateway_owned',
        status: 'active',
      });

      const rows = await store.listDueManagedSubscriptions(
        new Date('2026-03-02T00:00:00.000Z'),
        10,
      );
      const ids = rows.map((row) => row.id);
      expect(ids).toContain(due.id);
      expect(ids).not.toContain(notYet.id);
      expect(rows.every((row) => row.managed === true)).toBe(true);
    });

    it('stops renewing when nextChargeAt is cleared', async () => {
      const row = await store.createManagedSubscription({
        ...base,
        currentPeriodStart: new Date('2026-04-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-05-01T00:00:00.000Z'),
        nextChargeAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      // `null` has to reach the column as NULL. If the patch treated it as "leave alone",
      // a cancelled subscription would keep coming back due and charging forever.
      await store.updateManagedSubscription(row.id, {
        status: 'canceled',
        nextChargeAt: null,
        endsAt: new Date('2026-05-01T00:00:00.000Z'),
      });

      const rows = await store.listDueManagedSubscriptions(
        new Date('2026-06-01T00:00:00.000Z'),
        10,
      );
      expect(rows.map((r) => r.id)).not.toContain(row.id);
      expect((await store.findSubscriptionById(row.id))?.status).toBe('canceled');
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
  describe('external reference', () => {
    it('round-trips the column and finds the payment by the app’s own id', async () => {
      await store.savePayment({
        gatewayId: 'pay_ref',
        provider: 'stripe',
        status: 'paid',
        amount: 4200,
        currency: 'BRL',
        externalReference: 'order-1042',
        paidAt: now,
      });

      const found = await store.findPaymentByExternalReference('order-1042');
      expect(found?.gatewayId).toBe('pay_ref');
      expect(found?.externalReference).toBe('order-1042');
      expect(await store.findPaymentByExternalReference('order-nope')).toBeNull();
    });

    it('does NOT blank the stored reference when a later event omits it', async () => {
      // The realistic sequence: `payment.succeeded` carries the reference, `payment.refunded`
      // does not. A store that wrote `undefined` through would destroy the key the app routes on.
      await store.savePayment({
        gatewayId: 'pay_ref',
        provider: 'stripe',
        status: 'refunded',
        amount: 4200,
        currency: 'BRL',
      });
      expect((await store.findPaymentByGatewayId('pay_ref'))?.externalReference).toBe('order-1042');

      // ...and an explicit `null` still clears it.
      await store.savePayment({
        gatewayId: 'pay_ref',
        provider: 'stripe',
        status: 'refunded',
        amount: 4200,
        currency: 'BRL',
        externalReference: null,
      });
      expect((await store.findPaymentByGatewayId('pay_ref'))?.externalReference).toBeNull();
    });

    it('answers with the NEWEST row when a reference was reused', async () => {
      await store.savePayment({
        gatewayId: 'pay_first',
        provider: 'stripe',
        status: 'failed',
        amount: 100,
        currency: 'BRL',
        externalReference: 'order-reused',
      });
      await store.savePayment({
        gatewayId: 'pay_retry',
        provider: 'stripe',
        status: 'paid',
        amount: 100,
        currency: 'BRL',
        externalReference: 'order-reused',
        paidAt: now,
      });
      expect((await store.findPaymentByExternalReference('order-reused'))?.gatewayId).toBe(
        'pay_retry',
      );
    });

    it('carries the reference on the normalized list item', async () => {
      const listed = await store.listPayments({ status: 'paid', limit: 100 });
      expect(listed.find((row) => row.gatewayId === 'pay_retry')?.externalReference).toBe(
        'order-reused',
      );
    });

    it('is served by an index, not a sequential scan', async () => {
      // An unindexed lookup key on a table that grows with every charge is a scan on the hot
      // path — and a test table of four rows would never reveal it, because the planner rightly
      // prefers a scan at that size. So the question asked here is the one that matters: WITH a
      // scan taken off the table, can the planner answer this predicate from the index at all?
      // It can only say yes if the index exists and covers the column the query filters on.
      const trx = await database.db.transaction();
      try {
        await trx.rawQuery('SET LOCAL enable_seqscan = off');
        const explained = await trx.rawQuery(
          "EXPLAIN SELECT * FROM billing_payments WHERE external_reference = 'order-1042'",
        );
        const plan = (explained.rows as Array<Record<string, string>>)
          .map((line) => Object.values(line)[0])
          .join('\n');
        expect(plan).toContain('billing_payments_external_reference_idx');
      } finally {
        await trx.rollback();
      }
    });
  });

  describe('dashboard retry', () => {
    it('replays a SIGNED gateway’s ledger row from the stored normalized event', async () => {
      // The bug this closes: the ledger kept only the raw payload, so rebuilding the event meant
      // calling `parseWebhook`, which re-verifies a signature computed over headers nothing
      // stored — a Stripe or Adyen retry answered `422` while unsigned gateways replayed fine.
      // Nothing here has a driver: if the replay re-parsed, it could not run at all.
      const processor = new WebhookProcessor({ store });
      const stripeEvent = {
        id: 'evt_signed_replay',
        provider: 'stripe',
        type: 'payment.succeeded',
        data: {
          gatewayId: 'pi_signed',
          amount: 7700,
          currency: 'BRL',
          externalReference: 'order-signed',
        },
        raw: { id: 'evt_signed_replay', signature_verified_once: true },
      } as never;

      // First delivery: the handler throws, so the ledger row lands `failed` — the state an
      // operator finds after fixing a handler bug.
      const failing = new WebhookProcessor({
        store,
        handlers: {
          'payment.succeeded': () => {
            throw new Error('handler bug');
          },
        },
      });
      await expect(failing.process(stripeEvent)).rejects.toThrow('handler bug');
      expect((await store.findWebhookEventByGatewayEventId('evt_signed_replay'))?.status).toBe(
        'failed',
      );

      const replay = createReplayAction({ store, process: (e) => processor.process(e as never) });
      const outcome = await replay({
        gatewayEventId: 'evt_signed_replay',
        provider: 'stripe',
        type: 'payment.succeeded',
        previousError: 'handler bug',
      });

      expect(outcome).toEqual({ kind: 'processed' });
      const row = await store.findWebhookEventByGatewayEventId('evt_signed_replay');
      expect(row?.status).toBe('processed');
      expect(row?.error).toBeNull();
      // And the built-in sync ran off the stored normalized event, reference included.
      expect((await store.findPaymentByExternalReference('order-signed'))?.gatewayId).toBe(
        'pi_signed',
      );
    });
  });

  describe('disputes', () => {
    /** The deadline read is the reason the table exists, so every row here carries a window. */
    const dueIn = (hours: number) => new Date(now.getTime() + hours * hour);

    it('upserts on the dispute gateway id and keeps what a later event omits', async () => {
      await store.saveDispute({
        gatewayId: 'dp_upsert',
        paymentGatewayId: 'pay_upsert',
        provider: 'stripe',
        status: 'open',
        reason: 'fraudulent',
        amount: 4990,
        currency: 'brl',
        evidenceDueBy: dueIn(48),
        payload: { object: 'dispute' },
      });
      await store.saveDispute({
        gatewayId: 'dp_upsert',
        paymentGatewayId: 'pay_upsert',
        provider: 'stripe',
        status: 'lost',
        outcome: 'lost',
        closedAt: now,
      });

      const row = await store.findDisputeByGatewayId('dp_upsert');
      expect(await store.countDisputes({})).toBe(1);
      expect(row?.status).toBe('lost');
      expect(row?.outcome).toBe('lost');
      // The closing event carries no deadline and no reason. Postgres would happily have
      // nulled both; the store must not.
      expect(row?.reason).toBe('fraudulent');
      expect(row?.evidenceDueBy?.toJSDate()).toEqual(dueIn(48));
      // `bigint` comes back as a string from pg — the normalized read is where that is fixed.
      expect((await store.listDisputes({ status: 'lost' }))[0]?.amount).toBe(4990);
    });

    it('lists the open windows closing inside the horizon, soonest first', async () => {
      await store.saveDispute({
        gatewayId: 'dp_far',
        paymentGatewayId: 'pay_far',
        provider: 'stripe',
        status: 'open',
        evidenceDueBy: dueIn(200),
      });
      await store.saveDispute({
        gatewayId: 'dp_soon',
        paymentGatewayId: 'pay_soon',
        provider: 'stripe',
        status: 'warning',
        evidenceDueBy: dueIn(6),
      });
      await store.saveDispute({
        gatewayId: 'dp_mid',
        paymentGatewayId: 'pay_mid',
        provider: 'adyen',
        status: 'under_review',
        evidenceDueBy: dueIn(20),
      });
      // No deadline at all, and a closed one inside the horizon: neither may appear.
      await store.saveDispute({
        gatewayId: 'dp_silent',
        paymentGatewayId: 'pay_silent',
        provider: 'stripe',
        status: 'open',
      });
      await store.saveDispute({
        gatewayId: 'dp_done',
        paymentGatewayId: 'pay_done',
        provider: 'stripe',
        status: 'won',
        evidenceDueBy: dueIn(2),
      });

      const due = await store.listDisputesDueWithin({ withinHours: 24, now });
      expect(due.map((row) => row.gatewayId)).toEqual(['dp_soon', 'dp_mid']);
      expect(await store.countDisputesDueWithin({ withinHours: 24, now })).toBe(2);
      // The count is what the exit code is decided on: it must not be capped by a page.
      expect((await store.listDisputesDueWithin({ withinHours: 24, now, limit: 1 })).length).toBe(
        1,
      );
      expect(await store.countDisputesDueWithin({ withinHours: 24, now, provider: 'adyen' })).toBe(
        1,
      );
    });

    it('keeps counting a window that has already closed', async () => {
      await store.saveDispute({
        gatewayId: 'dp_overdue',
        paymentGatewayId: 'pay_overdue',
        provider: 'mollie',
        status: 'open',
        evidenceDueBy: new Date(now.getTime() - 30 * hour),
      });
      // SQL's `<=` alone would keep it; the point is that nothing added a lower bound. Going
      // quiet the moment the deadline passes reads as resolved, at exactly the wrong moment.
      const due = await store.listDisputesDueWithin({ withinHours: 1, now, provider: 'mollie' });
      expect(due.map((row) => row.gatewayId)).toEqual(['dp_overdue']);
    });

    it('finds the unresolved dispute against a payment, and skips the resolved one', async () => {
      await store.saveDispute({
        gatewayId: 'dp_open_for_pay',
        paymentGatewayId: 'pay_two_disputes',
        provider: 'stripe',
        status: 'lost',
      });
      expect(await store.findOpenDisputeByPayment('pay_two_disputes')).toBeNull();

      await store.saveDispute({
        gatewayId: 'dp_second_for_pay',
        paymentGatewayId: 'pay_two_disputes',
        provider: 'stripe',
        status: 'open',
      });
      expect((await store.findOpenDisputeByPayment('pay_two_disputes'))?.gatewayId).toBe(
        'dp_second_for_pay',
      );
    });

    it('rejects a second row under the same dispute id', async () => {
      await store.saveDispute({
        gatewayId: 'dp_unique',
        paymentGatewayId: 'pay_unique',
        provider: 'stripe',
        status: 'open',
      });
      // The unique constraint IS the idempotency guarantee — a redelivered dispute webhook
      // must update one row, never accumulate them. Only a real database can say so.
      await expect(
        database.db.table('billing_disputes').insert({
          id: '00000000-0000-4000-8000-000000000001',
          gateway_id: 'dp_unique',
          payment_gateway_id: 'pay_unique',
          provider: 'stripe',
          status: 'open',
          created_at: now,
          updated_at: now,
        }),
      ).rejects.toThrow();
    });
  });

  describe('an install with no billing_disputes table, with autoCreateSchema off', () => {
    // A processor that wants to write disputes and no table to write them to. The dispute row
    // is ADDITIONAL — the payment still moves, the diagnostics still publish — so the write is
    // skipped and the reads answer empty, rather than failing every gateway delivery with
    // `relation "billing_disputes" does not exist`.
    //
    // Reachable only with `autoCreateSchema: false`: on the default the store would create the
    // table on first use and there would be nothing missing. Which is the point of the default.
    let legacy: LucidBillingStore;

    beforeAll(async () => {
      await database.db.rawQuery('ALTER TABLE billing_disputes RENAME TO billing_disputes_kept');
      legacy = new LucidBillingStore({}, { autoCreateSchema: false });
    });

    afterAll(async () => {
      await database.db.rawQuery('ALTER TABLE billing_disputes_kept RENAME TO billing_disputes');
    });

    it('skips the write and says so by answering null', async () => {
      expect(
        await legacy.saveDispute({
          gatewayId: 'dp_legacy',
          paymentGatewayId: 'pay_legacy_dispute',
          provider: 'stripe',
          status: 'open',
          evidenceDueBy: new Date(now.getTime() + hour),
        }),
      ).toBeNull();
    });

    it('answers empty for every dispute read instead of raising', async () => {
      expect(await legacy.findDisputeByGatewayId('dp_legacy')).toBeNull();
      expect(await legacy.findOpenDisputeByPayment('pay_legacy_dispute')).toBeNull();
      expect(await legacy.listDisputes({})).toEqual([]);
      expect(await legacy.countDisputes({})).toBe(0);
      expect(await legacy.listDisputesDueWithin({ withinHours: 72, now })).toEqual([]);
      expect(await legacy.countDisputesDueWithin({ withinHours: 72, now })).toBe(0);
    });

    it('still takes a payment webhook', async () => {
      // The whole point: a missing dispute table must not stop money being recorded.
      await legacy.savePayment({
        gatewayId: 'pay_during_legacy_disputes',
        provider: 'stripe',
        status: 'paid',
        amount: 500,
        currency: 'BRL',
        paidAt: now,
      });
      expect((await legacy.findPaymentByGatewayId('pay_during_legacy_disputes'))?.status).toBe(
        'paid',
      );
    });
  });

  describe('an install whose schema predates two columns, with autoCreateSchema off', () => {
    // Both columns are nullable and both writes are guarded, so an app on an older schema keeps
    // taking webhooks: it records a payment WITHOUT a stored reference, and a ledger row the
    // dashboard's retry declines to replay. This block is the only place that claim is actually
    // executed — the columns are dropped underneath a fresh store and put back afterwards.
    //
    // **`autoCreateSchema: false` is the whole premise.** With it on — the default — the store
    // calls `createBillingTables` on first use and the missing columns are simply added back,
    // so there is no degradation left to test. The graceful path still matters, and only here:
    // for the app that took the schema into its own hands and has not run its migration yet.
    let legacy: LucidBillingStore;

    beforeAll(async () => {
      await database.db.rawQuery('ALTER TABLE billing_payments DROP COLUMN external_reference');
      await database.db.rawQuery('ALTER TABLE billing_webhook_events DROP COLUMN normalized');
      legacy = new LucidBillingStore({}, { autoCreateSchema: false });
    });

    afterAll(async () => {
      await database.db.rawQuery(
        'ALTER TABLE billing_payments ADD COLUMN external_reference varchar(255) NULL',
      );
      await database.db.rawQuery(
        'CREATE INDEX billing_payments_external_reference_idx ON billing_payments (external_reference)',
      );
      await database.db.rawQuery(
        'ALTER TABLE billing_webhook_events ADD COLUMN normalized jsonb NULL',
      );
    });

    it('still records a payment, dropping only the reference it cannot store', async () => {
      await legacy.savePayment({
        gatewayId: 'pay_legacy',
        provider: 'stripe',
        status: 'paid',
        amount: 999,
        currency: 'BRL',
        externalReference: 'order-legacy',
        paidAt: now,
      });
      expect((await legacy.findPaymentByGatewayId('pay_legacy'))?.status).toBe('paid');
    });

    it('answers null instead of raising `column does not exist` at a polling browser', async () => {
      expect(await legacy.findPaymentByExternalReference('order-legacy')).toBeNull();
    });

    it('still records the webhook, and the retry says plainly it cannot replay it', async () => {
      const row = await legacy.recordWebhookEvent({
        gatewayEventId: 'evt_legacy',
        provider: 'stripe',
        type: 'payment.succeeded',
        payload: { id: 'evt_legacy' },
        normalized: { gatewayId: 'pi_legacy', amount: 999, currency: 'BRL' },
      });
      expect(row).not.toBeNull();
      await legacy.markWebhookFailed(String(row?.id), 'handler bug');

      const replay = createReplayAction({
        store: legacy,
        process: async () => {
          throw new Error('must not run');
        },
      });
      const outcome = await replay({
        gatewayEventId: 'evt_legacy',
        provider: 'stripe',
        type: 'payment.succeeded',
        previousError: 'handler bug',
      });

      expect(outcome.kind).toBe('undeliverable');
      expect(outcome.kind === 'undeliverable' && outcome.message).toContain(
        'billing_webhook_events.normalized',
      );
      // The row is exactly as the operator found it: original error, still failed.
      const stored = await legacy.findWebhookEventByGatewayEventId('evt_legacy');
      expect(stored?.status).toBe('failed');
      expect(stored?.error).toBe('handler bug');
    });
  });
});
