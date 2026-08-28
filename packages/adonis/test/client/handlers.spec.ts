import type { HttpContext } from '@adonisjs/core/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsClientConfig } from '../../src/client/define_config.js';
import { resolveConfig } from '../../src/client/define_config.js';
import { paymentStatus } from '../../src/client/handlers.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

/**
 * The guards on `GET <path>/status`.
 *
 * The failure this endpoint exists to make unwritable is IDOR: a caller passes somebody
 * else's reference and gets their payment back. It has already happened to a sibling
 * package in this ecosystem, so every case below is a real one, not a hypothetical.
 */
describe('payment status handler', () => {
  let store: InMemoryBillingStore;

  const ctx = (auth: unknown) => ({ auth }) as unknown as HttpContext;
  const anonymous = ctx({});
  const ana = ctx({ user: { id: 1 } });
  const bruno = ctx({ user: { id: 2 } });

  const call = (
    context: HttpContext,
    reference: string | undefined,
    config: PaymentsClientConfig = {},
    onDeny?: (reason: string) => void,
  ) =>
    paymentStatus(
      { store, config: resolveConfig(config), ...(onDeny ? { onDeny } : {}) },
      context,
      reference,
    );

  beforeEach(async () => {
    store = new InMemoryBillingStore();

    // Ana's payment at Asaas, and the registry mapping that proves it is hers.
    await store.saveCustomer({
      gatewayId: 'cus_ana',
      provider: 'asaas',
      ownerType: 'User',
      ownerId: '1',
    });
    await store.savePayment({
      gatewayId: 'pay_ana',
      provider: 'asaas',
      status: 'paid',
      amount: 12_345,
      currency: 'BRL',
      customerId: 'cus_ana',
      paidAt: new Date('2026-08-27T12:00:00.000Z'),
      payload: { secret: 'the raw gateway payload', card: { last4: '4242' } },
    });

    // Bruno has a mapping too, at the same gateway — so a denial below is about ownership,
    // not about one of them being unknown to the registry.
    await store.saveCustomer({
      gatewayId: 'cus_bruno',
      provider: 'asaas',
      ownerType: 'User',
      ownerId: '2',
    });
  });

  it('refuses an unauthenticated request with 401', async () => {
    const result = await call(anonymous, 'pay_ana');
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'unauthorized' });
  });

  it('refuses when authorize says no, even though an owner would resolve', async () => {
    // Pins `authorize` on its own. Ana is a perfectly resolvable owner, so the only thing
    // that can refuse her here is the first guard — and if it stopped running, the store
    // would be read for a request the app said no to.
    const spy = vi.spyOn(store, 'findPaymentByGatewayId');
    const result = await call(ana, 'pay_ana', { authorize: () => false });
    expect(result.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses when authorize passes but no owner can be resolved', async () => {
    // A real shape: a guard that authenticates a machine token with no user row behind it.
    const result = await call(ana, 'pay_ana', { authorize: () => true, owner: () => null });
    expect(result.status).toBe(401);
  });

  it('refuses a caller asking for someone ELSE s reference with 403', async () => {
    const denials: string[] = [];
    const result = await call(bruno, 'pay_ana', {}, (reason) => denials.push(reason));

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'forbidden' });
    // Not one field of Ana's payment crosses the boundary — not even the amount.
    expect(JSON.stringify(result.body)).not.toContain('12345');
    expect(denials[0]).toContain('cus_bruno');
    expect(denials[0]).toContain('cus_ana');
  });

  it('answers the rightful owner with the four-field shape and nothing else', async () => {
    const result = await call(ana, 'pay_ana');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'paid',
      amount: 12_345,
      currency: 'BRL',
      paidAt: '2026-08-27T12:00:00.000Z',
    });
    // The keys are the whole contract: a column added to `billing_payments` later must not
    // start appearing in a browser because nobody remembered to exclude it.
    expect(Object.keys(result.body as object).sort()).toEqual([
      'amount',
      'currency',
      'paidAt',
      'status',
    ]);
  });

  it('never carries the stored gateway payload', async () => {
    const result = await call(ana, 'pay_ana');
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('the raw gateway payload');
    expect(serialized).not.toContain('4242');
    expect(serialized).not.toContain('cus_ana');
  });

  it('DENIES when the app never recorded a customer mapping, and says why', async () => {
    // The common case for an app that adopted payments before the registry existed. The
    // opposite choice — allow when nothing is known — hands every payment to every user.
    const empty = new InMemoryBillingStore();
    await empty.savePayment({
      gatewayId: 'pay_orphan',
      provider: 'asaas',
      status: 'paid',
      amount: 100,
      currency: 'BRL',
      customerId: 'cus_ana',
    });
    const denials: string[] = [];
    const result = await paymentStatus(
      { store: empty, config: resolveConfig(), onDeny: (reason) => denials.push(reason) },
      ana,
      'pay_orphan',
    );

    expect(result.status).toBe(403);
    expect(denials[0]).toContain('ensureCustomer');
    expect(denials[0]).toContain('authorizeReference');
  });

  it('denies a payment with no customer at all', async () => {
    await store.savePayment({
      gatewayId: 'pay_anonymous',
      provider: 'asaas',
      status: 'paid',
      amount: 500,
      currency: 'BRL',
    });
    expect((await call(ana, 'pay_anonymous')).status).toBe(403);
  });

  it('keeps the same owner s customers at different gateways apart', async () => {
    // Ana holds `cus_ana` at asaas and nothing at woovi. A guard that ignored `provider`
    // would hand her any woovi payment whose customer happened to be `cus_ana`.
    await store.savePayment({
      gatewayId: 'pay_woovi',
      provider: 'woovi',
      status: 'paid',
      amount: 700,
      currency: 'BRL',
      customerId: 'cus_ana',
    });
    expect((await call(ana, 'pay_woovi')).status).toBe(403);
  });

  it('answers 404 for a reference with no payment row, which is a Pix that is not paid yet', async () => {
    // `billing_payments` is written by the webhook, so a fresh charge has no row. The hook
    // keeps polling on this one — it is the waiting state, not a failure.
    const result = await call(ana, 'pay_nope');
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'unknown reference' });
  });

  it('requires a reference', async () => {
    expect((await call(ana, undefined)).status).toBe(400);
    expect((await call(ana, '   ')).status).toBe(400);
  });

  it('runs the caller checks BEFORE it looks at the reference', async () => {
    // The whole design rule in one assertion: an anonymous request must not be able to
    // learn whether a reference exists, so the store is never touched for one.
    const spy = vi.spyOn(store, 'findPaymentByGatewayId');
    expect((await call(anonymous, 'pay_ana')).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('uses a custom authorizeReference and never hands it the payment', async () => {
    const seen: unknown[][] = [];
    const config: PaymentsClientConfig = {
      authorizeReference: (...args) => {
        seen.push(args);
        return args[1] === 'pay_ana';
      },
    };

    // Bruno now passes, because the app said so — the registry is not consulted at all.
    expect((await call(bruno, 'pay_ana', config)).status).toBe(200);
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]?.[1]).toBe('pay_ana');

    await store.savePayment({
      gatewayId: 'pay_other',
      provider: 'asaas',
      status: 'paid',
      amount: 1,
      currency: 'BRL',
      customerId: 'cus_bruno',
    });
    expect((await call(bruno, 'pay_other', config)).status).toBe(403);
  });

  it('maps an app-side reference onto the gateway id, with the guard still running', async () => {
    const config: PaymentsClientConfig = {
      resolveReference: (_ctx, reference) => (reference === 'order-1' ? 'pay_ana' : null),
    };
    expect((await call(ana, 'order-1', config)).status).toBe(200);
    // A mapping that resolves is not a mapping that authorizes: Bruno still gets a 403.
    expect((await call(bruno, 'order-1', config)).status).toBe(403);
    // An unknown app-side reference is a 404, like an unknown gateway id.
    expect((await call(ana, 'order-2', config)).status).toBe(404);
  });

  it('reads bigint amounts and Luxon timestamps off a store row', async () => {
    // The Lucid store hands back `amount` as a string (Postgres bigint) and `paidAt` as a
    // Luxon DateTime. Reading either straight through produces `"12345"` or `{}` on the wire.
    const lucidish = {
      async findPaymentByGatewayId() {
        return {
          gatewayId: 'pay_lucid',
          provider: 'asaas',
          status: 'paid',
          amount: '98765',
          currency: 'BRL',
          customerId: 'cus_ana',
          paidAt: { toJSDate: () => new Date('2026-01-02T03:04:05.000Z') },
        };
      },
      findCustomerByOwner: store.findCustomerByOwner.bind(store),
    } as never;

    const result = await paymentStatus(
      { store: lucidish, config: resolveConfig() },
      ana,
      'pay_lucid',
    );
    expect(result.body).toEqual({
      status: 'paid',
      amount: 98_765,
      currency: 'BRL',
      paidAt: '2026-01-02T03:04:05.000Z',
    });
  });
});
