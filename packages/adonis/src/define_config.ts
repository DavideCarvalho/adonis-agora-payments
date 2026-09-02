import type { BillingStore } from './billing/billing_store.js';
import type { BillingModels } from './billing/lucid_billing_store.js';
import type { WebhookHandler } from './billing/webhook_processor.js';
import type { PaymentsDriver } from './driver.js';
import type { AdyenDriverConfig } from './drivers/adyen.js';
import type { DodoDriverConfig } from './drivers/dodo.js';
import type { LemonSqueezyDriverConfig } from './drivers/lemonsqueezy.js';
import type { MercadoPagoDriverConfig } from './drivers/mercadopago.js';
import type { MollieDriverConfig } from './drivers/mollie.js';
import type { PaddleDriverConfig } from './drivers/paddle.js';
import type { PayPalDriverConfig } from './drivers/paypal.js';
import type { PolarDriverConfig } from './drivers/polar.js';
import type { RazorpayDriverConfig } from './drivers/razorpay.js';
import type { SquareDriverConfig } from './drivers/square.js';
import type { InvoiceProvider } from './invoice/invoice_provider.js';
import type { SubscriptionsConfig } from './subscription_mode.js';
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
  /**
   * Currency for charges that don't name one (lowercase ISO 4217). **Required** — Stripe
   * bills in whatever you tell it to, so a default here would be a guess at which country
   * the app charges in, and a wrong guess succeeds silently.
   */
  currency: string;
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

export interface PagarmeDriverConfig {
  /**
   * Pagar.me secret key (`sk_…`, `sk_test_…` in the sandbox). Sent as the username of an
   * HTTP Basic header with an empty password. Defaults to `env.get('PAGARME_SECRET_KEY')`.
   */
  secretKey?: string;
  /** Base URL of the Core API. Defaults to `https://api.pagar.me/core/v5`. */
  baseUrl?: string;
  /**
   * Username of the optional HTTP Basic credentials you set on the webhook endpoint in the
   * Pagar.me dashboard. Defaults to `env.get('PAGARME_WEBHOOK_USER')`. Pagar.me signs
   * nothing — these credentials are the only authentication its webhooks offer, and when
   * either is set the driver rejects requests that don't carry them.
   */
  webhookUser?: string;
  /** Password of those webhook credentials. Defaults to `env.get('PAGARME_WEBHOOK_PASSWORD')`. */
  webhookPassword?: string;
  /**
   * Default Pix expiry in seconds when a charge doesn't set `metadata.expiresIn`. Pagar.me
   * requires `expires_in` on every Pix payment. Defaults to 86400 (24h).
   */
  pixExpiresIn?: number;
  // No `currency`: Pagar.me is BRL-only, so there is nothing to choose.
}

export interface InfinitePayDriverConfig {
  /**
   * Your InfiniteTag — the merchant handle the public checkout endpoint identifies you by.
   * This is not a secret key: InfinitePay's checkout API takes no credentials at all.
   * Defaults to `env.get('INFINITEPAY_HANDLE')`. "Checkout Integrado" must be enabled in
   * the InfinitePay app before links can be created.
   */
  handle?: string;
  /** Base URL of the checkout API. Defaults to `https://api.checkout.infinitepay.io`. */
  baseUrl?: string;
  /**
   * Where InfinitePay should POST the payment webhook. InfinitePay has **no global webhook
   * registration** — the URL is sent per link — so without this (or
   * `env.get('INFINITEPAY_WEBHOOK_URL')`) no webhook ever arrives. Point it at the
   * library's route, e.g. `https://app.example.com/payments/webhook/infinitepay`, and
   * consider adding an unguessable segment: the payload carries no signature.
   */
  webhookUrl?: string;
  // No `currency`: InfinitePay is BRL-only.
}

export interface PagBankDriverConfig {
  /** PagBank API token (Bearer). Defaults to `env.get('PAGBANK_TOKEN')`. */
  token?: string;
  /** Use the PagBank sandbox host. Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
  /**
   * The token PagBank hashes into `x-authenticity-token` on webhooks. PagBank has no
   * separate webhook secret — it is the same token that authenticates API calls — so this
   * defaults to {@link PagBankDriverConfig.token} (or `env.get('PAGBANK_WEBHOOK_TOKEN')`),
   * and webhook verification is on out of the box.
   */
  webhookToken?: string;
  /**
   * Whether to verify `x-authenticity-token` on incoming webhooks. Defaults to `true`.
   *
   * The only reason this exists: PagBank's sandbox does not always send the header, so a
   * developer testing locally would otherwise be stuck. Setting it to `false` leaves the
   * webhook endpoint accepting anything that can reach it — never do that in production.
   */
  verifyWebhooks?: boolean;
  /**
   * URLs PagBank notifies for the orders this driver creates (`notification_urls`).
   * Usually one entry pointing at the lib-mounted `/payments/webhook/pagbank`. You can
   * also configure it per account in the PagBank dashboard and leave this empty.
   */
  notificationUrls?: string[];
}

export interface EfiDriverConfig {
  /** Efí OAuth client id. Defaults to `env.get('EFI_CLIENT_ID')`. */
  clientId?: string;
  /** Efí OAuth client secret. Defaults to `env.get('EFI_CLIENT_SECRET')`. */
  clientSecret?: string;
  /**
   * The Pix key that receives the charges (`chave` on every `cob`). Defaults to
   * `env.get('EFI_PIX_KEY')`. Required — the Pix API refuses a charge without one.
   */
  pixKey?: string;
  /** Use the Efí homologation host (`pix-h`). Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
  /**
   * The client certificate Efí's Pix API demands on **every** request, the token request
   * included: a path to the `.p12` (or `.pem`) generated in the Efí dashboard, or its
   * contents as a Buffer. Defaults to `env.get('EFI_CERTIFICATE')`.
   *
   * Mutual TLS cannot be expressed as a header, so this is not optional the way an API key
   * is optional — without it (or a custom {@link EfiDriverConfig.fetch}) the driver
   * refuses to boot.
   */
  certificate?: string | Buffer | Uint8Array;
  /** Passphrase of the `.p12`, when you set one. Efí's default export has none. */
  certificatePassphrase?: string;
  /** Default `cob` expiry in seconds. Defaults to 3600 (one hour). */
  expirationSeconds?: number;
  /**
   * A `fetch` to use instead of the certificate-bearing one the driver builds. The escape
   * hatch for terminating mTLS somewhere else (a proxy, a pooled undici dispatcher) — and
   * what the tests inject.
   */
  fetch?: typeof globalThis.fetch;
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
 *     stripe: payments.stripe({ currency: 'usd' }),
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
  /**
   * Providers whose webhook deliveries are allowed to arrive UNVERIFIED.
   *
   * By default the provider refuses to boot when a driver that can authenticate a webhook
   * has no credential configured — an empty credential slot means the mounted
   * `POST /payments/webhook/:provider` accepts anything anyone posts to it, and the built-in
   * sync marks the payments in it paid.
   *
   * Set it when verification genuinely happens upstream (mutual TLS at the edge, an API
   * gateway that checks the signature before forwarding), naming the providers:
   *
   * ```ts
   * allowUnverifiedWebhooks: ['efi']
   * ```
   *
   * `true` opts every provider out at once, which is almost never what you want.
   */
  allowUnverifiedWebhooks?: boolean | string[];
  /** Invoice emission settings. */
  invoice?: InvoiceSectionConfig;
  /**
   * Who drives subscriptions — the gateway, or this library. See {@link SubscriptionsConfig}.
   *
   * ```ts
   * subscriptions: {
   *   mode: 'gateway',                  // default for everyone
   *   providers: { woovi: 'managed' },  // ...except Woovi, which cannot cancel or update
   * }
   * ```
   */
  subscriptions?: SubscriptionsConfig;

  /** Billing (subscription) layer settings. */
  billing?: {
    /**
     * Whether the Lucid billing layer is enabled. When enabled the provider wires the
     * billing stores, mixins and webhook processor. Defaults to true.
     */
    enabled?: boolean;
    /**
     * Gateway event types your drivers pass through unmapped that you register a handler
     * for, when the type happens to fall in the library's own `payment.*`/`subscription.*`
     * namespace.
     *
     * A handler registered for a type nothing ever emits is a silent no-op — the ledger
     * still records the delivery as processed — so a type in that namespace which is not one
     * of the normalized `WEBHOOK_EVENT_TYPES` is refused at boot as a typo. A gateway type a
     * driver could not map arrives lowercased as the gateway spells it
     * (`payment_anticipated`), which needs no declaration; this is for the rare gateway that
     * spells one WITH a dot in the same namespace.
     */
    passthroughEvents?: string[];
    /**
     * Whether the library creates its own tables on first use. Defaults to **true**, the
     * ecosystem convention — `@adonis-agora/durable` and `@adonis-agora/authz` both own
     * their schema, and an app that installs a lib should not have to publish and run a
     * migration before it can take a payment.
     *
     * The DDL is idempotent (`CREATE TABLE IF NOT EXISTS`), so an install that already ran
     * the published migration gets no-ops.
     *
     * Set it to `false` when your schema is managed elsewhere — a shared database you do not
     * own, a team that reviews every DDL, a deploy that runs migrations as a separate step.
     * Then publish the migration (`node ace configure @adonis-agora/payments`) and run it;
     * it calls the SAME `createBillingTables` function, so the two paths cannot drift.
     */
    autoCreateSchema?: boolean;
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
     *   else in-process with retries.
     * - `'durable'` — a durable workflow run (requires `@adonis-agora/durable`, throws when missing).
     * - `'in-process'` — inline with exponential-backoff retries.
     *
     * Mirrors how other Agora libraries pick a backend (`durable`'s `store`, etc.).
     *
     * There was a `'queue'` here. It was declared, documented, and implemented nowhere — the
     * dispatcher's `queueDispatch` hook was never read, so the mode fell through and silently
     * ran one of the other two. It is refused at boot now rather than left to look supported.
     */
    dispatcher?: 'auto' | 'durable' | 'in-process';
    /**
     * Which half of a split deployment this process is.
     *
     * - `'all'` (default) — one process receives webhooks and processes them.
     * - `'api'` — mount the webhook route, validate and hand off; never process.
     *   App handlers are not resolved here, because they run on the worker.
     * - `'worker'` — do not mount the route; process what the API half enqueued.
     *
     * Splitting requires a dispatcher with a channel between the halves, so
     * `'api'`/`'worker'` demand an explicit `dispatcher: 'durable'`. `'in-process'` has no
     * channel — it calls the processor directly — and `'auto'` is too vague to split on, so
     * both are refused at boot.
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
  stripe(config: StripeDriverConfig): PaymentsDriverFactory {
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
  pagarme(config: PagarmeDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { PagarmeDriver } = await import('./drivers/pagarme.js');
      return new PagarmeDriver(ctx, config);
    };
  },
  infinitepay(config: InfinitePayDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { InfinitePayDriver } = await import('./drivers/infinitepay.js');
      return new InfinitePayDriver(ctx, config);
    };
  },
  pagbank(config: PagBankDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { PagBankDriver } = await import('./drivers/pagbank.js');
      return new PagBankDriver(ctx, config);
    };
  },
  efi(config: EfiDriverConfig = {}): PaymentsDriverFactory {
    return async (ctx) => {
      const { EfiDriver } = await import('./drivers/efi.js');
      return new EfiDriver(ctx, config);
    };
  },
  adyen(config: AdyenDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { AdyenDriver } = await import('./drivers/adyen.js');
      return new AdyenDriver(ctx, config);
    };
  },
  dodo(config: DodoDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { DodoDriver } = await import('./drivers/dodo.js');
      return new DodoDriver(ctx, config);
    };
  },
  lemonsqueezy(config: LemonSqueezyDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { LemonSqueezyDriver } = await import('./drivers/lemonsqueezy.js');
      return new LemonSqueezyDriver(ctx, config);
    };
  },
  mercadopago(config: MercadoPagoDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { MercadoPagoDriver } = await import('./drivers/mercadopago.js');
      return new MercadoPagoDriver(ctx, config);
    };
  },
  mollie(config: MollieDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { MollieDriver } = await import('./drivers/mollie.js');
      return new MollieDriver(ctx, config);
    };
  },
  paddle(config: PaddleDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { PaddleDriver } = await import('./drivers/paddle.js');
      return new PaddleDriver(ctx, config);
    };
  },
  paypal(config: PayPalDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { PayPalDriver } = await import('./drivers/paypal.js');
      return new PayPalDriver(ctx, config);
    };
  },
  polar(config: PolarDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { PolarDriver } = await import('./drivers/polar.js');
      return new PolarDriver(ctx, config);
    };
  },
  razorpay(config: RazorpayDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { RazorpayDriver } = await import('./drivers/razorpay.js');
      return new RazorpayDriver(ctx, config);
    };
  },
  square(config: SquareDriverConfig): PaymentsDriverFactory {
    return async (ctx) => {
      const { SquareDriver } = await import('./drivers/square.js');
      return new SquareDriver(ctx, config);
    };
  },
};

/**
 * Config types for the drivers whose interfaces live in their own module.
 *
 * The four original drivers declare their config here; the later ones declare it beside the
 * driver so each module type-checks on its own. Re-exported so both halves look identical
 * from the outside.
 */
export type {
  AdyenDriverConfig,
  DodoDriverConfig,
  LemonSqueezyDriverConfig,
  MercadoPagoDriverConfig,
  MollieDriverConfig,
  PaddleDriverConfig,
  PayPalDriverConfig,
  PolarDriverConfig,
  RazorpayDriverConfig,
  SquareDriverConfig,
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

export type { InvoiceProvider, PaymentsDriver };

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
