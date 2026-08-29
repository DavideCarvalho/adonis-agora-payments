import type { HttpContext } from '@adonisjs/core/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import type { PaymentsClientConfig } from '../../src/client/define_config.js';
import { resolveConfig } from '../../src/client/define_config.js';
import { paymentStatus } from '../../src/client/handlers.js';
import type { PaymentsDriver } from '../../src/driver.js';
import { ensureCustomer } from '../../src/ensure_customer.js';
import { type IntegrationDatabase, createIntegrationDatabase } from './harness.js';

/**
 * The browser-facing status endpoint against a real Postgres, on the real published
 * migration.
 *
 * The unit suite drives the same handler through `InMemoryBillingStore`, which is a
 * hand-written reimplementation of the store contract — it proves the guards branch
 * correctly and nothing about whether the SQL underneath them is valid. That gap matters
 * more here than anywhere else in this package: the default ownership check is a
 * `findCustomerByOwner` query over `billing_customers`, and a query that silently returns
 * `null` against a real database would turn every allowed request into a `403` — while a
 * query that silently matched the WRONG row would hand one customer's payment to another.
 * Both are invisible to a test that never touches SQL.
 *
 * The mapping here is written by `ensureCustomer(..., { store, owner })` on purpose: that
 * is the one path the docs tell apps to use, so this also proves the documented setup
 * produces a registry the guard can actually read.
 */
describe('payments client status endpoint (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  const ctx = (auth: unknown) => ({ auth }) as unknown as HttpContext;
  const anonymous = ctx({});
  const ana = ctx({ user: { id: 1 } });
  const bruno = ctx({ user: { id: 2 } });
  const carla = ctx({ user: { id: 3 } });

  const call = (
    context: HttpContext,
    reference: string,
    config: PaymentsClientConfig = {},
    onDeny?: (reason: string) => void,
  ) =>
    paymentStatus(
      { store, config: resolveConfig(config), ...(onDeny ? { onDeny } : {}) },
      context,
      reference,
    );

  const driver = (id: string, provider: string) =>
    ({ provider, createCustomer: async () => ({ id }) }) as unknown as PaymentsDriver;

  beforeAll(async () => {
    database = await createIntegrationDatabase('payments_client_spec');
    store = new LucidBillingStore();

    // Ana and Bruno each hold a customer at asaas, recorded the documented way.
    await ensureCustomer(
      driver('cus_ana', 'asaas'),
      undefined,
      { name: 'Ana' },
      {
        store,
        owner: { type: 'User', id: 1 },
      },
    );
    await ensureCustomer(
      driver('cus_bruno', 'asaas'),
      undefined,
      { name: 'Bruno' },
      {
        store,
        owner: { type: 'User', id: 2 },
      },
    );
    // Carla is a real user who was never put through `ensureCustomer` — the common state of
    // an app that adopted payments before the customer registry existed.

    await store.savePayment({
      gatewayId: 'pay_ana',
      provider: 'asaas',
      status: 'paid',
      // A nine-digit amount, so a `bigint` that comes back from Postgres as a STRING and is
      // passed through unconverted fails here rather than shipping `"1234500"` to a browser.
      amount: 1_234_500,
      currency: 'BRL',
      customerId: 'cus_ana',
      paidAt: new Date('2026-08-27T12:00:00.000Z'),
      payload: { pix: { qr: 'BR-CODE' }, card: { last4: '4242' }, secret: 'raw gateway payload' },
    });
    await store.savePayment({
      gatewayId: 'pay_pending',
      provider: 'asaas',
      status: 'pending',
      amount: 999,
      currency: 'BRL',
      customerId: 'cus_ana',
    });
  });

  afterAll(async () => {
    await database?.teardown();
  });

  it('refuses an unauthenticated request', async () => {
    const result = await call(anonymous, 'pay_ana');
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'unauthorized' });
  });

  it('refuses when authorize says no, even though an owner would resolve', async () => {
    // Ana is mapped and owns `pay_ana`; only the first guard can refuse her.
    expect((await call(ana, 'pay_ana', { authorize: () => false })).status).toBe(401);
  });

  it('refuses a caller asking for someone else s reference', async () => {
    const denials: string[] = [];
    const result = await call(bruno, 'pay_ana', {}, (reason) => denials.push(reason));

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'forbidden' });
    // Bruno IS in the registry — this is a genuine ownership denial, not a lookup miss.
    expect(denials[0]).toContain('cus_bruno');
  });

  it('answers the rightful owner with the minimal shape', async () => {
    const result = await call(ana, 'pay_ana');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'paid',
      amount: 1_234_500,
      currency: 'BRL',
      paidAt: '2026-08-27T12:00:00.000Z',
    });
    expect(typeof (result.body as { amount: unknown }).amount).toBe('number');
  });

  it('carries no payload, no customer and no gateway ids', async () => {
    const serialized = JSON.stringify((await call(ana, 'pay_ana')).body);
    for (const leak of [
      'payload',
      'raw gateway payload',
      '4242',
      'BR-CODE',
      'cus_ana',
      'pay_ana',
    ]) {
      expect(serialized, leak).not.toContain(leak);
    }
    expect(Object.keys((await call(ana, 'pay_ana')).body as object).sort()).toEqual([
      'amount',
      'currency',
      'paidAt',
      'status',
    ]);
  });

  it('reports a charge that has not settled without a paidAt', async () => {
    expect((await call(ana, 'pay_pending')).body).toEqual({
      status: 'pending',
      amount: 999,
      currency: 'BRL',
      paidAt: null,
    });
  });

  it('DENIES a caller the app never mapped, rather than allowing them', async () => {
    const denials: string[] = [];
    const result = await call(carla, 'pay_ana', {}, (reason) => denials.push(reason));

    expect(result.status).toBe(403);
    // And says what to do about it, because a silent 403 on every poll is unloggable.
    expect(denials[0]).toContain('ensureCustomer');
    expect(denials[0]).toContain('authorizeReference');
  });

  it('answers 404 for a reference with no row yet', async () => {
    // The ordinary state of a Pix nobody has paid: the webhook writes `billing_payments`.
    expect((await call(ana, 'pay_never_charged')).status).toBe(404);
  });

  it('lets an app own the rules with its own authorizeReference', async () => {
    // Carla has no registry mapping, and the app says she may see this payment anyway —
    // which is exactly the tier-2 escape hatch, proven against real SQL.
    const config: PaymentsClientConfig = {
      authorizeReference: (_ctx, reference) => reference === 'pay_ana',
    };
    expect((await call(carla, 'pay_ana', config)).status).toBe(200);
    expect((await call(carla, 'pay_pending', config)).status).toBe(403);
  });
});
