import type { BillingStore } from './billing/billing_store.js';

/**
 * Container bindings this package publishes.
 *
 * `'payments.billingStore'` exists because `BillingStore` is an interface: there is no class
 * to hand `@inject()` when the app configured a custom store. AdonisJS solves the same
 * problem the same way — `'lucid.db'` is a string alias for the `Database` singleton — and it
 * is what makes the store swappable in tests through the container rather than through a
 * package-specific setter.
 *
 * ```ts
 * import { inject } from '@adonisjs/core'
 *
 * @inject()
 * export class Cobranca {
 *   constructor(private store: BillingStore) {}
 * }
 *
 * // in a test
 * app.container.swap('payments.billingStore', () => new InMemoryBillingStore())
 * ```
 */
declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'payments.billingStore': BillingStore;
  }
}
