import { describe, expect, it } from 'vitest';
import { PaymentsManager } from '../src/payments_manager.js';
import { FakePaymentsDriver, InMemoryBillingStore } from '../src/testing/index.js';
import { createPaymentsControlPlane } from '../src/topology/control_plane.js';
import { memoryTenantLedger } from '../src/topology/ledger.js';
import {
  HUB_MESSAGE_VERSION,
  isHubUnavailable,
  PaymentsHubError,
} from '../src/topology/protocol.js';
import { buildTenantRuntime, fallbackTransport, resolveTopology } from '../src/topology/runtime.js';
import {
  createHubClient,
  createPaymentsHubApi,
  describeRemoteDrivers,
  HubEventPump,
  RemoteDriver,
} from '../src/topology/tenant.js';
import { type HubTransport, httpHubTransport } from '../src/topology/transports.js';
import { sharedSecretVerifier } from '../src/topology/verify.js';
import type { WebhookEvent } from '../src/types.js';

/** A control plane with one fake gateway, and two apps that use it. */
function setup(options: { adoptUnclaimed?: boolean } = {}) {
  const gateway = new FakePaymentsDriver({ provider: 'asaas' });
  const manager = new PaymentsManager({ drivers: new Map([['asaas', gateway]]) });
  const store = new InMemoryBillingStore();
  const ledger = memoryTenantLedger();
  const plane = createPaymentsControlPlane({
    manager: () => manager,
    store: () => store,
    ledger,
    verifyTenant: sharedSecretVerifier({
      partitions: {
        'entre-textos': { secret: 'et-secret', capabilities: ['payments:*'] },
        eduliberta: { secret: 'el-secret', capabilities: ['payments:*'] },
        readonly: { secret: 'ro-secret', capabilities: ['payments:read'] },
      },
    }),
    ...(options.adoptUnclaimed !== undefined ? { adoptUnclaimed: options.adoptUnclaimed } : {}),
  });
  const calls: unknown[] = [];
  const transport: HubTransport = {
    name: 'memory',
    async request(message) {
      calls.push(message);
      return plane.handle(message);
    },
  };
  /** A tenant app: its client, remote driver and hub API, all over the in-memory transport. */
  const app = (partition: string, secret: string) => {
    const client = createHubClient({ transport, token: secret, partition, retries: 0 });
    const driver = new RemoteDriver('asaas', client, { methods: ['pix', 'credit_card'] });
    return { client, driver, hub: createPaymentsHubApi(client, () => undefined), partition };
  };
  return {
    gateway,
    manager,
    store,
    ledger,
    plane,
    calls,
    transport,
    et: app('entre-textos', 'et-secret'),
    el: app('eduliberta', 'el-secret'),
  };
}

const paymentEvent = (id: string, data: Record<string, unknown>): WebhookEvent => ({
  id,
  provider: 'asaas',
  type: 'payment.succeeded',
  data,
  raw: { id },
});

describe('payments topology: control plane + tenant', () => {
  it('runs a tenant charge on the control plane gateway and claims the payment for that app', async () => {
    const { gateway, et, ledger } = setup();
    const payment = await et.driver.charge({ amount: 1990, method: 'pix' } as never);
    expect(gateway.chargeCalls).toHaveLength(1);
    expect(payment.provider).toBe('asaas');
    expect(await ledger.owners('payment', payment.gatewayId)).toEqual(['entre-textos']);
  });

  it('never lets an app touch another app’s payment (not_found, not forbidden)', async () => {
    const { et, el, gateway } = setup();
    const payment = await et.driver.charge({ amount: 1990, method: 'pix' } as never);
    await expect(el.driver.refund(payment.gatewayId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(el.driver.findPayment(payment.gatewayId)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(gateway.refundCalls).toHaveLength(0);
    await expect(et.driver.refund(payment.gatewayId)).resolves.toBeDefined();
  });

  it('keeps ONE gateway customer per account across apps', async () => {
    const { et, el, gateway, store } = setup();
    const a = await et.driver.createCustomer({ name: 'Ana', email: 'a@x.test', account: 'sub_1' });
    const b = await el.hub.customer('sub_1', 'asaas', { name: 'Ana' });
    expect(b).toEqual({ id: a.id, created: false });
    expect(gateway.createCustomerCalls).toHaveLength(1);
    // The account never reaches the gateway.
    expect(gateway.createCustomerCalls[0]?.input).not.toHaveProperty('account');
    const row = await store.findCustomerByOwner('account', 'sub_1', 'asaas');
    expect(row).toMatchObject({ gatewayId: a.id });
    // Both apps may charge that customer.
    await expect(
      el.driver.charge({ amount: 100, method: 'pix', customerId: a.id } as never),
    ).resolves.toBeDefined();
  });

  it('refuses a customer the app never got', async () => {
    const { et, el } = setup();
    const own = await et.driver.createCustomer({ name: 'Bia' });
    await expect(
      el.driver.charge({ amount: 100, method: 'pix', customerId: own.id } as never),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('adopts an unclaimed object only when allowed', async () => {
    const strict = setup();
    const legacy = await strict.gateway.charge({ amount: 1 } as never);
    await expect(strict.et.driver.findPayment(legacy.gatewayId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await strict.plane.adopt('entre-textos', 'payment', legacy.gatewayId, 'asaas');
    await expect(strict.et.driver.findPayment(legacy.gatewayId)).resolves.toMatchObject({
      gatewayId: legacy.gatewayId,
    });

    const lax = setup({ adoptUnclaimed: true });
    const old = await lax.gateway.charge({ amount: 1 } as never);
    await expect(lax.et.driver.findPayment(old.gatewayId)).resolves.toBeDefined();
    await expect(lax.el.driver.findPayment(old.gatewayId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('replays a retried call instead of charging twice', async () => {
    const { plane, gateway } = setup();
    const message = {
      v: HUB_MESSAGE_VERSION,
      id: 'call-1',
      operation: 'driver',
      input: { provider: 'asaas', call: 'charge', args: [{ amount: 500, method: 'pix' }] },
      token: 'et-secret',
      partition: 'entre-textos',
      issuedAt: Date.now(),
    };
    const first = await plane.handle(message);
    const second = await plane.handle({ ...message, issuedAt: Date.now() });
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(gateway.chargeCalls).toHaveLength(1);
    // The same id from ANOTHER app is another call.
    const other = await plane.handle({ ...message, token: 'el-secret', partition: 'eduliberta' });
    expect(other.ok).toBe(true);
    expect(gateway.chargeCalls).toHaveLength(2);
  });

  it('runs a failed call again on retry (the id is released)', async () => {
    const { plane, gateway } = setup();
    let fail = true;
    const charge = gateway.charge.bind(gateway);
    gateway.charge = async (input) => {
      if (fail) throw new Error('gateway down');
      return charge(input);
    };
    const message = {
      v: HUB_MESSAGE_VERSION,
      id: 'call-2',
      operation: 'driver',
      input: { provider: 'asaas', call: 'charge', args: [{ amount: 500 }] },
      token: 'et-secret',
      partition: 'entre-textos',
      issuedAt: Date.now(),
    };
    const failed = await plane.handle(message);
    expect(failed).toMatchObject({ ok: false, error: { code: 'gateway' } });
    fail = false;
    expect((await plane.handle(message)).ok).toBe(true);
  });

  it('verifies the token on every call and checks capabilities', async () => {
    const { plane } = setup();
    const base = { v: HUB_MESSAGE_VERSION, issuedAt: Date.now() };
    expect(
      await plane.handle({ ...base, id: 'a', operation: 'whoami', token: 'wrong' }),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(
      await plane.handle({
        ...base,
        id: 'b',
        operation: 'whoami',
        token: 'ro-secret',
        partition: 'readonly',
      }),
    ).toMatchObject({ ok: true, result: { partition: 'readonly' } });
    expect(
      await plane.handle({
        ...base,
        id: 'c',
        operation: 'driver',
        input: { provider: 'asaas', call: 'charge', args: [{ amount: 1 }] },
        token: 'ro-secret',
        partition: 'readonly',
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(
      await plane.handle({
        ...base,
        id: 'd',
        operation: 'events.pull',
        token: 'ro-secret',
        partition: 'readonly',
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(
      await plane.handle({
        ...base,
        id: 'e',
        operation: 'whoami',
        token: 'et-secret',
        partition: 'entre-textos',
        issuedAt: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await plane.handle({ nope: true })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('refuses webhook-only and unknown driver calls', async () => {
    const { plane } = setup();
    const reply = await plane.handle({
      v: HUB_MESSAGE_VERSION,
      id: 'w',
      operation: 'driver',
      input: { provider: 'asaas', call: 'parseWebhook', args: ['{}', {}] },
      token: 'et-secret',
      partition: 'entre-textos',
      issuedAt: Date.now(),
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('forwards a processed webhook only to the app that owns the payment', async () => {
    const { plane, et, el, ledger } = setup();
    const payment = await et.driver.charge({ amount: 1990, method: 'pix' } as never);
    const routed = await plane.forward(paymentEvent('evt_1', { gatewayId: payment.gatewayId }));
    expect(routed).toEqual(['entre-textos']);
    expect(await ledger.pull('entre-textos', 10)).toHaveLength(1);
    expect(await ledger.pull('eduliberta', 10)).toHaveLength(0);
    // Forwarding the same event again (a gateway retry) queues nothing new.
    await plane.forward(paymentEvent('evt_1', { gatewayId: payment.gatewayId }));
    expect(await ledger.pull('entre-textos', 10)).toHaveLength(1);
    // Nobody's payment: stays on the control plane.
    expect(await plane.forward(paymentEvent('evt_2', { gatewayId: 'pay_unknown' }))).toEqual([]);
    void el;
  });

  it('routes a renewal payment of a claimed subscription, and learns it', async () => {
    const { plane, el, ledger } = setup();
    const sub = await el.driver.createSubscription({
      customerId: (await el.driver.createCustomer({ name: 'C' })).id,
      planId: 'plan',
      amount: 100,
    } as never);
    const routed = await plane.forward(
      paymentEvent('evt_r', { gatewayId: 'pay_renewal', subscriptionId: sub.gatewayId }),
    );
    expect(routed).toEqual(['eduliberta']);
    expect(await ledger.owners('payment', 'pay_renewal')).toEqual(['eduliberta']);
  });

  it('does not guess between two apps for an unclaimed payment of a shared customer', async () => {
    const { plane, et, el } = setup();
    const customer = await et.driver.createCustomer({ account: 'sub_9' });
    await el.hub.customer('sub_9', 'asaas');
    expect(
      await plane.forward(paymentEvent('evt_x', { gatewayId: 'pay_x', customerId: customer.id })),
    ).toEqual([]);
    expect(
      (
        await plane.forward({
          ...paymentEvent('evt_c', { customerId: customer.id }),
          type: 'customer.updated',
        })
      ).sort(),
    ).toEqual(['eduliberta', 'entre-textos']);
  });

  it('pumps forwarded events into the app and acknowledges them only after delivery', async () => {
    const { plane, et, ledger, transport } = setup();
    const payment = await et.driver.charge({ amount: 1990, method: 'pix' } as never);
    await plane.forward(paymentEvent('evt_p1', { gatewayId: payment.gatewayId }));
    await plane.forward(paymentEvent('evt_p2', { gatewayId: payment.gatewayId }));

    const failing = new HubEventPump({
      client: et.client,
      transport,
      partition: 'entre-textos',
      deliver: async () => {
        throw new Error('handler failed');
      },
    });
    await expect(failing.drain()).rejects.toThrow('handler failed');
    expect(await ledger.pull('entre-textos', 10)).toHaveLength(2);

    const seen: string[] = [];
    const pump = new HubEventPump({
      client: et.client,
      transport,
      partition: 'entre-textos',
      deliver: async (event) => {
        seen.push(event.id);
      },
      batch: 1,
    });
    expect(await pump.drain()).toBe(2);
    expect(seen).toEqual(['evt_p1', 'evt_p2']);
    expect(await ledger.pull('entre-textos', 10)).toHaveLength(0);
    expect(await ledger.backlog()).toEqual({});
  });

  it('an app cannot acknowledge another app’s events', async () => {
    const { plane, et, el, ledger } = setup();
    const payment = await et.driver.charge({ amount: 1, method: 'pix' } as never);
    await plane.forward(paymentEvent('evt_a', { gatewayId: payment.gatewayId }));
    const [envelope] = await ledger.pull('entre-textos', 1);
    expect(await el.client.call('events.ack', { seqs: [envelope?.seq] })).toEqual({ acked: 0 });
    expect(await ledger.pull('entre-textos', 1)).toHaveLength(1);
  });

  it('answers an account’s billing scoped to the calling app', async () => {
    const { et, el, store } = setup();
    const customer = await et.driver.createCustomer({ account: 'sub_5', name: 'D' });
    const payment = await et.driver.charge({
      amount: 300,
      method: 'pix',
      customerId: customer.id,
    } as never);
    await store.savePayment({
      gatewayId: payment.gatewayId,
      provider: 'asaas',
      customerId: customer.id,
      amount: 300,
      currency: 'brl',
      status: 'paid',
    } as never);
    const mine = await et.hub.account('sub_5');
    expect(mine.customers).toEqual([customer.id]);
    expect(mine.payments).toHaveLength(1);
    await el.hub.customer('sub_5', 'asaas');
    expect((await el.hub.account('sub_5')).payments).toHaveLength(0);
  });

  it('describes the control plane providers to the remote drivers', async () => {
    const { et } = setup();
    expect(et.driver.capabilities).toEqual({});
    expect(await describeRemoteDrivers(et.client, [et.driver])).toBe(true);
    expect(et.driver.provider).toBe('asaas');
    expect(et.driver.capabilities.subscriptions).toBe(true);
    expect(et.driver.supportedMethods).toContain('boleto');
  });

  it('a remote driver never parses webhooks', async () => {
    const { et } = setup();
    await expect(et.driver.parseWebhook('{}', {})).rejects.toThrow(/control plane/);
    expect(et.driver.webhookVerification).toBe('unsupported');
  });
});

describe('payments topology: client and transports', () => {
  it('fetches a fresh token once after unauthorized', async () => {
    let issued = 0;
    const token = Object.assign(async () => `t${issued}`, { reset: () => (issued += 1) });
    const transport: HubTransport = {
      name: 'memory',
      async request(message) {
        return message.token === 't1'
          ? { v: HUB_MESSAGE_VERSION, id: message.id, ok: true, result: 'ok' }
          : {
              v: HUB_MESSAGE_VERSION,
              id: message.id,
              ok: false,
              error: { code: 'unauthorized', message: 'no' },
            };
      },
    };
    const client = createHubClient({ transport, token });
    expect(await client.call('whoami')).toBe('ok');
    expect(issued).toBe(1);
  });

  it('retries an unreachable control plane with the same call id', async () => {
    const ids: string[] = [];
    let attempts = 0;
    const transport: HubTransport = {
      name: 'flaky',
      async request(message) {
        ids.push(message.id);
        attempts += 1;
        if (attempts < 3) throw new PaymentsHubError('unavailable', 'down');
        return { v: HUB_MESSAGE_VERSION, id: message.id, ok: true, result: 1 };
      },
    };
    const client = createHubClient({ transport, token: 's', retries: 2 });
    expect(await client.call('whoami')).toBe(1);
    expect(new Set(ids).size).toBe(1);
  });

  it('surfaces an unreachable control plane as unavailable', async () => {
    const transport = httpHubTransport({
      url: 'http://hub.test/_payments',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const client = createHubClient({ transport, token: 's', retries: 0 });
    const error = await client.call('whoami').catch((e: unknown) => e);
    expect(isHubUnavailable(error)).toBe(true);
  });

  it('posts the envelope to <url>/rpc over HTTP', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const transport = httpHubTransport({
      url: async () => 'http://hub.test/_payments/',
      fetch: async (url, init) => {
        seen = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(
          JSON.stringify({ v: HUB_MESSAGE_VERSION, id: seen.body.id, ok: true, result: { a: 1 } }),
          { status: 200 },
        );
      },
    });
    const client = createHubClient({ transport, token: 'tok' });
    expect(await client.call('whoami')).toEqual({ a: 1 });
    expect(seen?.url).toBe('http://hub.test/_payments/rpc');
    expect(seen?.body).toMatchObject({ v: 1, operation: 'whoami', token: 'tok' });
  });

  it('falls back to HTTP with the same id when the bus cannot deliver', async () => {
    const ids: string[] = [];
    const bus: HubTransport = {
      name: 'redis',
      async request(message) {
        ids.push(message.id);
        throw new PaymentsHubError('timeout', 'no reply');
      },
    };
    const http: HubTransport = {
      name: 'http',
      async request(message) {
        ids.push(message.id);
        return { v: HUB_MESSAGE_VERSION, id: message.id, ok: true, result: 'via http' };
      },
    };
    const client = createHubClient({ transport: fallbackTransport(bus, http), token: 's' });
    expect(await client.call('whoami')).toBe('via http');
    expect(ids[0]).toBe(ids[1]);
  });
});

describe('payments topology: config', () => {
  const token = 'secret';

  it('defaults to standalone', () => {
    expect(resolveTopology({})).toBe('standalone');
  });

  it('refuses a half-configured control plane or tenant', () => {
    expect(() => resolveTopology({ topology: 'control-plane' })).toThrow(/verifyTenant/);
    expect(() =>
      resolveTopology({ topology: 'tenant', tenant: { partition: 'a', token, providers: [] } }),
    ).toThrow(/tenant.url/);
    expect(() =>
      resolveTopology({
        topology: 'tenant',
        tenant: { partition: 'a', token, providers: [], url: 'http://hub.test' },
      }),
    ).toThrow(/lists no/);
  });

  it('refuses gateway credentials on a tenant', () => {
    expect(() =>
      resolveTopology({
        topology: 'tenant',
        tenant: { partition: 'a', token, providers: ['asaas'], url: 'http://hub.test' },
        providers: { asaas: async () => new FakePaymentsDriver() },
      }),
    ).toThrow(/credentials belong to the control plane/);
    expect(
      resolveTopology({
        topology: 'tenant',
        tenant: { partition: 'a', token, providers: ['asaas'], url: 'http://hub.test' },
        providers: { stripe: undefined },
      }),
    ).toBe('tenant');
  });

  it('builds remote drivers routed by config.methods', () => {
    const runtime = buildTenantRuntime({
      topology: 'tenant',
      methods: { pix: 'woovi', credit_card: 'asaas' },
      tenant: { partition: 'a', token, providers: ['asaas', 'woovi'], url: 'http://hub.test' },
    });
    expect([...runtime.drivers.keys()]).toEqual(['asaas', 'woovi']);
    expect(runtime.drivers.get('woovi')?.supportedMethods).toEqual(['pix']);
    const manager = new PaymentsManager({
      drivers: new Map(runtime.drivers),
      methods: { pix: 'woovi', credit_card: 'asaas' },
    });
    expect(manager.driver('pix').provider).toBe('woovi');
    expect(() => manager.hub()).toThrow(/topology: 'tenant'/);
  });
});

describe('payments topology: managed renewals during an outage', () => {
  it('stops the pass without counting a failure when the control plane is unreachable', async () => {
    const { createManagedSubscription, renewDueManagedSubscriptions } = await import(
      '../src/billing/managed_subscriptions.js'
    );
    const store = new InMemoryBillingStore();
    const driver = new FakePaymentsDriver({ provider: 'asaas' });
    await createManagedSubscription(driver, store, {
      customerId: 'cus_1',
      planId: 'p',
      amount: 100,
      cycle: 'MONTHLY',
      startDate: '2026-01-10',
    } as never);
    driver.charge = async () => {
      throw new PaymentsHubError('unavailable', 'hub down');
    };
    const now = new Date('2026-02-10T00:00:00Z');
    expect(await renewDueManagedSubscriptions(() => driver, store, { now })).toEqual([]);
    const [row] = await store.listDueManagedSubscriptions(now, 10);
    expect(row?.renewalFailureCount ?? 0).toBe(0);
    expect(row?.lastRenewalError ?? null).toBeNull();
  });
});

describe('payments topology: csrf exceptions', () => {
  it('skips the webhook and rpc routes only', async () => {
    const { paymentsCsrfExceptions } = await import('../src/topology/runtime.js');
    expect(paymentsCsrfExceptions('/payments/webhook/asaas')).toBe(true);
    expect(paymentsCsrfExceptions('/_payments/rpc?x=1')).toBe(true);
    expect(paymentsCsrfExceptions('/_payments/rpcx')).toBe(false);
    expect(paymentsCsrfExceptions('/payments/api/refund')).toBe(false);
    expect(paymentsCsrfExceptions('/hub/rpc', { controlPlanePath: 'hub/' })).toBe(true);
  });
});
