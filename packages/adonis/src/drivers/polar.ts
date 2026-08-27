import {
  publishPaymentDiagnostics,
  publishRefundDiagnostics,
  publishSubscriptionDiagnostics,
} from '../diagnostics.js';
import type {
  ChargeInput,
  CheckoutInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  PaymentsDriver,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
} from '../driver.js';
import { headerValue, httpRequest, isNotFound } from '../http.js';
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
import { verifyStandardWebhookSignature } from '../webhook_security.js';
import { requireCredential, requireCurrency } from './shared.js';

export interface PolarDriverConfig {
  /** Organization Access Token (`polar_oat_...`). Defaults to `env.get('POLAR_ACCESS_TOKEN')`. */
  accessToken?: string;
  /**
   * Currency for checkouts that don't name one (lowercase ISO 4217). **Required** — Polar
   * sells worldwide and takes whatever you hand it, so a default here would be a guess at
   * which country the app charges in, and a wrong guess succeeds.
   */
  currency: string;
  /**
   * Use Polar's sandbox (`https://sandbox-api.polar.sh`). Defaults to
   * `NODE_ENV !== 'production'`. Sandbox tokens are not interchangeable with production
   * ones — the two environments hold separate organizations.
   */
  sandbox?: boolean;
  /**
   * Webhook signing secret from the endpoint's settings (`whsec_...`). Defaults to
   * `env.get('POLAR_WEBHOOK_SECRET')`. Required to parse Polar webhooks.
   */
  webhookSecret?: string;
}

/**
 * `GET/POST /v1/customers/`. Polar customers are a union of `individual` and `team`; the
 * driver only creates individuals, and both shapes share every field read here.
 */
interface PolarCustomer {
  id: string;
  email: string;
  name?: string | null;
  external_id?: string | null;
  /** Polar answers with a `[value, type]` pair, not the bare string that was sent. */
  tax_id?: Array<string | null> | string | null;
  metadata?: Record<string, unknown>;
}

/** `GET /v1/orders/{id}` — an order is the closest thing Polar has to a payment. */
interface PolarOrder {
  id: string;
  created_at: string;
  status: 'draft' | 'pending' | 'paid' | 'refunded' | 'partially_refunded' | 'void';
  paid: boolean;
  /** Everything the customer paid, tax included, in cents. */
  total_amount: number;
  refunded_amount: number;
  refundable_amount: number;
  currency: string;
  customer_id: string;
  product_id?: string | null;
  subscription_id?: string | null;
  checkout_id?: string | null;
  invoice_number?: string | null;
  is_invoice_generated?: boolean;
  metadata?: Record<string, unknown>;
}

/** `POST /v1/checkouts/`. */
interface PolarCheckout {
  id: string;
  url: string;
  status: 'open' | 'expired' | 'confirmed' | 'succeeded' | 'failed';
  total_amount: number;
  currency: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  product_id?: string | null;
  metadata?: Record<string, unknown>;
}

/** `GET/PATCH/DELETE /v1/subscriptions/{id}`. */
interface PolarSubscription {
  id: string;
  created_at: string;
  status:
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused';
  /** Recurring amount in cents, before tax. */
  amount: number;
  currency: string;
  recurring_interval: string;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_end?: string | null;
  cancel_at_period_end: boolean;
  canceled_at?: string | null;
  ends_at?: string | null;
  ended_at?: string | null;
  customer_id: string;
  product_id: string;
  metadata?: Record<string, unknown>;
}

/** `POST /v1/refunds/`. */
interface PolarRefund {
  id: string;
  created_at: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  amount: number;
  currency: string;
  order_id: string;
  customer_id: string;
  subscription_id?: string | null;
}

/** Every Polar list endpoint answers `{ items, pagination }`. */
interface PolarList<T> {
  items: T[];
}

/** The webhook envelope: `{ type, timestamp, data }` — note there is no id in the body. */
interface PolarWebhookPayload {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

/**
 * The API version this driver is written against, pinned on every request via
 * `Polar-Version`. Polar defaults to `2026-04` when the header is absent, so omitting it
 * would silently follow whatever Polar promotes to default next.
 */
const POLAR_API_VERSION = '2026-04';

/**
 * Polar driver — merchant-of-record billing for software (polar.sh), written against the
 * REST API (`https://api.polar.sh`, spec version `2026-04`) with `fetch`; the
 * `@polar-sh/sdk` peer dependency is deliberately not used.
 *
 * Polar sells on your behalf: it is the legal seller of record and handles sales tax/VAT
 * registration, calculation and remittance. That is a business arrangement the library
 * does not model — it only changes which driver you configure.
 *
 * The shape of the API follows from that. There is no "charge a card for an amount"
 * endpoint: everything starts from a **product** you created in Polar, and money moves
 * through a hosted checkout. So {@link PolarDriver.charge} refuses, and
 * {@link PolarDriver.createCheckout} is the way in.
 */
export class PolarDriver implements PaymentsDriver {
  readonly provider = 'polar';
  /**
   * Polar's checkout takes cards (plus the local methods it enables per country); the API
   * has no field to request one, so the driver can only say "a card checkout" and let
   * Polar present what it supports. Pix and boleto are not offered — nothing in the API
   * reference produces either.
   */
  readonly supportedMethods = ['credit_card', 'undefined'] as const;
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true };

  #baseUrl: string;
  #bearerToken: string;
  #currency: string;
  #webhookSecret: string | undefined;
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: PolarDriverConfig) {
    this.#invoiceCtx = ctx;
    this.#bearerToken = requireCredential({
      driver: 'polar',
      option: 'accessToken',
      env: 'POLAR_ACCESS_TOKEN',
      value: config.accessToken,
    });
    this.#currency = requireCurrency('polar', config.currency);
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
    this.#webhookSecret = config.webhookSecret ?? process.env.POLAR_WEBHOOK_SECRET;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    if (!input.email) {
      throw new Error(
        '[payments] Polar requires an email to create a customer — it is the identity Polar deduplicates on.',
      );
    }
    const data = await this.#request<PolarCustomer>('/v1/customers/', {
      method: 'POST',
      body: {
        email: input.email,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.taxId !== undefined ? { tax_id: input.taxId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<PolarCustomer>(
        `/v1/customers/${encodeURIComponent(customerId)}`,
      );
      return this.#mapCustomer(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const data = await this.#request<PolarCustomer>(
      `/v1/customers/${encodeURIComponent(customerId)}`,
      {
        method: 'PATCH',
        body: {
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.taxId !== undefined ? { tax_id: input.taxId } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      },
    );
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  /**
   * Polar has no endpoint that charges an amount. `POST /v1/orders/` exists but creates a
   * *draft* order for an off-session charge against a saved payment method, needs a second
   * `POST /v1/orders/{id}/finalize` call, and is gated behind the
   * `off_session_charges_enabled` feature flag — nothing a driver can rely on. Faking a
   * charge by opening a checkout and returning it as a settled `Payment` would report money
   * that has not moved, so this refuses instead.
   */
  async charge(_input: ChargeInput): Promise<Payment> {
    throw new Error(
      '[payments] Polar does not expose a direct charge endpoint — as a merchant of record it sells through its own checkout. ' +
        'Use `createCheckout({ planId: <polar product id>, successUrl })` and read the resulting order from the `order.paid` webhook.',
    );
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#request<PolarOrder>(`/v1/orders/${encodeURIComponent(gatewayId)}`);
      return this.#mapPayment(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Refund an order. `paymentGatewayId` is a Polar **order** id, because an order is what
   * this driver maps onto `Payment`.
   */
  async refund(paymentGatewayId: string, amount?: Money): Promise<Refund> {
    // `amount` is required by `POST /v1/refunds/` — a full refund has to name the figure,
    // so an omitted amount is resolved from the order's own `refundable_amount` rather
    // than guessed. Note it is the NET figure: Polar refunds the tax alongside it (in
    // full, or prorated for a partial refund), so this is not `total_amount`.
    let value = amount;
    if (value === undefined) {
      const order = await this.#request<PolarOrder>(
        `/v1/orders/${encodeURIComponent(paymentGatewayId)}`,
      );
      value = order.refundable_amount;
    }
    const data = await this.#request<PolarRefund>('/v1/refunds/', {
      method: 'POST',
      body: {
        order_id: paymentGatewayId,
        amount: value,
        // The driver is not told why the refund is happening, and Polar's enum has no
        // "merchant initiated" member, so `other` is the only honest choice.
        reason: 'other',
        revoke_benefits: false,
      },
    });
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      status:
        data.status === 'succeeded'
          ? 'succeeded'
          : data.status === 'pending'
            ? 'pending'
            : 'failed',
      createdAt: data.created_at,
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const productId = input.planId ?? (input.metadata?.productId as string | undefined);
    if (!productId) {
      throw new Error(
        '[payments] Polar checkout needs a product — pass the Polar product id as `planId` (or `metadata.productId`). ' +
          'Polar prices live on the product; there is no ad-hoc line item.',
      );
    }
    const metadata = this.#metadataWithReference(
      this.#withoutDriverKeys(input.metadata),
      input.externalReference,
    );
    const data = await this.#request<PolarCheckout>('/v1/checkouts/', {
      method: 'POST',
      body: {
        products: [productId],
        success_url: input.successUrl,
        // Polar has no cancel URL. `return_url` is the closest thing it offers: it puts a
        // back button on the checkout page pointing here.
        ...(input.cancelUrl !== undefined ? { return_url: input.cancelUrl } : {}),
        // "Amount in cents, before discounts and taxes. Only useful for custom prices,
        // it'll be ignored for fixed and free prices." — so this is safe to always send,
        // but it does NOT override a fixed product price.
        amount: input.amount,
        ...(input.currency !== undefined
          ? { currency: input.currency }
          : { currency: this.#currency }),
        ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
        ...(input.trialDays !== undefined
          ? { trial_interval: 'day', trial_interval_count: input.trialDays }
          : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    });
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      url: data.url,
      status: this.#mapCheckoutStatus(data.status),
      amount: { amount: data.total_amount, currency: data.currency.toLowerCase() },
      ...(data.customer_id ? { customerId: data.customer_id } : {}),
      ...(data.subscription_id ? { subscriptionId: data.subscription_id } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  /**
   * `POST /v1/subscriptions/` — Polar's own words: "This endpoint only allows to create
   * subscription on free products. For paid products, use the checkout flow." Anything the
   * contract carries that Polar cannot honor here is refused rather than dropped, because
   * a dropped `amount` is a subscription billing a price nobody chose.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Polar takes the subscription price from the product, so `amount` cannot be set on a subscription. ' +
          'Create the product with the price you want and pass its id as `planId`.',
      );
    }
    if (input.cycle !== undefined) {
      throw new Error(
        '[payments] Polar takes the billing interval from the product, so `cycle` cannot be set on a subscription. ' +
          'Create a product with the interval you want and pass its id as `planId`.',
      );
    }
    if (input.trialDays !== undefined) {
      throw new Error(
        '[payments] Polar sets trials on the checkout, not on `POST /v1/subscriptions/`. ' +
          'Pass `trialDays` to `createCheckout()` instead.',
      );
    }
    if (input.card !== undefined) {
      throw new Error(
        '[payments] Polar has no tokenized-card input — as a merchant of record it collects the card on its own checkout. ' +
          'Use `createCheckout({ planId })`.',
      );
    }
    const data = await this.#request<PolarSubscription>('/v1/subscriptions/', {
      method: 'POST',
      body: {
        product_id: input.planId,
        customer_id: input.customerId,
        metadata: this.#metadataWithReference(input.metadata, input.externalReference),
      },
    });
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const id = encodeURIComponent(subscriptionGatewayId);
    // Polar splits the two: PATCH `cancel_at_period_end` schedules the cancellation for
    // the end of the paid period; DELETE revokes access immediately.
    const data =
      options?.atPeriodEnd === false
        ? await this.#request<PolarSubscription>(`/v1/subscriptions/${id}`, { method: 'DELETE' })
        : await this.#request<PolarSubscription>(`/v1/subscriptions/${id}`, {
            method: 'PATCH',
            body: { cancel_at_period_end: true },
          });
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  /**
   * The only thing `PATCH /v1/subscriptions/{id}` can change about what a customer pays is
   * *which product* they are on — Polar has no price field on a subscription. So a plan
   * change is expressed as `metadata.productId`, and an `amount` is refused rather than
   * silently discarded.
   */
  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Polar has no subscription amount to update — the price belongs to the product. ' +
          'Switch plans with `updateSubscription(id, { metadata: { productId: <new polar product id> } })`.',
      );
    }
    if (input.description !== undefined) {
      throw new Error(
        '[payments] Polar subscriptions carry no description — the product supplies the name shown to the customer.',
      );
    }
    const productId = input.metadata?.productId as string | undefined;
    const prorationBehavior = input.metadata?.prorationBehavior as string | undefined;
    if (productId === undefined) {
      throw new Error(
        '[payments] Nothing to update on a Polar subscription. The only supported change is the plan: ' +
          'pass `metadata.productId` (optionally `metadata.prorationBehavior`).',
      );
    }
    const data = await this.#request<PolarSubscription>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionGatewayId)}`,
      {
        method: 'PATCH',
        body: {
          product_id: productId,
          ...(prorationBehavior !== undefined ? { proration_behavior: prorationBehavior } : {}),
        },
      },
    );
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<PolarSubscription>(
        `/v1/subscriptions/${encodeURIComponent(gatewayId)}`,
      );
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  /**
   * Polar's orders are its invoices — `invoice_number` is on the order itself. The PDF
   * lives behind a per-order `GET /v1/orders/{id}/invoice`, so `hostedPdfUrl` is left
   * unset here rather than firing one request per row.
   */
  async listInvoices(customerId: string): Promise<Invoice[]> {
    const data = await this.#request<PolarList<PolarOrder>>(
      `/v1/orders/?customer_id=${encodeURIComponent(customerId)}&limit=100`,
    );
    return (data.items ?? []).map((order) => ({
      id: order.id,
      gatewayId: order.id,
      provider: this.provider,
      customerId: order.customer_id,
      ...(order.subscription_id ? { subscriptionId: order.subscription_id } : {}),
      status: this.#mapInvoiceStatus(order.status),
      amount: { amount: order.total_amount, currency: order.currency.toLowerCase() },
      createdAt: order.created_at,
      ...(order.invoice_number ? { number: order.invoice_number } : {}),
      payload: order as unknown as Record<string, unknown>,
    }));
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (!this.#webhookSecret) {
      throw new Error(
        '[payments] Polar webhook processing requires a webhook secret. Set `POLAR_WEBHOOK_SECRET` env or pass `webhookSecret` to `payments.polar()`.',
      );
    }
    // Polar signs with Standard Webhooks, but its key derivation is NOT the spec default:
    // `@polar-sh/sdk` base64-*encodes* the secret before handing it to the reference
    // library, which base64-decodes it again — so the HMAC key is the secret's raw UTF-8
    // bytes, `whsec_` prefix and all. Decoding it as base64 (what Dodo and Svix do) would
    // reject every genuine Polar delivery.
    const id = this.#verifiedEventId(rawBody, headers, this.#webhookSecret);
    const payload = JSON.parse(rawBody) as PolarWebhookPayload;
    const data = payload.data ?? {};
    return {
      id,
      provider: this.provider,
      type: this.#mapWebhookType(payload.type),
      createdAt: payload.timestamp ?? new Date().toISOString(),
      data: this.#mapWebhookData(payload.type, data),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  /**
   * Verify the delivery and return the event id, which for Standard Webhooks lives in the
   * `webhook-id` header rather than the body — it is what the idempotency ledger
   * deduplicates on.
   *
   * `keyEncoding: 'raw'` is the Polar-specific half: the HMAC key is the secret's UTF-8
   * bytes verbatim, `whsec_` prefix included, NOT the spec's base64-decoded default.
   */
  #verifiedEventId(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): string {
    const id = headerValue(headers, 'webhook-id');
    if (
      id === undefined ||
      headerValue(headers, 'webhook-timestamp') === undefined ||
      headerValue(headers, 'webhook-signature') === undefined
    ) {
      throw new Error(
        '[payments] Missing Standard Webhooks headers on Polar request (webhook-id, webhook-timestamp, webhook-signature).',
      );
    }
    if (!verifyStandardWebhookSignature({ rawBody, headers, secret, keyEncoding: 'raw' })) {
      throw new Error('[payments] Invalid Polar webhook signature.');
    }
    return id;
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: PolarCustomer): Customer {
    // Polar answers `tax_id` as a `[number, type]` pair; the contract wants the number.
    const taxId = Array.isArray(data.tax_id) ? data.tax_id[0] : data.tax_id;
    return {
      id: data.id,
      email: data.email,
      ...(data.name ? { name: data.name } : {}),
      ...(taxId ? { taxId } : {}),
      ...(data.metadata !== undefined && Object.keys(data.metadata).length > 0
        ? { metadata: data.metadata }
        : {}),
    };
  }

  #mapPayment(data: PolarOrder): Payment {
    const statusMap: Record<string, Payment['status']> = {
      draft: 'pending',
      pending: 'pending',
      paid: 'paid',
      // A partial refund leaves the order settled; only a full one flips it to refunded.
      partially_refunded: 'paid',
      refunded: 'refunded',
      void: 'canceled',
    };
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: data.total_amount, currency: data.currency.toLowerCase() },
      status: statusMap[data.status] ?? 'pending',
      customerId: data.customer_id,
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at,
    };
    if (data.subscription_id) result.subscriptionId = data.subscription_id;
    // Polar exposes no settlement timestamp on the order, so a paid order dates its
    // payment from when the order was created rather than inventing a moment.
    if (data.paid) result.paidAt = data.created_at;
    return result;
  }

  #mapSubscription(data: PolarSubscription): Subscription {
    const statusMap: Record<string, Subscription['status']> = {
      incomplete: 'incomplete',
      incomplete_expired: 'ended',
      trialing: 'trialing',
      active: 'active',
      past_due: 'past_due',
      canceled: 'canceled',
      unpaid: 'past_due',
      // The shared contract has no paused state; a paused Polar subscription still exists
      // and still belongs to the customer, which is what `active` means to the billing
      // layer. Same choice the Stripe driver makes.
      paused: 'active',
    };
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customer_id,
      status: statusMap[data.status] ?? 'active',
      planId: data.product_id,
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      ...(data.trial_end ? { trialEndsAt: data.trial_end } : {}),
      ...((data.ends_at ?? data.ended_at)
        ? { endsAt: (data.ends_at ?? data.ended_at) as string }
        : {}),
      ...(data.current_period_start ? { currentPeriodStart: data.current_period_start } : {}),
      ...(data.current_period_end ? { currentPeriodEnd: data.current_period_end } : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at,
    };
  }

  #mapCheckoutStatus(status: PolarCheckout['status']): CheckoutSession['status'] {
    switch (status) {
      case 'succeeded':
        return 'complete';
      case 'expired':
      case 'failed':
        return 'expired';
      default:
        // `confirmed` means the payment is being processed — the session is not settled yet.
        return 'open';
    }
  }

  #mapInvoiceStatus(status: PolarOrder['status']): Invoice['status'] {
    switch (status) {
      case 'paid':
      case 'partially_refunded':
      case 'refunded':
        return 'paid';
      case 'pending':
        return 'pending';
      case 'void':
        return 'void';
      default:
        return 'draft';
    }
  }

  #mapWebhookType(event: string): string {
    switch (event) {
      case 'order.paid':
        return 'payment.succeeded';
      case 'order.refunded':
      case 'refund.created':
        return 'payment.refunded';
      case 'order.created':
      case 'order.updated':
      case 'refund.updated':
        return 'payment.updated';
      case 'subscription.created':
        return 'subscription.created';
      case 'subscription.active':
      case 'subscription.updated':
      case 'subscription.uncanceled':
      case 'subscription.past_due':
      // `cycled` is the renewal event, and it fires whether or not the renewal payment
      // succeeded — before the renewal order exists. It is a subscription state change,
      // not a payment.
      case 'subscription.cycled':
      case 'subscription.paused':
      case 'subscription.resumed':
        return 'subscription.updated';
      case 'subscription.canceled':
      case 'subscription.revoked':
        return 'subscription.canceled';
      default:
        // checkout.*, customer.*, benefit*.*, product.*, organization.* — passed through so
        // an app handler can subscribe to them by their Polar name.
        return event;
    }
  }

  /**
   * Normalize the event body onto the shapes the billing layer's built-in sync expects.
   * `externalReference` comes back out of `metadata.external_reference`, which Polar copies
   * from the checkout onto the resulting order and subscription.
   */
  #mapWebhookData(event: string, data: Record<string, unknown>): Record<string, unknown> {
    if (event.startsWith('order.')) {
      const order = data as unknown as PolarOrder;
      return {
        gatewayId: order.id,
        amount: order.total_amount,
        currency: (order.currency ?? this.#currency).toLowerCase(),
        customerId: order.customer_id,
        ...(order.subscription_id ? { subscriptionId: order.subscription_id } : {}),
        ...this.#referenceFrom(order.metadata),
      };
    }
    if (event.startsWith('refund.')) {
      const refund = data as unknown as PolarRefund;
      // Keyed by the ORDER, not the refund: the order is what this driver reports as the
      // payment, so it is the row an app handler has to find.
      return {
        gatewayId: refund.order_id,
        amount: refund.amount,
        currency: (refund.currency ?? this.#currency).toLowerCase(),
        customerId: refund.customer_id,
        ...(refund.subscription_id ? { subscriptionId: refund.subscription_id } : {}),
      };
    }
    if (event.startsWith('subscription.')) {
      const subscription = data as unknown as PolarSubscription;
      const mapped = this.#mapSubscription(subscription);
      return {
        gatewayId: mapped.gatewayId,
        customerId: mapped.customerId,
        status: mapped.status,
        planId: mapped.planId,
        ...(mapped.trialEndsAt !== undefined ? { trialEndsAt: mapped.trialEndsAt } : {}),
        ...(mapped.endsAt !== undefined ? { endsAt: mapped.endsAt } : {}),
        ...this.#referenceFrom(subscription.metadata),
      };
    }
    return data;
  }

  #referenceFrom(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
    const reference = metadata?.external_reference;
    return {
      ...(typeof reference === 'string' ? { externalReference: reference } : {}),
      ...(metadata !== undefined && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }

  /**
   * Polar echoes checkout/subscription `metadata` on the order and subscription it
   * produces, which makes it the only place `externalReference` can survive the round
   * trip to a webhook.
   */
  #metadataWithReference(
    metadata: Record<string, unknown> | undefined,
    externalReference: string | undefined,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      ...(externalReference !== undefined ? { external_reference: externalReference } : {}),
    };
  }

  /** Drop the keys this driver reads as arguments, so they don't leak into Polar metadata. */
  #withoutDriverKeys(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
    const { productId: _productId, ...rest } = metadata ?? {};
    return rest;
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      bearerToken: this.#bearerToken,
      headers: { 'Polar-Version': POLAR_API_VERSION },
    });
  }
}
