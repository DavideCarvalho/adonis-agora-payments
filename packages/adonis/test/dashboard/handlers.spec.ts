import { describe, expect, it } from 'vitest';
import type { ApiRequest, Deps } from '../../src/dashboard/handlers.js';
import { overview, payments, webhookEvents } from '../../src/dashboard/handlers.js';
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
    expect(body.page).toEqual({ limit: 50, offset: 0, count: 3 });
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
    expect(body.page).toEqual({ limit: 50, offset: 0, count: 3 });
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
