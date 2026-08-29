import { beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../src/billing/billing_store.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * The store reads a console needs to answer "did THIS charge land?", and the two it needs to
 * stop reporting a healthy install that is losing money.
 *
 * Every one of these was previously unaskable through the SPI: `listPayments` filtered on status
 * and provider, so the app's own reference — the only id an operator actually holds — could be
 * returned but never searched for; `listCustomers` had no owner filter and no batch read, so the
 * `cus_…` on a payment row named nobody; the ledger had no event-type filter; and the only
 * dispute read that alerts required a deadline the gateway usually never sends.
 */
describe('payment lookup filters', () => {
  let store: InMemoryBillingStore;

  const charge = async (
    gatewayId: string,
    over: Partial<{
      externalReference: string | null;
      customerId: string | null;
      status: string;
      provider: string;
    }> = {},
  ) =>
    store.savePayment({
      gatewayId,
      provider: over.provider ?? 'asaas',
      status: over.status ?? 'paid',
      amount: 1000,
      currency: 'BRL',
      ...(over.externalReference !== undefined
        ? { externalReference: over.externalReference }
        : {}),
      ...(over.customerId !== undefined ? { customerId: over.customerId } : {}),
    });

  beforeEach(() => {
    store = new InMemoryBillingStore();
  });

  it('finds the payment carrying one app-side reference', async () => {
    await charge('pay_1', { externalReference: 'order-4102' });
    await charge('pay_2', { externalReference: 'order-9999' });

    const rows = await store.listPayments({ externalReference: 'order-4102' });
    expect(rows.map((row) => row.gatewayId)).toEqual(['pay_1']);
  });

  it('matches a reference EXACTLY — order-4 must never return order-42', async () => {
    // A substring match would make this lookup answer a question nobody asked, about money.
    await charge('pay_short', { externalReference: 'order-4' });
    await charge('pay_long', { externalReference: 'order-42' });

    expect(
      (await store.listPayments({ externalReference: 'order-4' })).map((row) => row.gatewayId),
    ).toEqual(['pay_short']);
  });

  it('returns EVERY row carrying a reused reference, not just the newest', async () => {
    // `findPaymentByExternalReference` answers with the most recent one. When an app retried and
    // both attempts exist, "which of them landed?" is exactly the question being asked, and one
    // row cannot answer it.
    await charge('pay_try1', { externalReference: 'order-7', status: 'failed' });
    await charge('pay_try2', { externalReference: 'order-7', status: 'paid' });

    const rows = await store.listPayments({ externalReference: 'order-7' });
    expect(rows.map((row) => row.gatewayId).sort()).toEqual(['pay_try1', 'pay_try2']);
  });

  it('finds a payment by the gateway id, and by the gateway customer id', async () => {
    await charge('pay_1', { customerId: 'cus_a' });
    await charge('pay_2', { customerId: 'cus_b' });
    await charge('pay_3', { customerId: 'cus_a' });

    expect((await store.listPayments({ gatewayId: 'pay_2' })).map((r) => r.gatewayId)).toEqual([
      'pay_2',
    ]);
    expect(
      (await store.listPayments({ customerId: 'cus_a' })).map((r) => r.gatewayId).sort(),
    ).toEqual(['pay_1', 'pay_3']);
  });

  it('composes the lookup with the status filter rather than replacing it', async () => {
    await charge('pay_ok', { externalReference: 'order-7', status: 'paid' });
    await charge('pay_no', { externalReference: 'order-7', status: 'failed' });

    expect(
      (await store.listPayments({ externalReference: 'order-7', status: 'paid' })).map(
        (r) => r.gatewayId,
      ),
    ).toEqual(['pay_ok']);
  });
});

describe('customer mapping reads', () => {
  let store: InMemoryBillingStore;

  beforeEach(async () => {
    store = new InMemoryBillingStore();
    await store.saveCustomer({
      gatewayId: 'cus_a',
      provider: 'asaas',
      ownerType: 'users',
      ownerId: '4102',
      name: 'Ana',
    });
    await store.saveCustomer({
      gatewayId: 'cus_b',
      provider: 'stripe',
      ownerType: 'users',
      ownerId: '77',
    });
  });

  it('narrows customers to one app-side owner', async () => {
    const rows = await store.listCustomers({ ownerType: 'users', ownerId: '4102' });
    expect(rows.map((row) => row.gatewayId)).toEqual(['cus_a']);
  });

  it('resolves several gateway customer ids in ONE read', async () => {
    // The join a page of payments needs. One lookup per row would be a query per row of every
    // page, which is why the payments screen went without an owner column at all.
    const rows = await store.listCustomersByGatewayIds(['cus_a', 'cus_b', 'cus_missing']);
    expect(rows.map((row) => row.gatewayId).sort()).toEqual(['cus_a', 'cus_b']);
  });

  it('answers an empty id list without touching anything', async () => {
    expect(await store.listCustomersByGatewayIds([])).toEqual([]);
  });
});

describe('ledger reads', () => {
  let store: InMemoryBillingStore;

  const deliver = async (id: string, type: string, payload: Record<string, unknown> = {}) =>
    store.recordWebhookEvent({ gatewayEventId: id, provider: 'asaas', type, payload });

  beforeEach(() => {
    store = new InMemoryBillingStore();
  });

  it('filters the ledger by EVENT TYPE — "did a refund event ever arrive?"', async () => {
    await deliver('evt_1', 'payment.succeeded');
    await deliver('evt_2', 'payment.refunded');
    await deliver('evt_3', 'payment.succeeded');

    const rows = await store.listWebhookEvents({ type: 'payment.refunded' });
    expect(rows.map((row) => row.gatewayEventId)).toEqual(['evt_2']);
  });

  it('composes the type filter with status rather than replacing it', async () => {
    const failed = await deliver('evt_bad', 'payment.refunded');
    await store.markWebhookFailed(String(failed?.id), 'boom');
    await deliver('evt_ok', 'payment.refunded');

    expect(
      (await store.listWebhookEvents({ type: 'payment.refunded', status: 'failed' })).map(
        (row) => row.gatewayEventId,
      ),
    ).toEqual(['evt_bad']);
  });

  it('finds the deliveries whose stored payload names one payment', async () => {
    await deliver('evt_1', 'payment.succeeded', { payment: { id: 'pay_9' } });
    await deliver('evt_2', 'payment.refunded', { payment: { id: 'pay_9' } });
    await deliver('evt_3', 'payment.succeeded', { payment: { id: 'pay_other' } });

    const rows = await store.listWebhookEventsForPayment('pay_9');
    expect(rows.map((row) => row.gatewayEventId).sort()).toEqual(['evt_1', 'evt_2']);
  });

  it('returns nothing for an empty payment id rather than the whole table', async () => {
    await deliver('evt_1', 'payment.succeeded', { payment: { id: 'pay_9' } });
    expect(await store.listWebhookEventsForPayment('')).toEqual([]);
  });

  it('never returns the stored payload', async () => {
    // The console is a management screen, not a debugger. A payload that reached it here would
    // reach it everywhere, because this is the one read that has to open one.
    await deliver('evt_1', 'payment.succeeded', { payment: { id: 'pay_9' }, secret: 'nope' });
    const [row] = await store.listWebhookEventsForPayment('pay_9');
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'createdAt',
      'error',
      'gatewayEventId',
      'id',
      'provider',
      'status',
      'type',
      'updatedAt',
    ]);
  });
});

describe('open dispute reads', () => {
  let store: InMemoryBillingStore;

  const dispute = async (gatewayId: string, status: string, evidenceDueBy: Date | null = null) =>
    store.saveDispute({
      gatewayId,
      paymentGatewayId: `pay_${gatewayId}`,
      provider: 'asaas',
      status,
      evidenceDueBy,
    });

  beforeEach(() => {
    store = new InMemoryBillingStore();
  });

  it('counts an open dispute the gateway sent NO deadline for', async () => {
    // The whole point. `countDisputesDueWithin` cannot see this row, and on Asaas — whose
    // deadline comes from a field no published webhook example carries — that is every row.
    await dispute('dp_1', 'open', null);

    expect(await store.countOpenDisputes({})).toBe(1);
    expect(await store.countDisputesDueWithin({ withinHours: 72 })).toBe(0);
  });

  it('counts every unanswered status, not just "open"', async () => {
    await dispute('dp_warn', 'warning');
    await dispute('dp_open', 'open');
    await dispute('dp_review', 'under_review');
    await dispute('dp_lost', 'lost');
    await dispute('dp_won', 'won');

    expect(await store.countOpenDisputes({})).toBe(3);
  });

  it('lists them OLDEST first — with no deadline, age is the only priority left', async () => {
    store.now = () => new Date('2026-01-01T00:00:00.000Z');
    await dispute('dp_old', 'open');
    store.now = () => new Date('2026-03-01T00:00:00.000Z');
    await dispute('dp_new', 'open');

    expect((await store.listOpenDisputes({})).map((row) => row.gatewayId)).toEqual([
      'dp_old',
      'dp_new',
    ]);
  });

  it('narrows to one provider', async () => {
    await dispute('dp_a', 'open');
    await store.saveDispute({
      gatewayId: 'dp_b',
      paymentGatewayId: 'pay_b',
      provider: 'stripe',
      status: 'open',
    });

    expect(await store.countOpenDisputes({ provider: 'stripe' })).toBe(1);
  });
});

describe('audit trail', () => {
  let store: InMemoryBillingStore;

  beforeEach(() => {
    store = new InMemoryBillingStore();
  });

  it('records who did what, and reads it back newest first', async () => {
    store.now = () => new Date('2026-01-01T00:00:00.000Z');
    await store.recordAuditEvent({
      action: AUDIT_ACTIONS.refund,
      actor: 'ana <7>',
      subjectType: 'payment',
      subjectId: 'pay_1',
      amount: 500,
      currency: 'BRL',
    });
    store.now = () => new Date('2026-02-01T00:00:00.000Z');
    await store.recordAuditEvent({ action: AUDIT_ACTIONS.webhookRejected, provider: 'asaas' });

    const rows = await store.listAuditEvents({});
    expect(rows.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.webhookRejected,
      AUDIT_ACTIONS.refund,
    ]);
    expect(rows[1]?.actor).toBe('ana <7>');
    expect(rows[1]?.amount).toBe(500);
  });

  it('leaves an unattributed row NULL rather than inventing a system actor', async () => {
    await store.recordAuditEvent({ action: AUDIT_ACTIONS.webhookRejected });
    expect((await store.listAuditEvents({}))[0]?.actor).toBeNull();
  });

  it('counts one action inside a window — the read the health check alerts on', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    store.now = () => new Date(now.getTime() - 48 * 3_600_000);
    await store.recordAuditEvent({ action: AUDIT_ACTIONS.webhookRejected });
    store.now = () => new Date(now.getTime() - 60_000);
    await store.recordAuditEvent({ action: AUDIT_ACTIONS.webhookRejected });
    await store.recordAuditEvent({ action: AUDIT_ACTIONS.refund });

    expect(
      await store.countAuditEvents({
        action: AUDIT_ACTIONS.webhookRejected,
        createdAfter: new Date(now.getTime() - 24 * 3_600_000),
      }),
      'only the recent rejection — not the two-day-old one, and not the refund',
    ).toBe(1);
  });

  it('narrows to one subject — the per-payment strand', async () => {
    await store.recordAuditEvent({
      action: AUDIT_ACTIONS.refund,
      subjectType: 'payment',
      subjectId: 'pay_1',
    });
    await store.recordAuditEvent({
      action: AUDIT_ACTIONS.refund,
      subjectType: 'payment',
      subjectId: 'pay_2',
    });

    const rows = await store.listAuditEvents({ subjectType: 'payment', subjectId: 'pay_1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectId).toBe('pay_1');
  });
});
