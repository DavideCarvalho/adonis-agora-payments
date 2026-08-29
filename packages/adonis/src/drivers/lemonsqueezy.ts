import { createHmac } from 'node:crypto';
import { publishRefundDiagnostics, publishSubscriptionDiagnostics } from '../diagnostics.js';
import type {
  ChargeInput,
  CheckoutInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  PaymentsDriver,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
  WebhookVerificationState,
} from '../driver.js';
import { headerValue, isNotFound } from '../http.js';
import type { EmitInvoiceContext } from '../invoice/emit_invoice.js';
import type {
  CheckoutSession,
  Customer,
  Invoice,
  Money,
  Payment,
  Refund,
  Subscription,
  WebhookEvent,
} from '../types.js';
import { safeCompare } from '../webhook_security.js';
import { requireCredential } from './shared.js';

/**
 * Config for {@link LemonSqueezyDriver} (`payments.lemonsqueezy({ … })`).
 *
 * Declared here rather than in `define_config.ts` so the driver module is self-contained;
 * `define_config.ts` re-exports it alongside the factory.
 */
export interface LemonSqueezyDriverConfig {
  /** Lemon Squeezy API key. Defaults to `env.get('LEMONSQUEEZY_API_KEY')`. */
  apiKey?: string;
  /**
   * The store checkouts and customers are created in. **Required** — every write endpoint
   * takes a store relationship and Lemon Squeezy accounts can hold several stores, each
   * with its own currency, so there is nothing sane to pick by default.
   */
  storeId: string | number;
  /**
   * Signing secret configured on the webhook in the Lemon Squeezy dashboard, used to
   * verify `X-Signature`. Defaults to `env.get('LEMONSQUEEZY_WEBHOOK_SECRET')`. Required
   * to parse webhooks — Lemon Squeezy always signs, so there is no unsigned mode.
   */
  webhookSecret?: string;
}

/**
 * JSON:API resource object. Lemon Squeezy is the only gateway in this package that speaks
 * JSON:API, so every field this driver reads lives one level down under `attributes`, and
 * `id` is a string at the resource level (never inside `attributes`).
 */
interface JsonApiResource<T> {
  type: string;
  id: string;
  attributes: T;
}

interface JsonApiDocument<T> {
  data: JsonApiResource<T>;
}

interface JsonApiCollection<T> {
  data: Array<JsonApiResource<T>>;
}

interface LemonSqueezyCustomerAttributes {
  store_id?: number;
  name?: string;
  email?: string;
  status?: string;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  urls?: { customer_portal?: string | null };
  created_at?: string;
  test_mode?: boolean;
}

/**
 * Lemon Squeezy money is already an **integer in the smallest currency unit** — `999` is
 * $9.99 — so unlike the Brazilian gateways there is no decimal conversion anywhere in this
 * driver. The `*_formatted` twins are display strings and are never read.
 */
interface LemonSqueezyOrderAttributes {
  store_id?: number;
  customer_id?: number;
  identifier?: string;
  order_number?: number;
  user_email?: string;
  currency: string;
  subtotal?: number;
  tax?: number;
  total: number;
  status: 'pending' | 'failed' | 'paid' | 'refunded';
  refunded?: boolean;
  refunded_at?: string | null;
  urls?: { receipt?: string };
  created_at?: string;
  test_mode?: boolean;
}

interface LemonSqueezySubscriptionAttributes {
  store_id?: number;
  customer_id?: number;
  order_id?: number;
  product_id?: number;
  variant_id?: number;
  status: 'on_trial' | 'active' | 'paused' | 'past_due' | 'unpaid' | 'cancelled' | 'expired';
  card_brand?: string | null;
  trial_ends_at?: string | null;
  renews_at?: string | null;
  ends_at?: string | null;
  created_at?: string;
  test_mode?: boolean;
}

interface LemonSqueezySubscriptionInvoiceAttributes {
  store_id?: number;
  subscription_id?: number;
  customer_id?: number;
  currency: string;
  status: 'pending' | 'paid' | 'void' | 'refunded' | 'partial_refund';
  refunded?: boolean;
  total: number;
  refunded_amount?: number;
  urls?: { invoice_url?: string };
  created_at?: string;
  test_mode?: boolean;
}

interface LemonSqueezyCheckoutAttributes {
  store_id?: number;
  variant_id?: number;
  custom_price?: number | null;
  url: string;
  expires_at?: string | null;
  created_at?: string;
  test_mode?: boolean;
}

interface LemonSqueezyWebhookPayload {
  meta: {
    event_name: string;
    custom_data?: Record<string, unknown> | null;
    test_mode?: boolean;
  };
  data: JsonApiResource<Record<string, unknown>> & { attributes: Record<string, unknown> };
}

/**
 * Lemon Squeezy driver — the v1 REST API on `api.lemonsqueezy.com`.
 *
 * Lemon Squeezy is a merchant of record: it is the seller of record on the buyer's
 * statement, calculates and remits sales tax/VAT worldwide, and pays you out. You sell to
 * Lemon Squeezy; Lemon Squeezy sells to your customer.
 *
 * Two consequences shape this driver. First, there is no server-side charge endpoint at
 * all — a purchase begins with a hosted checkout, so `charge()` throws and
 * `createCheckout()` is the entry point. Second, subscriptions are created by a customer
 * completing a checkout for a subscription variant, never by an API call, so
 * `createSubscription()` throws too.
 *
 * The API is JSON:API (`application/vnd.api+json`), which is unusual enough that the
 * request helper and every mapper below are written around `data.attributes`.
 */
export class LemonSqueezyDriver implements PaymentsDriver {
  readonly provider = 'lemonsqueezy';
  /**
   * The hosted checkout decides which methods to offer from the buyer's country and the
   * store's settings, and the API takes no payment-method argument — so `'undefined'`
   * ("the customer chooses at checkout") is the only honest canonical name. Routing
   * `credit_card` here is refused by the manager, which is correct: this driver cannot
   * promise the payment will be a card rather than PayPal.
   */
  readonly supportedMethods = ['undefined'] as const;
  /**
   * `disputes: false`. Lemon Squeezy has no dispute API and no dispute webhook — see
   * `#mapWebhookType`. As merchant of record it "typically manages these disputes on
   * behalf of the seller", so there is nothing here to read and nothing to submit.
   */
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true, disputes: false };

  #baseUrl = 'https://api.lemonsqueezy.com/v1';
  #apiKey: string;
  #storeId: string;
  #webhookSecret: string | undefined;

  constructor(_ctx: EmitInvoiceContext, config: LemonSqueezyDriverConfig) {
    this.#apiKey = requireCredential({
      driver: 'lemonsqueezy',
      option: 'apiKey',
      env: 'LEMONSQUEEZY_API_KEY',
      value: config.apiKey,
    });
    this.#storeId = String(config.storeId);
    // An empty env var is "unset", not "a secret that can never match" — otherwise a
    // blank `LEMONSQUEEZY_WEBHOOK_SECRET` fails every webhook with a signature error
    // instead of the message telling you to configure it.
    const webhookSecret = config.webhookSecret ?? process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    this.#webhookSecret = webhookSecret === '' ? undefined : webhookSecret;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCustomer');
    if (input.name === undefined || input.email === undefined) {
      throw new Error('[payments] Lemon Squeezy requires both a name and an email on a customer.');
    }
    this.#refuseTaxId(input.taxId);
    const document = await this.#request<JsonApiDocument<LemonSqueezyCustomerAttributes>>(
      '/customers',
      {
        method: 'POST',
        body: {
          data: {
            type: 'customers',
            attributes: {
              name: input.name,
              email: input.email,
              ...(typeof input.metadata?.city === 'string' ? { city: input.metadata.city } : {}),
              ...(typeof input.metadata?.region === 'string'
                ? { region: input.metadata.region }
                : {}),
              ...(typeof input.metadata?.country === 'string'
                ? { country: input.metadata.country }
                : {}),
            },
            relationships: { store: { data: { type: 'stores', id: this.#storeId } } },
          },
        },
      },
    );
    return this.#mapCustomer(document.data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const document = await this.#request<JsonApiDocument<LemonSqueezyCustomerAttributes>>(
        `/customers/${encodeURIComponent(customerId)}`,
      );
      return this.#mapCustomer(document.data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    this.#refuseTaxId(input.taxId);
    const document = await this.#request<JsonApiDocument<LemonSqueezyCustomerAttributes>>(
      `/customers/${encodeURIComponent(customerId)}`,
      {
        method: 'PATCH',
        body: {
          data: {
            type: 'customers',
            id: String(customerId),
            attributes: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.email !== undefined ? { email: input.email } : {}),
            },
          },
        },
      },
    );
    return this.#mapCustomer(document.data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  /**
   * Lemon Squeezy has no endpoint that takes money. As merchant of record it owns the
   * payment page: the only way to start a purchase is a hosted checkout, so returning a
   * `Payment` here would report a charge that was never attempted.
   */
  async charge(_input: ChargeInput): Promise<Payment> {
    throw new Error(
      '[payments] Lemon Squeezy cannot charge server-side — as merchant of record it ' +
        'collects every payment through its hosted checkout. Use `createCheckout()` and ' +
        'act on the `order_created` webhook.',
    );
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const document = await this.#request<JsonApiDocument<LemonSqueezyOrderAttributes>>(
        `/orders/${encodeURIComponent(gatewayId)}`,
      );
      return this.#mapPayment(document.data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Refunds an **order** (`paymentGatewayId` is an order id, the same id `findPayment`
   * takes). `amount` is in cents, like everywhere else here; omit it for a full refund.
   * Renewal charges are subscription invoices with their own ids and their own refund
   * endpoint — this method does not reach them.
   *
   * `options.idempotencyKey` is REFUSED, not ignored: Lemon Squeezy has no deduplication
   * mechanism, so accepting a key would turn a retry guarantee into a second refund.
   */
  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    this.#refuseIdempotencyKey(options?.idempotencyKey, 'refund');
    const document = await this.#request<JsonApiDocument<LemonSqueezyOrderAttributes>>(
      `/orders/${encodeURIComponent(paymentGatewayId)}/refund`,
      {
        method: 'POST',
        body: {
          data: {
            type: 'orders',
            id: String(paymentGatewayId),
            attributes: { ...(amount !== undefined ? { amount } : {}) },
          },
        },
      },
    );
    const order = document.data.attributes;
    const refund: Refund = {
      id: document.data.id,
      gatewayId: document.data.id,
      provider: this.provider,
      amount: { amount: amount ?? order.total, currency: order.currency.toLowerCase() },
      // The refund endpoint returns the order, not a refund resource: `refunded` is the
      // only confirmation the API gives that the money went back.
      status: order.refunded === true || order.status === 'refunded' ? 'succeeded' : 'pending',
      createdAt: order.refunded_at ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a hosted checkout for a **variant** — `planId` is a Lemon Squeezy variant id
   * and is required, because a checkout always sells something from the catalog. Pass
   * `amount` to override the variant's price (`custom_price`, in cents).
   */
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCheckout');
    if (input.planId === undefined) {
      throw new Error(
        '[payments] Lemon Squeezy checkouts always sell a catalog variant. Pass the ' +
          'variant id as `planId` (use `amount` to override its price).',
      );
    }
    if (input.trialDays !== undefined) {
      // A Lemon Squeezy trial is a property of the variant, not of the checkout.
      // Accepting the option here would bill a customer who was promised a trial.
      throw new Error(
        '[payments] Lemon Squeezy configures trials on the variant, not per checkout. ' +
          'Create a variant with a free trial and pass its id as `planId`.',
      );
    }
    const custom = this.#customData(input);
    const document = await this.#request<JsonApiDocument<LemonSqueezyCheckoutAttributes>>(
      '/checkouts',
      {
        method: 'POST',
        body: {
          data: {
            type: 'checkouts',
            attributes: {
              // Lemon Squeezy's money is an integer of the smallest currency unit, the
              // same unit this package works in — `custom_price: 1990` is $19.90. No
              // `formatDecimal`, no division. (API reference, the checkout object:
              // "a positive integer in cents representing the custom price".)
              ...(input.amount > 0 ? { custom_price: input.amount } : {}),
              product_options: {
                ...(input.description !== undefined ? { name: input.description } : {}),
                // Lemon Squeezy has one post-purchase URL, not a success/cancel pair.
                redirect_url: input.successUrl,
              },
              checkout_data: {
                ...(typeof input.metadata?.email === 'string'
                  ? { email: input.metadata.email }
                  : {}),
                ...(typeof input.metadata?.name === 'string' ? { name: input.metadata.name } : {}),
                ...(typeof input.metadata?.taxNumber === 'string'
                  ? { tax_number: input.metadata.taxNumber }
                  : {}),
                ...(custom !== undefined ? { custom } : {}),
              },
            },
            relationships: {
              store: { data: { type: 'stores', id: this.#storeId } },
              variant: { data: { type: 'variants', id: String(input.planId) } },
            },
          },
        },
      },
    );
    const attributes = document.data.attributes;
    return {
      id: document.data.id,
      gatewayId: document.data.id,
      provider: this.provider,
      url: attributes.url,
      status: 'open',
      // No `amount`: the checkout response states a price but never a currency (the store
      // sets it), and this package will not invent one. The currency arrives on the
      // `order_created` webhook, where it is read off the order.
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  /**
   * Lemon Squeezy's API has no create-subscription endpoint: a subscription exists only
   * once a customer has completed a checkout for a subscription variant. Anything
   * returned here would be a subscription Lemon Squeezy has never heard of.
   */
  async createSubscription(_input: CreateSubscriptionInput): Promise<Subscription> {
    throw new Error(
      '[payments] Lemon Squeezy cannot create a subscription over the API — it creates ' +
        'one when a customer completes a checkout for a subscription variant. Call ' +
        "`createCheckout({ planId: '<variant id>' })` and read the id off the " +
        '`subscription_created` webhook.',
    );
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    if (options?.atPeriodEnd === false) {
      // Cancelling puts the subscription in `cancelled` and lets it run to `ends_at`;
      // there is no immediate-termination endpoint, and pretending otherwise would leave
      // a customer with access the caller believes was revoked.
      throw new Error(
        '[payments] Lemon Squeezy cancels at the end of the current billing period and ' +
          'has no immediate cancellation. Call `cancelSubscription(id)` without ' +
          '`atPeriodEnd: false`, and revoke access yourself on `ends_at`.',
      );
    }
    const document = await this.#request<JsonApiDocument<LemonSqueezySubscriptionAttributes>>(
      `/subscriptions/${encodeURIComponent(subscriptionGatewayId)}`,
      { method: 'DELETE' },
    );
    const subscription = this.#mapSubscription(document.data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  /**
   * The only change Lemon Squeezy accepts on a subscription that this contract can carry
   * is a plan swap, and it is expressed as a variant id — so it is read from
   * `metadata.variantId`. There is no writable amount (the price belongs to the variant),
   * no description, and no custom-data field; each is refused rather than dropped.
   */
  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'updateSubscription');
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Lemon Squeezy has no editable amount on a subscription — the price ' +
          'belongs to the variant. Swap plans with ' +
          "`updateSubscription(id, { metadata: { variantId: '<variant id>' } })`.",
      );
    }
    if (input.description !== undefined) {
      throw new Error('[payments] Lemon Squeezy subscriptions have no description field.');
    }
    const variantId = input.metadata?.variantId;
    if (variantId === undefined) {
      throw new Error(
        '[payments] Lemon Squeezy only accepts a plan swap here. Pass ' +
          '`metadata.variantId` with the variant to move the subscription to.',
      );
    }
    const document = await this.#request<JsonApiDocument<LemonSqueezySubscriptionAttributes>>(
      `/subscriptions/${encodeURIComponent(subscriptionGatewayId)}`,
      {
        method: 'PATCH',
        body: {
          data: {
            type: 'subscriptions',
            id: String(subscriptionGatewayId),
            attributes: {
              variant_id: Number(variantId),
              ...(input.metadata?.invoiceImmediately !== undefined
                ? { invoice_immediately: Boolean(input.metadata.invoiceImmediately) }
                : {}),
              ...(input.metadata?.disableProrations !== undefined
                ? { disable_prorations: Boolean(input.metadata.disableProrations) }
                : {}),
            },
          },
        },
      },
    );
    return this.#mapSubscription(document.data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const document = await this.#request<JsonApiDocument<LemonSqueezySubscriptionAttributes>>(
        `/subscriptions/${encodeURIComponent(gatewayId)}`,
      );
      return this.#mapSubscription(document.data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  /**
   * Lists the customer's **orders** — the receipts Lemon Squeezy issues for a purchase.
   * `GET /v1/orders` and `GET /v1/subscription-invoices` have no customer filter, so this
   * walks the customer's own `orders` relationship instead. Renewal charges live under
   * `/v1/subscription-invoices?filter[subscription_id]=…` and are not listed here.
   */
  async listInvoices(customerId: string): Promise<Invoice[]> {
    const collection = await this.#request<JsonApiCollection<LemonSqueezyOrderAttributes>>(
      `/customers/${encodeURIComponent(customerId)}/orders`,
    );
    return collection.data.map((resource) => {
      const order = resource.attributes;
      const statusMap: Record<LemonSqueezyOrderAttributes['status'], Invoice['status']> = {
        paid: 'paid',
        pending: 'open',
        failed: 'uncollectible',
        refunded: 'void',
      };
      return {
        id: resource.id,
        gatewayId: resource.id,
        provider: this.provider,
        ...(order.customer_id !== undefined ? { customerId: String(order.customer_id) } : {}),
        status: statusMap[order.status] ?? 'open',
        amount: { amount: order.total, currency: order.currency.toLowerCase() },
        createdAt: order.created_at ?? new Date().toISOString(),
        ...(order.urls?.receipt !== undefined ? { hostedPdfUrl: order.urls.receipt } : {}),
        ...(order.order_number !== undefined ? { number: String(order.order_number) } : {}),
        payload: order as unknown as Record<string, unknown>,
      };
    });
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * `parseWebhook` already refuses without the secret — declaring it moves the refusal to boot.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookSecret !== undefined ? 'configured' : 'unconfigured';
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (this.#webhookSecret === undefined) {
      throw new Error(
        '[payments] Lemon Squeezy webhook processing requires the signing secret set on ' +
          'the webhook in the dashboard. Set `LEMONSQUEEZY_WEBHOOK_SECRET` or pass ' +
          '`webhookSecret` to `payments.lemonsqueezy()`.',
      );
    }
    const signature = headerValue(headers, 'x-signature');
    if (signature === undefined || signature === '') {
      throw new Error('[payments] Missing `X-Signature` header on Lemon Squeezy webhook request.');
    }
    // HMAC-SHA256 over the raw body, sent as **hex**. The shared `verifyHmacSignature`
    // helper digests to base64, so it does not fit here.
    const expected = createHmac('sha256', this.#webhookSecret)
      .update(rawBody, 'utf8')
      .digest('hex');
    if (!safeCompare(signature, expected)) {
      throw new Error('[payments] Invalid Lemon Squeezy webhook signature.');
    }

    const payload = JSON.parse(rawBody) as LemonSqueezyWebhookPayload;
    const eventName = payload.meta?.event_name ?? 'unknown';
    return {
      id: this.#webhookEventId(eventName, payload),
      provider: this.provider,
      type: this.#mapWebhookType(eventName, payload),
      ...(typeof payload.data?.attributes?.created_at === 'string'
        ? { createdAt: payload.data.attributes.created_at }
        : {}),
      data: this.#mapWebhookData(eventName, payload),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(resource: JsonApiResource<LemonSqueezyCustomerAttributes>): Customer {
    const attributes = resource.attributes;
    return {
      id: resource.id,
      ...(attributes.email !== undefined ? { email: attributes.email } : {}),
      ...(attributes.name !== undefined ? { name: attributes.name } : {}),
    };
  }

  #mapPayment(resource: JsonApiResource<LemonSqueezyOrderAttributes>): Payment {
    const order = resource.attributes;
    const statusMap: Record<LemonSqueezyOrderAttributes['status'], Payment['status']> = {
      paid: 'paid',
      pending: 'pending',
      failed: 'failed',
      refunded: 'refunded',
    };
    const result: Payment = {
      id: resource.id,
      gatewayId: resource.id,
      provider: this.provider,
      // Already an integer of the smallest unit — no `fromDecimal` here.
      amount: { amount: order.total, currency: order.currency.toLowerCase() },
      status: order.refunded === true ? 'refunded' : (statusMap[order.status] ?? 'pending'),
      payload: order as unknown as Record<string, unknown>,
      createdAt: order.created_at ?? new Date().toISOString(),
    };
    if (order.customer_id !== undefined) result.customerId = String(order.customer_id);
    if (order.urls?.receipt !== undefined) result.hostedUrl = order.urls.receipt;
    // Lemon Squeezy has no `paid_at`: an order only exists once payment succeeded, so
    // `created_at` is the moment it was paid.
    if (order.status === 'paid' && order.created_at !== undefined) result.paidAt = order.created_at;
    return result;
  }

  #mapSubscription(resource: JsonApiResource<LemonSqueezySubscriptionAttributes>): Subscription {
    const attributes = resource.attributes;
    const statusMap: Record<LemonSqueezySubscriptionAttributes['status'], Subscription['status']> =
      {
        on_trial: 'trialing',
        active: 'active',
        past_due: 'past_due',
        unpaid: 'past_due',
        cancelled: 'canceled',
        expired: 'ended',
        // A paused Lemon Squeezy subscription still exists and will resume — but it is not
        // billing now, so reporting it as `active` entitled a subscriber who is not paying.
        paused: 'paused',
      };
    return {
      id: resource.id,
      gatewayId: resource.id,
      provider: this.provider,
      customerId: attributes.customer_id !== undefined ? String(attributes.customer_id) : '',
      status: statusMap[attributes.status] ?? 'active',
      planId: attributes.variant_id !== undefined ? String(attributes.variant_id) : '',
      // No `amount`: a Lemon Squeezy subscription object carries no price at all — the
      // price belongs to the variant, and the charged total only appears on each
      // subscription invoice.
      ...(attributes.trial_ends_at ? { trialEndsAt: attributes.trial_ends_at } : {}),
      ...(attributes.ends_at ? { endsAt: attributes.ends_at } : {}),
      // `renews_at` is the next collection date, i.e. the end of the current period.
      ...(attributes.renews_at ? { currentPeriodEnd: attributes.renews_at } : {}),
      payload: attributes as unknown as Record<string, unknown>,
      createdAt: attributes.created_at ?? new Date().toISOString(),
    };
  }

  #mapWebhookType(eventName: string, payload: LemonSqueezyWebhookPayload): string {
    switch (eventName) {
      case 'order_created': {
        // `order_created` fires for every order Lemon Squeezy records, including ones
        // that failed or were refunded before delivery — so the order's own status, not
        // the event name, decides what this means.
        const status = payload.data?.attributes?.status;
        if (status === 'refunded') return 'payment.refunded';
        if (status === 'failed') return 'payment.failed';
        if (status === 'paid') return 'payment.succeeded';
        return 'payment.updated';
      }
      case 'order_refunded':
      case 'subscription_payment_refunded':
        return 'payment.refunded';
      case 'subscription_payment_success':
      case 'subscription_payment_recovered':
        return 'payment.succeeded';
      case 'subscription_payment_failed':
        return 'payment.failed';
      case 'subscription_created':
        return 'subscription.created';
      case 'subscription_updated':
      case 'subscription_plan_changed':
      case 'subscription_paused':
      case 'subscription_unpaused':
      case 'subscription_resumed':
        return 'subscription.updated';
      case 'subscription_cancelled':
      case 'subscription_expired':
        return 'subscription.canceled';
      default:
        // `license_key_*`, `affiliate_activated`, `customer_updated` — passed through so an
        // app handler can subscribe by the Lemon Squeezy name.
        //
        // There is deliberately no dispute type here: **Lemon Squeezy has NO dispute or
        // chargeback event at all** — no warning, no chargeback, no resolution. The whole
        // catalogue is `order_created`, `order_refunded`, the `subscription_*` family and
        // `license_key_created` / `license_key_updated`; there is not even an
        // `order_updated`, so an order that Lemon Squeezy later marks `fraudulent` (its
        // status for a charged-back order) reaches this driver through no event whatsoever.
        //
        // That is the merchant-of-record bargain rather than an oversight: Lemon Squeezy is
        // the seller on the buyer's statement, the chargeback is raised against Lemon
        // Squeezy, and Lemon Squeezy "typically manages these disputes on behalf of the
        // seller", deducting the amount plus a $15 dispute fee from the next payout. There
        // is no deadline that belongs to you and no evidence you can file. Forcing an
        // unrelated event into `payment.disputed` would invent a notification that does not
        // exist; the honest answer is that the first you hear of a chargeback is the payout.
        return eventName;
    }
  }

  #mapWebhookData(eventName: string, payload: LemonSqueezyWebhookPayload): Record<string, unknown> {
    const resource = payload.data;
    const externalReference = this.#readExternalReference(payload.meta?.custom_data);
    const common = {
      ...(externalReference !== undefined ? { externalReference } : {}),
      ...(payload.meta?.test_mode !== undefined ? { testMode: payload.meta.test_mode } : {}),
    };
    if (resource?.type === 'subscriptions') {
      const subscription = this.#mapSubscription(
        resource as unknown as JsonApiResource<LemonSqueezySubscriptionAttributes>,
      );
      return {
        gatewayId: subscription.gatewayId,
        customerId: subscription.customerId,
        status: subscription.status,
        planId: subscription.planId,
        ...(subscription.endsAt !== undefined ? { endsAt: subscription.endsAt } : {}),
        ...common,
      };
    }
    if (resource?.type === 'subscription-invoices') {
      const invoice = resource.attributes as unknown as LemonSqueezySubscriptionInvoiceAttributes;
      return {
        gatewayId: resource.id,
        amount: invoice.total,
        currency: invoice.currency.toLowerCase(),
        ...(invoice.customer_id !== undefined ? { customerId: String(invoice.customer_id) } : {}),
        ...(invoice.subscription_id !== undefined
          ? { subscriptionId: String(invoice.subscription_id) }
          : {}),
        ...common,
      };
    }
    if (resource?.type === 'orders') {
      const payment = this.#mapPayment(
        resource as unknown as JsonApiResource<LemonSqueezyOrderAttributes>,
      );
      return {
        gatewayId: payment.gatewayId,
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
        ...common,
      };
    }
    return { gatewayId: resource?.id ?? '', eventName, ...common };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  /**
   * Lemon Squeezy webhooks carry no event id, so one is derived. `updated_at` is part of
   * it because two `subscription_updated` events for the same subscription are distinct
   * events, and an id without it would make the second look like a replay to the billing
   * layer's idempotency ledger.
   */
  #webhookEventId(eventName: string, payload: LemonSqueezyWebhookPayload): string {
    const updatedAt = payload.data?.attributes?.updated_at;
    const parts = [eventName, payload.data?.type ?? 'unknown', payload.data?.id ?? 'unknown'];
    if (typeof updatedAt === 'string') parts.push(updatedAt);
    return parts.join(':');
  }

  /**
   * The routing key is written to `checkout_data.custom.external_reference`, which Lemon
   * Squeezy echoes on every webhook for the resulting order and subscription as
   * `meta.custom_data`. `metadata.externalReference` is still honoured as a fallback for
   * callers written before `CheckoutInput.externalReference` existed.
   */
  #customData(input: CheckoutInput): Record<string, unknown> | undefined {
    const {
      email: _email,
      name: _name,
      taxNumber: _taxNumber,
      city: _city,
      region: _region,
      country: _country,
      externalReference: fromMetadata,
      ...rest
    } = input.metadata ?? {};
    const reference =
      input.externalReference ?? (typeof fromMetadata === 'string' ? fromMetadata : undefined);
    const custom = {
      ...rest,
      ...(reference !== undefined ? { external_reference: reference } : {}),
    };
    return Object.keys(custom).length > 0 ? custom : undefined;
  }

  #readExternalReference(
    customData: Record<string, unknown> | null | undefined,
  ): string | undefined {
    const value = customData?.external_reference;
    // Lemon Squeezy returns custom values as strings, but a number written at checkout
    // has been seen coming back as one — normalize rather than silently dropping the key.
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return undefined;
  }

  /**
   * Lemon Squeezy has **no request deduplication** — no `Idempotency-Key` header, no
   * request-id field on any endpoint. So a key handed to this driver is refused rather
   * than accepted and dropped: silently dropping it turns a caller's retry guarantee into
   * a second refund or a second checkout.
   */
  #refuseIdempotencyKey(key: string | undefined, operation: string): void {
    if (key === undefined) return;
    throw new Error(
      `[payments] Lemon Squeezy has no idempotency mechanism, so \`idempotencyKey\` cannot be honoured on ${operation}(). Its API deduplicates nothing, and a retried request performs the operation a second time — deduplicate on your side (persist the key and check it) before calling.`,
    );
  }

  #refuseTaxId(taxId: string | undefined): void {
    if (taxId === undefined) return;
    throw new Error(
      '[payments] Lemon Squeezy has no tax id on a customer — the buyer enters a tax ' +
        'number at checkout. Pass it as `metadata.taxNumber` on `createCheckout()`.',
    );
  }

  /**
   * JSON:API needs `Accept` and `Content-Type` of `application/vnd.api+json`, and the
   * shared `httpRequest` helper hardcodes `application/json` with no way to add headers —
   * so this driver does its own `fetch`, throwing the same `Error` with a `status`
   * property so `isNotFound` keeps working.
   */
  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    const requestInit: RequestInit = {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
    };
    if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);

    const response = await fetch(`${this.#baseUrl}${path}`, requestInit);
    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(
        new Error(`[payments] HTTP request failed (${response.status}): ${text}`),
        { status: response.status },
      );
    }
    return (await response.json()) as T;
  }
}
