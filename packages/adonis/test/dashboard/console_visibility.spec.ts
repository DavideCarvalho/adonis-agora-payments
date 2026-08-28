import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/billing/billing_store.js';
import type { RefundOutcome } from '../../src/dashboard/actions.js';
import type { ApiRequest, Deps } from '../../src/dashboard/handlers.js';
import {
  auditEvents,
  customers,
  health,
  paymentDetail,
  payments,
  providers,
  refundPayment,
  resolveDispute,
  webhookEvents,
} from '../../src/dashboard/handlers.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

function req(
  query: Record<string, string | string[] | undefined> = {},
  params: Record<string, string | undefined> = {},
  body?: unknown,
): ApiRequest {
  return { params, query, ...(body !== undefined ? { body } : {}) };
}

function deps(store: InMemoryBillingStore, over: Partial<Deps> = {}): Deps {
  return { store, currency: 'BRL', now: () => NOW, ...over };
}

/** A store holding one student's charge, mapped to an app user, plus a decoy. */
async function seed(): Promise<InMemoryBillingStore> {
  const store = new InMemoryBillingStore();
  await store.saveCustomer({
    gatewayId: 'cus_ana',
    provider: 'asaas',
    ownerType: 'users',
    ownerId: '4102',
    name: 'Ana',
    email: 'ana@example.com',
  });
  await store.savePayment({
    gatewayId: 'pay_ana',
    provider: 'asaas',
    status: 'paid',
    amount: 19900,
    currency: 'BRL',
    customerId: 'cus_ana',
    externalReference: 'enrolment-4102',
    paidAt: NOW,
  });
  await store.savePayment({
    gatewayId: 'pay_other',
    provider: 'asaas',
    status: 'paid',
    amount: 100,
    currency: 'BRL',
  });
  return store;
}

/**
 * "Did THIS student's payment land?"
 *
 * The console could not answer it. `listPayments` returned the app's own reference and this
 * serializer dropped it, so the screen showed a `pay_…` where the operator was holding an
 * enrolment number — and there was no filter for either id anywhere.
 */
describe('payments row identity', () => {
  it('carries the app’s OWN reference on every row', async () => {
    const res = await payments(deps(await seed()), req());
    const body = res.body as { payments: Array<{ gatewayId: string; externalReference: unknown }> };
    const row = body.payments.find((p) => p.gatewayId === 'pay_ana');
    expect(row?.externalReference).toBe('enrolment-4102');
  });

  it('reports a null reference as null rather than omitting the field', async () => {
    const res = await payments(deps(await seed()), req());
    const body = res.body as { payments: Array<{ gatewayId: string; externalReference: unknown }> };
    const row = body.payments.find((p) => p.gatewayId === 'pay_other');
    expect(row).toHaveProperty('externalReference');
    expect(row?.externalReference).toBeNull();
  });

  it('names the app-side OWNER, not just the gateway’s customer id', async () => {
    const res = await payments(deps(await seed()), req());
    const body = res.body as {
      payments: Array<{ gatewayId: string; customerId: unknown; owner: unknown }>;
    };
    const row = body.payments.find((p) => p.gatewayId === 'pay_ana');
    expect(
      row?.customerId,
      'the gateway id is still there — it is what you paste at the gateway',
    ).toBe('cus_ana');
    expect(row?.owner).toEqual({
      type: 'users',
      id: '4102',
      name: 'Ana',
      email: 'ana@example.com',
    });
  });

  it('reports an unmapped customer as a null owner rather than guessing', async () => {
    const res = await payments(deps(await seed()), req());
    const body = res.body as { payments: Array<{ gatewayId: string; owner: unknown }> };
    expect(body.payments.find((p) => p.gatewayId === 'pay_other')?.owner).toBeNull();
  });

  it('finds a payment by the app’s reference', async () => {
    const res = await payments(deps(await seed()), req({ reference: 'enrolment-4102' }));
    const body = res.body as { payments: Array<{ gatewayId: string }>; filters: unknown };
    expect(body.payments.map((p) => p.gatewayId)).toEqual(['pay_ana']);
    expect(body.filters).toMatchObject({ reference: 'enrolment-4102' });
  });

  it('finds a payment by the gateway id, and by the gateway customer id', async () => {
    const store = await seed();
    const byGateway = (await payments(deps(store), req({ gatewayId: 'pay_ana' }))).body as {
      payments: Array<{ gatewayId: string }>;
    };
    expect(byGateway.payments.map((p) => p.gatewayId)).toEqual(['pay_ana']);

    const byCustomer = (await payments(deps(store), req({ customerId: 'cus_ana' }))).body as {
      payments: Array<{ gatewayId: string }>;
    };
    expect(byCustomer.payments.map((p) => p.gatewayId)).toEqual(['pay_ana']);
  });

  it('treats an empty reference param as no filter, not as a search for ""', async () => {
    const res = await payments(deps(await seed()), req({ reference: '' }));
    expect((res.body as { payments: unknown[] }).payments).toHaveLength(2);
  });
});

/**
 * The customers endpoint — the mapping that ties a `cus_…` to a person.
 *
 * There was no such endpoint at all, though `billing_customers` has been written by every app
 * calling `ensureCustomer` since the first release.
 */
describe('customers', () => {
  it('lists the owner mapping', async () => {
    const res = await customers(deps(await seed()), req());
    const body = res.body as { customers: Array<{ gatewayId: string; ownerId: string | null }> };
    expect(body.customers).toEqual([
      expect.objectContaining({ gatewayId: 'cus_ana', ownerType: 'users', ownerId: '4102' }),
    ]);
  });

  it('narrows to one app-side owner', async () => {
    const store = await seed();
    await store.saveCustomer({
      gatewayId: 'cus_bob',
      provider: 'asaas',
      ownerType: 'users',
      ownerId: '77',
    });
    const res = await customers(deps(store), req({ ownerId: '4102' }));
    expect((res.body as { customers: Array<{ gatewayId: string }> }).customers).toHaveLength(1);
  });
});

/** The per-payment view: what IS knowable, assembled. */
describe('paymentDetail', () => {
  const withTimeline = async () => {
    const store = await seed();
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_paid',
      provider: 'asaas',
      type: 'payment.succeeded',
      payload: { payment: { id: 'pay_ana' } },
    });
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_elsewhere',
      provider: 'asaas',
      type: 'payment.succeeded',
      payload: { payment: { id: 'pay_other' } },
    });
    await store.saveDispute({
      gatewayId: 'dp_1',
      paymentGatewayId: 'pay_ana',
      provider: 'asaas',
      status: 'open',
    });
    await store.saveDispute({
      gatewayId: 'dp_elsewhere',
      paymentGatewayId: 'pay_other',
      provider: 'asaas',
      status: 'open',
    });
    await store.recordAuditEvent({
      action: AUDIT_ACTIONS.refund,
      actor: 'ana <7>',
      subjectType: 'payment',
      subjectId: 'pay_ana',
      amount: 1000,
      currency: 'BRL',
    });
    return store;
  };

  it('assembles the state, the owner, the disputes, the ledger rows and the audit trail', async () => {
    const res = await paymentDetail(
      await deps(await withTimeline()),
      req({}, { gatewayId: 'pay_ana' }),
    );
    const body = res.body as {
      payment: { gatewayId: string; externalReference: unknown; owner: unknown };
      disputes: Array<{ gatewayId: string }>;
      events: { rows: Array<{ gatewayEventId: string }>; matchedBy: string };
      audit: Array<{ actor: string | null }>;
    };
    expect(body.payment.gatewayId).toBe('pay_ana');
    expect(body.payment.externalReference).toBe('enrolment-4102');
    expect(body.payment.owner).toMatchObject({ id: '4102' });
    expect(
      body.disputes.map((d) => d.gatewayId),
      'only THIS payment’s disputes',
    ).toEqual(['dp_1']);
    expect(body.events.rows.map((e) => e.gatewayEventId)).toEqual(['evt_paid']);
    expect(body.audit.map((a) => a.actor)).toEqual(['ana <7>']);
  });

  it('says HOW the ledger rows were matched rather than implying a real link', async () => {
    // A payload substring scan can over-match and can miss. Reading "3 events" as "exactly the
    // three that touched this payment" is the mistake the disclosure exists to stop.
    const res = await paymentDetail(deps(await withTimeline()), req({}, { gatewayId: 'pay_ana' }));
    expect((res.body as { events: { matchedBy: string } }).events.matchedBy).toBe(
      'payload-substring',
    );
  });

  it('404s a payment that is not recorded', async () => {
    const res = await paymentDetail(deps(await seed()), req({}, { gatewayId: 'pay_nope' }));
    expect(res.status).toBe(404);
  });
});

describe('ledger filters', () => {
  const seedLedger = async () => {
    const store = new InMemoryBillingStore();
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_1',
      provider: 'asaas',
      type: 'payment.succeeded',
      payload: {},
    });
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_2',
      provider: 'asaas',
      type: 'payment.refunded',
      payload: {},
    });
    return store;
  };

  it('filters the ledger by event type', async () => {
    const res = await webhookEvents(deps(await seedLedger()), req({ type: 'payment.refunded' }));
    const body = res.body as { events: Array<{ gatewayEventId: string }> };
    expect(body.events.map((e) => e.gatewayEventId)).toEqual(['evt_2']);
  });

  it('offers the event types this install has actually received', async () => {
    const res = await providers(deps(await seedLedger()));
    expect((res.body as { eventTypes: string[] }).eventTypes).toEqual([
      'payment.refunded',
      'payment.succeeded',
    ]);
  });
});

/**
 * Closing a dispute the gateway never closes.
 *
 * Asaas publishes no lost-dispute event and the driver hardcodes `outcome: 'won'` on close, so a
 * dispute that was LOST stays `open` forever — and `disputes_due` counts past-deadline rows on
 * purpose, so the alarm never goes quiet again.
 */
describe('resolveDispute', () => {
  const withDispute = async () => {
    const store = new InMemoryBillingStore();
    await store.saveDispute({
      gatewayId: 'dp_1',
      paymentGatewayId: 'pay_1',
      provider: 'asaas',
      status: 'open',
      amount: 19900,
      currency: 'BRL',
      evidenceDueBy: new Date(NOW.getTime() - 3_600_000),
    });
    return store;
  };

  it('closes the row and stops the alarm', async () => {
    const store = await withDispute();
    expect(await store.countOpenDisputes({})).toBe(1);

    const res = await resolveDispute(
      deps(store, { actor: 'ana <7>' }),
      req({}, { gatewayId: 'dp_1' }, { status: 'lost', note: 'bank ruled for the cardholder' }),
    );

    expect(res.status).toBe(200);
    expect(await store.countOpenDisputes({}), 'the check can finally go quiet').toBe(0);
    expect(await store.countDisputesDueWithin({ withinHours: 72, now: NOW })).toBe(0);
  });

  it('records WHO said so, with the outcome and the note', async () => {
    const store = await withDispute();
    await resolveDispute(
      deps(store, { actor: 'ana <7>' }),
      req({}, { gatewayId: 'dp_1' }, { status: 'lost', note: 'case 8812' }),
    );

    const [entry] = await store.listAuditEvents({ action: AUDIT_ACTIONS.disputeResolved });
    expect(entry?.actor).toBe('ana <7>');
    expect(entry?.subjectId).toBe('dp_1');
    expect(entry?.message).toBe('case 8812');
    expect(entry?.metadata).toMatchObject({ status: 'lost', previousStatus: 'open' });
  });

  it('keeps the deadline the OPENING event carried — the close names none', async () => {
    const store = await withDispute();
    await resolveDispute(deps(store), req({}, { gatewayId: 'dp_1' }, { status: 'lost' }));
    const [row] = await store.listDisputes({});
    expect(row?.evidenceDueBy, 'blanking it would destroy the record of the window').not.toBeNull();
  });

  it('refuses a status that is not an ending', async () => {
    // "Resolve" that can put a row back into `open` is an edit box over a money table.
    const res = await resolveDispute(
      deps(await withDispute()),
      req({}, { gatewayId: 'dp_1' }, { status: 'open' }),
    );
    expect(res.status).toBe(400);
  });

  it('404s a dispute that is not recorded', async () => {
    const res = await resolveDispute(
      deps(await withDispute()),
      req({}, { gatewayId: 'dp_nope' }, { status: 'lost' }),
    );
    expect(res.status).toBe(404);
  });

  it('records the actor as unattributed when the console has no session', async () => {
    const store = await withDispute();
    await resolveDispute(deps(store), req({}, { gatewayId: 'dp_1' }, { status: 'lost' }));
    expect((await store.listAuditEvents({}))[0]?.actor).toBeNull();
  });
});

/** A refund issued from the console leaves a record naming a person. */
describe('refund audit trail', () => {
  const okRefund = async (): Promise<RefundOutcome> => ({
    kind: 'ok',
    refund: { gatewayId: 're_1', amount: 5000, currency: 'BRL', status: 'succeeded' },
  });

  it('records WHO refunded WHAT', async () => {
    const store = await seed();
    await refundPayment(
      deps(store, { actor: 'ana <7>', actions: { refund: okRefund } }),
      req({}, { gatewayId: 'pay_ana' }, { amount: 5000 }),
    );

    const [entry] = await store.listAuditEvents({ action: AUDIT_ACTIONS.refund });
    expect(entry?.actor).toBe('ana <7>');
    expect(entry?.subjectId).toBe('pay_ana');
    expect(entry?.amount, 'the amount ASKED for, in minor units').toBe(5000);
    expect(entry?.currency).toBe('BRL');
    expect(entry?.metadata).toMatchObject({ partial: true, paymentAmount: 19900 });
  });

  it('records a FULL refund at the payment’s own amount', async () => {
    const store = await seed();
    await refundPayment(
      deps(store, { actor: 'ana <7>', actions: { refund: okRefund } }),
      req({}, { gatewayId: 'pay_ana' }),
    );
    const [entry] = await store.listAuditEvents({ action: AUDIT_ACTIONS.refund });
    expect(entry?.amount).toBe(19900);
    expect(entry?.metadata).toMatchObject({ partial: false });
  });

  it('records NOTHING when the gateway refused', async () => {
    const store = await seed();
    await refundPayment(
      deps(store, {
        actor: 'ana <7>',
        actions: { refund: async () => ({ kind: 'gateway-error', message: 'no' }) },
      }),
      req({}, { gatewayId: 'pay_ana' }),
    );
    expect(
      await store.listAuditEvents({ action: AUDIT_ACTIONS.refund }),
      'an audit of refunds that never happened is an audit nobody can trust',
    ).toEqual([]);
  });
});

/** The rejected-delivery check and its endpoint. */
describe('rejected deliveries', () => {
  const withRejection = async () => {
    const store = new InMemoryBillingStore();
    store.now = () => NOW;
    await store.recordAuditEvent({
      action: AUDIT_ACTIONS.webhookRejected,
      provider: 'asaas',
      message: 'signature did not verify',
    });
    return store;
  };

  it('turns the health report red — a rotated secret used to look like a quiet week', async () => {
    const store = await withRejection();
    const res = await health(deps(store));
    const body = res.body as {
      healthy: boolean;
      checks: Array<{ key: string; count: number }>;
    };
    expect(body.healthy).toBe(false);
    expect(body.checks.find((c) => c.key === 'rejected_deliveries')?.count).toBe(1);
  });

  it('surfaces the refusals through the audit endpoint', async () => {
    const res = await auditEvents(
      deps(await withRejection()),
      req({ action: AUDIT_ACTIONS.webhookRejected }),
    );
    const body = res.body as { audit: Array<{ message: string | null; provider: string | null }> };
    expect(body.audit).toEqual([
      expect.objectContaining({ provider: 'asaas', message: 'signature did not verify' }),
    ]);
  });
});
