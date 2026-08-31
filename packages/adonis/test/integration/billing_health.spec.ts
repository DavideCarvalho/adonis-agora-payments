import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingHealth } from '../../src/billing/billing_health.js';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * `billingHealth` over real SQL.
 *
 * The unit suite proves the thresholds against the in-memory store — a hand-written
 * reimplementation. What it cannot prove is that Postgres agrees: that the window filters
 * compile, that `count(*)` comes back where the code reads it, and that a `group by` over
 * a filtered ledger returns rows at all. Each of those has failed silently as a zero.
 */
describe('billingHealth (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const NOW = new Date('2026-08-27T12:00:00.000Z');
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

  /** Lucid stamps `created_at` itself, so backdating is a deliberate second write. */
  const backdate = async (table: string, column: string, key: string, when: Date) => {
    await database.db.rawQuery(`update ${table} set created_at = ? where ${column} = ?`, [
      when.toISOString(),
      key,
    ]);
  };

  beforeAll(async () => {
    database = await createIntegrationDatabase('billing_health_spec');
    store = new LucidBillingStore();

    // Claimed 40 minutes ago and never finished — the abandoned-worker signature.
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_stuck',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: {},
    });
    await backdate('billing_webhook_events', 'gateway_event_id', 'evt_stuck', at(40 * MINUTE));

    // Claimed a minute ago — in flight, not stuck.
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_fresh',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: {},
    });
    await backdate('billing_webhook_events', 'gateway_event_id', 'evt_fresh', at(MINUTE));

    // Two failures inside the window, one outside it.
    for (const [id, type, provider, age] of [
      ['evt_fail_a', 'payment.succeeded', 'stripe', 3 * HOUR],
      ['evt_fail_b', 'payment.succeeded', 'stripe', 4 * HOUR],
      ['evt_fail_c', 'subscription.updated', 'asaas', 5 * HOUR],
      ['evt_fail_old', 'payment.succeeded', 'stripe', 72 * HOUR],
    ] as const) {
      const row = await store.recordWebhookEvent({
        gatewayEventId: id,
        provider,
        type,
        payload: {},
      });
      await store.markWebhookFailed(String(row?.id), 'handler threw');
      await backdate('billing_webhook_events', 'gateway_event_id', id, at(age));
    }

    // A charge created five hours ago that never confirmed, and a fresh one that is fine.
    for (const [id, status, age] of [
      ['pay_forgotten', 'pending', 5 * HOUR],
      ['pay_in_flight', 'pending', 10 * MINUTE],
      ['pay_settled', 'paid', 6 * HOUR],
    ] as const) {
      await store.savePayment({
        gatewayId: id,
        provider: 'stripe',
        status,
        amount: 1000,
        currency: 'BRL',
      });
      await backdate('billing_payments', 'gateway_id', id, at(age));
    }

    // An open chargeback whose evidence window closes in twelve hours, one that closes in
    // eight days, one the gateway sent no deadline for, and one already lost. Only the first
    // may be counted — and its deadline is the only thing that makes it actionable at all.
    // (A window that has ALREADY closed is covered in the store's own integration spec; it
    // is deliberately absent here, because nothing could then widen this install to healthy.)
    for (const [id, status, dueInHours] of [
      ['dp_closing', 'open', 12],
      ['dp_next_week', 'warning', 8 * 24],
      ['dp_no_deadline', 'open', null],
      ['dp_lost', 'lost', 6],
    ] as const) {
      await store.saveDispute({
        gatewayId: id,
        paymentGatewayId: `pay_${id}`,
        provider: 'stripe',
        status,
        evidenceDueBy:
          dueInHours === null ? null : new Date(NOW.getTime() + dueInHours * 60 * MINUTE),
      });
    }
  });

  afterAll(async () => {
    await database?.teardown();
  });

  it('finds the stuck event without counting the one still in flight', async () => {
    const report = await billingHealth(store, { now: NOW });
    expect(report.checks.find((check) => check.key === 'stuck_webhooks')?.count).toBe(1);
  });

  it('counts failures inside the window and groups them worst-first', async () => {
    const report = await billingHealth(store, { now: NOW });
    expect(report.checks.find((check) => check.key === 'failed_webhooks')?.count).toBe(3);
    expect(report.failures).toEqual([
      { provider: 'stripe', type: 'payment.succeeded', count: 2 },
      { provider: 'asaas', type: 'subscription.updated', count: 1 },
    ]);
  });

  it('counts the unconfirmed charge only', async () => {
    const report = await billingHealth(store, { now: NOW });
    expect(report.checks.find((check) => check.key === 'unconfirmed_payments')?.count).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it('counts the closing dispute window and names it', async () => {
    const report = await billingHealth(store, { now: NOW });
    // The one closing in twelve hours. Not the one due next week, not the one the gateway
    // sent no deadline for, and not the one that already closed as lost.
    expect(report.checks.find((check) => check.key === 'disputes_due')?.count).toBe(1);
    expect(report.deadlines.map((row) => row.gatewayId)).toEqual(['dp_closing']);
    expect(report.deadlines[0]?.paymentGatewayId).toBe('pay_dp_closing');
    expect(report.deadlines[0]?.evidenceDueBy).toEqual(new Date(NOW.getTime() + 12 * HOUR));
  });

  it('quiets every THRESHOLD check once the thresholds are widened past every row', async () => {
    const report = await billingHealth(store, {
      now: NOW,
      stuckAfter: 48 * HOUR,
      unconfirmedAfter: 48 * HOUR,
      failedWithin: MINUTE,
      // The one threshold here that looks FORWARD, so NARROWING it is what quiets it.
      disputeDueWithin: MINUTE,
      rejectedWithin: MINUTE,
    });
    expect(report.failures).toEqual([]);
    expect(report.deadlines).toEqual([]);
    expect(
      report.checks.filter((check) => !check.healthy).map((check) => check.key),
      'every windowed check goes quiet; the open chargeback does not, because it has no window',
    ).toEqual(['open_disputes']);
  });

  it('keeps the open-dispute check red with NO threshold that can turn it off', async () => {
    // Deliberate, and the reason the check exists: `disputes_due` can be narrowed until it
    // reports zero, and on a gateway that publishes no deadline it reports zero anyway. An open
    // chargeback is money already out of the account, so there is no horizon at which it stops
    // mattering — the way to quiet this one is to record how the dispute ended.
    const report = await billingHealth(store, { now: NOW, disputeDueWithin: MINUTE });
    const open = report.checks.find((check) => check.key === 'open_disputes');
    expect(open?.healthy).toBe(false);
    expect(
      report.openDisputes.map((row) => row.gatewayId).includes('dp_no_deadline'),
      'the row the deadline read can never see',
    ).toBe(true);
  });
});
