import { beforeEach, describe, expect, it } from 'vitest';
import { billingHealth } from '../src/billing/billing_health.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-08-27T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

describe('billingHealth', () => {
  let store: InMemoryBillingStore;

  /** Write a row as if it had been created `msAgo` milliseconds before `NOW`. */
  const clockAt = (msAgo: number) => {
    store.now = () => at(msAgo);
  };

  beforeEach(() => {
    store = new InMemoryBillingStore();
    store.now = () => NOW;
  });

  const claim = async (gatewayEventId: string, type = 'payment.succeeded', provider = 'stripe') =>
    store.recordWebhookEvent({ gatewayEventId, provider, type, payload: {} });

  const charge = async (gatewayId: string, status: string) =>
    store.savePayment({ gatewayId, provider: 'stripe', status, amount: 100, currency: 'BRL' });

  it('reports healthy when nothing is stuck, failed or unconfirmed', async () => {
    clockAt(0);
    await charge('pay_ok', 'paid');
    const processed = await claim('evt_ok');
    await store.markWebhookProcessed(String(processed?.id));

    const report = await billingHealth(store, { now: NOW });
    expect(report.healthy).toBe(true);
    expect(report.checks.map((check) => check.count)).toEqual([0, 0, 0, 0]);
    expect(report.failures).toEqual([]);
    expect(report.deadlines).toEqual([]);
  });

  it('counts an event claimed and never finished as stuck — but only past the threshold', async () => {
    clockAt(30 * MINUTE);
    await claim('evt_abandoned');
    // TWO fresh claims, deliberately: with a single one, a filter inverted to `createdAfter`
    // would still answer "1" and the test would pass while measuring the wrong rows.
    clockAt(2 * MINUTE);
    await claim('evt_just_now');
    await claim('evt_just_now_2');

    const report = await billingHealth(store, { now: NOW });
    const stuck = report.checks.find((check) => check.key === 'stuck_webhooks');
    expect(stuck?.count, 'only the 30-minute-old claim is past the 15m default').toBe(1);
    expect(report.healthy).toBe(false);
  });

  it('honors a custom stuck threshold', async () => {
    clockAt(30 * MINUTE);
    await claim('evt_abandoned');

    expect(
      (await billingHealth(store, { now: NOW, stuckAfter: 45 * MINUTE })).checks.find(
        (check) => check.key === 'stuck_webhooks',
      )?.count,
    ).toBe(0);
  });

  it('counts failures inside the window and groups them by provider and type', async () => {
    clockAt(2 * HOUR);
    const recent = await claim('evt_failed_recent', 'payment.succeeded');
    await store.markWebhookFailed(String(recent?.id), 'boom');
    const other = await claim('evt_failed_other', 'subscription.updated', 'asaas');
    await store.markWebhookFailed(String(other?.id), 'boom');
    const second = await claim('evt_failed_recent_2', 'payment.succeeded');
    await store.markWebhookFailed(String(second?.id), 'boom');

    clockAt(72 * HOUR);
    const ancient = await claim('evt_failed_ancient', 'payment.succeeded');
    await store.markWebhookFailed(String(ancient?.id), 'boom');

    const report = await billingHealth(store, { now: NOW });
    expect(report.checks.find((check) => check.key === 'failed_webhooks')?.count).toBe(3);
    expect(report.failures, 'worst first, and the 3-day-old failure is outside the window').toEqual(
      [
        { provider: 'stripe', type: 'payment.succeeded', count: 2 },
        { provider: 'asaas', type: 'subscription.updated', count: 1 },
      ],
    );
  });

  it('counts charges that were created and never confirmed', async () => {
    clockAt(5 * HOUR);
    await charge('pay_forgotten', 'pending');
    clockAt(10 * MINUTE);
    await charge('pay_in_flight', 'pending');
    clockAt(5 * HOUR);
    await charge('pay_settled', 'paid');

    const report = await billingHealth(store, { now: NOW });
    const unconfirmed = report.checks.find((check) => check.key === 'unconfirmed_payments');
    expect(
      unconfirmed?.count,
      'only the old pending charge — not the fresh one, not the paid one',
    ).toBe(1);
    expect(unconfirmed?.healthy).toBe(false);
  });

  it('labels the thresholds it actually used', async () => {
    const report = await billingHealth(store, {
      now: NOW,
      stuckAfter: 5 * MINUTE,
      unconfirmedAfter: 3 * HOUR,
      failedWithin: 48 * HOUR,
    });
    const label = (key: string) => report.checks.find((check) => check.key === key)?.label ?? '';
    expect(label('stuck_webhooks')).toContain('5m');
    expect(label('unconfirmed_payments')).toContain('3h');
    expect(label('failed_webhooks')).toContain('2d');
    expect(label('disputes_due'), '72h reads as 3d').toContain('3d');
  });

  describe('closing dispute windows', () => {
    /** An open dispute whose evidence window closes `hoursAhead` from `NOW`. */
    const disputeDue = async (gatewayId: string, hoursAhead: number | null, status = 'open') =>
      store.saveDispute({
        gatewayId,
        paymentGatewayId: `pi_${gatewayId}`,
        provider: 'stripe',
        status,
        evidenceDueBy: hoursAhead === null ? null : new Date(NOW.getTime() + hoursAhead * HOUR),
      });

    it('counts an open dispute whose window closes inside the default 72h', async () => {
      await disputeDue('dp_soon', 12);
      await disputeDue('dp_far', 200);

      const report = await billingHealth(store, { now: NOW });
      const due = report.checks.find((check) => check.key === 'disputes_due');
      expect(due?.count, 'only the window closing inside three days').toBe(1);
      expect(due?.healthy).toBe(false);
      expect(report.healthy).toBe(false);
    });

    it('keeps counting a window that has already closed', async () => {
      await disputeDue('dp_overdue', -48);
      // Going quiet the moment the deadline passes would read as "resolved" — at exactly the
      // moment it became true. It is still open, and still unanswered.
      const report = await billingHealth(store, { now: NOW });
      expect(report.checks.find((check) => check.key === 'disputes_due')?.count).toBe(1);
    });

    it('ignores a dispute the gateway sent no deadline for, and a closed one', async () => {
      await disputeDue('dp_no_deadline', null);
      await disputeDue('dp_lost', 1, 'lost');

      const report = await billingHealth(store, { now: NOW });
      expect(report.checks.find((check) => check.key === 'disputes_due')?.count).toBe(0);
      expect(report.healthy).toBe(true);
    });

    it('honors a custom horizon', async () => {
      await disputeDue('dp_next_week', 120);
      expect(
        (await billingHealth(store, { now: NOW })).checks.find((c) => c.key === 'disputes_due')
          ?.count,
      ).toBe(0);
      expect(
        (await billingHealth(store, { now: NOW, disputeDueWithin: 7 * 24 * HOUR })).checks.find(
          (c) => c.key === 'disputes_due',
        )?.count,
      ).toBe(1);
    });

    it('names which windows are closing, soonest first', async () => {
      await disputeDue('dp_second', 40);
      await disputeDue('dp_first', 4);

      const report = await billingHealth(store, { now: NOW });
      // A count names nobody to email and no gateway dashboard to open.
      expect(report.deadlines.map((row) => row.gatewayId)).toEqual(['dp_first', 'dp_second']);
      expect(report.deadlines[0]?.paymentGatewayId).toBe('pi_dp_first');
    });
  });

  it('is unhealthy when any single check trips', async () => {
    clockAt(3 * HOUR);
    await charge('pay_forgotten', 'pending');

    const report = await billingHealth(store, { now: NOW });
    expect(report.healthy).toBe(false);
    expect(report.checks.filter((check) => !check.healthy)).toHaveLength(1);
    expect(report.checkedAt).toEqual(NOW);
  });
});
