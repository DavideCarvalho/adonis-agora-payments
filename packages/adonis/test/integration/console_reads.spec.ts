import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/billing/billing_store.js';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * The console's new reads, against a real Postgres and the real published migration.
 *
 * Two of them cannot be trusted from the unit suite at all, because the in-memory store is a
 * hand-written reimplementation and neither behaviour is JavaScript:
 *
 * - `listWebhookEventsForPayment` emits `CAST(payload AS TEXT) LIKE ?`. On Postgres `payload` is
 *   `JSONB`, which has NO `LIKE` operator — the cast is the whole reason the query parses, and
 *   the in-memory store's `JSON.stringify(...).includes(...)` would go on passing if it were
 *   wrong.
 * - `billing_audit_events` is a new TABLE. Whether the migration apps actually run creates it,
 *   and whether the columns the store writes exist in it, is not observable without a database.
 */
describe('console reads (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  const now = new Date('2026-08-27T12:00:00.000Z');

  beforeAll(async () => {
    database = await createIntegrationDatabase('console_reads_spec');
    store = new LucidBillingStore();
  });

  afterAll(async () => {
    await database?.teardown();
  });

  describe('payment lookups', () => {
    beforeAll(async () => {
      await store.saveCustomer({
        gatewayId: 'cus_ana',
        provider: 'asaas',
        ownerType: 'users',
        ownerId: '4102',
        name: 'Ana',
      });
      await store.savePayment({
        gatewayId: 'pay_ana',
        provider: 'asaas',
        status: 'paid',
        amount: 19900,
        currency: 'BRL',
        customerId: 'cus_ana',
        externalReference: 'enrolment-4102',
        paidAt: now,
      });
      await store.savePayment({
        gatewayId: 'pay_decoy',
        provider: 'asaas',
        status: 'paid',
        amount: 100,
        currency: 'BRL',
        externalReference: 'enrolment-41',
      });
    });

    it('finds a payment by the app’s own reference, exactly', async () => {
      // `enrolment-41` is a prefix of `enrolment-4102`. A `LIKE` here instead of an equality
      // would answer a different question, about money.
      const rows = await store.listPayments({ externalReference: 'enrolment-41' });
      expect(rows.map((row) => row.gatewayId)).toEqual(['pay_decoy']);
    });

    it('finds a payment by the gateway id and by the gateway customer id', async () => {
      expect(
        (await store.listPayments({ gatewayId: 'pay_ana' })).map((row) => row.gatewayId),
      ).toEqual(['pay_ana']);
      expect(
        (await store.listPayments({ customerId: 'cus_ana' })).map((row) => row.gatewayId),
      ).toEqual(['pay_ana']);
    });

    it('resolves the app-side owner for a set of gateway customer ids', async () => {
      const rows = await store.listCustomersByGatewayIds(['cus_ana', 'cus_nobody']);
      expect(rows).toEqual([
        expect.objectContaining({ gatewayId: 'cus_ana', ownerType: 'users', ownerId: '4102' }),
      ]);
    });

    it('narrows customers to one app-side owner', async () => {
      expect(
        (await store.listCustomers({ ownerType: 'users', ownerId: '4102' })).map(
          (row) => row.gatewayId,
        ),
      ).toEqual(['cus_ana']);
    });
  });

  describe('ledger reads', () => {
    beforeAll(async () => {
      await store.recordWebhookEvent({
        gatewayEventId: 'evt_paid',
        provider: 'asaas',
        type: 'payment.succeeded',
        payload: { payment: { id: 'pay_timeline' }, value: 199 },
      });
      await store.recordWebhookEvent({
        gatewayEventId: 'evt_refund',
        provider: 'asaas',
        type: 'payment.refunded',
        payload: { payment: { id: 'pay_timeline' } },
      });
      await store.recordWebhookEvent({
        gatewayEventId: 'evt_elsewhere',
        provider: 'asaas',
        type: 'payment.succeeded',
        payload: { payment: { id: 'pay_unrelated' } },
      });
    });

    it('filters the ledger by event type', async () => {
      const rows = await store.listWebhookEvents({ type: 'payment.refunded' });
      expect(rows.map((row) => row.gatewayEventId)).toEqual(['evt_refund']);
    });

    it('finds the deliveries whose JSONB payload names one payment', async () => {
      // The query that cannot exist without the cast: `jsonb LIKE text` is not an operator in
      // Postgres, so a missing `CAST` here is a 42883 at runtime and green in the unit suite.
      const rows = await store.listWebhookEventsForPayment('pay_timeline');
      expect(rows.map((row) => row.gatewayEventId).sort()).toEqual(['evt_paid', 'evt_refund']);
    });

    it('returns the normalized list item, never the stored payload', async () => {
      const [row] = await store.listWebhookEventsForPayment('pay_timeline');
      expect(row).not.toHaveProperty('payload');
      expect(row).not.toHaveProperty('normalized');
    });
  });

  describe('open disputes, with no deadline anywhere', () => {
    beforeAll(async () => {
      // Exactly what Asaas produces: a chargeback with `evidence_due_by` null, because the
      // deadline only ever comes from a field its published webhook examples do not carry.
      await store.saveDispute({
        gatewayId: 'dp_no_deadline',
        paymentGatewayId: 'pay_ana',
        provider: 'asaas',
        status: 'open',
        amount: 19900,
        currency: 'BRL',
      });
      await store.saveDispute({
        gatewayId: 'dp_finished',
        paymentGatewayId: 'pay_decoy',
        provider: 'asaas',
        status: 'lost',
      });
    });

    it('is invisible to the deadline read and visible to this one', async () => {
      expect(await store.countDisputesDueWithin({ withinHours: 72, now })).toBe(0);
      expect(await store.countOpenDisputes({})).toBe(1);
      expect((await store.listOpenDisputes({})).map((row) => row.gatewayId)).toEqual([
        'dp_no_deadline',
      ]);
    });

    it('goes quiet once the outcome is recorded', async () => {
      await store.saveDispute({
        gatewayId: 'dp_no_deadline',
        paymentGatewayId: 'pay_ana',
        provider: 'asaas',
        status: 'lost',
        outcome: 'lost',
        closedAt: now,
      });
      expect(await store.countOpenDisputes({})).toBe(0);
      // And the amount the OPENING event carried is still on the row — `saveDispute` leaves
      // absent fields alone, which is what makes recording an outcome survivable.
      const closed = (await store.listDisputes({})).find(
        (row) => row.gatewayId === 'dp_no_deadline',
      );
      expect(closed?.amount).toBe(19900);
      expect(closed?.outcome).toBe('lost');
    });
  });

  describe('audit trail', () => {
    it('is created by the published migration', async () => {
      // Scoped to THIS spec's schema: every integration file runs in its own Postgres schema,
      // and an unscoped `information_schema` read returns the same table once per schema.
      const result = (await database.db.rawQuery(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'billing_audit_events' AND table_schema = current_schema()`,
      )) as { rows: Array<{ column_name: string }> };
      expect(result.rows.map((row) => row.column_name).sort()).toEqual([
        'action',
        'actor',
        'amount',
        'created_at',
        'currency',
        'id',
        'message',
        'metadata',
        'provider',
        'subject_id',
        'subject_type',
        'updated_at',
      ]);
    });

    it('round-trips an actor, a BIGINT amount and a JSON metadata bag', async () => {
      const written = await store.recordAuditEvent({
        action: AUDIT_ACTIONS.refund,
        actor: 'ana <7>',
        provider: 'asaas',
        subjectType: 'payment',
        subjectId: 'pay_ana',
        amount: 19900,
        currency: 'BRL',
        metadata: { partial: false, refundGatewayId: 're_1' },
      });
      expect(written).not.toBeNull();

      const [row] = await store.listAuditEvents({ subjectType: 'payment', subjectId: 'pay_ana' });
      expect(row?.actor).toBe('ana <7>');
      // BIGINT arrives as a STRING on node-postgres. `19900` here and `'19900'` are the
      // difference between adding and concatenating.
      expect(row?.amount).toBe(19900);
      expect(row?.metadata).toEqual({ partial: false, refundGatewayId: 're_1' });
    });

    it('counts one action inside a window — the read the health check alerts on', async () => {
      await store.recordAuditEvent({
        action: AUDIT_ACTIONS.webhookRejected,
        provider: 'asaas',
        message: 'signature did not verify',
        createdAt: new Date(now.getTime() - 60_000),
      });
      await store.recordAuditEvent({
        action: AUDIT_ACTIONS.webhookRejected,
        provider: 'asaas',
        createdAt: new Date(now.getTime() - 48 * 3_600_000),
      });

      expect(
        await store.countAuditEvents({
          action: AUDIT_ACTIONS.webhookRejected,
          createdAfter: new Date(now.getTime() - 24 * 3_600_000),
        }),
        'the two-day-old refusal is outside the window; the refund is a different action',
      ).toBe(1);
    });
  });

  describe('an install with no billing_audit_events table, with autoCreateSchema off', () => {
    // An app that upgraded the package before running the migration. Every audit write is
    // ADDITIONAL to an action that already happened — a refund the gateway already accepted —
    // so a missing table must skip the note rather than fail the refund.
    let legacy: LucidBillingStore;

    beforeAll(async () => {
      await database.db.rawQuery(
        'ALTER TABLE billing_audit_events RENAME TO billing_audit_events_kept',
      );
      legacy = new LucidBillingStore({}, { autoCreateSchema: false });
    });

    afterAll(async () => {
      await database.db.rawQuery(
        'ALTER TABLE billing_audit_events_kept RENAME TO billing_audit_events',
      );
    });

    it('skips the write and says so by answering null', async () => {
      expect(await legacy.recordAuditEvent({ action: AUDIT_ACTIONS.refund })).toBeNull();
    });

    it('answers empty for every audit read instead of raising', async () => {
      expect(await legacy.listAuditEvents({})).toEqual([]);
      expect(await legacy.countAuditEvents({})).toBe(0);
    });
  });
});
