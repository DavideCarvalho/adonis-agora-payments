import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentsManager } from '../../src/payments_manager.js';
import { FakePaymentsDriver } from '../../src/testing/fake_payments_driver.js';
import { createPaymentsControlPlane } from '../../src/topology/control_plane.js';
import type { TenantLedger } from '../../src/topology/ledger.js';
import { dropTenantLedgerTables, lucidTenantLedger } from '../../src/topology/lucid_ledger.js';
import { HUB_MESSAGE_VERSION } from '../../src/topology/protocol.js';
import { createHubClient, HubEventPump, RemoteDriver } from '../../src/topology/tenant.js';
import { redisHubTransport, serveRedisHub } from '../../src/topology/transports.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import type { WebhookEvent } from '../../src/types.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

const SCHEMA = 'payments_hub_spec';

const event = (id: string, gatewayId: string): WebhookEvent => ({
  id,
  provider: 'asaas',
  type: 'payment.succeeded',
  data: { gatewayId, amount: 1, currency: 'brl' },
  raw: { id },
});

/**
 * The control plane's ledger as SQL against a real Postgres, in its own schema and with every
 * query qualified (the database's search_path points elsewhere).
 */
describe('lucid tenant ledger (integration)', () => {
  let database: IntegrationDatabase;
  let ledger: TenantLedger;

  beforeAll(async () => {
    // search_path = this spec's schema; the ledger must still land in SCHEMA because it names it.
    database = await createIntegrationDatabase('payments_hub_spec_search_path', { migrate: false });
    ledger = lucidTenantLedger({ schema: SCHEMA, db: () => database.db.connection() as never });
  });

  afterAll(async () => {
    await dropTenantLedgerTables(database.db.connection() as never, { schema: SCHEMA });
    await database.db.rawQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await database.teardown();
  });

  it('creates its tables in the configured schema', async () => {
    await ledger.backlog();
    const result = (await database.db.rawQuery(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [SCHEMA],
    )) as { rows: { table_name: string }[] };
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'billing_tenant_calls',
      'billing_tenant_events',
      'billing_tenant_objects',
    ]);
  });

  it('claims single-owner objects once and shares customers', async () => {
    expect(await ledger.claim('a', 'payment', 'pay_1', 'asaas')).toBe(true);
    expect(await ledger.claim('a', 'payment', 'pay_1', 'asaas')).toBe(true);
    expect(await ledger.claim('b', 'payment', 'pay_1', 'asaas')).toBe(false);
    expect(await ledger.owners('payment', 'pay_1')).toEqual(['a']);
    expect(await ledger.claim('a', 'customer', 'cus_1', 'asaas')).toBe(true);
    expect(await ledger.claim('b', 'customer', 'cus_1', 'asaas')).toBe(true);
    expect((await ledger.owners('customer', 'cus_1')).sort()).toEqual(['a', 'b']);
  });

  it('lets exactly one of two racing apps claim an object', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((app) => ledger.claim(app, 'subscription', 'sub_race', 'asaas')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ledger.owners('subscription', 'sub_race')).toHaveLength(1);
  });

  it('queues, dedupes, pulls in order, acks per app and prunes', async () => {
    await ledger.enqueue('a', event('evt_1', 'pay_1'));
    await ledger.enqueue('a', event('evt_1', 'pay_1'));
    await ledger.enqueue('a', event('evt_2', 'pay_1'));
    await ledger.enqueue('b', event('evt_1', 'pay_1'));
    const pending = await ledger.pull('a', 10);
    expect(pending.map((row) => row.event.id)).toEqual(['evt_1', 'evt_2']);
    expect(pending[0]?.event.data).toEqual({ gatewayId: 'pay_1', amount: 1, currency: 'brl' });
    expect(await ledger.backlog()).toEqual({ a: 2, b: 1 });
    expect(
      await ledger.ack(
        'b',
        pending.map((row) => row.seq),
      ),
    ).toBe(0);
    expect(
      await ledger.ack(
        'a',
        pending.map((row) => row.seq),
      ),
    ).toBe(2);
    expect(await ledger.pull('a', 10)).toEqual([]);
    const pruned = await ledger.prune(new Date(Date.now() + 60_000));
    expect(pruned.events).toBe(2);
    expect(await ledger.backlog()).toEqual({ b: 1 });
  });

  it('replays a finished call and releases an abandoned one', async () => {
    expect(await ledger.beginCall('a', 'call_1')).toEqual({ state: 'new' });
    expect(await ledger.beginCall('a', 'call_1')).toEqual({ state: 'running' });
    expect(await ledger.beginCall('b', 'call_1')).toEqual({ state: 'new' });
    const reply = { v: HUB_MESSAGE_VERSION, id: 'call_1', ok: true, result: { n: 1 } };
    await ledger.finishCall('a', 'call_1', reply);
    expect(await ledger.beginCall('a', 'call_1')).toEqual({ state: 'done', reply });
    await ledger.abandonCall('b', 'call_1');
    expect(await ledger.beginCall('b', 'call_1')).toEqual({ state: 'new' });
  });
});

const redisUrl = process.env.PAYMENTS_TEST_REDIS_URL;

/** Tenant ↔ control plane over a real Redis: calls, replies and the event wake-up. */
describe.skipIf(!redisUrl)('redis transport (integration)', () => {
  const prefix = `payments-test-${process.pid}`;
  const connections: Redis[] = [];
  const connect = () => {
    const redis = new Redis(redisUrl as string, {
      keyPrefix: 'agora-bus-test:',
      lazyConnect: false,
    });
    connections.push(redis);
    return redis;
  };
  let server: ReturnType<typeof serveRedisHub>;
  let gateway: FakePaymentsDriver;
  let pumpClient: ReturnType<typeof createHubClient>;
  let transport: ReturnType<typeof redisHubTransport>;
  let driver: RemoteDriver;

  beforeAll(async () => {
    gateway = new FakePaymentsDriver({ provider: 'asaas' });
    const manager = new PaymentsManager({ drivers: new Map([['asaas', gateway]]) });
    const { memoryTenantLedger } = await import('../../src/topology/ledger.js');
    const plane = createPaymentsControlPlane({
      manager: () => manager,
      ledger: memoryTenantLedger(),
      verifyTenant: sharedSecretVerifier({ partitions: { et: 'secret' } }),
      notify: (partition) => server.notify(partition),
    });
    server = serveRedisHub((message) => plane.handle(message), {
      connection: connect(),
      writer: connect(),
      prefix,
      blockSeconds: 1,
    });
    transport = redisHubTransport({ connection: connect(), wakeConnection: connect(), prefix });
    pumpClient = createHubClient({ transport, token: 'secret', partition: 'et' });
    driver = new RemoteDriver('asaas', pumpClient);
    (globalThis as { __plane?: unknown }).__plane = plane;
  });

  afterAll(async () => {
    await server?.stop();
    for (const redis of connections) redis.disconnect();
  });

  it('runs a call through the bus and answers it', async () => {
    expect(await pumpClient.call('whoami')).toMatchObject({ partition: 'et' });
    const payment = await driver.charge({ amount: 700, method: 'pix' } as never);
    expect(gateway.chargeCalls).toHaveLength(1);
    expect(payment.gatewayId).toBe('pi_1');
  });

  it('answers concurrent calls each on its own reply key', async () => {
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => pumpClient.call<{ partition: string }>('whoami')),
    );
    expect(answers.every((answer) => answer.partition === 'et')).toBe(true);
  });

  it('wakes the tenant pump when the control plane forwards an event', async () => {
    const plane = (globalThis as { __plane?: ReturnType<typeof createPaymentsControlPlane> })
      .__plane as ReturnType<typeof createPaymentsControlPlane>;
    const seen: string[] = [];
    const pump = new HubEventPump({
      client: pumpClient,
      transport,
      partition: 'et',
      idleSeconds: 30,
      deliver: async (delivered) => {
        seen.push(delivered.id);
      },
    });
    pump.start();
    // Let the pump drain (nothing) and block on the wake key.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await plane.forward(event('evt_bus', 'pi_1'));
    while (seen.length === 0 && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await pump.stop();
    expect(seen).toEqual(['evt_bus']);
    // Woken, not polled: far below the 30 s idle wait.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
