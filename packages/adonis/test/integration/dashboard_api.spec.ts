import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import type { ApiRequest, Deps } from '../../src/dashboard/handlers.js';
import { overview, payments, webhookEvents } from '../../src/dashboard/handlers.js';
import { type IntegrationDatabase, createIntegrationDatabase } from './harness.js';

/**
 * The dashboard's JSON API against a real Postgres, on the real published migration.
 *
 * The unit suite drives these same handlers through `InMemoryBillingStore`, which is a
 * hand-written reimplementation of the contract — it proves the handlers read the store
 * correctly, and nothing about whether the store's SQL is valid or lands where the code
 * reads it. That distinction is not academic here: `revenue()` and
 * `countActiveSubscriptions()` returned a silent ZERO against a real database until very
 * recently (a Lucid aggregate lands in `$extras`, not on the model), and every unit test
 * stayed green through it because the in-memory store simply added numbers up. A dashboard
 * whose headline figure is confidently `R$ 0,00` is worse than one that errors, so the
 * assertions below are specifically that the aggregates are the RIGHT NON-ZERO numbers.
 */
describe('payments dashboard API (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const NOW = new Date('2026-08-27T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  function req(query: Record<string, string | string[] | undefined> = {}): ApiRequest {
    return { params: {}, query };
  }

  function deps(currency = 'BRL'): Deps {
    return { store, currency, now: () => NOW };
  }

  beforeAll(async () => {
    database = await createIntegrationDatabase('payments_dashboard_spec');
    store = new LucidBillingStore();

    // ── Payments. Two settle inside the 30d window, one outside it, one never paid. ──
    await store.savePayment({
      gatewayId: 'pi_recent',
      provider: 'stripe',
      status: 'paid',
      amount: 123456,
      currency: 'BRL',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      paidAt: ago(2 * HOUR),
    });
    await store.savePayment({
      gatewayId: 'pi_cent',
      provider: 'stripe',
      status: 'paid',
      amount: 1,
      currency: 'BRL',
      paidAt: ago(3 * DAY),
    });
    await store.savePayment({
      gatewayId: 'pi_ancient',
      provider: 'asaas',
      status: 'paid',
      amount: 9_999_999,
      currency: 'BRL',
      paidAt: ago(400 * DAY),
    });
    await store.savePayment({
      gatewayId: 'pi_failed',
      provider: 'woovi',
      status: 'failed',
      amount: 4200,
      currency: 'BRL',
    });

    // ── Subscriptions. `countActiveSubscriptions` counts active AND trialing. ──
    for (const [gatewayId, status] of [
      ['sub_active', 'active'],
      ['sub_trial', 'trialing'],
      ['sub_dead', 'canceled'],
    ] as const) {
      await store.saveSubscription({
        gatewayId,
        provider: 'stripe',
        customerId: 'cus_1',
        status,
        planId: 'pro',
      });
    }

    // ── Metered usage, inside and outside the window. ──
    await store.recordUsage({ meter: 'api_calls', quantity: 7, recordedAt: ago(HOUR) });
    await store.recordUsage({ meter: 'api_calls', quantity: 3, recordedAt: ago(2 * DAY) });
    await store.recordUsage({ meter: 'api_calls', quantity: 1000, recordedAt: ago(400 * DAY) });
    await store.recordUsage({ meter: 'storage_gb', quantity: 12, recordedAt: ago(HOUR) });
    // Recorded AFTER the window's upper bound. A window is two bounds, and a suite whose rows
    // all sit in the past cannot tell an implementation that drops the upper one from a correct
    // one — a back-dated import or a clock-skewed worker produces exactly this row.
    await store.recordUsage({
      meter: 'api_calls',
      quantity: 500,
      recordedAt: new Date(NOW.getTime() + HOUR),
    });

    // ── The ledger: one failed (with a real handler message), one processed, one in flight. ──
    const failed = await store.recordWebhookEvent({
      gatewayEventId: 'evt_failed',
      provider: 'stripe',
      type: 'invoice.payment_failed',
      payload: { id: 'evt_failed' },
    });
    await store.markWebhookFailed(
      String(failed?.id),
      "TypeError: Cannot read properties of null (reading 'id')",
    );
    const done = await store.recordWebhookEvent({
      gatewayEventId: 'evt_done',
      provider: 'stripe',
      type: 'invoice.paid',
      payload: { id: 'evt_done' },
    });
    await store.markWebhookProcessed(String(done?.id));
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_inflight',
      provider: 'woovi',
      type: 'charge.paid',
      payload: { id: 'evt_inflight' },
    });
  });

  afterAll(async () => {
    await database?.teardown();
  });

  describe('GET /api/overview', () => {
    it('reports a NON-ZERO revenue in integer cents, windowed on paid_at', async () => {
      const res = await overview(deps(), req({ period: '30d' }));
      expect(res.status).toBe(200);
      const body = res.body as {
        currency: string;
        period: { from: string; to: string; preset: string };
        metrics: Array<{ key: string; value: number }>;
      };
      const revenue = body.metrics.find((m) => m.key === 'revenue')?.value;
      // 123456 + 1. The 400-day-old payment and the failed one are both excluded, and the
      // figure crosses the wire as cents — never 1234.57.
      expect(revenue).toBe(123457);
      expect(body.currency).toBe('BRL');
      expect(body.period.preset).toBe('30d');
      expect(body.period.to).toBe(NOW.toISOString());
    });

    it('counts active subscriptions INCLUDING trialing, and it is not zero', async () => {
      const res = await overview(deps(), req());
      const metrics = (res.body as { metrics: Array<{ key: string; value: number }> }).metrics;
      expect(metrics.find((m) => m.key === 'active_subscriptions')?.value).toBe(2);
    });

    it('aggregates metered usage per meter over the window', async () => {
      const res = await overview(deps(), req({ period: '30d' }));
      const metrics = (res.body as { metrics: Array<{ key: string; value: number }> }).metrics;
      // 7 + 3 in window. Neither the 400-day-old 1000 nor the future-dated 500 is.
      expect(metrics.find((m) => m.key === 'meter:api_calls')?.value).toBe(10);
      expect(metrics.find((m) => m.key === 'meter:storage_gb')?.value).toBe(12);
    });

    it('narrows with the period, dropping what falls outside it', async () => {
      const res = await overview(deps(), req({ period: '24h' }));
      const metrics = (res.body as { metrics: Array<{ key: string; value: number }> }).metrics;
      // Only pi_recent settled inside 24h.
      expect(metrics.find((m) => m.key === 'revenue')?.value).toBe(123456);
      expect(metrics.find((m) => m.key === 'meter:api_calls')?.value).toBe(7);
    });
  });

  describe('GET /api/payments', () => {
    it('lists real rows newest first, in integer cents, with ISO timestamps', async () => {
      const res = await payments(deps(), req());
      const body = res.body as {
        payments: Array<{
          gatewayId: string;
          amount: number;
          currency: string;
          paidAt: string | null;
          createdAt: string | null;
          customerId: string | null;
        }>;
        page: { limit: number; offset: number; count: number };
      };
      expect(body.page.count).toBe(4);
      const recent = body.payments.find((p) => p.gatewayId === 'pi_recent');
      expect(recent?.amount).toBe(123456);
      expect(recent?.currency).toBe('BRL');
      expect(recent?.customerId).toBe('cus_1');
      expect(recent?.paidAt).toBe(ago(2 * HOUR).toISOString());
      expect(typeof recent?.createdAt).toBe('string');
      // Never paid -> null, not an epoch-zero date.
      expect(body.payments.find((p) => p.gatewayId === 'pi_failed')?.paidAt).toBeNull();
    });

    it('filters by status through real SQL', async () => {
      const res = await payments(deps(), req({ status: 'failed' }));
      const body = res.body as { payments: Array<{ gatewayId: string }> };
      expect(body.payments.map((p) => p.gatewayId)).toEqual(['pi_failed']);
    });

    it('pages with limit/offset without repeating or skipping a row', async () => {
      const first = await payments(deps(), req({ limit: '2', offset: '0' }));
      const second = await payments(deps(), req({ limit: '2', offset: '2' }));
      const ids = (res: { body: unknown }) =>
        (res.body as { payments: Array<{ gatewayId: string }> }).payments.map((p) => p.gatewayId);
      const all = [...ids(first), ...ids(second)];
      expect(all).toHaveLength(4);
      expect(new Set(all).size).toBe(4);
    });
  });

  describe('GET /api/webhook-events', () => {
    it('surfaces the failed event WITH the handler error — the row an operator acts on', async () => {
      const res = await webhookEvents(deps(), req({ status: 'failed' }));
      const body = res.body as {
        events: Array<{ gatewayEventId: string; type: string; error: string | null }>;
      };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]?.gatewayEventId).toBe('evt_failed');
      expect(body.events[0]?.type).toBe('invoice.payment_failed');
      expect(body.events[0]?.error).toContain('Cannot read properties of null');
    });

    it('lists the whole ledger newest first with a null error on the healthy rows', async () => {
      const res = await webhookEvents(deps(), req());
      const body = res.body as {
        events: Array<{ gatewayEventId: string; createdAt: string | null; error: string | null }>;
        page: { count: number };
      };
      expect(body.page.count).toBe(3);
      expect(body.events.map((e) => e.gatewayEventId).sort()).toEqual([
        'evt_done',
        'evt_failed',
        'evt_inflight',
      ]);
      // Newest first, asserted on the timestamps rather than on a fixed id order: three rows
      // written in the same millisecond tie on `created_at`, and Postgres breaks a tie in
      // whatever order it likes.
      const times = body.events.map((e) => new Date(String(e.createdAt)).getTime());
      expect(times.every((t) => Number.isFinite(t))).toBe(true);
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(body.events.find((e) => e.gatewayEventId === 'evt_done')?.error).toBeNull();
    });

    it('filters the in-flight rows separately from the failed ones', async () => {
      const res = await webhookEvents(deps(), req({ status: 'received' }));
      const body = res.body as { events: Array<{ gatewayEventId: string }> };
      expect(body.events.map((e) => e.gatewayEventId)).toEqual(['evt_inflight']);
    });
  });
});
