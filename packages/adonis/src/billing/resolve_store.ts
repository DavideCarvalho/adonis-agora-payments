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
  const factory = config.billing?.store;
  if (!factory) return new LucidBillingStore();
  return factory({ config: () => config });
}

/**
 * Whether a resolved store may be bound in the container under the
 * `LucidBillingStore` token. Binding a custom store there would make `@inject()`
 * hand back something the annotation does not describe.
 */
export function isInjectableAsLucid(store: BillingStore): store is LucidBillingStore {
  return store instanceof LucidBillingStore;
}
