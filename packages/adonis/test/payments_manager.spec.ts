import { describe, expect, it } from 'vitest';
import { PaymentsManager, defineConfig, resolveDrivers } from '../src/index.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';

function makeManager(
  drivers: [string, FakePaymentsDriver][],
  opts: Partial<ConstructorParameters<typeof PaymentsManager>[0]> = {},
) {
  return new PaymentsManager({ drivers: new Map(drivers), ...opts });
}

describe('PaymentsManager', () => {
  it('resolves a named driver', () => {
    const driver = new FakePaymentsDriver({ provider: 'stripe' });
    const manager = makeManager([['stripe', driver]]);
    expect(manager.driver('stripe')).toBe(driver);
    expect(manager.driver().provider).toBe('stripe');
  });

  it('falls back to the default driver when no name is given', () => {
    const a = new FakePaymentsDriver({ provider: 'a' });
    const b = new FakePaymentsDriver({ provider: 'b' });
    const manager = makeManager([
      ['a', a],
      ['b', b],
    ]);
    expect(manager.driver()).toBe(a);
  });

  it('uses the configured default name over the first driver', () => {
    const a = new FakePaymentsDriver({ provider: 'a' });
    const b = new FakePaymentsDriver({ provider: 'b' });
    const manager = makeManager(
      [
        ['a', a],
        ['b', b],
      ],
      { defaultName: 'b' },
    );
    expect(manager.driver()).toBe(b);
  });

  it('routes a payment method to its configured provider', () => {
    const woovi = new FakePaymentsDriver({ provider: 'woovi' });
    const stripe = new FakePaymentsDriver({ provider: 'stripe' });
    const asaas = new FakePaymentsDriver({ provider: 'asaas' });
    const manager = makeManager(
      [
        ['woovi', woovi],
        ['stripe', stripe],
        ['asaas', asaas],
      ],
      {
        methods: { pix: 'woovi', credit_card: 'stripe', boleto: 'asaas' },
      },
    );
    // Routed by METHOD, so what comes back is the driver bound to that method — the same
    // provider, not the same object. `provider` is the identity that matters to a caller.
    expect(manager.driver('pix').provider).toBe('woovi');
    expect(manager.driver('credit_card').provider).toBe('stripe');
    expect(manager.driver('boleto').provider).toBe('asaas');
    // Routed by NAME: nothing to thread, so the driver comes back untouched.
    expect(manager.driver('stripe')).toBe(stripe);
    // Stable across calls, so a caller can hold on to one.
    expect(manager.driver('pix')).toBe(manager.driver('pix'));
  });

  it('throws when a routed method is not supported by the provider', () => {
    // FakePaymentsDriver supports all methods, so use a driver that is Pix-only.
    const pixOnly = new (class extends FakePaymentsDriver {
      override readonly supportedMethods = ['pix', 'undefined'] as const;
    })({ provider: 'woovi' });
    const manager = makeManager([['woovi', pixOnly]], {
      methods: { pix: 'woovi', credit_card: 'woovi' },
    });
    expect(manager.driver('pix').provider).toBe('woovi');
    expect(() => manager.driver('credit_card')).toThrow(
      /does not support payment method "credit_card"/,
    );
  });

  /**
   * `payments.driver('pix')` picked the provider and then told it nothing. Every driver that
   * varies by method reads it off the charge — Stripe's `payment_method_types`, Asaas' and
   * AbacatePay's `billingType` — so a charge routed as Pix was created with whatever the
   * gateway's dashboard defaults are. It read as working, and came back a card.
   */
  it('threads the routed method into the charge', async () => {
    const woovi = new FakePaymentsDriver({ provider: 'woovi' });
    const seen: unknown[] = [];
    woovi.charge = async (input) => {
      seen.push(input.method);
      return {
        id: 'p1',
        gatewayId: 'p1',
        provider: 'woovi',
        amount: { amount: input.amount, currency: 'brl' },
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
      };
    };
    const manager = makeManager([['woovi', woovi]], { methods: { pix: 'woovi' } });

    await manager.driver('pix').charge({ amount: 1990 });
    expect(seen).toEqual(['pix']);
  });

  it('lets an explicit method on the charge win over the routed one', async () => {
    // Routing is a default, not an override: a caller who names a method meant it.
    const asaas = new FakePaymentsDriver({ provider: 'asaas' });
    const seen: unknown[] = [];
    asaas.charge = async (input) => {
      seen.push(input.method);
      return {
        id: 'p1',
        gatewayId: 'p1',
        provider: 'asaas',
        amount: { amount: input.amount, currency: 'brl' },
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
      };
    };
    const manager = makeManager([['asaas', asaas]], { methods: { pix: 'asaas' } });

    await manager.driver('pix').charge({ amount: 1990, method: 'boleto' });
    expect(seen).toEqual(['boleto']);
  });

  it('does not fabricate members the driver does not have', () => {
    // The contract has optional members and callers test for them with `typeof x ===
    // "function"`. A wrapper that defines everything turns "this gateway cannot do that"
    // into "it can, until you call it".
    const woovi = new FakePaymentsDriver({ provider: 'woovi' });
    const manager = makeManager([['woovi', woovi]], { methods: { pix: 'woovi' } });
    const routed = manager.driver('pix');
    expect(typeof (routed as { findDispute?: unknown }).findDispute).toBe(
      typeof (woovi as { findDispute?: unknown }).findDispute,
    );
    expect(routed.supportedMethods).toEqual(woovi.supportedMethods);
  });

  it('throws a clear error for an unknown driver', () => {
    const manager = makeManager([['stripe', new FakePaymentsDriver()]]);
    expect(() => manager.driver('nope')).toThrow(/not configured|neither a configured provider/);
  });

  it('throws when no drivers are configured', () => {
    expect(() => makeManager([]).driver()).toThrow(/No drivers configured/);
  });

  it('resolves drivers from config factories', async () => {
    const config = defineConfig({
      default: 'fake',
      providers: {
        fake: () => Promise.resolve(new FakePaymentsDriver({ provider: 'fake' })),
      },
    });
    const map = await resolveDrivers(config);
    expect(map.size).toBe(1);
    expect(map.get('fake')!.provider).toBe('fake');
  });
});

describe('assertCapability', () => {
  const driverWith = (capabilities: Record<string, boolean>) =>
    ({ provider: 'testing', capabilities }) as unknown as PaymentsDriver;

  it('names only the capabilities that are actually supported', () => {
    const manager = new PaymentsManager({
      drivers: new Map([['testing', driverWith({ refunds: true, invoices: false })]]),
    });
    const driver = manager.driver('testing');

    let message = '';
    try {
      manager.assertCapability(driver, 'invoices');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('does not support invoices');
    // The bug this pins: listing every KEY told a driver that spells out
    // `{ invoices: false }` that invoices were among its supported capabilities.
    expect(message).toContain('Supported capabilities: refunds.');
    expect(message).not.toContain('refunds, invoices');
  });

  it('says "(none)" when a driver supports nothing beyond the core contract', () => {
    const manager = new PaymentsManager({
      drivers: new Map([['testing', driverWith({ refunds: false, subscriptions: false })]]),
    });
    let message = '';
    try {
      manager.assertCapability(manager.driver('testing'), 'refunds');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Supported capabilities: (none).');
  });
});
