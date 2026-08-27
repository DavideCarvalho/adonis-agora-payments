import type { BillingStore } from './billing/billing_store.js';
import type { BillingModels } from './billing/lucid_billing_store.js';
import type { WebhookHandler } from './billing/webhook_processor.js';
import type { PaymentsDriver } from './driver.js';
import type { InvoiceProvider } from './invoice/invoice_provider.js';
import type { InvoiceOptions, PaymentMethodName } from './types.js';
import type { WebhookHandlerService } from './webhook_handlers.js';

/**
 * A lazy factory that builds a {@link PaymentsDriver}. Each driver factory imports its
 * peer dependency (the Stripe SDK, etc.) lazily inside the thunk, so it only loads when
 * that driver is actually selected — making every gateway SDK an optional peer.
 */
export type PaymentsDriverFactory = (ctx: PaymentsContext) => Promise<PaymentsDriver>;

/** A lazy factory that builds an {@link InvoiceProvider} (Focus, Tecnospeed, eNotas, PlugNotas). */
export type InvoiceProviderFactory = (ctx: InvoiceContext) => Promise<InvoiceProvider>;

/**
 * A lazy factory that builds the {@link BillingStore} the billing layer persists through.
 * Omit `billing.store` entirely and the Lucid store over the published tables is used.
 */
export type BillingStoreFactory = (
  ctx: BillingStoreContext,
) => BillingStore | Promise<BillingStore>;

/** Context handed to the billing-store factory when the provider resolves it. */
export interface BillingStoreContext {
  /** Lazy access to the package's own config. */
  config: () => PaymentsConfig;
}

/** `config.billing.handlers` — normalized webhook event type → handler. */
export type BillingHandlers = Record<string, WebhookHandler | WebhookHandlerService>;

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

export interface ENotasInvoiceConfig {
  /** eNotas API key. Defaults to `env.get('ENOTAS_API_KEY')`. */
  apiKey?: string;
  /** eNotas API URL. Defaults to the production endpoint. */
  baseUrl?: string;
}

export interface PlugNotasInvoiceConfig {
  /** PlugNotas API key. Defaults to `env.get('PLUGNOTAS_API_KEY')`. */
  apiKey?: string;
  /** PlugNotas API URL. Defaults to the production endpoint. */
  baseUrl?: string;
}

export interface AsaasInvoiceConfig {
  /** Asaas API key. Defaults to `env.get('ASAAS_API_KEY')`. */
  apiKey?: string;
  /** Use the Asaas sandbox environment. Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
}

export interface TecnospeedInvoiceConfig {
  /** Tecnospeed API token. Defaults to `env.get('TECNOSPEED_TOKEN')`. */
  token?: string;
  /** Tecnospeed API base URL (per-municipality/plan). Defaults to the generic v1 base. */
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
     * Legacy alias for {@link dispatcher}: `'auto'` (default) or a boolean (`true` =
     * `'durable'`, `false` = `'in-process'`). Prefer `dispatcher` for the full set of
     * backends.
     */
    durable?: 'auto' | boolean;
    /**
     * How webhook events are processed:
     *
     * - `'auto'` (default) — `@adonis-agora/durable` when its provider is registered;
     *   else `@adonisjs/queue` when it's installed; else in-process with retries.
     * - `'durable'` — a durable workflow run (requires `@adonis-agora/durable`, throws when missing).
     * - `'queue'` — an `@adonisjs/queue` job (requires the queue provider, throws when missing).
     * - `'in-process'` — inline with exponential-backoff retries.
     *
     * Mirrors how other Agora libraries pick a backend (`durable`'s `store`, etc.).
     */
    dispatcher?: 'auto' | 'durable' | 'queue' | 'in-process';
    /** Queue name the `'queue'` dispatcher enqueues to. Defaults to the queue's default. */
    queue?: string;
    /**
     * Which half of a split deployment this process is.
     *
     * - `'all'` (default) — one process receives webhooks and processes them.
     * - `'api'` — mount the webhook route, validate and hand off; never process.
     *   App handlers are not resolved here, because they run on the worker.
     * - `'worker'` — do not mount the route; process what the API half enqueued.
     *
     * Splitting requires a dispatcher with a channel between the halves, so
     * `'api'`/`'worker'` demand an explicit `dispatcher` of `'durable'` or
     * `'queue'`. `'in-process'` has no channel — it calls the processor directly —
     * and `'auto'` is too vague to split on, so both are refused at boot.
     */
    role?: 'all' | 'api' | 'worker';
    /**
     * Where the billing layer persists — subscriptions, payments, the idempotency
     * ledger and usage events.
     *
     * Omit it: the Lucid store over the published billing tables is the default, and
     * the provider binds it in the container so services can `@inject()` it.
     *
     * ```ts
     * import { billingStores } from '@adonis-agora/payments'
     *
     * // Same as omitting it, but with your own models:
     * store: billingStores.lucid({ models: { usageEventModel: MyUsageEvent } })
     * ```
     */
    store?: BillingStoreFactory;
    /**
     * Business webhook handlers run INSIDE the lib-mounted `/payments/webhook/:provider`
     * route, by the {@link WebhookProcessor}. Errors mark the event failed in the ledger
     * and trigger the dispatcher's retry. An alternative to subscribing to the
     * `agora:payments:billing:*` events — pick whichever fits the app (events for
     * fire-and-forget, handlers here for error-driven retry).
     *
     * Keyed by the normalized event type (e.g. `'payment.succeeded'`). Each factory
     * receives the AdonisJS container and returns the handler, so it can resolve DI
     * services lazily:
     *
     * ```ts
     * handlers: {
     *   'payment.succeeded': async ({ app }) => {
     *     const svc = await app.container.make(MeetingPackageService)
     *     return (event) => svc.handlePayment(event)
     *   },
     * }
     * ```
     */
    handlers?: BillingHandlers;
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

/**
 * Built-in billing-store factories. The Lucid store is the default, so this only
 * needs naming when you swap the models it reads and writes.
 */
export const billingStores = {
  lucid(config: { models?: BillingModels } = {}): BillingStoreFactory {
    return async () => {
      const { LucidBillingStore } = await import('./billing/lucid_billing_store.js');
      return new LucidBillingStore(config.models ?? {});
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
  enotas(config: ENotasInvoiceConfig = {}): InvoiceProviderFactory {
    return async (ctx) => {
      const { ENotasInvoiceProvider } = await import('./invoice/drivers/enotas.js');
      return new ENotasInvoiceProvider(ctx, config);
    };
  },
  plugnotas(config: PlugNotasInvoiceConfig = {}): InvoiceProviderFactory {
    return async (ctx) => {
      const { PlugNotasInvoiceProvider } = await import('./invoice/drivers/plugnotas.js');
      return new PlugNotasInvoiceProvider(ctx, config);
    };
  },
  asaas(config: AsaasInvoiceConfig = {}): InvoiceProviderFactory {
    return async (ctx) => {
      const { AsaasInvoiceProvider } = await import('./invoice/drivers/asaas.js');
      return new AsaasInvoiceProvider(ctx, config);
    };
  },
  tecnospeed(config: TecnospeedInvoiceConfig = {}): InvoiceProviderFactory {
    return async (ctx) => {
      const { TecnospeedInvoiceProvider } = await import('./invoice/drivers/tecnospeed.js');
      return new TecnospeedInvoiceProvider(ctx, config);
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
