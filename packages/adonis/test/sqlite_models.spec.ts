import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import {
  BillingAuditEvent,
  BillingCustomer,
  BillingDispute,
  BillingPayment,
  BillingSubscription,
  BillingUsageEvent,
  BillingWebhookEvent,
} from '../src/billing/mixins/index.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { WebhookEvent } from '../src/types.js';

/**
 * The default models against a real SQLite.
 *
 * Two things SQLite does differently from Postgres and MySQL, both of which broke the ledger:
 *
 * - Every billing id is a uuid generated in a `beforeCreate` hook, and an INSERT reports the
 *   numeric rowid. A model that lets Lucid take the primary key from the INSERT result holds that
 *   rowid instead of its uuid, so every later `where id = ?` misses the row.
 * - JSON columns are `TEXT`. The driver cannot bind an object in an UPDATE, and reads come back as
 *   the JSON string.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('default models on SQLite', () => {
  let db: Database;
  let store: LucidBillingStore;

  beforeAll(async () => {
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    db = new Database(
      {
        connection: 'sqlite',
        connections: {
          sqlite: {
            client: 'better-sqlite3',
            connection: { filename: ':memory:' },
            useNullAsDefault: true,
          },
        },
      },
      new LoggerFactory().create(),
      new Emitter(app),
    );
    BaseModel.useAdapter(db.modelAdapter());
    store = new LucidBillingStore();
  });

  afterAll(async () => {
    await db?.manager.closeAll();
  });

  const paymentSucceeded = (id: string, gatewayId: string): WebhookEvent => ({
    id,
    provider: 'asaas',
    type: 'payment.succeeded',
    data: { gatewayId, amount: 19900, currency: 'BRL' },
    raw: { payment: { id: gatewayId } },
  });

  it('marks an ingested webhook processed', async () => {
    const processor = new WebhookProcessor({ store });
    expect(await processor.process(paymentSucceeded('evt_ok', 'pay_ok'))).toBe(true);

    expect((await store.findWebhookEventByGatewayEventId('evt_ok'))?.status).toBe('processed');
    // Processed is final: the redelivery is refused rather than re-run.
    expect(await processor.process(paymentSucceeded('evt_ok', 'pay_ok'))).toBe(false);
  });

  it('marks a webhook whose handler threw failed, and lets the retry re-run it', async () => {
    let attempts = 0;
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'payment.succeeded': () => {
          attempts += 1;
          if (attempts === 1) throw new Error('downstream unavailable');
        },
      },
    });

    await expect(processor.process(paymentSucceeded('evt_bad', 'pay_bad'))).rejects.toThrow(
      'downstream unavailable',
    );
    const failed = await store.listWebhookEvents({ status: 'failed' });
    expect(failed.map((row) => [row.gatewayEventId, row.error])).toEqual([
      ['evt_bad', 'downstream unavailable'],
    ]);

    // The retry re-runs the built-in sync, which UPDATEs the payment row the first attempt wrote.
    expect(await processor.process(paymentSucceeded('evt_bad', 'pay_bad'))).toBe(true);
    expect(attempts).toBe(2);
    expect((await store.findWebhookEventByGatewayEventId('evt_bad'))?.status).toBe('processed');
  });

  it('applies payment.updated to a recorded payment and round-trips its JSON', async () => {
    const processor = new WebhookProcessor({ store });
    await processor.process(paymentSucceeded('evt_paid', 'pay_upd'));
    const raw = { payment: { id: 'pay_upd', refunds: [{ value: 50 }] }, note: 'partial' };

    expect(
      await processor.process({
        id: 'evt_upd',
        provider: 'asaas',
        type: 'payment.updated',
        data: { gatewayId: 'pay_upd', amount: 19900, currency: 'BRL', refundedAmount: 50 },
        raw,
      }),
    ).toBe(true);

    const payment = await store.findPaymentByGatewayId('pay_upd');
    expect(payment?.payload).toEqual(raw);
    expect(Number(payment?.refundedAmount)).toBe(50);
    const ledger = await BillingWebhookEvent.findBy('gateway_event_id', 'evt_upd');
    expect(ledger?.payload).toEqual(raw);
    expect(ledger?.normalized).toMatchObject({ gatewayId: 'pay_upd', refundedAmount: 50 });
  });

  it('round-trips every JSON column as an object, through an insert and an update', async () => {
    const customer = await store.saveCustomer({
      gatewayId: 'cus_json',
      provider: 'asaas',
      metadata: { plan: 'pro', tags: ['a', 'b'] },
    });
    await store.saveCustomer({
      gatewayId: 'cus_json',
      provider: 'asaas',
      metadata: { plan: 'max' },
    });
    expect((await BillingCustomer.find(customer.id))?.metadata).toEqual({ plan: 'max' });

    const subscription = {
      gatewayId: 'sub_json',
      provider: 'asaas',
      customerId: 'cus_json',
      status: 'active',
      planId: 'plan_1',
    };
    await store.saveSubscription({ ...subscription, payload: { v: 1 } });
    await store.saveSubscription({ ...subscription, payload: { v: 2 } });
    expect((await store.findSubscriptionByGatewayId('sub_json'))?.payload).toEqual({ v: 2 });

    const dispute = { gatewayId: 'dp_json', paymentGatewayId: 'pay_x', provider: 'asaas' };
    await store.saveDispute({ ...dispute, status: 'open', payload: { stage: 'open' } });
    await store.saveDispute({ ...dispute, status: 'won', payload: { stage: 'won' } });
    expect((await store.findDisputeByGatewayId('dp_json'))?.payload).toEqual({ stage: 'won' });

    const usage = await store.recordUsage({
      meter: 'tokens',
      quantity: 3,
      metadata: { model: 'x' },
    });
    expect((await BillingUsageEvent.find(usage.id))?.metadata).toEqual({ model: 'x' });

    const audit = await store.recordAuditEvent({ action: 'refund', metadata: { reason: 'dup' } });
    expect((await BillingAuditEvent.find(audit?.id as string))?.metadata).toEqual({
      reason: 'dup',
    });
    expect((await store.listAuditEvents({ action: 'refund' }))[0]?.metadata).toEqual({
      reason: 'dup',
    });
  });

  it('keeps the generated uuid on every model after it is saved', async () => {
    const saved = [
      [BillingCustomer, await store.saveCustomer({ gatewayId: 'cus_1', provider: 'asaas' })],
      [
        BillingSubscription,
        await store.saveSubscription({
          gatewayId: 'sub_1',
          provider: 'asaas',
          customerId: 'cus_1',
          status: 'active',
          planId: 'plan_1',
        }),
      ],
      [
        BillingPayment,
        await store.savePayment({
          gatewayId: 'pay_1',
          provider: 'asaas',
          status: 'paid',
          amount: 100,
          currency: 'BRL',
        }),
      ],
      [
        BillingWebhookEvent,
        await store.recordWebhookEvent({
          gatewayEventId: 'evt_1',
          provider: 'asaas',
          type: 'payment.succeeded',
          payload: {},
        }),
      ],
      [
        BillingDispute,
        await store.saveDispute({
          gatewayId: 'dp_1',
          paymentGatewayId: 'pay_1',
          provider: 'asaas',
          status: 'open',
        }),
      ],
      [BillingUsageEvent, await store.recordUsage({ meter: 'tokens', quantity: 1 })],
    ] as const;

    for (const [Model, row] of saved) {
      const id = (row as { id: unknown } | null)?.id;
      expect(id, Model.name).toMatch(UUID);
      expect((await Model.find(id as string))?.id, Model.name).toBe(id);
    }

    const audit = await store.recordAuditEvent({ action: 'refund', subjectId: 'pay_1' });
    expect(audit?.id).toMatch(UUID);
    expect((await BillingAuditEvent.find(audit?.id as string))?.id).toBe(audit?.id);
  });
});
