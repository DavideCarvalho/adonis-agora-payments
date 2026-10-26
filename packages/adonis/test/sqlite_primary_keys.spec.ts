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
 * Every billing id is a uuid generated in a `beforeCreate` hook. On SQLite an INSERT reports the
 * numeric rowid, and a model that lets Lucid take the primary key from the INSERT result ends up
 * holding that rowid instead of its uuid — so every later `where id = ?` misses the row, and a
 * webhook is never marked processed or failed.
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
    // An app-defined type, so the built-in sync writes no payment row and the retry exercises
    // only the ledger.
    const event: WebhookEvent = {
      id: 'evt_bad',
      provider: 'asaas',
      type: 'invoice.issued',
      data: { invoice: 'inv_1' },
      raw: { invoice: 'inv_1' },
    };
    let attempts = 0;
    const processor = new WebhookProcessor({
      store,
      handlers: {
        'invoice.issued': () => {
          attempts += 1;
          if (attempts === 1) throw new Error('downstream unavailable');
        },
      },
    });

    await expect(processor.process(event)).rejects.toThrow('downstream unavailable');
    const failed = await store.listWebhookEvents({ status: 'failed' });
    expect(failed.map((row) => [row.gatewayEventId, row.error])).toEqual([
      ['evt_bad', 'downstream unavailable'],
    ]);

    expect(await processor.process(event)).toBe(true);
    expect(attempts).toBe(2);
    expect((await store.findWebhookEventByGatewayEventId('evt_bad'))?.status).toBe('processed');
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
