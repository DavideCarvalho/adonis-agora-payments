import { describe, expect, it } from 'vitest';
import { type PaymentsConfig, payments } from '../src/define_config.js';
import { PaymentsManager, resolveDrivers } from '../src/payments_manager.js';

/**
 * "This installation does not charge" as a configurable state.
 *
 * Every declared provider is built during boot and drivers validate credentials in their
 * constructor, so a provider declared without a key used to take the whole PROCESS down —
 * not payments, the process. That hits exactly the environments that never charge: CI, and
 * every developer machine. These tests pin that an absent slot is skipped before its factory
 * runs, and that asking for the missing driver still fails, at the point of use.
 */

describe('absent provider slot', () => {
  it('skips the slot without ever building the driver', async () => {
    let built = false;
    const config: PaymentsConfig = {
      providers: {
        asaas: payments.when(false, () => {
          built = true;
          return async () => ({}) as never;
        }),
      },
    };

    const drivers = await resolveDrivers(config);
    expect(drivers.size).toBe(0);
    // The point of the thunk: a disabled provider is never CONSTRUCTED, so a driver that
    // throws on a missing API key never gets the chance.
    expect(built).toBe(false);
  });

  it('builds the slot when the credential is there', async () => {
    const config: PaymentsConfig = {
      providers: {
        asaas: payments.when(true, () => async () => ({ name: 'asaas' }) as never),
      },
    };
    const drivers = await resolveDrivers(config);
    expect([...drivers.keys()]).toEqual(['asaas']);
  });

  it('a throwing factory still fails loudly when the provider IS declared', async () => {
    // The escape hatch must not become a blanket swallow: a real misconfiguration of a
    // provider the app asked for is still a boot error.
    const config: PaymentsConfig = {
      providers: {
        asaas: async () => {
          throw new Error('[payments] Asaas driver requires an API key.');
        },
      },
    };
    await expect(resolveDrivers(config)).rejects.toThrow('requires an API key');
  });

  it('an app with no drivers at all boots, and errors only when asked to charge', async () => {
    const drivers = await resolveDrivers({ providers: {} });
    const manager = new PaymentsManager({ drivers });
    expect(() => manager.driver('pix')).toThrow();
  });
});
