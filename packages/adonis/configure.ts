import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/payments` — auto-wires the package:
 *
 * 1. registers the payments service provider in `adonisrc.ts`, plus the optional
 *    dashboard provider;
 * 2. registers the Assembler `init` hook that generates the `app/payment_handlers/`
 *    barrel (discovery works without it — the provider falls back to a runtime scan —
 *    but the barrel removes that scan from boot);
 * 3. publishes `config/payments.ts`, `config/payments_dashboard.ts` and
 *    `config/payments_client.ts` (the browser status endpoint — off unless enabled);
 * 4. publishes the Lucid migrations for the billing tables — the `create_billing_tables` one,
 *    the `add_billing_external_reference` one that carries the two columns added after it, and
 *    the `add_billing_disputes` one that carries the `billing_disputes` table (run
 *    `node ace migration:run`; delete all three files if you only use payments without the
 *    billing layer);
 * 5. registers the env validations for the payment providers.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  // biome-ignore lint/suspicious/noExplicitAny: `createCodemods` types the callback; matching media.
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('@adonis-agora/payments/payments_provider');
    rcFile.addProvider('@adonis-agora/payments/dashboard_provider');
    rcFile.addProvider('@adonis-agora/payments/payments_client_provider');
    rcFile.addCommand('@adonis-agora/payments/commands');
    rcFile.addAssemblerHook('init', '@adonis-agora/payments/hooks/webhook_handlers');
  });

  const stubs = stubsRoot();
  await codemods.makeUsingStub(stubs, 'config/payments.stub', {});
  await codemods.makeUsingStub(stubs, 'config/payments_dashboard.stub', {});
  await codemods.makeUsingStub(stubs, 'config/payments_client.stub', {});
  await codemods.makeUsingStub(stubs, 'database/migrations/create_billing_tables.stub', {});
  // Published alongside the first, not instead of it: `create_billing_tables` has already run
  // in every existing install, so the two columns it now declares reach those installs only as
  // a separate migration. A fresh install gets both files and the second finds nothing to do —
  // every step in it is guarded by `hasColumn`.
  await codemods.makeUsingStub(
    stubs,
    'database/migrations/add_billing_external_reference.stub',
    {},
  );
  // The third, same reasoning again: `billing_disputes` is a whole TABLE added after
  // `create_billing_tables` shipped, so it reaches existing installs only as its own file.
  // Guarded by `hasTable`, so on a fresh install (which gets all three) it does nothing.
  await codemods.makeUsingStub(stubs, 'database/migrations/add_billing_disputes.stub', {});

  await codemods.defineEnvValidations({
    leadingComment: 'PAYMENTS_',
    variables: {
      STRIPE_KEY: 'Env.schema.string.optional()',
      STRIPE_WEBHOOK_SECRET: 'Env.schema.string.optional()',
      ABACATE_API_KEY: 'Env.schema.string.optional()',
      ABACATE_PUBLIC_KEY: 'Env.schema.string.optional()',
      ASAAS_API_KEY: 'Env.schema.string.optional()',
      WOOVI_APP_ID: 'Env.schema.string.optional()',
      FOCUS_NFE_TOKEN: 'Env.schema.string.optional()',
      PAYMENTS_DASHBOARD_TOKEN: 'Env.schema.string.optional()',
    },
  });
}
