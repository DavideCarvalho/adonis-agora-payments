import type { HttpContext } from '@adonisjs/core/http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleWebhookDelivery } from '../../providers/payments_provider.js';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import { createBillingTables, truncateBillingTables } from '../../src/billing/schema.js';
import { WebhookDispatcher } from '../../src/billing/webhook_dispatcher.js';
import { WebhookProcessor } from '../../src/billing/webhook_processor.js';
import type { PaymentsDriver } from '../../src/driver.js';
import { PaymentsManager } from '../../src/payments_manager.js';
import type { WebhookEvent } from '../../src/types.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * The webhook ledger's write path and the reads the console polls, against a real Postgres.
 *
 * The claim is the INSERT: concurrent deliveries of one event race on the unique
 * `gateway_event_id`, and the losers must read as redeliveries — not as a constraint error that
 * answers the gateway `500` and invites yet another delivery.
 */
describe('webhook ledger (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;
  const statements: string[] = [];

  const paymentSucceeded = (id: string, gatewayId: string): WebhookEvent => ({
    id,
    provider: 'asaas',
    type: 'payment.succeeded',
    data: { gatewayId, amount: 19900, currency: 'BRL' },
    raw: { event: 'PAYMENT_RECEIVED', payment: { id: gatewayId } },
  });

  const ledgerRow = async (gatewayEventId: string) => {
    const result = (await database.db.rawQuery(
      'SELECT status, error, payment_gateway_id FROM billing_webhook_events WHERE gateway_event_id = ?',
      [gatewayEventId],
    )) as { rows: { status: string; error: string | null; payment_gateway_id: string | null }[] };
    return result.rows[0];
  };

  beforeAll(async () => {
    database = await createIntegrationDatabase('webhook_ledger_spec');
    store = new LucidBillingStore();
    const connection = database.db.connection();
    const clients = new Set([connection.getWriteClient(), connection.getReadClient()]);
    for (const client of clients) {
      client.on('query', (query: { sql: string }) => statements.push(query.sql));
    }
  });

  afterAll(async () => {
    await database?.teardown();
  });

  beforeEach(async () => {
    await truncateBillingTables(database.db.connection());
    // Warm the schema promise and the per-column probes, so a count below is the steady state
    // of a running process rather than its first request.
    await store.listWebhookEventsForPayment('warm');
    await store.recordWebhookEvent({
      gatewayEventId: 'evt_warm',
      provider: 'asaas',
      type: 'payment.updated',
      payload: {},
      normalized: { gatewayId: 'warm' },
    });
    await store.savePayment({
      gatewayId: 'pay_warm',
      provider: 'asaas',
      status: 'paid',
      amount: 1,
      currency: 'BRL',
      externalReference: 'warm',
      refundedAmount: 0,
    });
    statements.length = 0;
  });

  describe('concurrent duplicate deliveries', () => {
    it('process exactly once, and every other delivery reads as a redelivery', async () => {
      let ran = 0;
      const processor = new WebhookProcessor({
        store,
        handlers: {
          'payment.succeeded': () => {
            ran += 1;
          },
        },
      });
      const event = paymentSucceeded('evt_dup', 'pay_dup');

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => processor.process(event)),
      );

      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(rejected, 'a duplicate delivery must not surface as an error').toEqual([]);
      const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<boolean>).value);
      expect(results.filter((result) => result === true)).toHaveLength(1);
      expect(results.filter((result) => result === false)).toHaveLength(5);
      expect(ran).toBe(1);
      expect((await ledgerRow('evt_dup'))?.status).toBe('processed');
    });

    it('answer the gateway 200, not 500, through the mounted route', async () => {
      const processor = new WebhookProcessor({ store });
      const dispatcher = new WebhookDispatcher({
        processor,
        mode: 'in-process',
        retries: { max: 1 },
      });
      const driver = {
        provider: 'asaas',
        supportedMethods: ['pix'],
        parseWebhook: () => paymentSucceeded('evt_route', 'pay_route'),
      } as unknown as PaymentsDriver;
      const manager = new PaymentsManager({ drivers: new Map([['asaas', driver]]) });

      const deliveries = Array.from({ length: 6 }, () => {
        const sent = { statusCode: 0 };
        const response = {
          status(code: number) {
            sent.statusCode = code;
            return response;
          },
          json: (body: unknown) => body,
        };
        const ctx = {
          params: { provider: 'asaas' },
          request: { raw: () => '{}', headers: () => ({}) },
          response,
        } as unknown as HttpContext;
        return { ctx, sent };
      });

      await Promise.all(
        deliveries.map(({ ctx }) => handleWebhookDelivery(ctx, { manager, dispatcher })),
      );

      expect(deliveries.map(({ sent }) => sent.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    });
  });

  describe('a failed event', () => {
    it('is claimed again by a retry and re-runs', async () => {
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
      const event = paymentSucceeded('evt_retry', 'pay_retry');

      await expect(processor.process(event)).rejects.toThrow('downstream unavailable');
      expect(await ledgerRow('evt_retry')).toMatchObject({
        status: 'failed',
        error: 'downstream unavailable',
      });

      expect(await processor.process(event)).toBe(true);
      expect(attempts).toBe(2);
      expect(await ledgerRow('evt_retry')).toMatchObject({ status: 'processed' });
      // Processed is final: a third delivery is a redelivery.
      expect(await processor.process(event)).toBe(false);
      expect(attempts).toBe(2);
    });

    it('is handed to exactly one of several concurrent retries', async () => {
      const first = await store.recordWebhookEvent({
        gatewayEventId: 'evt_failed',
        provider: 'asaas',
        type: 'payment.succeeded',
        payload: { original: true },
        normalized: { gatewayId: 'pay_failed' },
      });
      await store.markWebhookFailed(String(first?.id), 'boom');

      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.recordWebhookEvent({
            gatewayEventId: 'evt_failed',
            provider: 'asaas',
            type: 'payment.succeeded',
            payload: {},
          }),
        ),
      );

      const won = claims.filter((claim) => claim !== null);
      expect(won).toHaveLength(1);
      // The retry reads back what the ORIGINAL delivery recorded.
      expect(won[0]?.payload).toEqual({ original: true });
      expect(won[0]?.normalized).toEqual({ gatewayId: 'pay_failed' });
      expect(await ledgerRow('evt_failed')).toMatchObject({ status: 'received', error: null });
    });
  });

  it('processes a new payment.succeeded delivery in four round trips', async () => {
    // Claim (INSERT), the payment upsert (SELECT + INSERT), mark processed (UPDATE).
    const processor = new WebhookProcessor({ store });
    expect(await processor.process(paymentSucceeded('evt_count', 'pay_count'))).toBe(true);
    expect(statements, statements.join('\n')).toHaveLength(4);
  });

  describe("a payment's timeline", () => {
    it('finds rows by the recorded payment id, with the payload scan kept to older rows', async () => {
      const processor = new WebhookProcessor({ store });
      await processor.process(paymentSucceeded('evt_paid', 'pay_9'));
      // About another payment, though its payload happens to name this one.
      await processor.process({
        ...paymentSucceeded('evt_other', 'pay_other'),
        raw: { note: 'replaces pay_9' },
      });
      expect((await ledgerRow('evt_paid'))?.payment_gateway_id).toBe('pay_9');
      statements.length = 0;

      const rows = await store.listWebhookEventsForPayment('pay_9');

      expect(rows.map((row) => row.gatewayEventId)).toEqual(['evt_paid']);
      expect(statements.some((sql) => /"payment_gateway_id" = \$1/.test(sql))).toBe(true);
      const scans = statements.filter((sql) => /LIKE/i.test(sql));
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) expect(scan).toMatch(/"payment_gateway_id" is null/i);
    });

    it('still finds rows recorded before the column existed', async () => {
      const processor = new WebhookProcessor({ store });
      await processor.process(paymentSucceeded('evt_new', 'pay_7'));
      await database.db.rawQuery(
        `INSERT INTO billing_webhook_events
           (id, gateway_event_id, provider, type, status, payload, created_at, updated_at)
         VALUES ('00000000-0000-0000-0000-000000000001', 'evt_old', 'asaas', 'payment.succeeded',
                 'processed', ?::jsonb, now() - interval '1 day', now() - interval '1 day')`,
        [JSON.stringify({ payment: { id: 'pay_7' } })],
      );

      const rows = await store.listWebhookEventsForPayment('pay_7');

      expect(rows.map((row) => row.gatewayEventId)).toEqual(['evt_new', 'evt_old']);
    });

    it('records an empty id on a row about something other than a payment', async () => {
      await store.recordWebhookEvent({
        gatewayEventId: 'evt_sub',
        provider: 'asaas',
        type: 'subscription.updated',
        payload: { subscription: 'sub_1' },
        normalized: { gatewayId: 'sub_1', customerId: 'cus_1', status: 'active' },
      });
      expect((await ledgerRow('evt_sub'))?.payment_gateway_id).toBe('');
    });
  });

  it('creates the indexes the ledger, the usage reads and the console poll use', async () => {
    const result = (await database.db.rawQuery(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename LIKE 'billing_%'`,
    )) as { rows: { tablename: string; indexname: string; indexdef: string }[] };
    const columns = new Map(
      result.rows.map((row) => [row.indexname, /\((.*)\)/.exec(row.indexdef)?.[1] ?? '']),
    );

    expect(Object.fromEntries(columns)).toMatchObject({
      billing_webhook_events_payment_idx: 'payment_gateway_id, created_at',
      billing_webhook_events_status_created_idx: 'status, created_at',
      billing_webhook_events_created_idx: 'created_at',
      billing_payments_status_created_idx: 'status, created_at',
      billing_payments_created_idx: 'created_at',
      billing_payments_status_paid_idx: 'status, paid_at',
      billing_subscriptions_status_created_idx: 'status, created_at',
      billing_usage_subscription_meter_recorded_idx: 'subscription_id, meter, recorded_at',
      billing_usage_customer_meter_recorded_idx: 'customer_id, meter, recorded_at',
      billing_usage_scope_meter_recorded_idx: 'scope_type, scope_id, meter, recorded_at',
      billing_usage_recorded_meter_idx: 'recorded_at, meter',
    });
    // Each a leading prefix of a `_recorded_` index above.
    for (const superseded of [
      'billing_usage_subscription_meter_idx',
      'billing_usage_customer_meter_idx',
      'billing_usage_scope_meter_idx',
    ]) {
      expect(columns.has(superseded), superseded).toBe(false);
    }
  });

  it('drops the superseded usage indexes from an install that has them', async () => {
    const connection = database.db.connection();
    await connection.rawQuery(
      'CREATE INDEX billing_usage_subscription_meter_idx ON billing_usage_events (subscription_id, meter)',
    );
    await createBillingTables(connection);
    const result = (await connection.rawQuery(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'billing_usage_subscription_meter_idx'`,
    )) as { rows: unknown[] };
    expect(result.rows).toEqual([]);
  });

  it('runs the windowed usage sum off the recorded_at index', async () => {
    // Two years of one meter across fifty subscriptions, so the planner has a real choice.
    const connection = database.db.connection();
    await connection.rawQuery(
      `INSERT INTO billing_usage_events
         (id, subscription_id, meter, quantity, metadata, recorded_at, updated_at)
       SELECT gen_random_uuid()::text, 'sub_' || (n % 50), 'tokens', 1, '{}'::jsonb,
              now() - (n % 730) * interval '1 day', now()
       FROM generate_series(1, 20000) AS n`,
    );
    await connection.rawQuery('ANALYZE billing_usage_events');
    const plan = (await connection.rawQuery(
      `EXPLAIN SELECT meter, SUM(quantity) FROM billing_usage_events
       WHERE subscription_id = 'sub_1' AND meter = 'tokens'
         AND recorded_at >= now() - interval '30 days' AND recorded_at < now()
       GROUP BY meter`,
    )) as { rows: { 'QUERY PLAN': string }[] };
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toMatch(/billing_usage_subscription_meter_recorded_idx/);
    expect(text).toMatch(/Index Cond: .*recorded_at/);
  });
});
