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
 * 3. publishes `config/payments.ts` + `config/payments_dashboard.ts`;
 * 4. publishes the Lucid migrations for the billing tables (run `node ace migration:run`;
 *    delete the file if you only use payments without the billing layer);
 * 5. registers the env validations for the payment providers.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  // biome-ignore lint/suspicious/noExplicitAny: `createCodemods` types the callback; matching media.
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('@adonis-agora/payments/payments_provider');
    rcFile.addProvider('@adonis-agora/payments/dashboard_provider');
    rcFile.addCommand('@adonis-agora/payments/commands');
    rcFile.addAssemblerHook('init', '@adonis-agora/payments/hooks/webhook_handlers');
  });

  const stubs = stubsRoot();
  await codemods.makeUsingStub(stubs, 'config/payments.stub', {});
  await codemods.makeUsingStub(stubs, 'config/payments_dashboard.stub', {});
  await codemods.makeUsingStub(stubs, 'database/migrations/create_billing_tables.stub', {});

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
