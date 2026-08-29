import type { PaymentsConfig } from '../define_config.js';
import type { BillingStore } from './billing_store.js';
import { LucidBillingStore } from './lucid_billing_store.js';

/**
 * The billing store for a config: `billing.store` when the app declared one,
 * otherwise the Lucid store over the published tables.
 *
 * Extracted from the provider so the default, the override and the DI-token rule
 * below are covered by tests that run the real thing rather than a copy of it.
 */
export async function resolveBillingStore(config: PaymentsConfig): Promise<BillingStore> {
  const autoCreateSchema = config.billing?.autoCreateSchema !== false;
  const factory = config.billing?.store;
  if (!factory) return new LucidBillingStore({}, { autoCreateSchema });

  const store = await factory({ config: () => config });
  // The flag has to reach a store the APP built too. `billing.store` is how an app swaps in
  // its own models — `() => lucidBillingStore({ paymentModel: MyPayment })` — and that store
  // is constructed before the provider ever reads the config, so it defaults to creating
  // tables. Skipping it here would run DDL against exactly the shared database
  // `autoCreateSchema: false` was set to protect.
  //
  // Only ever turned OFF: a store the app built and configured itself is not something to
  // switch schema creation ON for behind its back.
  if (!autoCreateSchema && store instanceof LucidBillingStore) store.disableAutoCreateSchema();
  return store;
}

/**
 * Whether a resolved store may be bound in the container under the
 * `LucidBillingStore` token. Binding a custom store there would make `@inject()`
 * hand back something the annotation does not describe.
 */
export function isInjectableAsLucid(store: BillingStore): store is LucidBillingStore {
  return store instanceof LucidBillingStore;
}
