import { describe, expect, it, vi } from 'vitest';
import { LucidBillingStore, lucidBillingStore } from '../src/billing/lucid_billing_store.js';
import { isInjectableAsLucid, resolveBillingStore } from '../src/billing/resolve_store.js';
import { billingStores } from '../src/define_config.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * `config.billing.store` is the seam that decides where the billing layer
 * persists. It has to survive the trip through the provider — and the default
 * has to stay injectable, because a store you can only reach by constructing it
 * yourself is not an Adonis-shaped dependency.
 */
describe('billingStores.lucid', () => {
  it('builds a Lucid store', async () => {
    const store = await billingStores.lucid()({ config: () => ({}) });
    expect(store).toBeInstanceOf(LucidBillingStore);
  });

  it('passes the app models through', async () => {
    class MyUsageEvent {}
    const store = await billingStores.lucid({
      models: { usageEventModel: MyUsageEvent as never },
    })({ config: () => ({}) });
    expect(store).toBeInstanceOf(LucidBillingStore);
  });
});

describe('resolveBillingStore — the function the provider calls', () => {
  it('defaults to Lucid when the config says nothing', async () => {
    expect(await resolveBillingStore({})).toBeInstanceOf(LucidBillingStore);
  });

  it('uses the configured factory when there is one', async () => {
    const custom = new InMemoryBillingStore();
    const store = await resolveBillingStore({ billing: { store: () => custom } });
    expect(store).toBe(custom);
  });

  it('hands the factory the app config', async () => {
    let seen: unknown;
    const config = {
      default: 'asaas',
      billing: {
        store: (ctx) => {
          seen = ctx.config();
          return new InMemoryBillingStore();
        },
      },
    };
    await resolveBillingStore(config as never);
    expect(seen).toBe(config);
  });

  it('only treats a Lucid store as injectable under the LucidBillingStore token', async () => {
    // Binding a custom store under the Lucid class would make `@inject()` hand
    // back something the annotation does not describe.
    expect(isInjectableAsLucid(await resolveBillingStore({}))).toBe(true);
    expect(
      isInjectableAsLucid(
        await resolveBillingStore({ billing: { store: () => new InMemoryBillingStore() } }),
      ),
    ).toBe(false);
  });
});

describe('autoCreateSchema reaches a store the app built', () => {
  it('turns it off on a store from billing.store, not just the default one', async () => {
    // `billing.store` is how an app swaps its own models in, and that store is constructed
    // before the provider reads the config — so the flag has to be applied afterwards.
    // Skipping it here would run DDL against exactly the shared database the flag was set
    // to protect.
    const store = await resolveBillingStore({
      billing: { autoCreateSchema: false, store: () => lucidBillingStore({}) },
    } as never);

    const ensure = vi.spyOn(store as LucidBillingStore, 'ensureSchema').mockResolvedValue();
    try {
      await (store as LucidBillingStore).findPaymentByGatewayId('pi_1');
    } catch {
      // expected — no connection configured
    }
    expect(ensure).not.toHaveBeenCalled();
  });

  it('leaves an app-built store creating tables by default', async () => {
    const store = await resolveBillingStore({
      billing: { store: () => lucidBillingStore({}) },
    } as never);

    const ensure = vi.spyOn(store as LucidBillingStore, 'ensureSchema').mockResolvedValue();
    try {
      await (store as LucidBillingStore).findPaymentByGatewayId('pi_1');
    } catch {
      // expected — no connection configured
    }
    expect(ensure).toHaveBeenCalled();
  });
});
