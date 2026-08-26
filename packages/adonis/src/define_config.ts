import type { PaymentsDriver } from './driver.js';
import type { InvoiceProvider } from './invoice/invoice_provider.js';
import type { InvoiceOptions, PaymentMethodName } from './types.js';

/**
 * A lazy factory that builds a {@link PaymentsDriver}. Each driver factory imports its
 * peer dependency (the Stripe SDK, etc.) lazily inside the thunk, so it only loads when
 * that driver is actually selected — making every gateway SDK an optional peer.
 */
export type PaymentsDriverFactory = (ctx: PaymentsContext) => Promise<PaymentsDriver>;

/** A lazy factory that builds an {@link InvoiceProvider} (Focus, Tecnospeed, eNotas, PlugNotas). */
export type InvoiceProviderFactory = (ctx: InvoiceContext) => Promise<InvoiceProvider>;

/** Context handed to driver factories when the provider resolves them. */
export interface PaymentsContext {
  /** Lazy import of the package's own config (circular-import safe). */
  config: () => PaymentsConfig;
  /** Resolve an invoice provider by name (falls back to the configured default). */
  invoice?: (name?: string) => InvoiceProvider;
}

/** Context handed to invoice provider factories. */
export interface InvoiceContext {
  /** Lazy import of the package's own invoice config section. */
  config: () => InvoiceSectionConfig;
}

export interface StripeDriverConfig {
  /** Stripe secret key. Defaults to `env.get('STRIPE_KEY')`. */
  apiKey?: string;
  /** Default currency. Defaults to `'brl'`. */
  currency?: string;
  /**
   * Webhook signing secret (`whsec_...`) used to verify `stripe-signature`. Defaults
   * to `env.get('STRIPE_WEBHOOK_SECRET')`. Required to parse Stripe webhooks.
   */
  webhookSecret?: string;
}

export interface AbacateDriverConfig {
  /** AbacatePay API token. Defaults to `env.get('ABACATE_API_KEY')`. */
  apiKey?: string;
  /** Public key used to verify webhook HMAC signatures. */
  publicKey?: string;
  /**
   * HMAC secret that signs AbacatePay webhooks (the dashboard's "public key").
   * Alias of {@link publicKey}; defaults to `env.get('ABACATE_PUBLIC_KEY')`. When set,
   * webhooks without a valid `x-webhook-signature` are rejected.
   */
  webhookSecret?: string;
}

export interface AsaasDriverConfig {
  /** Asaas API key. Defaults to `env.get('ASAAS_API_KEY')`. */
  apiKey?: string;
  /** Use the Asaas sandbox environment. Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
  /**
   * Shared webhook token configured in the Asaas dashboard. Defaults to
   * `env.get('ASAAS_WEBHOOK_ACCESS_TOKEN')` (or `ASAAS_WEBHOOK_TOKEN`). When set,
   * webhooks without the matching token header are rejected.
   */
  webhookToken?: string;
}

export interface FocusInvoiceConfig {
  /** Focus NFe API token. Defaults to `env.get('FOCUS_NFE_TOKEN')`. */
  token?: string;
  /** Focus NFe API URL. Defaults to the production endpoint. */
  baseUrl?: string;
}

export interface WooviDriverConfig {
  /** Woovi/OpenPix app id. Defaults to `env.get('WOOVI_APP_ID')`. */
  appId?: string;
  /** Base URL of the OpenPix API. Defaults to production. */
  baseUrl?: string;
  /**
   * Per-webhook HMAC secret (dashboard → API/Plugins). Verifies the deprecated
   * `X-OpenPix-Signature` header. Defaults to `env.get('WOOVI_WEBHOOK_SECRET')`.
   * Prefer {@link webhookPublicKey}.
   */
  webhookSecret?: string;
  /**
   * Woovi account public key, used to verify the recommended `x-webhook-signature`
   * header (RSA-SHA256). PEM or base64-encoded PEM; defaults to
   * `env.get('WOOVI_WEBHOOK_PUBLIC_KEY')`.
   */
  webhookPublicKey?: string;
}

/**
 * Shape of `config/payments.ts`.
 *
 * Both payment gateways and invoice providers are named maps with a `default` — so a
 * charge call either just works with the defaults, or names a specific provider per call.
 *
 * ```ts
 * import { defineConfig, payments, invoice } from '@adonis-agora/payments'
 *
 * export default defineConfig({
 *   default: 'stripe',
 *   providers: {
 *     stripe: payments.stripe(),
 *     asaas: payments.asaas({ sandbox: true }),
 *   },
 *   invoice: {
 *     default: 'focus',
 *     providers: {
 *       focus: invoice.focus(),
 *       // Custom providers are plain factories too.
 *       myProvider: () => import('#services/my_invoice').then((m) => new m.MyInvoiceProvider()),
 *     },
 *     defaults: {
 *       service: { description: 'Software license' },
 *     },
 *   },
 *   billing: {
 *     enabled: true,
 *     durable: 'auto',
 *   },
 * })
 * ```
 */
export interface PaymentsConfig {
  /** Name of the default payment provider (a key of `providers`). */
  default?: string;
  /** Named payment providers, built with the {@link payments} factory. */
  providers?: Record<string, PaymentsDriverFactory>;
  /**
   * Route a payment method to a provider name (a key of `providers`). Resolves the
   * driver per method on a charge call.
   *
   * ```ts
   * methods: {
   *   pix: 'woovi',           // Pix via Woovi/OpenPix
   *   credit_card: 'stripe',  // card via Stripe
   *   boleto: 'asaas',        // boleto via Asaas
   *   debit_card: 'asaas',
   *   undefined: 'asaas',     // customer picks at checkout
   * }
   * ```
   */
  methods?: Partial<Record<PaymentMethodName, string>>;
  /** Invoice emission settings. */
  invoice?: InvoiceSectionConfig;
  /** Billing (subscription) layer settings. */
  billing?: {
    /**
     * Whether the Lucid billing layer is enabled. When enabled the provider wires the
     * billing stores, mixins and webhook processor. Defaults to true.
     */
    enabled?: boolean;
    /**
     * `'auto'` (default): use `@adonis-agora/durable` to process webhooks when it is
     * installed in the app; otherwise fall back to an in-process dispatcher with retries.
     * `true`: require durable (throw when missing). `false`: always use the in-process
     * dispatcher.
     */
    durable?: 'auto' | boolean;
  };
}

/**
 * Identity helper giving `config/payments.ts` full type-checking (media/durable pattern).
 */
export function defineConfig<const T extends PaymentsConfig>(config: T): T {
  return config;
}

/** Built-in driver factories. Each lazily imports its gateway SDK. */
export const payments = {
  stripe(config: StripeDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { StripeDriver } = await import('./drivers/stripe.js');
      return new StripeDriver(ctx, config);
    };
  },
  abacate(config: AbacateDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { AbacateDriver } = await import('./drivers/abacate.js');
      return new AbacateDriver(ctx, config);
    };
  },
  asaas(config: AsaasDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { AsaasDriver } = await import('./drivers/asaas.js');
      return new AsaasDriver(ctx, config);
    };
  },
  woovi(config: WooviDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { WooviDriver } = await import('./drivers/woovi.js');
      return new WooviDriver(ctx, config);
    };
  },
};

/** Built-in invoice provider factories. Each lazily imports its provider module. */
export const invoice = {
  focus(config: FocusInvoiceConfig = {}): InvoiceProviderFactory {
    return async (ctx) => {
      const { FocusInvoiceProvider } = await import('./invoice/drivers/focus.js');
      return new FocusInvoiceProvider(ctx, config);
    };
  },
};

export type { PaymentsDriver, InvoiceProvider };

/** Invoice emission settings (the `invoice` key of {@link PaymentsConfig}). */
export interface InvoiceSectionConfig {
  /** Name of the default invoice provider (a key of `invoice.providers`). */
  default?: string;
  /** Named invoice providers, built with the {@link invoice} factory. */
  providers?: Record<string, InvoiceProviderFactory>;
  /** Defaults merged into every `invoice` option. */
  defaults?: {
    service?: InvoiceOptions['service'];
    tax?: InvoiceOptions['tax'];
    metadata?: InvoiceOptions['metadata'];
  };
}

export type { InvoiceConfig }; // compat alias
type InvoiceConfig = InvoiceSectionConfig;
