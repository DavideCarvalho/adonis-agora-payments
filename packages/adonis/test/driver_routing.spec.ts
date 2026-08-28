import { describe, expect, it } from 'vitest';
import { PaymentsManager } from '../src/payments_manager.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';

function manager(methods?: Record<string, string>, extra?: string[]): PaymentsManager {
  const drivers = new Map<string, FakePaymentsDriver>([
    ['asaas', new FakePaymentsDriver({ provider: 'asaas' })],
  ]);
  for (const name of extra ?? []) drivers.set(name, new FakePaymentsDriver({ provider: name }));
  return new PaymentsManager({
    drivers: drivers as never,
    ...(methods !== undefined ? { methods: methods as never } : {}),
    defaultName: 'asaas',
  });
}

const charge = { amount: 1000, currency: 'brl', customerId: 'cus_1' } as const;

/**
 * `#resolveName` answered `{ name: defaultName }` with no method, so `driver()` never
 * consulted `config.methods` at all and the driver came back UNBOUND. The manager's own
 * comment names the failure it was already guarding one branch down: *"A charge routed as Pix
 * could come back a card."* The app that found this configured pix/credit_card/boleto and
 * calls `driver()` everywhere — correct only because it repeats `method:` on every charge.
 */
describe('driver() and config.methods', () => {
  it('binds the method when the routing is unambiguous', async () => {
    const payments = manager({ pix: 'asaas' });
    const driver = payments.driver();
    await driver.charge(charge);
    expect((driver as FakePaymentsDriver).chargeCalls[0]?.input.method).toBe('pix');
  });

  it('refuses a charge with no method when several route to the default provider', async () => {
    const payments = manager({ pix: 'asaas', credit_card: 'asaas', boleto: 'asaas' });
    await expect(payments.driver().charge(charge)).rejects.toThrow(
      /has no payment method and would fall back/,
    );
  });

  it('names the two ways to say what you meant', async () => {
    const payments = manager({ pix: 'asaas', credit_card: 'asaas' });
    await expect(payments.driver().charge(charge)).rejects.toThrow(/driver\('/);
  });

  it('keeps working for the app that already repeats `method:` on every charge', async () => {
    const payments = manager({ pix: 'asaas', credit_card: 'asaas', boleto: 'asaas' });
    const driver = payments.driver();
    await driver.charge({ ...charge, method: 'boleto' });
    expect((driver as FakePaymentsDriver).chargeCalls[0]?.input.method).toBe('boleto');
  });

  it('refuses a method config.methods routes to a DIFFERENT provider', async () => {
    const payments = manager({ pix: 'asaas', credit_card: 'stripe' }, ['stripe']);
    await expect(payments.driver().charge({ ...charge, method: 'credit_card' })).rejects.toThrow(
      /routes "credit_card" to "stripe"/,
    );
  });

  it('leaves an app with no routing configured exactly as it was', async () => {
    const payments = manager();
    const driver = payments.driver();
    await driver.charge(charge);
    expect((driver as FakePaymentsDriver).chargeCalls[0]?.input.method).toBeUndefined();
  });

  it('does not consult the routing map when the PROVIDER was named', async () => {
    // `driver('asaas')` already answered "which provider"; the map answers that question and
    // nothing else, so naming a provider is not overridden by it.
    const payments = manager({ pix: 'asaas', credit_card: 'asaas' });
    const driver = payments.driver('asaas');
    await driver.charge(charge);
    expect((driver as FakePaymentsDriver).chargeCalls[0]?.input.method).toBeUndefined();
  });

  it('still routes a named method the way it always did', async () => {
    const payments = manager({ pix: 'asaas', credit_card: 'asaas' });
    const driver = payments.driver('pix');
    await driver.charge(charge);
    expect((driver as FakePaymentsDriver).chargeCalls[0]?.input.method).toBe('pix');
  });
});

/**
 * `config.methods` is written in terms of the KEYS under `config.providers`, and an app is
 * free to name a provider something of its own. Every test above happens to use a key equal
 * to the driver's `provider` string, which is exactly why this went unnoticed: the routing
 * check was comparing the driver's own name against the config key, so a charge routed
 * perfectly correctly was refused.
 */
describe('a provider key that is not the driver name', () => {
  it('charges through a provider the app named itself', async () => {
    const driver = new FakePaymentsDriver();
    const manager = new PaymentsManager({
      drivers: new Map([['primary', driver]]),
      methods: { credit_card: 'primary' },
      defaultName: 'primary',
    });

    await manager.driver('credit_card').charge({ customerId: 'cus_1', amount: 1000 });

    expect(driver.chargeCalls).toHaveLength(1);
    expect(driver.chargeCalls[0]?.input.method).toBe('credit_card');
  });

  it('still refuses a method the map routes somewhere else', async () => {
    const primary = new FakePaymentsDriver();
    const backup = new FakePaymentsDriver();
    const manager = new PaymentsManager({
      drivers: new Map([
        ['primary', primary],
        ['backup', backup],
      ]),
      methods: { credit_card: 'primary', pix: 'backup' },
      defaultName: 'primary',
    });

    await expect(
      manager.driver('credit_card').charge({ customerId: 'cus_1', amount: 1000, method: 'pix' }),
    ).rejects.toThrow(/routes "pix" to "backup"/);
  });

  it('caches the bound proxy per provider AND method', async () => {
    // The proxy closes over the name the routing check compares against, so the cache is
    // keyed on `name:method`. Keyed on the method alone it would be correct only for as
    // long as one provider owns that method — a coincidence, not an invariant.
    const driver = new FakePaymentsDriver();
    const manager = new PaymentsManager({
      drivers: new Map([['primary', driver]]),
      methods: { credit_card: 'primary', pix: 'primary' },
      defaultName: 'primary',
    });

    expect(manager.driver('credit_card')).toBe(manager.driver('credit_card'));
    expect(manager.driver('credit_card')).not.toBe(manager.driver('pix'));

    await manager.driver('pix').charge({ customerId: 'cus_1', amount: 1000 });
    expect(driver.chargeCalls[0]?.input.method).toBe('pix');
  });
});
