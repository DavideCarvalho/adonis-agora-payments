import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePaymentsTenancy } from '../../src/agora/tenancy.js';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import type { RefundCapableDriver } from '../../src/dashboard/actions.js';
import { consoleCapabilities, createConsoleActions } from '../../src/dashboard/api_core.js';
import type { PaymentsDriver } from '../../src/driver.js';
import {
  answerPaymentsConsoleCommands,
  type FederatedPaymentsAction,
  FederatedPaymentsConsole,
} from '../../src/federation/console.js';
import { redisIdempotencyStore } from '../../src/federation/idempotency.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { RedisBus } from './redis_bus.js';

/**
 * The federated console end to end, in one process: two apps on SQLite (the Hub and Entre
 * Textos, each with its own Lucid billing store), one fake Redis, and two instances of Entre
 * Textos answering commands. The Hub reads ET's tables through its own connection and sends ET's
 * actions over the bus; ET runs them through its own console handlers, gateway and audit trail.
 */

const SECRET_API_KEY = 'sk_live_51SECRETkeyDoNotLeak';
/** The secret the Hub and Entre Textos share (shared-secret mode of the console channel). */
const CHANNEL_SECRET = 'et-console-secret-0123456789';
const WEBHOOK_SECRET = 'whsec_TOPsecretWebhookSigning';
const CPF = '123.456.789-09';
const CARD = '4242424242424242';
const PIX = '00020126580014br.gov.bcb.pix0136a629534e-7693-4846-852d-1bbff817b5a8520400005303986';

/** A Stripe-shaped gateway that counts refunds and holds credentials the Hub must never see. */
function fakeStripe() {
  const refunds: Array<{ gatewayId: string; amount?: number; idempotencyKey?: string }> = [];
  const seenKeys = new Map<string, unknown>();
  const driver = {
    provider: 'stripe',
    config: { apiKey: SECRET_API_KEY, webhookSecret: WEBHOOK_SECRET },
    capabilities: { refunds: true, disputes: true },
    async refund(gatewayId: string, amount?: number, options?: { idempotencyKey?: string }) {
      // Like Stripe: the same idempotency key answers the first refund again.
      const key = options?.idempotencyKey;
      if (key !== undefined && seenKeys.has(key)) return seenKeys.get(key);
      refunds.push({
        gatewayId,
        ...(amount !== undefined ? { amount } : {}),
        ...(key !== undefined ? { idempotencyKey: key } : {}),
      });
      const refund = {
        gatewayId: `re_${refunds.length}`,
        provider: 'stripe',
        amount: { amount: amount ?? 19900, currency: 'BRL' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      if (key !== undefined) seenKeys.set(key, refund);
      return refund;
    },
  };
  return { driver, refunds };
}

describe('federated payments console (in process)', () => {
  let db: Database;
  let hubStore: LucidBillingStore;
  let etStore: LucidBillingStore;
  const bus = new RedisBus();
  const stripe = fakeStripe();
  const channels: RedisConsoleChannel[] = [];
  let hub: FederatedPaymentsConsole;
  /** Every answer the Hub gave, to search for secrets. */
  const answers: string[] = [];

  const ALL_ACTIONS: FederatedPaymentsAction[] = ['refund', 'retryWebhook', 'resolveDispute'];

  async function startEtInstance(): Promise<void> {
    const drivers = new Map<string, PaymentsDriver>([
      ['stripe', stripe.driver as unknown as PaymentsDriver],
    ]);
    const client = bus.connection();
    channels.push(
      await answerPaymentsConsoleCommands({
        client,
        prefix: 'et',
        secret: CHANNEL_SECRET,
        actions: new Set(ALL_ACTIONS),
        idempotency: redisIdempotencyStore(client, 'et'),
        runtime: {
          currency: 'BRL',
          store: () => etStore,
          capabilities: async () => consoleCapabilities(drivers),
          actions: async (store) =>
            createConsoleActions({
              manager: {
                driver: (name) => drivers.get(name) as unknown as RefundCapableDriver as never,
              },
              store,
              tenancy: () => resolvePaymentsTenancy(undefined),
              gatewayIdempotency: (provider) => provider === 'stripe',
            }),
        },
      }),
    );
  }

  const dispatch = async (
    route: string,
    req: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown },
    meta: Parameters<FederatedPaymentsConsole['dispatch']>[3]['meta'] = {},
    app = 'et',
  ) => {
    const answer = await hub.dispatch(
      app,
      route,
      { params: req.params ?? {}, query: req.query ?? {}, body: req.body },
      { currency: 'BRL', meta: { actor: 'ops@hub.example', via: 'Hub', ...meta } },
    );
    answers.push(JSON.stringify(answer));
    return answer;
  };

  const ADMIN = { capabilities: ['payments:*'] };

  beforeAll(async () => {
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    const sqlite = {
      client: 'better-sqlite3' as const,
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    };
    db = new Database(
      { connection: 'hub', connections: { hub: sqlite, et: sqlite } },
      new LoggerFactory().create(),
      new Emitter(app),
    );
    BaseModel.useAdapter(db.modelAdapter());
    hubStore = new LucidBillingStore({}, { connection: 'hub' });
    etStore = new LucidBillingStore({}, { connection: 'et' });

    // The Hub's own data, to tell apart from ET's.
    await hubStore.savePayment({
      gatewayId: 'pay_hub',
      provider: 'stripe',
      status: 'paid',
      amount: 500,
      currency: 'BRL',
    });

    // ET's data, with everything that must not leave ET.
    await etStore.saveCustomer({
      gatewayId: 'cus_et',
      provider: 'stripe',
      ownerType: 'users',
      ownerId: '42',
      email: 'aluna@example.com',
      name: 'Aluna',
      taxId: CPF,
      metadata: { apiKey: SECRET_API_KEY },
    });
    await etStore.savePayment({
      gatewayId: 'pay_et',
      provider: 'stripe',
      status: 'paid',
      amount: 19900,
      currency: 'BRL',
      customerId: 'cus_et',
      paidAt: new Date(),
      payload: { card: { number: CARD, cvc: '123' }, pix: PIX, secret: WEBHOOK_SECRET },
    });
    const event = await etStore.recordWebhookEvent({
      gatewayEventId: 'evt_failed',
      provider: 'stripe',
      type: 'payment.succeeded',
      payload: { data: { object: { id: 'pay_et', card: CARD } }, signature: WEBHOOK_SECRET },
      normalized: { gatewayId: 'pay_et', amount: 19900, currency: 'BRL' },
    });
    await etStore.markWebhookFailed(event!.id as string, `handler failed for card ${CARD}`);
    await etStore.saveDispute({
      gatewayId: 'dp_et',
      paymentGatewayId: 'pay_et',
      provider: 'stripe',
      status: 'open',
      amount: 19900,
      currency: 'BRL',
      payload: { pix: PIX },
    });

    // Two instances of ET answer commands; the Hub knows ET only by its tables and its prefix.
    await startEtInstance();
    await startEtInstance();
    hub = new FederatedPaymentsConsole(
      {
        et: {
          label: 'Entre Textos',
          store: { connection: 'et' },
          controlPlane: { prefix: 'et', secret: CHANNEL_SECRET },
        },
        down: {
          label: 'Down app',
          store: { connection: 'et' },
          controlPlane: { prefix: 'nobody-listens', secret: CHANNEL_SECRET },
        },
        browse: {
          label: 'Browse only',
          store: { connection: 'et' },
          controlPlane: { prefix: 'et', secret: CHANNEL_SECRET },
          actions: false,
        },
      },
      { redis: async () => bus.connection() },
    );
  });

  afterAll(async () => {
    await hub?.close();
    for (const channel of channels) await channel.close();
    await db?.manager.closeAll();
  });

  it('reads the owning app’s tables, not its own', async () => {
    const page = await dispatch('payments', { query: {} });
    expect(page.status).toBe(200);
    const ids = (page.body as { data: Array<{ gatewayId: string }> }).data.map((p) => p.gatewayId);
    expect(ids).toEqual(['pay_et']);
  });

  it('masks the document number at the row', async () => {
    const page = await dispatch('customers', { query: {} });
    expect(page.status).toBe(200);
    const [customer] = (page.body as { data: Array<{ taxId: string; email: string }> }).data;
    expect(customer?.taxId).toBe('***.456.789-**');
    expect(customer?.email).toBe('aluna@example.com');
  });

  it('serves every federated read', async () => {
    for (const [route, params] of [
      ['overview', {}],
      ['health', {}],
      ['paymentDetail', { gatewayId: 'pay_et' }],
      ['audit', {}],
      ['disputes', {}],
      ['subscriptions', {}],
      ['webhookEvents', {}],
      ['providers', {}],
    ] as const) {
      const answer = await dispatch(route, { params });
      expect(answer.status, `${route}: ${JSON.stringify(answer.body)}`).toBe(200);
    }
    // The gateways' capabilities come from the app (booleans), never their configuration.
    const providers = await dispatch('providers', {});
    expect((providers.body as { capabilities: unknown }).capabilities).toEqual({
      stripe: {
        refunds: true,
        disputes: true,
        cancelSubscription: false,
        updateSubscription: false,
      },
    });
  });

  it('refuses an action without the viewer’s capability or an idempotency key', async () => {
    const noCapability = await dispatch(
      'refund',
      { params: { gatewayId: 'pay_et' }, body: {} },
      // The console's authorize granted this viewer something else (not refunds).
      { idempotencyKey: 'key-no-capability', capabilities: ['payments:disputes:resolve'] },
    );
    expect(noCapability.status).toBe(403);
    const noKey = await dispatch('refund', { params: { gatewayId: 'pay_et' }, body: {} }, ADMIN);
    expect(noKey.status).toBe(400);
    const browse = await dispatch(
      'refund',
      { params: { gatewayId: 'pay_et' }, body: {} },
      { ...ADMIN, idempotencyKey: 'key-browse-only' },
      'browse',
    );
    expect(browse.status).toBe(403);
    expect(stripe.refunds).toHaveLength(0);
  });

  it('a refund runs once in the owning app, idempotent across command retries', async () => {
    const meta = { ...ADMIN, idempotencyKey: 'refund-pay-et-0001' };
    const request = { params: { gatewayId: 'pay_et' }, body: { amount: 1000 } };
    const first = await dispatch('refund', request, meta);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(stripe.refunds).toHaveLength(1);
    // Exactly one of the two instances ran it, with the gateway's own idempotency key.
    expect(stripe.refunds[0]?.idempotencyKey).toBe('console-refund-pay-et-0001');

    // The console sends it again (a timeout, a retry): same answer, no second refund.
    const again = await dispatch('refund', request, meta);
    expect(again).toEqual(first);
    // Even as a raw command with a new command id, straight on the bus.
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'et',
      secret: CHANNEL_SECRET,
    });
    const raw = await channel.send({
      id: 'retry-by-hand',
      verb: 'refund',
      args: [{ ...request, query: {}, idempotencyKey: 'refund-pay-et-0001' }],
      actor: 'ops@hub.example',
      capabilities: ['payments:refund'],
      via: 'Hub',
    });
    await channel.close();
    expect(raw.ok && (raw.data as { status: number }).status).toBe(200);
    expect(stripe.refunds).toHaveLength(1);

    // The same key for different arguments is refused.
    const reused = await dispatch(
      'refund',
      { params: { gatewayId: 'pay_et' }, body: { amount: 2000 } },
      meta,
    );
    expect(reused.status).toBe(422);
    expect(stripe.refunds).toHaveLength(1);

    // The owning app's audit trail names the Hub's viewer, through the Hub.
    const audit = await etStore.listAuditEvents({ action: 'payment.refunded' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe('ops@hub.example (via Hub)');
    // And nothing was written to the Hub's own store.
    expect(await hubStore.listAuditEvents({})).toHaveLength(0);
  });

  it('two concurrent sends with one key refund once', async () => {
    const meta = { ...ADMIN, idempotencyKey: 'refund-concurrent-0001' };
    const request = { params: { gatewayId: 'pay_et' }, body: { amount: 500 } };
    const before = stripe.refunds.length;
    const answers2 = await Promise.all([
      dispatch('refund', request, meta),
      dispatch('refund', request, meta),
    ]);
    expect(stripe.refunds.length - before).toBe(1);
    expect(answers2.map((a) => a.status).sort()).toEqual(
      answers2.some((a) => a.status === 409) ? [200, 409] : [200, 200],
    );
  });

  it('runs other allow-listed actions through the app (retry, resolve)', async () => {
    const resolved = await dispatch(
      'resolve',
      { params: { gatewayId: 'dp_et' }, body: { status: 'won', note: 'documents sent' } },
      { capabilities: ['payments:disputes:resolve'], idempotencyKey: 'resolve-dp-et-0001' },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect((await etStore.findDisputeByGatewayId('dp_et'))?.status).toBe('won');

    const retried = await dispatch(
      'retry',
      { params: { gatewayEventId: 'evt_failed' }, body: {} },
      { capabilities: ['payments:webhooks:retry'], idempotencyKey: 'retry-evt-0001' },
    );
    // ET has no replayable handler here: what matters is that ET answered (not the Hub).
    expect([200, 422, 502]).toContain(retried.status);
  });

  it('an app nobody answers for fails fast with 503', async () => {
    const started = Date.now();
    const answer = await dispatch(
      'refund',
      { params: { gatewayId: 'pay_et' }, body: {} },
      { ...ADMIN, idempotencyKey: 'refund-down-0001' },
      'down',
    );
    expect(answer.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('no secret, credential, full document, card or PIX code crosses the bus or reaches the Hub', () => {
    const everything = `${bus.wire}\n${answers.join('\n')}`;
    expect(answers.length).toBeGreaterThan(10);
    for (const secret of [SECRET_API_KEY, WEBHOOK_SECRET, CARD, PIX, '12345678909', CPF]) {
      expect(everything, `"${secret}" leaked`).not.toContain(secret);
    }
    // The card number in a free-text error is reduced to its last 4.
    expect(everything).toContain('•••• 4242');
  });
});
