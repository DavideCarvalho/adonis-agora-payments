import { describe, expect, it } from 'vitest';
import {
  BILLING_LIST_MAX_SIZE,
  clampPage,
  clampSize,
  listOffset,
} from '../src/billing/list_query.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * `listPayments`/`listWebhookEvents` are the reads the dashboard is built on. They return a
 * NORMALIZED plain shape rather than the implementation's row type — the write side of
 * `BillingStore` is generic over that type, so a reader cannot work against it.
 *
 * The Lucid implementation is exercised against a real database elsewhere; these cover the
 * behaviour both implementations must share (order, filter, paging, normalization), driven
 * through the in-memory store.
 */

const T0 = new Date('2026-08-27T12:00:00.000Z');

function storeWithClock(): InMemoryBillingStore {
  const store = new InMemoryBillingStore();
  let tick = 0;
  store.now = () => new Date(T0.getTime() + 1000 * tick++);
  return store;
}

describe('listPayments', () => {
  it('returns the normalized shape, with amount left as integer cents', async () => {
    const store = storeWithClock();
    await store.savePayment({
      gatewayId: 'pi_1',
      provider: 'stripe',
      status: 'paid',
      amount: 123456,
      currency: 'BRL',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      paidAt: T0,
    });
    const [row] = await store.listPayments({});
    expect(row).toMatchObject({
      gatewayId: 'pi_1',
      provider: 'stripe',
      status: 'paid',
      // NOT 1234.56 — the store never divides.
      amount: 123456,
      currency: 'BRL',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    });
    expect(row?.paidAt).toEqual(T0);
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('orders newest first', async () => {
    const store = storeWithClock();
    for (const id of ['a', 'b', 'c']) {
      await store.savePayment({
        gatewayId: id,
        provider: 'stripe',
        status: 'paid',
        amount: 1,
        currency: 'BRL',
      });
    }
    expect((await store.listPayments({})).map((r) => r.gatewayId)).toEqual(['c', 'b', 'a']);
  });

  it('filters by status', async () => {
    const store = storeWithClock();
    await store.savePayment({
      gatewayId: 'ok',
      provider: 'stripe',
      status: 'paid',
      amount: 1,
      currency: 'BRL',
    });
    await store.savePayment({
      gatewayId: 'bad',
      provider: 'stripe',
      status: 'failed',
      amount: 1,
      currency: 'BRL',
    });
    expect((await store.listPayments({ status: 'failed' })).map((r) => r.gatewayId)).toEqual([
      'bad',
    ]);
    expect(await store.listPayments({ status: 'nonexistent' })).toEqual([]);
  });

  it('pages with page and size', async () => {
    const store = storeWithClock();
    for (const id of ['a', 'b', 'c', 'd']) {
      await store.savePayment({
        gatewayId: id,
        provider: 'stripe',
        status: 'paid',
        amount: 1,
        currency: 'BRL',
      });
    }
    expect((await store.listPayments({ size: 2 })).map((r) => r.gatewayId)).toEqual(['d', 'c']);
    expect((await store.listPayments({ size: 2, page: 2 })).map((r) => r.gatewayId)).toEqual([
      'b',
      'a',
    ]);
    expect(await store.listPayments({ size: 2, page: 6 })).toEqual([]);
  });

  it('does not return an upserted payment twice', async () => {
    const store = storeWithClock();
    for (const status of ['pending', 'paid']) {
      await store.savePayment({
        gatewayId: 'pi_1',
        provider: 'stripe',
        status,
        amount: 500,
        currency: 'BRL',
      });
    }
    const rows = await store.listPayments({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('paid');
  });
});

describe('listWebhookEvents', () => {
  it('surfaces a failed event with its error message', async () => {
    const store = storeWithClock();
    const row = await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.failed',
      payload: { a: 1 },
    });
    await store.markWebhookFailed(row?.id ?? '', 'boom');
    const [event] = await store.listWebhookEvents({ status: 'failed' });
    expect(event).toMatchObject({
      gatewayEventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.failed',
      status: 'failed',
      error: 'boom',
    });
    expect(event?.createdAt).toBeInstanceOf(Date);
    expect(event?.updatedAt).toBeInstanceOf(Date);
  });

  it('reports a processed event with a null error', async () => {
    const store = storeWithClock();
    const row = await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: {},
    });
    await store.markWebhookProcessed(row?.id ?? '');
    const [event] = await store.listWebhookEvents({});
    expect(event?.status).toBe('processed');
    expect(event?.error).toBeNull();
  });

  it('clears the error when a failed event is claimed again for a retry', async () => {
    const store = storeWithClock();
    const row = await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: {},
    });
    await store.markWebhookFailed(row?.id ?? '', 'boom');
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: {},
    });
    const [event] = await store.listWebhookEvents({});
    // A retry in flight must not still read as failed with a stale reason.
    expect(event?.status).toBe('received');
    expect(event?.error).toBeNull();
  });

  it('orders newest first and pages', async () => {
    const store = storeWithClock();
    for (const id of ['a', 'b', 'c']) {
      await store.recordWebhookEvent({
        gatewayEventId: id,
        provider: 'stripe',
        type: 't',
        payload: {},
      });
    }
    expect((await store.listWebhookEvents({})).map((e) => e.gatewayEventId)).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(
      (await store.listWebhookEvents({ size: 1, page: 2 })).map((e) => e.gatewayEventId),
    ).toEqual(['b']);
  });
});

describe('paging bounds', () => {
  it('defaults, floors and caps the size', () => {
    expect(clampSize(undefined)).toBe(50);
    expect(clampSize(0)).toBe(50);
    expect(clampSize(-1)).toBe(50);
    expect(clampSize(Number.NaN)).toBe(50);
    expect(clampSize(10.9)).toBe(10);
    expect(clampSize(1_000_000)).toBe(BILLING_LIST_MAX_SIZE);
  });

  it('clamps the page to the 1-based first page', () => {
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-3)).toBe(1);
    expect(clampPage(Number.NaN)).toBe(1);
    expect(clampPage(7.9)).toBe(7);
  });

  it('turns a page into the 0-based SQL offset callers never see', () => {
    expect(listOffset(undefined, undefined)).toBe(0);
    expect(listOffset(1, 25)).toBe(0);
    expect(listOffset(3, 25)).toBe(50);
    // A page below 1 and a garbage size both fall back to the defaults, never to a negative
    // offset — the one value that would make a store throw instead of returning a page.
    expect(listOffset(0, 0)).toBe(0);
  });
});
