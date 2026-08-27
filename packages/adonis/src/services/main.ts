import type { BillingStore } from '../billing/billing_store.js';
import { PaymentsManager } from '../payments_manager.js';

/**
 * Lazy singleton accessor for the payments manager. Set by the provider when it builds
 * the manager; importing this module never triggers the app boot (media/authkit pattern).
 */
let payments: PaymentsManager | undefined;

export function getPayments(): PaymentsManager {
  if (!payments) {
    throw new Error(
      '[payments] PaymentsManager is not ready yet. Make sure the PaymentsProvider is registered and the app has booted.',
    );
  }
  return payments;
}

/** Set by the provider once the manager is built. */
export function setPayments(manager: PaymentsManager): void {
  payments = manager;
}

/**
 * The billing store the provider resolved from `config.billing.store` — the Lucid
 * store over the published tables unless the app configured another one.
 *
 * `@inject()`-ing `LucidBillingStore` covers the default case; this accessor is what
 * reaches a **custom** store, which has no class to use as a DI token.
 */
let billingStore: BillingStore | undefined;

export function getBillingStore(): BillingStore {
  if (!billingStore) {
    throw new Error(
      '[payments] The billing store is not ready yet. Make sure the PaymentsProvider is registered, the app has booted, and `billing.enabled` is not false.',
    );
  }
  return billingStore;
}

/** Set by the provider once the store is resolved. */
export function setBillingStore(store: BillingStore): void {
  billingStore = store;
}

export default getPayments;
