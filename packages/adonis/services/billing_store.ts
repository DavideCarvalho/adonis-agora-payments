import app from '@adonisjs/core/services/app';
import type { BillingStore } from '../src/billing/billing_store.js';

/**
 * The billing store, ready to use — same shape as {@link ../services/payments.js}.
 *
 * ```ts
 * import billingStore from '@adonis-agora/payments/services/billing_store'
 *
 * const [assinatura] = await billingStore.listSubscriptions({ externalReference: clinic.id })
 * ```
 *
 * Reads that have a manager method (`payments.arrears()`) should use it; this is for the
 * store-only surface, which `listSubscriptions` still is.
 */
let billingStore: BillingStore;

await app.booted(async () => {
  billingStore = await app.container.make('payments.billingStore');
});

export { billingStore as default };
