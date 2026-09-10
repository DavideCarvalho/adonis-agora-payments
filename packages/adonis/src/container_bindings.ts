import type { BillingStore } from './billing/billing_store.js';

/**
 * Container bindings this package publishes.
 *
 * `'payments.billingStore'` exists because `BillingStore` is an interface: there is no class
 * to hand `@inject()` when the app configured a custom store. AdonisJS solves the same
 * problem the same way — `'lucid.db'` is a string alias for the `Database` singleton.
 *
 * ```ts
 * import { inject } from '@adonisjs/core'
 *
 * @inject()
 * export class Cobranca {
 *   constructor(private store: BillingStore) {}
 * }
 * ```
 *
 * WHAT THIS TOKEN DOES NOT DO, because the obvious assumption is wrong in two ways:
 *
 * 1. `container.swap()` does not take it. Swap is typed for CLASS tokens only; a string
 *    binding is replaced by re-registering it (`container.singleton('payments.billingStore',
 *    () => other)`).
 * 2. Re-registering it does not reach `PaymentsManager`. The manager receives its store as a
 *    thunk built at boot (`() => getBillingStore()`), which reads the module-level accessor
 *    on `services/main` — so `payments.arrears()` and every other manager read keep using the
 *    store the provider resolved. To substitute the store on THAT path, use
 *    `setBillingStore()` from `services/main` and restore it afterwards.
 *
 * In short: the token is for code that receives a store by injection; `setBillingStore` is
 * for code that goes through the manager.
 */
declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'payments.billingStore': BillingStore;
  }
}
