import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingStore } from '../src/billing/billing_store.js';
import {
  auditEvents,
  customers,
  type Deps,
  disputes,
  payments,
  subscriptions,
  webhookEvents,
} from '../src/dashboard/handlers.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

interface CursorBody {
  data: Array<{ id: string }>;
  meta: {
    nextCursor: string | null;
    prevCursor: string | null;
    hasNext: boolean;
    hasPrev: boolean;
  };
  counts?: unknown;
}

const T0 = Date.parse('2026-11-17T10:00:00.000Z');

/** Five of everything the console lists, at two instants (ties on `created_at`). */
async function seeded(): Promise<InMemoryBillingStore> {
  const store = new InMemoryBillingStore();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let n = 0; n < 5; n++) {
      vi.setSystemTime(T0 + Math.floor(n / 3) * 1000);
      await store.savePayment({
        gatewayId: `pay_${n}`,
        provider: 'asaas',
        status: 'paid',
        amount: 100,
        currency: 'BRL',
      });
      await store.saveCustomer({ gatewayId: `cus_${n}`, provider: 'asaas' });
      await store.saveSubscription({
        gatewayId: `sub_${n}`,
        provider: 'asaas',
        customerId: `cus_${n}`,
        status: 'past_due',
        planId: 'pro',
      });
      await store.recordWebhookEvent({
        gatewayEventId: `evt_${n}`,
        provider: 'asaas',
        type: 'payment.succeeded',
        payload: {},
      });
      await store.saveDispute({
        gatewayId: `dp_${n}`,
        provider: 'asaas',
        paymentGatewayId: `pay_${n}`,
        status: 'open',
        amount: 100,
        currency: 'BRL',
      });
      await store.recordAuditEvent({ action: 'payment.refunded', provider: 'asaas' });
    }
  } finally {
    vi.useRealTimers();
  }
  return store;
}

const LISTS = { payments, customers, subscriptions, webhookEvents, disputes, auditEvents };
// Webhook events and subscriptions open on one status; ask for every one.
const ALL: Record<string, Record<string, unknown>> = {
  webhookEvents: { filter: { status: 'received' } },
  subscriptions: { filter: { status: 'past_due' } },
};

describe('console lists by cursor', () => {
  let deps: Deps;
  beforeEach(async () => {
    deps = { store: (await seeded()) as unknown as BillingStore, currency: 'BRL' };
  });

  for (const [name, handler] of Object.entries(LISTS)) {
    it(`${name}: first/after walk every row once, no total`, async () => {
      const seen: string[] = [];
      let after: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const response = await handler(deps, {
          params: {},
          query: { ...ALL[name], first: '2', ...(after ? { after } : {}) },
        });
        expect(response.status).toBe(200);
        const body = response.body as CursorBody & { meta: { total?: number } };
        expect(body.meta.total).toBeUndefined();
        expect(body.meta.hasPrev).toBe(after !== null);
        seen.push(...body.data.map((row) => row.id));
        if (!body.meta.hasNext) break;
        after = body.meta.nextCursor;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });
  }

  it('keeps ?page= on the offset envelope with its total', async () => {
    const response = await payments(deps, { params: {}, query: { page: '2', size: '2' } });
    expect((response.body as { meta: object }).meta).toMatchObject({
      total: 5,
      currentPage: 2,
      lastPage: 3,
    });
  });

  it('carries the subscription counts on the first cursor page only', async () => {
    const query = { filter: { status: 'past_due' }, first: '2' };
    const first = (await subscriptions(deps, { params: {}, query })).body as CursorBody;
    expect(first.counts).toEqual({ past_due: 5, failing_renewals: 0 });
    const next = (
      await subscriptions(deps, {
        params: {},
        query: { ...query, after: first.meta.nextCursor },
      })
    ).body as CursorBody;
    expect(next.counts).toBeUndefined();
  });

  it('refuses a forged cursor, before/last, and a cursor on the dispute work list', async () => {
    for (const query of [{ after: 'forged' }, { before: 'x', last: '2' }]) {
      expect((await payments(deps, { params: {}, query })).status).toBe(400);
    }
    const workList = await disputes(deps, {
      params: {},
      query: { filter: { dueWithin: '48' }, sort: 'evidenceDueBy', first: '2' },
    });
    expect(workList.status).toBe(400);
  });
});
