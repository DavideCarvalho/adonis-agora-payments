import app from '@adonisjs/core/services/app';
import type { PaymentsManager } from '../src/payments_manager.js';

/**
 * The payments manager, ready to use — the shape every first-party AdonisJS package hands
 * you (`@adonisjs/lucid/services/db`, `@adonisjs/drive/services/main`, `@adonisjs/mail`).
 *
 * ```ts
 * import payments from '@adonis-agora/payments/services/payments'
 *
 * const status = await payments.arrears({ externalReference: clinic.id })
 * ```
 *
 * WHY THIS EXISTS ALONGSIDE `services/main`. That module exports `getPayments()`, a getter
 * fed by a `setPayments()` push from the provider. It works, but it is not how an Adonis app
 * reads a service: you import the thing, you do not call a function to fetch the thing. It
 * also meant the container binding was decorative — nothing resolved through it, so nothing
 * could be substituted through it either.
 *
 * Here the container is the source: `app.booted()` resolves `'payments.manager'`, exactly as
 * Lucid's `services/db` resolves `Database`. Rebinding that token in a test now actually
 * changes what application code gets.
 *
 * `services/main` keeps its named accessors — the library's own providers and testing
 * helpers import them, and they must work before the app is booted, which top-level `await
 * app.booted()` cannot do.
 */
let payments: PaymentsManager;

await app.booted(async () => {
  payments = await app.container.make('payments.manager');
});

export { payments as default };
