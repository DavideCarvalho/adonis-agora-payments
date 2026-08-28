import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import DashboardProvider from '../../providers/dashboard_provider.js';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import type { RefundAction, ReplayAction } from '../../src/dashboard/actions.js';
import type { PaymentsDashboardConfig } from '../../src/dashboard/define_config.js';
import type { ApiRequest, Deps } from '../../src/dashboard/handlers.js';
import {
  health,
  overview,
  payments,
  providers,
  refundPayment,
  retryWebhookEvent,
  subscriptions,
  webhookEvents,
} from '../../src/dashboard/handlers.js';
import { setBillingStore } from '../../src/services/main.js';
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

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const NOW = new Date('2026-08-27T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  function req(query: Record<string, string | string[] | undefined> = {}): ApiRequest {
    return { params: {}, query };
  }

  function deps(currency = 'BRL'): Deps {
    return { store, currency, now: () => NOW };
  }

  /** Lucid stamps `created_at` itself, so backdating a row is a deliberate second write. */
  async function backdate(table: string, column: string, key: string, when: Date): Promise<void> {
    await database.db.rawQuery(`update ${table} set created_at = ? where ${column} = ?`, [
      when.toISOString(),
      key,
    ]);
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
    // Created five hours ago and never confirmed — what a webhook endpoint that stopped being
    // reachable looks like from the inside. Nothing else in the system errors on this.
    await store.savePayment({
      gatewayId: 'pi_unconfirmed',
      provider: 'asaas',
      status: 'pending',
      amount: 7700,
      currency: 'BRL',
      customerId: 'cus_2',
    });
    await backdate('billing_payments', 'gateway_id', 'pi_unconfirmed', ago(5 * HOUR));

    // ── Subscriptions. `countActiveSubscriptions` counts active AND trialing. ──
    for (const [gatewayId, status, provider] of [
      ['sub_active', 'active', 'stripe'],
      ['sub_trial', 'trialing', 'stripe'],
      ['sub_dead', 'canceled', 'stripe'],
      // The two an operator actually opens this screen for.
      ['sub_late', 'past_due', 'stripe'],
      ['sub_late_2', 'past_due', 'asaas'],
      ['sub_paused', 'paused', 'stripe'],
    ] as const) {
      await store.saveSubscription({
        gatewayId,
        provider,
        customerId: `cus_${gatewayId}`,
        status,
        planId: 'pro',
        trialEndsAt: status === 'trialing' ? new Date(NOW.getTime() + DAY) : null,
        endsAt: new Date(NOW.getTime() + 7 * DAY),
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
    // Claimed 40 minutes ago and never finished: the dispatcher's consumer is not running.
    await backdate('billing_webhook_events', 'gateway_event_id', 'evt_inflight', ago(40 * MINUTE));

    // The dashboard provider reads the store through `services/main`, not through a parameter.
    setBillingStore(store);
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
      expect(body.page.count).toBe(5);
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
      const first = await payments(deps(), req({ limit: '3', offset: '0' }));
      const second = await payments(deps(), req({ limit: '3', offset: '3' }));
      const ids = (res: { body: unknown }) =>
        (res.body as { payments: Array<{ gatewayId: string }> }).payments.map((p) => p.gatewayId);
      const all = [...ids(first), ...ids(second)];
      expect(all).toHaveLength(5);
      expect(new Set(all).size).toBe(5);
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
  describe('GET /api/health', () => {
    it('names the three silent failures against real rows', async () => {
      const res = await health(deps(), req());
      expect(res.status).toBe(200);
      const body = res.body as {
        healthy: boolean;
        checks: Array<{ key: string; count: number; healthy: boolean }>;
      };
      const count = (key: string) => body.checks.find((c) => c.key === key)?.count;
      expect(body.healthy).toBe(false);
      // Claimed 40 min ago, never finished.
      expect(count('stuck_webhooks')).toBe(1);
      // The one failure, inside the 24h window.
      expect(count('failed_webhooks')).toBe(1);
      // Created 5 h ago and still pending.
      expect(count('unconfirmed_payments')).toBe(1);
    });

    it('groups the failures by provider and type through a real GROUP BY', async () => {
      // A `group by` over a filtered ledger has returned an empty set before; a health panel that
      // says "1 failure" and cannot name it sends the operator nowhere.
      const res = await health(deps(), req());
      const failures = (
        res.body as { failures: Array<{ provider: string; type: string; count: number }> }
      ).failures;
      expect(failures).toEqual([
        { provider: 'stripe', type: 'invoice.payment_failed', count: 1 },
      ]);
    });
  });

  describe('GET /api/subscriptions', () => {
    it('lists real rows with plan, customer and both boundary dates as ISO strings', async () => {
      const res = await subscriptions(deps(), req({ status: 'trialing' }));
      expect(res.status).toBe(200);
      const body = res.body as {
        subscriptions: Array<{
          gatewayId: string;
          planId: string;
          customerId: string | null;
          trialEndsAt: string | null;
          endsAt: string | null;
        }>;
      };
      expect(body.subscriptions).toHaveLength(1);
      expect(body.subscriptions[0]).toMatchObject({
        gatewayId: 'sub_trial',
        planId: 'pro',
        customerId: 'cus_sub_trial',
        trialEndsAt: new Date(NOW.getTime() + DAY).toISOString(),
        endsAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      });
    });

    it('filters past_due through real SQL — the rows that cost money today', async () => {
      const res = await subscriptions(deps(), req({ status: 'past_due' }));
      const body = res.body as { subscriptions: Array<{ gatewayId: string }> };
      expect(body.subscriptions.map((sub) => sub.gatewayId).sort()).toEqual([
        'sub_late',
        'sub_late_2',
      ]);
    });

    it('keeps paused out of active, and counts past_due over the WHOLE table', async () => {
      const res = await subscriptions(deps(), req({ status: 'active', limit: '1' }));
      const body = res.body as {
        subscriptions: Array<{ gatewayId: string }>;
        counts: { past_due: number };
      };
      expect(body.subscriptions.map((sub) => sub.gatewayId)).toEqual(['sub_active']);
      expect(body.counts.past_due).toBe(2);
    });
  });

  describe('provider filter + discovery', () => {
    it('narrows real payment rows to one gateway', async () => {
      const res = await payments(deps(), req({ provider: 'asaas' }));
      const body = res.body as {
        payments: Array<{ gatewayId: string; provider: string }>;
        page: { truncated: boolean };
      };
      expect(body.payments.map((p) => p.gatewayId).sort()).toEqual(['pi_ancient', 'pi_unconfirmed']);
      expect(body.payments.every((p) => p.provider === 'asaas')).toBe(true);
      expect(body.page.truncated).toBe(false);
    });

    it('narrows real subscription rows to one gateway', async () => {
      const res = await subscriptions(deps(), req({ provider: 'asaas' }));
      const body = res.body as { subscriptions: Array<{ gatewayId: string }> };
      expect(body.subscriptions.map((sub) => sub.gatewayId)).toEqual(['sub_late_2']);
    });

    it('narrows the real ledger to one gateway', async () => {
      const res = await webhookEvents(deps(), req({ provider: 'woovi' }));
      const body = res.body as { events: Array<{ gatewayEventId: string }> };
      expect(body.events.map((e) => e.gatewayEventId)).toEqual(['evt_inflight']);
    });

    it('reports the gateways this install actually has data for', async () => {
      const res = await providers(deps(), req());
      expect((res.body as { providers: string[] }).providers).toEqual([
        'asaas',
        'stripe',
        'woovi',
      ]);
    });
  });

  describe('POST /api/payments/:gatewayId/refund', () => {
    /** A refund port that records what it was handed instead of calling a gateway. */
    function spyRefund() {
      const calls: Array<{ provider: string; gatewayId: string; amount?: number }> = [];
      const action: RefundAction = async (input) => {
        calls.push(input);
        return {
          kind: 'ok',
          refund: { gatewayId: 're_1', amount: input.amount ?? 123456, currency: 'BRL', status: 'succeeded' },
        };
      };
      return { calls, action };
    }

    function body(gatewayId: string, payload?: unknown): ApiRequest {
      return {
        params: { gatewayId },
        query: {},
        ...(payload !== undefined ? { body: payload } : {}),
      };
    }

    it('reads the real row and refunds through THAT row’s gateway', async () => {
      const spy = spyRefund();
      const res = await refundPayment(
        { ...deps(), actions: { refund: spy.action } },
        body('pi_recent'),
      );
      expect(res.status).toBe(200);
      // `pi_recent` is a Stripe charge and `pi_ancient` an Asaas one. Each has to be refunded at
      // ITS OWN gateway — the provider comes off the row, never from the request or a default.
      await refundPayment({ ...deps(), actions: { refund: spy.action } }, body('pi_ancient'));
      expect(spy.calls).toEqual([
        { provider: 'stripe', gatewayId: 'pi_recent' },
        { provider: 'asaas', gatewayId: 'pi_ancient' },
      ]);
    });

    it('reads the amount off the real numeric column when validating a partial', async () => {
      // Postgres hands `numeric` back as a STRING. Comparing a partial against `'123456'` instead
      // of `123456` either rejects every refund or accepts one bigger than the payment.
      const spy = spyRefund();
      const tooBig = await refundPayment(
        { ...deps(), actions: { refund: spy.action } },
        body('pi_recent', { amount: 123457 }),
      );
      expect(tooBig.status).toBe(400);
      const okRes = await refundPayment(
        { ...deps(), actions: { refund: spy.action } },
        body('pi_recent', { amount: 123456 }),
      );
      expect(okRes.status).toBe(200);
      expect(spy.calls).toEqual([{ provider: 'stripe', gatewayId: 'pi_recent', amount: 123456 }]);
    });

    it('refuses a real row that is not paid, without touching the gateway', async () => {
      const spy = spyRefund();
      const res = await refundPayment(
        { ...deps(), actions: { refund: spy.action } },
        body('pi_unconfirmed'),
      );
      expect(res.status).toBe(409);
      expect(spy.calls).toEqual([]);
    });

    it('leaves the real row alone — the gateway’s webhook is what updates it', async () => {
      await refundPayment({ ...deps(), actions: { refund: spyRefund().action } }, body('pi_recent'));
      const row = await store.findPaymentByGatewayId('pi_recent');
      expect(row?.status).toBe('paid');
    });
  });

  describe('POST /api/webhook-events/:gatewayEventId/retry', () => {
    function spyReplay() {
      const calls: Array<{ gatewayEventId: string; previousError: string | null }> = [];
      const action: ReplayAction = async (input) => {
        calls.push(input);
        return { kind: 'processed' };
      };
      return { calls, action };
    }

    function target(gatewayEventId: string): ApiRequest {
      return { params: { gatewayEventId }, query: {} };
    }

    it('replays a real failed row, handing the port the error it actually carried', async () => {
      const spy = spyReplay();
      const res = await retryWebhookEvent(
        { ...deps(), actions: { replayWebhook: spy.action } },
        target('evt_failed'),
      );
      expect(res.status).toBe(200);
      expect(spy.calls[0]?.previousError).toContain('Cannot read properties of null');
    });

    it('refuses a real row that is processed or in flight', async () => {
      const spy = spyReplay();
      for (const id of ['evt_done', 'evt_inflight']) {
        const res = await retryWebhookEvent(
          { ...deps(), actions: { replayWebhook: spy.action } },
          target(id),
        );
        expect(res.status).toBe(409);
      }
      expect(spy.calls).toEqual([]);
    });
  });

  /**
   * The routes as the app actually mounts them, over the real store.
   *
   * The handler tests above prove the SQL; these prove the two things a handler cannot: that an
   * unauthorized request never reaches one, and that a refund is not reachable by `GET`.
   */
  describe('mounted routes (guard + method)', () => {
    interface RegisteredRoute {
      method: 'get' | 'post';
      pattern: string;
      handler?: (ctx: unknown) => Promise<unknown>;
    }

    async function boot(config: PaymentsDashboardConfig): Promise<RegisteredRoute[]> {
      const routes: RegisteredRoute[] = [];
      const register =
        (method: 'get' | 'post') =>
        (pattern: string, handler?: (ctx: unknown) => Promise<unknown>) => {
          routes.push({ method, pattern, ...(handler ? { handler } : {}) });
          return { as: () => undefined };
        };
      const router = { get: register('get'), post: register('post') };
      const app = {
        config: { get: (key: string) => (key === 'payments_dashboard' ? config : {}) },
        booted: async (callback: () => Promise<void>) => {
          await callback();
        },
        container: {
          make: async (token: unknown) => {
            if (token === 'router') return router;
            // No PaymentsManager in this test app: the actions are absent and the endpoints say
            // so, which is a different answer from "denied".
            throw new Error('not bound');
          },
        },
        makePath: (segment: string) => `/nonexistent/${segment}`,
      } as unknown as ApplicationService;
      await new DashboardProvider(app).boot();
      return routes;
    }

    interface Recorded {
      status?: number;
      body?: unknown;
    }

    function fakeCtx(recorded: Recorded) {
      const response = {
        getHeader: () => undefined,
        status(code: number) {
          recorded.status = code;
          return this;
        },
        json(value: unknown) {
          recorded.body = value;
          return this;
        },
        redirect: () => ({ withQs: () => ({ toPath: () => undefined }) }),
        header() {
          return this;
        },
        send: () => undefined,
      };
      return {
        response,
        params: { gatewayId: 'pi_recent', gatewayEventId: 'evt_failed' },
        request: {
          qs: () => ({}),
          body: () => ({}),
          url: () => '/payments-dashboard',
          plainCookie: () => undefined,
          secure: () => false,
          headers: () => ({}),
        },
      };
    }

    const REFUND = '/payments-dashboard/api/payments/:gatewayId/refund';
    const RETRY = '/payments-dashboard/api/webhook-events/:gatewayEventId/retry';

    it('mounts the refund and the retry as POST and NEVER as GET', async () => {
      const routes = await boot({});
      const gets = routes.filter((r) => r.method === 'get').map((r) => r.pattern);
      expect(gets).not.toContain(REFUND);
      expect(gets).not.toContain(RETRY);
      const posts = routes.filter((r) => r.method === 'post').map((r) => r.pattern);
      expect(posts).toEqual([REFUND, RETRY]);
    });

    it('refuses an unauthorized refund before it can read a single row', async () => {
      const routes = await boot({ authorize: () => false });
      const route = routes.find((r) => r.pattern === REFUND);
      const recorded: Recorded = {};
      await route?.handler?.(fakeCtx(recorded));
      expect(recorded.status).toBe(403);
      expect(recorded.body).toEqual({ error: 'forbidden' });
    });

    it('refuses an unauthorized retry the same way', async () => {
      const routes = await boot({ authorize: () => false });
      const route = routes.find((r) => r.pattern === RETRY);
      const recorded: Recorded = {};
      await route?.handler?.(fakeCtx(recorded));
      expect(recorded.status).toBe(403);
    });

    it('refuses an unauthorized READ too — the guard is not action-only', async () => {
      const routes = await boot({ authorize: () => false });
      const route = routes.find((r) => r.pattern === '/payments-dashboard/api/health');
      const recorded: Recorded = {};
      await route?.handler?.(fakeCtx(recorded));
      expect(recorded.status).toBe(403);
    });

    it('serves an AUTHORIZED read off the real store once past the guard', async () => {
      // Proves the guard is what stopped the requests above, not a missing store.
      const routes = await boot({ authorize: () => true });
      const route = routes.find((r) => r.pattern === '/payments-dashboard/api/health');
      const recorded: Recorded = {};
      await route?.handler?.(fakeCtx(recorded));
      expect(recorded.status).toBe(200);
      expect(recorded.body).toMatchObject({ healthy: false });
    });

    it('answers an authorized refund with 503 when no payments manager is wired', async () => {
      const routes = await boot({ authorize: () => true });
      const route = routes.find((r) => r.pattern === REFUND);
      const recorded: Recorded = {};
      await route?.handler?.(fakeCtx(recorded));
      expect(recorded.status).toBe(503);
      expect(recorded.body).toMatchObject({ error: expect.stringContaining('payments manager') });
    });
  });
});
