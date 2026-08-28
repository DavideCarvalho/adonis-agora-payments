import { describe, expect, it } from 'vitest';
import type {
  RefundAction,
  RefundOutcome,
  ReplayAction,
  ReplayOutcome,
} from '../../src/dashboard/actions.js';
import type { ApiRequest, Deps } from '../../src/dashboard/handlers.js';
import {
  DISPUTE_STATUSES,
  PROVIDER_SCAN_CAP,
  disputes,
  health,
  overview,
  payments,
  providers,
  refundPayment,
  retryWebhookEvent,
  subscriptions,
  webhookEvents,
} from '../../src/dashboard/handlers.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

function req(query: Record<string, string | string[] | undefined> = {}): ApiRequest {
  return { params: {}, query };
}

function deps(store: InMemoryBillingStore, currency = 'BRL'): Deps {
  return { store, currency, now: () => NOW };
}

/** Build a store with a known set of rows, stamped with an explicit clock. */
async function seed(): Promise<InMemoryBillingStore> {
  const store = new InMemoryBillingStore();
  let tick = 0;
  store.now = () => new Date(NOW.getTime() - 1000 * (100 - tick++));

  await store.savePayment({
    gatewayId: 'pi_1',
    provider: 'stripe',
    status: 'paid',
    amount: 123456,
    currency: 'BRL',
    paidAt: new Date(NOW.getTime() - 60_000),
  });
  await store.savePayment({
    gatewayId: 'pi_2',
    provider: 'asaas',
    status: 'failed',
    amount: 999,
    currency: 'BRL',
  });
  await store.savePayment({
    gatewayId: 'pi_3',
    provider: 'stripe',
    status: 'paid',
    amount: 1,
    currency: 'BRL',
    paidAt: new Date(NOW.getTime() - 30_000),
  });
  await store.saveSubscription({
    gatewayId: 'sub_1',
    provider: 'stripe',
    customerId: 'cus_1',
    status: 'active',
    planId: 'pro',
  });
  await store.saveSubscription({
    gatewayId: 'sub_2',
    provider: 'stripe',
    customerId: 'cus_2',
    status: 'trialing',
    planId: 'pro',
  });
  await store.saveSubscription({
    gatewayId: 'sub_3',
    provider: 'stripe',
    customerId: 'cus_3',
    status: 'canceled',
    planId: 'pro',
  });
  await store.recordUsage({
    subscriptionId: 'sub_1',
    meter: 'api_calls',
    quantity: 7,
    recordedAt: new Date(NOW.getTime() - 60_000),
  });

  const failed = await store.recordWebhookEvent({
    gatewayEventId: 'evt_bad',
    provider: 'stripe',
    type: 'payment.failed',
    payload: {},
  });
  await store.markWebhookFailed(failed?.id ?? '', 'handler threw: Cannot read property id of null');
  const done = await store.recordWebhookEvent({
    gatewayEventId: 'evt_ok',
    provider: 'stripe',
    type: 'payment.succeeded',
    payload: {},
  });
  await store.markWebhookProcessed(done?.id ?? '');
  await store.recordWebhookEvent({
    gatewayEventId: 'evt_new',
    provider: 'woovi',
    type: 'charge.paid',
    payload: {},
  });
  return store;
}

describe('overview', () => {
  it('returns the billingOverview metrics with the display currency', async () => {
    const store = await seed();
    const res = await overview(deps(store), req());
    expect(res.status).toBe(200);
    const body = res.body as {
      currency: string;
      period: { from: string; to: string; preset: string };
      metrics: Array<{ key: string; value: number }>;
    };
    expect(body.currency).toBe('BRL');
    expect(body.period.preset).toBe('30d');
    expect(body.period.to).toBe(NOW.toISOString());
    // Revenue crosses the wire as INTEGER CENTS: 123456 + 1, never 1234.57.
    expect(body.metrics.find((m) => m.key === 'revenue')?.value).toBe(123457);
    // countActiveSubscriptions includes `trialing`.
    expect(body.metrics.find((m) => m.key === 'active_subscriptions')?.value).toBe(2);
    expect(body.metrics.find((m) => m.key === 'meter:api_calls')?.value).toBe(7);
  });

  it('honors the period preset', async () => {
    const store = await seed();
    const res = await overview(deps(store), req({ period: '24h' }));
    const body = res.body as { period: { from: string; preset: string } };
    expect(body.period.preset).toBe('24h');
    expect(new Date(body.period.from).getTime()).toBe(NOW.getTime() - 24 * 60 * 60 * 1000);
  });

  it('echoes back a configured non-BRL currency', async () => {
    const store = await seed();
    const res = await overview(deps(store, 'USD'), req());
    expect((res.body as { currency: string }).currency).toBe('USD');
  });
});

describe('payments', () => {
  it('lists every payment newest first, in integer cents', async () => {
    const store = await seed();
    const res = await payments(deps(store), req());
    const body = res.body as {
      payments: Array<{ gatewayId: string; amount: number; paidAt: string | null }>;
      page: { limit: number; offset: number; count: number };
    };
    expect(body.payments.map((p) => p.gatewayId)).toEqual(['pi_3', 'pi_2', 'pi_1']);
    expect(body.payments[0]?.amount).toBe(1);
    expect(body.page).toEqual({ limit: 50, offset: 0, count: 3, scanned: 3, truncated: false });
  });

  it('filters by status', async () => {
    const store = await seed();
    const res = await payments(deps(store), req({ status: 'failed' }));
    const body = res.body as { payments: Array<{ gatewayId: string }> };
    expect(body.payments.map((p) => p.gatewayId)).toEqual(['pi_2']);
  });

  it('treats an empty status param as no filter', async () => {
    const store = await seed();
    const res = await payments(deps(store), req({ status: '' }));
    expect((res.body as { payments: unknown[] }).payments).toHaveLength(3);
  });

  it('serializes timestamps as ISO strings or null', async () => {
    const store = await seed();
    const res = await payments(deps(store), req({ status: 'failed' }));
    const row = (res.body as { payments: Array<{ paidAt: string | null; createdAt: string }> })
      .payments[0];
    expect(row?.paidAt).toBeNull();
    expect(typeof row?.createdAt).toBe('string');
  });

  it('pages with limit/offset and echoes the paging back', async () => {
    const store = await seed();
    const first = await payments(deps(store), req({ limit: '2', offset: '0' }));
    const second = await payments(deps(store), req({ limit: '2', offset: '2' }));
    expect((first.body as { page: { count: number } }).page).toEqual({
      limit: 2,
      offset: 0,
      count: 2,
      scanned: 2,
      truncated: false,
    });
    // count < limit is the client's "no more pages" signal.
    expect((second.body as { page: { count: number } }).page.count).toBe(1);
  });

  it('caps an absurd limit instead of selecting the table', async () => {
    const store = await seed();
    const res = await payments(deps(store), req({ limit: '100000' }));
    expect((res.body as { page: { limit: number } }).page.limit).toBe(200);
  });

  it('ignores a garbage limit/offset rather than returning nothing', async () => {
    const store = await seed();
    const res = await payments(deps(store), req({ limit: 'lots', offset: '-5' }));
    const body = res.body as { page: { limit: number; offset: number }; payments: unknown[] };
    expect(body.page).toEqual({ limit: 50, offset: 0, count: 3, scanned: 3, truncated: false });
    expect(body.payments).toHaveLength(3);
  });
});

describe('webhookEvents', () => {
  it('lists the ledger newest first', async () => {
    const store = await seed();
    const res = await webhookEvents(deps(store), req());
    const body = res.body as { events: Array<{ gatewayEventId: string }> };
    expect(body.events.map((e) => e.gatewayEventId)).toEqual(['evt_new', 'evt_ok', 'evt_bad']);
  });

  it("surfaces a failed event WITH the handler's error message", async () => {
    // The single most operationally useful row in this console: the error is the only record
    // of why the event's effect never happened.
    const store = await seed();
    const res = await webhookEvents(deps(store), req({ status: 'failed' }));
    const body = res.body as { events: Array<{ gatewayEventId: string; error: string | null }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.gatewayEventId).toBe('evt_bad');
    expect(body.events[0]?.error).toContain('handler threw');
  });

  it('carries a null error for a healthy row', async () => {
    const store = await seed();
    const res = await webhookEvents(deps(store), req({ status: 'processed' }));
    expect((res.body as { events: Array<{ error: string | null }> }).events[0]?.error).toBeNull();
  });

  it('offers the three ledger statuses as the filter list', async () => {
    const store = await seed();
    const res = await webhookEvents(deps(store), req());
    expect((res.body as { statuses: string[] }).statuses).toEqual([
      'received',
      'processed',
      'failed',
    ]);
  });
});

// ── Health ────────────────────────────────────────────────────────────────────────────────────

describe('health', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  /** A store whose rows are stamped at an explicit age, so the thresholds are actually exercised. */
  async function healthStore(): Promise<InMemoryBillingStore> {
    const store = new InMemoryBillingStore();
    const at = (ms: number) => {
      store.now = () => new Date(NOW.getTime() - ms);
    };

    // Claimed 30 min ago and never finished — past the 15 min "stuck" threshold.
    at(30 * MINUTE);
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_stuck',
      provider: 'stripe',
      type: 'invoice.paid',
      payload: {},
    });
    // Claimed a minute ago: in flight, NOT stuck. A check that counted this would fire on every
    // healthy install under load.
    at(MINUTE);
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_inflight',
      provider: 'stripe',
      type: 'invoice.paid',
      payload: {},
    });

    at(2 * HOUR);
    for (const [id, provider, type] of [
      ['evt_a', 'stripe', 'invoice.payment_failed'],
      ['evt_b', 'stripe', 'invoice.payment_failed'],
      ['evt_c', 'asaas', 'payment.failed'],
    ] as const) {
      const row = await store.recordWebhookEvent({
        gatewayEventId: id,
        provider,
        type,
        payload: {},
      });
      await store.markWebhookFailed(row?.id ?? '', 'boom');
    }

    // Created 4 h ago and still pending — past the 2 h "unconfirmed" threshold.
    at(4 * HOUR);
    await store.savePayment({
      gatewayId: 'pi_unconfirmed',
      provider: 'asaas',
      status: 'pending',
      amount: 5000,
      currency: 'BRL',
    });
    // Created a minute ago and pending: the gateway simply has not answered yet.
    at(MINUTE);
    await store.savePayment({
      gatewayId: 'pi_fresh',
      provider: 'asaas',
      status: 'pending',
      amount: 100,
      currency: 'BRL',
    });
    return store;
  }

  it('reports a clean install as healthy with every check at zero', async () => {
    const res = await health(deps(new InMemoryBillingStore()), req());
    expect(res.status).toBe(200);
    const body = res.body as {
      healthy: boolean;
      checkedAt: string;
      checks: Array<{ key: string; count: number; healthy: boolean; hint: string }>;
      failures: unknown[];
    };
    expect(body.healthy).toBe(true);
    expect(body.checks).toHaveLength(6);
    expect(body.checks.map((c) => c.key)).toContain('disputes_due');
    expect(body.checks.every((c) => c.count === 0 && c.healthy)).toBe(true);
    expect(body.failures).toEqual([]);
    expect(body.checkedAt).toBe(NOW.toISOString());
  });

  it('counts the three silent failures and marks the install unhealthy', async () => {
    const res = await health(deps(await healthStore()), req());
    const body = res.body as {
      healthy: boolean;
      checks: Array<{ key: string; count: number; healthy: boolean }>;
    };
    const count = (key: string) => body.checks.find((c) => c.key === key)?.count;
    expect(body.healthy).toBe(false);
    // The one-minute-old event is in flight, not stuck; the one-minute-old charge is not
    // unconfirmed. Only the aged rows count.
    expect(count('stuck_webhooks')).toBe(1);
    expect(count('failed_webhooks')).toBe(3);
    expect(count('unconfirmed_payments')).toBe(1);
  });

  it('names the closing dispute windows, as ISO strings', async () => {
    const store = await healthStore();
    const due = new Date(NOW.getTime() + 6 * 3_600_000);
    await store.saveDispute({
      gatewayId: 'dp_closing',
      paymentGatewayId: 'pi_1',
      provider: 'stripe',
      status: 'open',
      evidenceDueBy: due,
    });

    const res = await health(deps(store), req());
    const body = res.body as {
      checks: Array<{ key: string; count: number }>;
      deadlines: Array<{ gatewayId: string; paymentGatewayId: string; evidenceDueBy: string }>;
    };
    expect(body.checks.find((c) => c.key === 'disputes_due')?.count).toBe(1);
    // A count names no gateway dashboard to open — the row has to come with it, and every
    // timestamp crosses this boundary as an ISO string.
    expect(body.deadlines).toEqual([
      expect.objectContaining({
        gatewayId: 'dp_closing',
        paymentGatewayId: 'pi_1',
        evidenceDueBy: due.toISOString(),
      }),
    ]);
  });

  it('names WHICH provider and event type is failing, worst first', async () => {
    // A count says "three things broke"; this says where to look.
    const res = await health(deps(await healthStore()), req());
    const failures = (
      res.body as { failures: Array<{ provider: string; type: string; count: number }> }
    ).failures;
    expect(failures[0]).toEqual({
      provider: 'stripe',
      type: 'invoice.payment_failed',
      count: 2,
    });
    expect(failures).toContainEqual({ provider: 'asaas', type: 'payment.failed', count: 1 });
  });

  it('carries a hint on every check — a count nobody can act on is decoration', async () => {
    const res = await health(deps(await healthStore()), req());
    const checks = (res.body as { checks: Array<{ hint: string; label: string }> }).checks;
    expect(checks.every((c) => c.hint.length > 0 && c.label.length > 0)).toBe(true);
  });
});

// ── Subscriptions ─────────────────────────────────────────────────────────────────────────────

describe('subscriptions', () => {
  async function subsStore(): Promise<InMemoryBillingStore> {
    const store = new InMemoryBillingStore();
    let tick = 0;
    store.now = () => new Date(NOW.getTime() - 1000 * (100 - tick++));
    const rows = [
      ['sub_active', 'stripe', 'active', 'pro'],
      ['sub_paused', 'stripe', 'paused', 'pro'],
      ['sub_due_1', 'asaas', 'past_due', 'basic'],
      ['sub_due_2', 'stripe', 'past_due', 'pro'],
      ['sub_trial', 'stripe', 'trialing', 'pro'],
    ] as const;
    for (const [gatewayId, provider, status, planId] of rows) {
      await store.saveSubscription({
        gatewayId,
        provider,
        customerId: `cus_${gatewayId}`,
        status,
        planId,
        trialEndsAt: status === 'trialing' ? new Date(NOW.getTime() + 86_400_000) : null,
        endsAt: new Date(NOW.getTime() + 7 * 86_400_000),
      });
    }
    return store;
  }

  it('lists subscriptions newest first with plan, customer and both boundary dates', async () => {
    const res = await subscriptions(deps(await subsStore()), req());
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
    expect(body.subscriptions[0]?.gatewayId).toBe('sub_trial');
    expect(body.subscriptions[0]?.planId).toBe('pro');
    expect(body.subscriptions[0]?.customerId).toBe('cus_sub_trial');
    expect(body.subscriptions[0]?.trialEndsAt).toBe(
      new Date(NOW.getTime() + 86_400_000).toISOString(),
    );
    expect(body.subscriptions[0]?.endsAt).toBe(
      new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    );
  });

  it('filters by status — the past_due rows are the ones that cost money today', async () => {
    const res = await subscriptions(deps(await subsStore()), req({ status: 'past_due' }));
    const body = res.body as { subscriptions: Array<{ gatewayId: string }> };
    expect(body.subscriptions.map((s) => s.gatewayId).sort()).toEqual(['sub_due_1', 'sub_due_2']);
  });

  it('keeps paused OUT of the active filter — a paused subscriber is not paying', async () => {
    const res = await subscriptions(deps(await subsStore()), req({ status: 'active' }));
    const body = res.body as { subscriptions: Array<{ gatewayId: string; status: string }> };
    expect(body.subscriptions.map((s) => s.gatewayId)).toEqual(['sub_active']);
    expect(body.subscriptions.every((s) => s.status !== 'paused')).toBe(true);
  });

  it('reports the WHOLE-TABLE past_due count, not the page count', async () => {
    // Paged down to one row, the count still has to say two — it is what decides whether the
    // operator opens the tab at all.
    const res = await subscriptions(deps(await subsStore()), req({ status: 'active', limit: '1' }));
    expect((res.body as { counts: { past_due: number } }).counts.past_due).toBe(2);
  });

  it('offers the status filter with past_due first', async () => {
    const res = await subscriptions(deps(await subsStore()), req());
    const statuses = (res.body as { statuses: string[] }).statuses;
    expect(statuses[0]).toBe('past_due');
    expect(statuses).toContain('paused');
  });
});

// ── Provider filter + discovery ───────────────────────────────────────────────────────────────

describe('provider filter', () => {
  it('narrows payments to one gateway', async () => {
    const store = await seed();
    const res = await payments(deps(store), req({ provider: 'asaas' }));
    const body = res.body as {
      payments: Array<{ gatewayId: string; provider: string }>;
      page: { count: number; truncated: boolean };
    };
    expect(body.payments.map((p) => p.gatewayId)).toEqual(['pi_2']);
    expect(body.page.truncated).toBe(false);
  });

  it('composes with the status filter instead of replacing it', async () => {
    const store = await seed();
    const res = await payments(deps(store), req({ provider: 'stripe', status: 'paid' }));
    const body = res.body as { payments: Array<{ gatewayId: string }> };
    expect(body.payments.map((p) => p.gatewayId)).toEqual(['pi_3', 'pi_1']);
  });

  it('narrows webhook events to one gateway', async () => {
    const store = await seed();
    const res = await webhookEvents(deps(store), req({ provider: 'woovi' }));
    const body = res.body as { events: Array<{ gatewayEventId: string }> };
    expect(body.events.map((e) => e.gatewayEventId)).toEqual(['evt_new']);
  });

  it('pages over the FILTERED set, not the raw one', async () => {
    const store = await seed();
    const first = await payments(deps(store), req({ provider: 'stripe', limit: '1', offset: '0' }));
    const second = await payments(
      deps(store),
      req({ provider: 'stripe', limit: '1', offset: '1' }),
    );
    expect((first.body as { payments: Array<{ gatewayId: string }> }).payments[0]?.gatewayId).toBe(
      'pi_3',
    );
    expect((second.body as { payments: Array<{ gatewayId: string }> }).payments[0]?.gatewayId).toBe(
      'pi_1',
    );
  });

  it('says so when the scan gave up rather than reporting a confident empty page', async () => {
    // "No Asaas payments" and "no Asaas payments in the last thousand rows" are different
    // answers, and only one of them is safe to act on.
    const store = new InMemoryBillingStore();
    for (let i = 0; i < PROVIDER_SCAN_CAP + 5; i += 1) {
      await store.savePayment({
        gatewayId: `pi_${i}`,
        provider: 'stripe',
        status: 'paid',
        amount: 1,
        currency: 'BRL',
      });
    }
    const res = await payments(deps(store), req({ provider: 'asaas' }));
    const body = res.body as { payments: unknown[]; page: { scanned: number; truncated: boolean } };
    expect(body.payments).toHaveLength(0);
    expect(body.page.scanned).toBe(PROVIDER_SCAN_CAP);
    expect(body.page.truncated).toBe(true);
  });

  it('never claims truncation for an unfiltered page', async () => {
    const store = await seed();
    const res = await payments(deps(store), req());
    expect((res.body as { page: { truncated: boolean } }).page.truncated).toBe(false);
  });
});

describe('providers', () => {
  it('reports the gateways actually present in the data, sorted, without duplicates', async () => {
    const store = await seed();
    const res = await providers(deps(store), req());
    // stripe + asaas from payments, stripe from subscriptions, woovi from the ledger.
    expect((res.body as { providers: string[] }).providers).toEqual(['asaas', 'stripe', 'woovi']);
  });

  it('is empty on a fresh install rather than listing the eighteen shipped drivers', async () => {
    const res = await providers(deps(new InMemoryBillingStore()), req());
    expect((res.body as { providers: string[] }).providers).toEqual([]);
  });
});

// ── Actions: refund ───────────────────────────────────────────────────────────────────────────

describe('refundPayment', () => {
  /** A store with one refundable payment and one that is not. */
  async function payStore(): Promise<InMemoryBillingStore> {
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pi_paid',
      provider: 'stripe',
      status: 'paid',
      amount: 5000,
      currency: 'BRL',
      customerId: 'cus_1',
    });
    await store.savePayment({
      gatewayId: 'pi_pending',
      provider: 'stripe',
      status: 'pending',
      amount: 5000,
      currency: 'BRL',
    });
    return store;
  }

  /** A refund port that records what it was asked for. */
  function spyRefund(outcome: RefundOutcome = { kind: 'ok', refund: okRefund() }) {
    const calls: Array<{ provider: string; gatewayId: string; amount?: number }> = [];
    const action: RefundAction = async (input) => {
      calls.push(input);
      return outcome;
    };
    return { calls, action };
  }

  function okRefund() {
    return { gatewayId: 're_1', amount: 5000, currency: 'BRL', status: 'succeeded' };
  }

  function withRefund(store: InMemoryBillingStore, action: RefundAction): Deps {
    return { ...deps(store), actions: { refund: action } };
  }

  function body(gatewayId: string, payload?: unknown): ApiRequest {
    return {
      params: { gatewayId },
      query: {},
      ...(payload !== undefined ? { body: payload } : {}),
    };
  }

  it('refunds the full amount through the payment’s OWN gateway', async () => {
    const store = await payStore();
    const spy = spyRefund();
    const res = await refundPayment(withRefund(store, spy.action), body('pi_paid'));
    expect(res.status).toBe(200);
    // The provider comes from the ROW, never from the request: refunding a Stripe charge at Asaas
    // is not a thing a client should be able to ask for.
    expect(spy.calls).toEqual([{ provider: 'stripe', gatewayId: 'pi_paid' }]);
  });

  it('passes a partial amount through as integer minor units', async () => {
    const store = await payStore();
    const spy = spyRefund();
    await refundPayment(withRefund(store, spy.action), body('pi_paid', { amount: 1999 }));
    expect(spy.calls[0]?.amount).toBe(1999);
  });

  it('does NOT rewrite the local row — the gateway’s webhook does that', async () => {
    const store = await payStore();
    await refundPayment(withRefund(store, spyRefund().action), body('pi_paid'));
    const row = await store.findPaymentByGatewayId('pi_paid');
    expect(row?.status).toBe('paid');
  });

  it('404s an unknown payment', async () => {
    const store = await payStore();
    const res = await refundPayment(withRefund(store, spyRefund().action), body('pi_nope'));
    expect(res.status).toBe(404);
  });

  it('refuses a payment that is not paid', async () => {
    const store = await payStore();
    const spy = spyRefund();
    const res = await refundPayment(withRefund(store, spy.action), body('pi_pending'));
    expect(res.status).toBe(409);
    // And nothing reached the gateway.
    expect(spy.calls).toEqual([]);
  });

  it('rejects an amount that is not a positive integer of minor units', async () => {
    const store = await payStore();
    const spy = spyRefund();
    for (const amount of [19.9, '1999', 0, -100]) {
      const res = await refundPayment(withRefund(store, spy.action), body('pi_paid', { amount }));
      expect(res.status).toBe(400);
    }
    expect(spy.calls).toEqual([]);
  });

  it('rejects a partial larger than the payment itself', async () => {
    const store = await payStore();
    const spy = spyRefund();
    const res = await refundPayment(
      withRefund(store, spy.action),
      body('pi_paid', { amount: 5001 }),
    );
    expect(res.status).toBe(400);
    expect(spy.calls).toEqual([]);
  });

  it('reports the GATEWAY’s own message when it refuses', async () => {
    // A silent failure here is worse than no button.
    const store = await payStore();
    const spy = spyRefund({ kind: 'gateway-error', message: 'charge_already_refunded' });
    const res = await refundPayment(withRefund(store, spy.action), body('pi_paid'));
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe('charge_already_refunded');
  });

  it('reports a gateway that has no refund API as a conflict, not a crash', async () => {
    const store = await payStore();
    const spy = spyRefund({ kind: 'unsupported', message: 'woovi has no refund API' });
    const res = await refundPayment(withRefund(store, spy.action), body('pi_paid'));
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain('refund API');
  });

  it('reports a provider that is no longer configured as unavailable', async () => {
    const store = await payStore();
    const spy = spyRefund({ kind: 'unavailable', message: 'Driver "stripe" is not configured.' });
    const res = await refundPayment(withRefund(store, spy.action), body('pi_paid'));
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toContain('not configured');
  });

  it('503s with a sentence when no payments manager is wired at all', async () => {
    const store = await payStore();
    const res = await refundPayment(deps(store), body('pi_paid'));
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toContain('payments manager');
  });
});

// ── Actions: webhook retry ────────────────────────────────────────────────────────────────────

describe('retryWebhookEvent', () => {
  function spyReplay(outcome: ReplayOutcome = { kind: 'processed' }) {
    const calls: Array<{ gatewayEventId: string; provider: string; previousError: string | null }> =
      [];
    const action: ReplayAction = async (input) => {
      calls.push(input);
      return outcome;
    };
    return { calls, action };
  }

  function withReplay(store: InMemoryBillingStore, action: ReplayAction): Deps {
    return { ...deps(store), actions: { replayWebhook: action } };
  }

  function target(gatewayEventId: string): ApiRequest {
    return { params: { gatewayEventId }, query: {} };
  }

  it('replays a failed event, handing the port its provider, type and previous error', async () => {
    const store = await seed();
    const spy = spyReplay();
    const res = await retryWebhookEvent(withReplay(store, spy.action), target('evt_bad'));
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('processed');
    expect(spy.calls[0]?.provider).toBe('stripe');
    expect(spy.calls[0]?.previousError).toContain('handler threw');
  });

  it('404s an event that never reached the ledger', async () => {
    const store = await seed();
    const res = await retryWebhookEvent(withReplay(store, spyReplay().action), target('evt_ghost'));
    expect(res.status).toBe(404);
  });

  it('refuses an in-flight or already-processed event', async () => {
    // Replaying a `received` row would race the handler that is still running it; replaying a
    // `processed` one would ask for an effect that already happened.
    const store = await seed();
    const spy = spyReplay();
    for (const id of ['evt_new', 'evt_ok']) {
      const res = await retryWebhookEvent(withReplay(store, spy.action), target(id));
      expect(res.status).toBe(409);
    }
    expect(spy.calls).toEqual([]);
  });

  it('reports a handler that threw AGAIN with its new message', async () => {
    const store = await seed();
    const spy = spyReplay({ kind: 'failed', message: 'TypeError: still broken' });
    const res = await retryWebhookEvent(withReplay(store, spy.action), target('evt_bad'));
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toContain('still broken');
  });

  it('reports an event the driver cannot rebuild, and says the ledger is untouched', async () => {
    const store = await seed();
    const spy = spyReplay({ kind: 'undeliverable', message: 'Missing `stripe-signature` header.' });
    const res = await retryWebhookEvent(withReplay(store, spy.action), target('evt_bad'));
    expect(res.status).toBe(422);
    const failure = res.body as { error: string; note: string };
    expect(failure.error).toContain('stripe-signature');
    expect(failure.note).toContain('unchanged');
  });

  it('reports a row something else claimed first as a conflict', async () => {
    const store = await seed();
    const spy = spyReplay({ kind: 'conflict' });
    const res = await retryWebhookEvent(withReplay(store, spy.action), target('evt_bad'));
    expect(res.status).toBe(409);
  });

  it('503s with a sentence when no payments manager is wired at all', async () => {
    const store = await seed();
    const res = await retryWebhookEvent(deps(store), target('evt_bad'));
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toContain('payments manager');
  });
});

/**
 * `GET <api>/disputes` — the panel that exists so nobody misses a window.
 *
 * Read-only by design: whether to fight a chargeback or refund it turns on the fee, the
 * evidence the app actually holds and the ratio that puts a merchant into a card network's
 * monitoring programme. That decision stays in the app's code; this endpoint only makes the
 * clock visible.
 */
describe('disputes', () => {
  const HOUR = 3_600_000;

  /** A store holding one warning, one open dispute closing soon, and one already lost. */
  async function disputeStore(): Promise<InMemoryBillingStore> {
    const store = new InMemoryBillingStore();
    let tick = 0;
    store.now = () => new Date(NOW.getTime() - 1000 * (100 - tick++));

    await store.saveDispute({
      gatewayId: 'dp_lost',
      paymentGatewayId: 'pi_1',
      provider: 'stripe',
      status: 'lost',
      outcome: 'lost',
      evidenceDueBy: new Date(NOW.getTime() + 2 * HOUR),
      amount: 4990,
      currency: 'BRL',
    });
    await store.saveDispute({
      gatewayId: 'dp_soon',
      paymentGatewayId: 'pi_2',
      provider: 'stripe',
      status: 'open',
      reason: 'fraudulent',
      evidenceDueBy: new Date(NOW.getTime() + 10 * HOUR),
      amount: 1000,
      currency: 'BRL',
    });
    await store.saveDispute({
      gatewayId: 'dp_warning',
      paymentGatewayId: 'pi_3',
      provider: 'adyen',
      status: 'warning',
      evidenceDueBy: new Date(NOW.getTime() + 4 * HOUR),
    });
    return store;
  }

  const body = (res: { body: unknown }) =>
    res.body as {
      disputes: Array<{ gatewayId: string; evidenceDueBy: string | null; amount: number | null }>;
      dueWithin?: { hours: number; total: number };
      page: { limit: number; offset: number; count: number };
      statuses: readonly string[];
    };

  it('lists every dispute newest first, with amounts as integer minor units', async () => {
    const res = await disputes(deps(await disputeStore()), req());
    expect(res.status).toBe(200);
    const payload = body(res);
    expect(payload.disputes.map((row) => row.gatewayId)).toEqual([
      'dp_warning',
      'dp_soon',
      'dp_lost',
    ]);
    // NOT 49.90 — nothing on this boundary divides.
    expect(payload.disputes[2]?.amount).toBe(4990);
    expect(payload.statuses).toEqual(DISPUTE_STATUSES);
  });

  it('filters by status and by provider', async () => {
    const store = await disputeStore();
    expect(
      body(await disputes(deps(store), req({ status: 'warning' }))).disputes.map(
        (r) => r.gatewayId,
      ),
    ).toEqual(['dp_warning']);
    expect(
      body(await disputes(deps(store), req({ provider: 'stripe' }))).disputes.map(
        (r) => r.gatewayId,
      ),
    ).toEqual(['dp_soon', 'dp_lost']);
  });

  it('switches to the closing windows on ?dueWithin, soonest first, open only', async () => {
    const res = await disputes(deps(await disputeStore()), req({ dueWithin: '12' }));
    const payload = body(res);
    // The lost one is inside the horizon and must not appear — nobody has to answer it.
    expect(payload.disputes.map((row) => row.gatewayId)).toEqual(['dp_warning', 'dp_soon']);
    expect(payload.dueWithin).toEqual({ hours: 12, total: 2 });
  });

  it('reports the full number of closing windows even when the page is smaller', async () => {
    const res = await disputes(deps(await disputeStore()), req({ dueWithin: '12', limit: '1' }));
    const payload = body(res);
    // A page that fills says nothing about how many more windows are closing, and that number
    // is the one an operator plans their day around.
    expect(payload.disputes).toHaveLength(1);
    expect(payload.dueWithin?.total).toBe(2);
  });

  it('defaults a bare ?dueWithin to the horizon billingHealth alerts on', async () => {
    const payload = body(await disputes(deps(await disputeStore()), req({ dueWithin: '' })));
    expect(payload.dueWithin?.hours).toBe(72);
  });

  it.each(['-5', 'soon'])('rejects %s rather than answering a different question', async (raw) => {
    // Falling back to the default would answer something the caller did not ask, and they
    // could not tell from the response which horizon they got.
    const res = await disputes(deps(await disputeStore()), req({ dueWithin: raw }));
    expect(res.status).toBe(400);
  });

  it('says a deadline is missing rather than inventing one', async () => {
    const store = new InMemoryBillingStore();
    await store.saveDispute({
      gatewayId: 'dp_silent',
      paymentGatewayId: 'pi_9',
      provider: 'woovi',
      status: 'open',
    });
    const payload = body(await disputes(deps(store), req()));
    // `null` means the gateway told us nothing — the SPA has to be able to say so.
    expect(payload.disputes[0]?.evidenceDueBy).toBeNull();
    // And it is not in the work list at all: nothing to be late for.
    expect(body(await disputes(deps(store), req({ dueWithin: '999' }))).disputes).toEqual([]);
  });
});
