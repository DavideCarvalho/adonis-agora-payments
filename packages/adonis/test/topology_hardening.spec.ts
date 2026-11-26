import { describe, expect, it } from 'vitest';
import { PaymentsManager } from '../src/payments_manager.js';
import { FakePaymentsDriver, InMemoryBillingStore } from '../src/testing/index.js';
import {
  createPaymentsControlPlane,
  hubIdempotencyKey,
  type PaymentsControlPlaneOptions,
  toPlainJson,
} from '../src/topology/control_plane.js';
import { memoryTenantLedger, type TenantLedger } from '../src/topology/ledger.js';
import { eventKey } from '../src/topology/lucid_ledger.js';
import {
  HUB_MESSAGE_VERSION,
  isHubOutcomeUnknown,
  PaymentsHubError,
} from '../src/topology/protocol.js';
import { createHubClient, RemoteDriver } from '../src/topology/tenant.js';
import type { HubTransport } from '../src/topology/transports.js';
import { sharedSecretVerifier } from '../src/topology/verify.js';
import type { WebhookEvent } from '../src/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const verifier = () =>
  sharedSecretVerifier({
    partitions: {
      'entre-textos': { secret: 'et-secret', capabilities: ['payments:*'] },
      eduliberta: { secret: 'el-secret', capabilities: ['payments:*'] },
    },
  });

const ET = 'https://www.entretextosassessoria.com.br';
const EL = 'https://eduliberta.com.br';

function setup(
  options: {
    provider?: string;
    ledger?: TenantLedger;
    store?: InMemoryBillingStore;
    gateway?: FakePaymentsDriver;
    plane?: Partial<PaymentsControlPlaneOptions>;
  } = {},
) {
  const gateway =
    options.gateway ?? new FakePaymentsDriver({ provider: options.provider ?? 'asaas' });
  const manager = new PaymentsManager({ drivers: new Map([['main', gateway]]) });
  const store = options.store ?? new InMemoryBillingStore();
  const ledger = options.ledger ?? memoryTenantLedger();
  const warnings: string[] = [];
  const plane = createPaymentsControlPlane({
    manager: () => manager,
    store: () => store,
    ledger,
    verifyTenant: verifier(),
    logger: { warn: (message) => warnings.push(message) },
    ...options.plane,
  });
  const transport: HubTransport = { name: 'memory', request: (message) => plane.handle(message) };
  const app = (partition: string, secret: string) => {
    const client = createHubClient({ transport, token: secret, partition, retries: 0 });
    return { client, driver: new RemoteDriver('main', client, { methods: ['pix'] }) };
  };
  /** One raw call, with an id the test picks (a retry reuses it). */
  const call = (id: string, input: unknown, extra: Record<string, unknown> = {}) =>
    plane.handle({
      v: HUB_MESSAGE_VERSION,
      id,
      operation: 'driver',
      input,
      token: 'et-secret',
      partition: 'entre-textos',
      issuedAt: Date.now(),
      ...extra,
    });
  return {
    gateway,
    store,
    ledger,
    plane,
    warnings,
    call,
    et: app('entre-textos', 'et-secret'),
    el: app('eduliberta', 'el-secret'),
  };
}

const charge = (input: Record<string, unknown> = {}) => ({
  provider: 'main',
  call: 'charge',
  args: [{ amount: 1990, method: 'pix', ...input }],
});

describe('payments control plane: interrupted calls (lease + reconcile)', () => {
  it('a call whose process died is reconciled after the lease, never "conflict" forever', async () => {
    const { call, ledger, gateway } = setup({ plane: { callLeaseMs: 20 } });
    // The crashed attempt: took the id, never finished nor released it.
    await ledger.beginCall('entre-textos', 'c1');
    const early = await call('c1', charge());
    expect(early.error?.code).toBe('conflict');
    await sleep(30);
    // Asaas without an idempotencyKey cannot be deduplicated: the outcome is unknown, and it is
    // NOT run a second time.
    const late = await call('c1', charge());
    expect(late.ok).toBe(false);
    expect(late.error?.code).toBe('indeterminate');
    expect(gateway.chargeCalls).toHaveLength(0);
    // Recorded: every later retry of the id gets the same answer, still without a charge.
    expect(await call('c1', charge())).toEqual(late);
    expect(gateway.chargeCalls).toHaveLength(0);
  });

  it('re-runs an interrupted Asaas charge that carries an idempotencyKey (the driver dedups by externalReference)', async () => {
    const { call, ledger, gateway } = setup({ plane: { callLeaseMs: 20 } });
    await ledger.beginCall('entre-textos', 'c2');
    await sleep(30);
    const answer = await call('c2', charge({ idempotencyKey: 'order_9' }));
    expect(answer.ok).toBe(true);
    expect(gateway.chargeCalls).toHaveLength(1);
    expect(gateway.chargeCalls[0]?.input.idempotencyKey).toBe('order_9');
    // Finished now: a retry replays.
    expect(await call('c2', charge({ idempotencyKey: 'order_9' }))).toEqual(answer);
    expect(gateway.chargeCalls).toHaveLength(1);
  });

  it('Stripe: every mutating call carries a key derived from the call id, so a re-run is safe', async () => {
    const { call, ledger, gateway } = setup({ provider: 'stripe', plane: { callLeaseMs: 20 } });
    const first = await call('s1', charge());
    expect(first.ok).toBe(true);
    expect(gateway.chargeCalls[0]?.input.idempotencyKey).toBe(
      hubIdempotencyKey('entre-textos', 's1'),
    );
    // The app's own key wins.
    await call('s2', charge({ idempotencyKey: 'mine' }));
    expect(gateway.chargeCalls[1]?.input.idempotencyKey).toBe('mine');
    // An interrupted Stripe call is re-run with the SAME key (Stripe answers the first result).
    await ledger.beginCall('entre-textos', 's3');
    await sleep(30);
    const rerun = await call('s3', charge());
    expect(rerun.ok).toBe(true);
    expect(gateway.chargeCalls[2]?.input.idempotencyKey).toBe(
      hubIdempotencyKey('entre-textos', 's3'),
    );
  });

  it('never injects a key into Asaas calls that refuse one', async () => {
    const { call, gateway } = setup();
    await call('a1', charge());
    expect(gateway.chargeCalls[0]?.input).not.toHaveProperty('idempotencyKey');
  });

  it('a run that outlived its lease does not overwrite or release its successor', async () => {
    const ledger = memoryTenantLedger();
    const slow = await ledger.beginCall('a', 'x');
    if (slow.state !== 'new') throw new Error('expected new');
    await sleep(15);
    const next = await ledger.beginCall('a', 'x', { leaseMs: 10 });
    if (next.state !== 'stale') throw new Error('expected stale');
    await ledger.abandonCall('a', 'x', slow.claim);
    expect(await ledger.beginCall('a', 'x', { leaseMs: 10_000 })).toEqual({ state: 'running' });
    const reply = { v: HUB_MESSAGE_VERSION, id: 'x', ok: true, result: 1 } as const;
    await ledger.finishCall('a', 'x', { ...reply, result: 'old' }, slow.claim);
    await ledger.finishCall('a', 'x', reply, next.claim);
    expect(await ledger.beginCall('a', 'x')).toEqual({ state: 'done', reply });
  });

  it('prune also removes in-flight rows of crashed runs', async () => {
    const ledger = memoryTenantLedger();
    await ledger.beginCall('a', 'crashed');
    expect((await ledger.prune(new Date(Date.now() + 1000))).calls).toBe(1);
    expect((await ledger.beginCall('a', 'crashed')).state).toBe('new');
  });

  it('managed renewals treat an indeterminate answer like an outage', () => {
    expect(isHubOutcomeUnknown(new PaymentsHubError('indeterminate', 'x'))).toBe(true);
    expect(isHubOutcomeUnknown(new PaymentsHubError('gateway', 'x'))).toBe(false);
  });
});

describe('payments control plane: one customer per account across processes', () => {
  it('two control planes racing the same account create ONE gateway customer', async () => {
    const ledger = memoryTenantLedger();
    const store = new InMemoryBillingStore();
    const gateway = new FakePaymentsDriver({ provider: 'asaas' });
    const original = gateway.createCustomer.bind(gateway);
    gateway.createCustomer = async (input) => {
      await sleep(30);
      return original(input);
    };
    const a = setup({ ledger, store, gateway });
    const b = setup({ ledger, store, gateway });
    const [x, y] = await Promise.all([
      a.et.driver.createCustomer({ name: 'Ana', account: 'sub_1' }),
      b.el.driver.createCustomer({ name: 'Ana', account: 'sub_1' }),
    ]);
    expect(gateway.createCustomerCalls).toHaveLength(1);
    expect(x.id).toBe(y.id);
    expect(await ledger.owners('customer', x.id)).toEqual(
      expect.arrayContaining(['entre-textos', 'eduliberta']),
    );
  });

  it('an expired lock (holder died) is taken over', async () => {
    const ledger = memoryTenantLedger();
    expect(await ledger.lock('k', 10)).not.toBeNull();
    expect(await ledger.lock('k', 10)).toBeNull();
    await sleep(15);
    const holder = await ledger.lock('k', 10);
    expect(holder).not.toBeNull();
    await ledger.unlock('k', holder as string);
    expect(await ledger.lock('k', 10)).not.toBeNull();
  });
});

describe('payments control plane: answers after the gateway acted', () => {
  it('a non-serializable gateway answer is sanitized, recorded and replayed, never re-run', async () => {
    const { call, gateway } = setup();
    const original = gateway.charge.bind(gateway);
    gateway.charge = async (input) => {
      const payment = (await original(input)) as unknown as Record<string, unknown>;
      payment.self = payment; // a cycle
      payment.big = 10n;
      return payment as never;
    };
    const first = await call('n1', charge());
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ gatewayId: 'pi_1', big: '10' });
    expect(await call('n1', charge())).toEqual(first);
    expect(gateway.chargeCalls).toHaveLength(1);
  });

  it('a throwing toJSON is reduced to its ids instead of failing a done charge', () => {
    const value = {
      id: 'pi_1',
      gatewayId: 'pi_1',
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(toPlainJson(value)).toEqual({ unserializable: true, id: 'pi_1', gatewayId: 'pi_1' });
    expect(toPlainJson(undefined)).toBeNull();
    const hostile = Object.defineProperty(
      {
        toJSON: () => {
          throw new Error('x');
        },
      },
      'id',
      {
        enumerable: true,
        get() {
          throw new Error('getter');
        },
      },
    );
    expect(toPlainJson(hostile)).toEqual({ unserializable: true });
  });

  it('a ledger that fails after the charge never releases the id', async () => {
    const inner = memoryTenantLedger();
    const ledger: TenantLedger = {
      ...inner,
      finishCall: async () => {
        throw new Error('db down');
      },
      claim: async () => {
        throw new Error('db down');
      },
    };
    const { call, gateway } = setup({ ledger, plane: { callLeaseMs: 60_000 } });
    const first = await call('f1', charge());
    // The charge happened: the app is told so.
    expect(first.ok).toBe(true);
    // A retry of the id does not charge again (still held, then reconciled after the lease).
    expect((await call('f1', charge())).error?.code).toBe('conflict');
    expect(gateway.chargeCalls).toHaveLength(1);
  });

  it('anything that throws after the gateway acted answers indeterminate and keeps the id', async () => {
    const { call, gateway } = setup();
    const original = gateway.charge.bind(gateway);
    gateway.charge = async (input) => {
      const payment = await original(input);
      return Object.defineProperty({ ...payment }, 'gatewayId', {
        enumerable: true,
        get() {
          throw new Error('broken getter');
        },
      }) as never;
    };
    const first = await call('g1', charge());
    expect(first.error?.code).toBe('indeterminate');
    // Recorded, not released: a retry of the id never charges a second time.
    expect(await call('g1', charge())).toEqual(first);
    expect(gateway.chargeCalls).toHaveLength(1);
  });

  it('a claim that fails after the charge does not fail the call', async () => {
    const inner = memoryTenantLedger();
    const ledger: TenantLedger = {
      ...inner,
      claim: async () => {
        throw new Error('db down');
      },
    };
    const { call, gateway } = setup({ ledger });
    const first = await call('k1', charge());
    expect(first.ok).toBe(true);
    expect(await call('k1', charge())).toEqual(first);
    expect(gateway.chargeCalls).toHaveLength(1);
  });

  it('refund(id, undefined, options) reaches the gateway without a null amount', async () => {
    const { et, gateway } = setup();
    const payment = await et.driver.charge({ amount: 500, method: 'pix' } as never);
    await et.driver.refund(payment.gatewayId, undefined, { idempotencyKey: 'r1' });
    expect(gateway.refundCalls).toEqual([{ paymentGatewayId: payment.gatewayId }]);
  });
});

describe('payments control plane: message freshness', () => {
  it('refuses a call dated ahead of the clock beyond the skew', async () => {
    const { call } = setup();
    const ahead = await call('t1', charge(), { issuedAt: Date.now() + 10 * 60 * 1000 });
    expect(ahead.error?.code).toBe('bad_request');
    expect(ahead.error?.message).toMatch(/future/);
    const within = await call('t2', charge(), { issuedAt: Date.now() + 5_000 });
    expect(within.ok).toBe(true);
  });
});

describe('payments control plane: event dedupe key', () => {
  it('hashes a long key whole instead of truncating it', () => {
    const base = 'x'.repeat(600);
    expect(eventKey('a', 'asaas', `${base}1`)).not.toBe(eventKey('a', 'asaas', `${base}2`));
    expect(eventKey('a', 'asaas', `${base}1`).length).toBeLessThanOrEqual(512);
    // A key that fits is unchanged (rows written before keep matching).
    expect(eventKey('a', 'asaas', 'evt_1')).toBe('a|asaas|evt_1');
  });
});

describe('payments control plane: routing checkout and dispute events', () => {
  const event = (id: string, data: Record<string, unknown>): WebhookEvent => ({
    id,
    provider: 'asaas',
    type: 'payment.succeeded',
    data,
    raw: { id },
  });

  async function shared() {
    const ctx = setup();
    const customer = await ctx.et.driver.createCustomer({ name: 'Ana', account: 'sub_1' });
    await ctx.el.driver.createCustomer({ name: 'Ana', account: 'sub_1' });
    return { ...ctx, customerId: customer.id };
  }

  it('routes a session event by its checkout id and learns its payment', async () => {
    const { plane, ledger, customerId } = await shared();
    await ledger.claim('entre-textos', 'checkout', 'cs_9', 'stripe');
    const routed = await plane.forward(
      event('e1', { gatewayId: 'pi_9', checkoutId: 'cs_9', customerId }),
    );
    expect(routed).toEqual(['entre-textos']);
    expect(await ledger.owners('payment', 'pi_9')).toEqual(['entre-textos']);
  });

  it('does not fan an unclaimed checkout of a shared customer out to both apps', async () => {
    const { plane, customerId } = await shared();
    expect(await plane.forward(event('e2', { sessionId: 'cs_x', customerId }))).toEqual([]);
    expect(await plane.forward(event('e3', { checkoutId: 'cs_y', customerId }))).toEqual([]);
    expect(await plane.forward(event('e4', { disputeId: 'dp_1', customerId }))).toEqual([]);
    // A customer-only event still reaches every app of the customer.
    expect((await plane.forward(event('e5', { customerId }))).sort()).toEqual([
      'eduliberta',
      'entre-textos',
    ]);
  });

  it('routes a dispute by its own id, and learns it from a claimed payment', async () => {
    const { plane, ledger, customerId } = await shared();
    await ledger.claim('eduliberta', 'dispute', 'dp_2', 'asaas');
    expect(
      await plane.forward(event('e6', { gatewayId: 'pay_u', disputeId: 'dp_2', customerId })),
    ).toEqual(['eduliberta']);
    await ledger.claim('entre-textos', 'payment', 'pay_7', 'asaas');
    expect(
      await plane.forward(event('e7', { gatewayId: 'pay_7', disputeId: 'dp_3', customerId })),
    ).toEqual(['entre-textos']);
    expect(await ledger.owners('dispute', 'dp_3')).toEqual(['entre-textos']);
  });
});

describe('payments control plane: return URLs go back to the calling app only', () => {
  const plane = {
    apps: {
      'entre-textos': { returnOrigins: [ET] },
      eduliberta: { returnOrigins: [EL, 'https://www.eduliberta.com.br'] },
    },
  } satisfies Partial<PaymentsControlPlaneOptions>;

  const checkout = (input: Record<string, unknown>) => ({
    provider: 'main',
    call: 'createCheckout',
    args: [{ amount: 1990, ...input }],
  });

  it('accepts the app’s own origins', async () => {
    const { et, el, gateway } = setup({ plane });
    await et.driver.createCheckout({
      amount: 1990,
      successUrl: `${ET}/pagamento/ok?session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${ET}/pagamento/cancelado`,
    });
    await el.driver.createCheckout({
      amount: 1990,
      successUrl: 'https://www.eduliberta.com.br/obrigado',
    });
    expect(gateway.createCheckoutCalls).toHaveLength(2);
  });

  it.each([
    ['another app’s origin', `${EL}/obrigado`],
    ['a foreign origin', 'https://evil.example/phish'],
    ['userinfo trick', `https://www.entretextosassessoria.com.br@evil.example/x`],
    ['a look-alike host', 'https://www.entretextosassessoria.com.br.evil.example/x'],
    ['plain http of the app', 'http://www.entretextosassessoria.com.br/x'],
    ['a relative path', '/pagamento/ok'],
    ['a script URL', 'javascript:alert(1)'],
  ])('refuses %s (400) and never reaches the gateway', async (_label, url) => {
    const { call, gateway } = setup({ plane });
    const answer = await call(`r-${url}`, checkout({ successUrl: url }));
    expect(answer.error?.code).toBe('bad_request');
    expect(gateway.createCheckoutCalls).toHaveLength(0);
  });

  it('checks cancelUrl, returnUrl and redirect fields hidden in metadata or nested objects', async () => {
    const { call, gateway } = setup({ plane });
    for (const [id, input] of [
      ['m1', { successUrl: `${ET}/ok`, cancelUrl: 'https://evil.example' }],
      ['m2', { successUrl: `${ET}/ok`, metadata: { returnUrl: 'https://evil.example' } }],
      [
        'm3',
        { successUrl: `${ET}/ok`, metadata: { callback: { successUrl: 'https://evil.example' } } },
      ],
      [
        'm4',
        { successUrl: `${ET}/ok`, metadata: { back_urls: { success: 'https://evil.example' } } },
      ],
      ['m5', { successUrl: `${ET}/ok`, metadata: { notification_url: 'https://evil.example' } }],
    ] as const) {
      expect((await call(id, checkout(input))).error?.code).toBe('bad_request');
    }
    expect(gateway.createCheckoutCalls).toHaveLength(0);
    const portal = await call('p1', {
      provider: 'main',
      call: 'cardUpdateUrl',
      args: [{ customerId: 'cus_x', returnUrl: 'https://evil.example' }],
    });
    expect(portal.error?.code).toBe('bad_request');
  });

  it('an app with no returnOrigins may send no return URL at all', async () => {
    const { call, gateway } = setup({ plane: { apps: ['entre-textos', 'eduliberta'] } });
    expect((await call('z1', checkout({ successUrl: `${ET}/ok` }))).error?.code).toBe(
      'bad_request',
    );
    // A call without one is unaffected.
    expect((await call('z2', charge())).ok).toBe(true);
    expect(gateway.createCheckoutCalls).toHaveLength(0);
  });

  it('takes extra origins from a resolver (e.g. the authkit client’s redirect URIs)', async () => {
    const { call, gateway } = setup({
      plane: {
        apps: { 'entre-textos': {} },
        returnOrigins: (partition) =>
          partition === 'entre-textos' ? ['https://entre-textos.up.railway.app/'] : [],
      },
    });
    const answer = await call(
      'q1',
      checkout({ successUrl: 'https://entre-textos.up.railway.app/ok' }),
    );
    expect(answer.ok).toBe(true);
    expect(gateway.createCheckoutCalls).toHaveLength(1);
  });

  it('a bad configured origin fails construction, not a payer', () => {
    expect(() =>
      createPaymentsControlPlane({
        manager: () => new PaymentsManager({ drivers: new Map() }),
        ledger: memoryTenantLedger(),
        verifyTenant: verifier(),
        apps: { 'entre-textos': { returnOrigins: ['www.entretextosassessoria.com.br'] } },
      }),
    ).toThrow(/not an http\(s\) origin/);
  });
});

describe('payments control plane: card calls only touch the calling app’s subscriptions', () => {
  /** The fake gateway, taught the three card calls (recording what reached it). */
  function withCardCalls(gateway: FakePaymentsDriver) {
    const reached: Array<{ call: string; input: unknown }> = [];
    const target = gateway as unknown as Record<string, unknown>;
    target.cardSetup = async (input: unknown) => {
      reached.push({ call: 'cardSetup', input });
      return { scripts: [], props: {} };
    };
    target.saveCard = async (input: unknown) => {
      reached.push({ call: 'saveCard', input });
      return { paymentMethodId: 'pm_1' };
    };
    target.cardUpdateUrl = async (input: unknown) => {
      reached.push({ call: 'cardUpdateUrl', input });
      return 'https://gateway.example/card';
    };
    return reached;
  }

  async function twoApps() {
    const ctx = setup();
    const reached = withCardCalls(ctx.gateway);
    const etCustomer = (await ctx.et.driver.createCustomer({ name: 'Ana' })).id;
    const etSub = (
      await ctx.et.driver.createSubscription({ customerId: etCustomer, planId: 'p', amount: 100 })
    ).gatewayId;
    const elCustomer = (await ctx.el.driver.createCustomer({ name: 'Bia' })).id;
    const elSub = (
      await ctx.el.driver.createSubscription({ customerId: elCustomer, planId: 'p', amount: 100 })
    ).gatewayId;
    return { ...ctx, reached, etCustomer, etSub, elSub };
  }

  it.each([
    ['cardSetup', 'subscriptionGatewayIds'],
    ['saveCard', 'subscriptionGatewayIds'],
  ])('%s refuses another app’s subscription anywhere in %s', async (name) => {
    const { call, reached, etCustomer, etSub, elSub } = await twoApps();
    const answer = await call(`c-${name}`, {
      provider: 'main',
      call: name,
      args: [{ customerId: etCustomer, token: 'tok', subscriptionGatewayIds: [etSub, elSub] }],
    });
    expect(answer.error?.code).toBe('not_found');
    expect(answer.error?.message).toContain(elSub);
    expect(reached).toEqual([]);
  });

  it('cardUpdateUrl refuses another app’s subscriptionGatewayId', async () => {
    const { call, reached, etCustomer, elSub } = await twoApps();
    const answer = await call('c-url', {
      provider: 'main',
      call: 'cardUpdateUrl',
      args: [{ customerId: etCustomer, subscriptionGatewayId: elSub }],
    });
    expect(answer.error?.code).toBe('not_found');
    expect(reached).toEqual([]);
  });

  it('refuses malformed subscription ids instead of skipping their check', async () => {
    const { call, reached, etCustomer, etSub } = await twoApps();
    for (const [id, input] of [
      ['b1', { customerId: etCustomer, token: 't', subscriptionGatewayIds: etSub }],
      ['b2', { customerId: etCustomer, token: 't', subscriptionGatewayIds: [etSub, 42] }],
      ['b3', { customerId: etCustomer, token: 't', subscriptionGatewayIds: [''] }],
      ['b4', { customerId: 42, token: 't' }],
    ] as const) {
      const answer = await call(id, { provider: 'main', call: 'saveCard', args: [input] });
      expect(answer.error?.code).toBe('bad_request');
    }
    const url = await call('b5', {
      provider: 'main',
      call: 'cardUpdateUrl',
      args: [{ customerId: etCustomer, subscriptionGatewayId: { $ne: 1 } }],
    });
    expect(url.error?.code).toBe('bad_request');
    expect(reached).toEqual([]);
  });

  it('lets the app move the card of its own subscriptions', async () => {
    const { et, reached, etCustomer, etSub } = await twoApps();
    await et.driver.saveCard!({
      customerId: etCustomer,
      token: 'tok',
      subscriptionGatewayIds: [etSub],
    });
    await et.driver.cardUpdateUrl!({ customerId: etCustomer, subscriptionGatewayId: etSub });
    expect(reached.map((entry) => entry.call)).toEqual(['saveCard', 'cardUpdateUrl']);
  });
});
