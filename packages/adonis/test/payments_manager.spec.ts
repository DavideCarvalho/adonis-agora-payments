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
    expect(manager.driver('pix')).toBe(woovi);
    expect(manager.driver('credit_card')).toBe(stripe);
    expect(manager.driver('boleto')).toBe(asaas);
    // A provider name still wins over method routing.
    expect(manager.driver('stripe')).toBe(stripe);
  });

  it('throws when a routed method is not supported by the provider', () => {
    // FakePaymentsDriver supports all methods, so use a driver that is Pix-only.
    const pixOnly = new (class extends FakePaymentsDriver {
      override readonly supportedMethods = ['pix', 'undefined'] as const;
    })({ provider: 'woovi' });
    const manager = makeManager([['woovi', pixOnly]], {
      methods: { pix: 'woovi', credit_card: 'woovi' },
    });
    expect(manager.driver('pix')).toBe(pixOnly);
    expect(() => manager.driver('credit_card')).toThrow(
      /does not support payment method "credit_card"/,
    );
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
