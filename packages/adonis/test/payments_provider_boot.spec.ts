import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import PaymentsProvider from '../providers/payments_provider.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import type { PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';
import {
  findWebhookDispatcher,
  resetPayments,
  setWebhookDispatcher,
} from '../src/services/main.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

afterEach(() => {
  resetPayments();
  setWebhookDispatcher(undefined);
});

/** An `ApplicationService` stand-in exposing only what `register()`/`boot()` touch. */
function fakeApp(config: PaymentsConfig): ApplicationService {
  const bindings = new Map<unknown, () => Promise<unknown> | unknown>();
  const app = {
    config: { get: () => config },
    booted: async (callback: () => Promise<void>) => {
      await callback();
    },
    // No `app/payment_handlers` and no generated barrel: this points at a directory that is
    // not there, which the discovery treats as "the convention is opt-in".
    makePath: (...parts: string[]) => `/nonexistent/${parts.join('/')}`,
    container: {
      singleton: (token: unknown, factory: () => unknown) => {
        bindings.set(token, factory);
      },
      bindValue: (token: unknown, value: unknown) => {
        bindings.set(token, () => value);
      },
      make: async (token: unknown) => {
        if (token === 'router') return { post: () => ({ as: () => {} }) };
        const factory = bindings.get(token);
        if (!factory) throw new Error(`nothing bound for ${String(token)}`);
        return factory();
      },
    },
  } as unknown as ApplicationService;
  return app;
}

async function boot(config: PaymentsConfig): Promise<void> {
  const provider = new PaymentsProvider(fakeApp(config));
  provider.register();
  await provider.boot();
}

const fake = () => new FakePaymentsDriver({ provider: 'fake' });

const base: PaymentsConfig = {
  providers: { fake: async () => fake() },
  billing: { store: () => new InMemoryBillingStore() },
};

describe('PaymentsProvider boot — handler registration', () => {
  it('boots with a correctly spelled handler', async () => {
    await expect(
      boot({ ...base, billing: { ...base.billing, handlers: { 'payment.succeeded': () => {} } } }),
    ).resolves.toBeUndefined();
  });

  /**
   * The bug, end to end: `'payment.suceeded'` registered a handler the processor never looked
   * up, the ledger marked the delivery processed, the route answered 200 — and the grant never
   * happened. Nothing anywhere said so.
   */
  it('REFUSES to boot on a misspelled event type', async () => {
    await expect(
      boot({ ...base, billing: { ...base.billing, handlers: { 'payment.suceeded': () => {} } } }),
    ).rejects.toThrow(/payment\.suceeded/);
  });

  it('boots when the app declares the dotted gateway type a passthrough', async () => {
    await expect(
      boot({
        ...base,
        billing: {
          ...base.billing,
          passthroughEvents: ['subscription.paused'],
          handlers: { 'subscription.paused': () => {} },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('checks the config keys even on an api-role process, which resolves no handlers', async () => {
    // The api half does not build the handlers — they run on the worker — but a misspelled
    // key is a config error on both halves, and the api process is usually the one booted
    // first.
    await expect(
      boot({
        ...base,
        billing: {
          ...base.billing,
          role: 'api',
          // An api/worker split has to have a channel between the halves; durable is it.
          dispatcher: 'durable',
          handlers: { 'payment.suceeded': () => {} },
        },
      }),
    ).rejects.toThrow(/payment\.suceeded/);
  });

  it('publishes the dispatcher so tests can await in-flight webhooks', async () => {
    await boot(base);
    expect(findWebhookDispatcher()).toBeInstanceOf(WebhookDispatcher);
  });
});

/**
 * A driver with a webhook credential SLOT and nothing in it verifies nothing — and the route
 * the library mounts is reachable from the public internet, so `POST /payments/webhook/asaas`
 * with a hand-written `PAYMENT_RECEIVED` body marked a payment paid. The app that found this
 * had to write the warning into its config, into `start/env.ts`, and into a dedicated test
 * asserting the env var was non-empty, because otherwise its two security tests passed
 * vacuously.
 */
describe('PaymentsProvider boot — webhook verification', () => {
  class Unverified extends FakePaymentsDriver {
    override readonly provider = 'asaas';
    get webhookVerification(): 'unconfigured' {
      return 'unconfigured';
    }
  }

  const unverified: PaymentsConfig = {
    providers: { asaas: async () => new Unverified({ provider: 'asaas' }) },
    billing: { store: () => new InMemoryBillingStore() },
  };

  it('REFUSES to boot when a driver that can verify has nothing to verify with', async () => {
    await expect(boot(unverified)).rejects.toThrow(/asaas.*no credential configured/s);
  });

  it('names the explicit opt-out for an app that verifies upstream', async () => {
    await expect(boot(unverified)).rejects.toThrow(/allowUnverifiedWebhooks/);
  });

  it('boots when the app opts that provider out explicitly', async () => {
    await expect(
      boot({ ...unverified, allowUnverifiedWebhooks: ['asaas'] }),
    ).resolves.toBeUndefined();
  });

  it('boots for a gateway that signs nothing at all — there is nothing to configure', async () => {
    class Unsigned extends FakePaymentsDriver {
      get webhookVerification(): 'unsupported' {
        return 'unsupported';
      }
    }
    await expect(
      boot({
        providers: { efi: async () => new Unsigned({ provider: 'efi' }) },
        billing: { store: () => new InMemoryBillingStore() },
      }),
    ).resolves.toBeUndefined();
  });

  it('still builds a working manager when everything is configured', async () => {
    const app = fakeApp(base);
    const provider = new PaymentsProvider(app);
    provider.register();
    await provider.boot();
    expect(await app.container.make(PaymentsManager)).toBeInstanceOf(PaymentsManager);
  });
});
