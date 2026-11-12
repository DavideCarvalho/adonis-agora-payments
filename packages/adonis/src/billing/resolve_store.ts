import type { PaymentsConfig } from '../define_config.js';
import type { BillingStore } from './billing_store.js';
import { LucidBillingStore } from './lucid_billing_store.js';
import { assertBillingSchemaName } from './schema.js';

/**
 * The billing store for a config: `billing.store` when the app declared one,
 * otherwise the Lucid store over the published tables.
 *
 * Extracted from the provider so the default, the override and the DI-token rule
 * below are covered by tests that run the real thing rather than a copy of it.
 */
export async function resolveBillingStore(config: PaymentsConfig): Promise<BillingStore> {
  const autoCreateSchema = config.billing?.autoCreateSchema !== false;
  const connection = config.billing?.connection;
  const schema = config.billing?.schema;
  if (schema !== undefined) assertBillingSchemaName(schema);
  const factory = config.billing?.store;
  if (!factory) {
    const store = new LucidBillingStore(
      {},
      {
        autoCreateSchema,
        ...(connection !== undefined ? { connection } : {}),
        ...(schema !== undefined ? { schema } : {}),
      },
    );
    // A schema the connection cannot hold (SQLite) fails the boot, not the first payment.
    store.assertDatabase();
    return store;
  }

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
  if (store instanceof LucidBillingStore) {
    // `billingStores.lucid(...)` inherits `billing.schema`; a store built by hand takes its own
    // options. One that disagrees with the config would put the tables somewhere the config,
    // the docs and `agora:doctor` do not look — refused rather than guessed between.
    if (schema !== undefined && store.database.schema !== schema) {
      throw new Error(
        `[@adonis-agora/payments] billing.schema is "${schema}" but billing.store built a LucidBillingStore with ${store.database.schema === undefined ? 'no schema' : `schema "${store.database.schema}"`}. Use billingStores.lucid({ models }) (it inherits billing.schema), or pass the same schema to the store.`,
      );
    }
    store.assertDatabase();
  }
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
