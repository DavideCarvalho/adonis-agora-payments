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
import { safeCompare } from '../webhook_security.js';
import { requireCredential, requireCurrency } from './shared.js';

/**
 * Config for {@link PaddleDriver} (`payments.paddle({ … })`).
 *
 * Declared here rather than in `define_config.ts` so the driver module is self-contained;
 * `define_config.ts` re-exports it alongside the factory.
 */
export interface PaddleDriverConfig {
  /**
   * Paddle API key (`pdl_live_apikey_…` / `pdl_sdbx_apikey_…`). Defaults to
   * `env.get('PADDLE_API_KEY')`.
   */
  apiKey?: string;
  /**
   * Currency for checkouts that don't name one (lowercase ISO 4217). **Required** —
   * Paddle bills in whatever currency the transaction names, so a default here would be a
   * guess at which country the app sells in, and a wrong guess succeeds silently.
   */
  currency: string;
  /** Use the Paddle sandbox (`sandbox-api.paddle.com`). Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
  /**
   * Paddle product id (`pro_…`) that non-catalog checkout prices are created against —
   * needed only for `createCheckout` calls that pass an `amount` instead of a `planId`.
   * Defaults to `env.get('PADDLE_PRODUCT_ID')`.
   */
  productId?: string;
  /**
   * Notification setting secret key (`pdl_ntfset_…`) that signs `Paddle-Signature`.
   * Defaults to `env.get('PADDLE_WEBHOOK_SECRET')`. Required to parse Paddle webhooks —
   * Paddle always signs, so there is no unsigned mode to fall back to.
   */
  webhookSecret?: string;
  /**
   * Reject webhooks whose signature timestamp is older than this many seconds. Off by
   * default: the HMAC already authenticates the request, Paddle documents the timestamp
   * check as optional, and the billing layer deduplicates on the event id — so a default
   * window would only ever discard real money events on a retry or a skewed clock.
   */
  webhookMaxAgeSeconds?: number;
}

/** Paddle wraps every response in `{ data, meta }`. */
interface PaddleEnvelope<T> {
  data: T;
}

interface PaddleCustomerResponse {
  id: string;
  name?: string | null;
  email: string;
  status?: string;
  custom_data?: Record<string, unknown> | null;
  created_at?: string;
}

/**
 * Paddle money: a **string** in the currency's smallest unit, with the currency named
 * separately in `currency_code`. `"1990"` + `"USD"` is $19.90 — the amount is never a
 * decimal and never carries its own currency.
 */
interface PaddleTotals {
  subtotal?: string;
  discount?: string;
  tax?: string;
  total?: string;
  credit?: string;
  balance?: string;
  grand_total?: string;
  fee?: string | null;
  earnings?: string | null;
  currency_code: string;
}

interface PaddleTransactionResponse {
  id: string;
  status: 'draft' | 'ready' | 'billed' | 'paid' | 'completed' | 'canceled' | 'past_due';
  customer_id?: string | null;
  subscription_id?: string | null;
  invoice_id?: string | null;
  invoice_number?: string | null;
  currency_code: string;
  origin?: string;
  custom_data?: Record<string, unknown> | null;
  collection_mode?: 'automatic' | 'manual';
  checkout?: { url?: string | null } | null;
  details?: { totals?: PaddleTotals; line_items?: Array<{ id?: string }> };
  payments?: Array<{ status?: string; method_details?: { type?: string } }>;
  billed_at?: string | null;
  created_at?: string;
}

interface PaddleSubscriptionResponse {
  id: string;
  status: 'active' | 'canceled' | 'past_due' | 'paused' | 'trialing';
  customer_id: string;
  currency_code?: string;
  custom_data?: Record<string, unknown> | null;
  items?: Array<{
    price?: { id?: string; unit_price?: { amount?: string; currency_code?: string } };
  }>;
  current_billing_period?: { starts_at?: string; ends_at?: string } | null;
  trial_dates?: { starts_at?: string; ends_at?: string } | null;
  scheduled_change?: { action?: string; effective_at?: string } | null;
  created_at?: string;
  canceled_at?: string | null;
}

/**
 * Paddle expresses a refund, a credit **and the entire dispute lifecycle** as the same
 * resource. `action` is what separates them, and `adjustment.created` is the only
 * notification a Paddle seller gets about a chargeback at all — Paddle Billing has no
 * `dispute.*` event.
 */
interface PaddleAdjustmentResponse {
  id: string;
  /**
   * `credit`, `refund`, `chargeback`, `chargeback_reverse`, `chargeback_warning`,
   * `chargeback_warning_reverse`, `credit_reverse`. Left as `string` because Paddle adds
   * actions and an unknown one must fall through to `payment.updated`, not fail to compile.
   */
  action: string;
  transaction_id: string;
  status: 'pending_approval' | 'approved' | 'rejected' | 'reversed';
  /** Why the adjustment was created. Paddle fills it in on the ones it creates itself. */
  reason?: string | null;
  totals?: { total?: string; currency_code?: string };
  created_at?: string;
}

interface PaddleWebhookPayload {
  event_id: string;
  event_type: string;
  occurred_at?: string;
  notification_id?: string;
  data: Record<string, unknown>;
}

/**
 * Paddle driver — **Paddle Billing** (the v2 API on `api.paddle.com`), not the deprecated
 * Paddle Classic vendors API. Paddle is a merchant of record: it is the seller on the
 * customer's statement, calculates and remits sales tax/VAT worldwide, and pays you out.
 * You are selling to Paddle; Paddle is selling to your customer.
 *
 * The consequence for this driver is that Paddle never moves money on a server-side API
 * call. There is no create-and-capture endpoint: every payment is collected by Paddle
 * Checkout (or by a Paddle-issued invoice), so `charge()` throws and `createCheckout()` is
 * the entry point. Subscriptions likewise cannot be created over the API — Paddle creates
 * one when a customer completes a checkout for a recurring price.
 *
 * REST via `fetch`; no SDK peer dependency. Paddle signs webhooks with HMAC-SHA256 over
 * `<ts>:<raw body>`, which is a few lines of `node:crypto`.
 */
export class PaddleDriver implements PaymentsDriver {
  readonly provider = 'paddle';
  /**
   * Paddle Checkout decides which methods to offer from the buyer's country and your
   * account settings; the API takes no payment-method argument on a transaction. So the
   * only honest canonical name is `'undefined'` — "the customer chooses at checkout".
   * Routing `credit_card` here is refused by the manager, which is correct: this driver
   * cannot promise the charge will be a card.
   */
  readonly supportedMethods = ['undefined'] as const;
  /**
   * `disputes: false`, and on Paddle that is not a gap — it is the product. "The Paddle
   * team contests chargebacks for you", and Paddle's own risk-prevention page says the
   * defense "is fully automated, and additional evidence submitted by sellers is not
   * required or accepted". There is nothing for `submitDisputeEvidence` to submit and no
   * dispute resource to read: Paddle exposes chargebacks only as adjustments.
   */
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true, disputes: false };

  #baseUrl: string;
  #apiKey: string;
  #currency: string;
  #productId: string | undefined;
  #webhookSecret: string | undefined;
  #webhookMaxAgeSeconds: number | undefined;

  constructor(_ctx: EmitInvoiceContext, config: PaddleDriverConfig) {
    this.#apiKey = requireCredential({
      driver: 'paddle',
      option: 'apiKey',
      env: 'PADDLE_API_KEY',
      value: config.apiKey,
    });
    // Paddle bills in whatever currency the transaction names, so there is no safe
    // default — the same reasoning as Stripe.
    this.#currency = requireCurrency('paddle', config.currency);
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    this.#productId = config.productId ?? process.env.PADDLE_PRODUCT_ID;
    // An empty env var is "unset", not "a secret that can never match" — otherwise a
    // blank `PADDLE_WEBHOOK_SECRET` fails every webhook with a signature error instead of
    // the message telling you to configure it.
    const webhookSecret = config.webhookSecret ?? process.env.PADDLE_WEBHOOK_SECRET;
    this.#webhookSecret = webhookSecret === '' ? undefined : webhookSecret;
    this.#webhookMaxAgeSeconds = config.webhookMaxAgeSeconds;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCustomer');
    if (input.email === undefined) {
      throw new Error('[payments] Paddle requires an email to create a customer.');
    }
    this.#refuseTaxId(input.taxId);
    const body: Record<string, unknown> = {
      email: input.email,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { custom_data: input.metadata } : {}),
    };
    const { data } = await this.#request<PaddleEnvelope<PaddleCustomerResponse>>('/customers', {
      method: 'POST',
      body,
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const { data } = await this.#request<PaddleEnvelope<PaddleCustomerResponse>>(
        `/customers/${encodeURIComponent(customerId)}`,
      );
      return this.#mapCustomer(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    this.#refuseTaxId(input.taxId);
    const body: Record<string, unknown> = {
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { custom_data: input.metadata } : {}),
    };
    const { data } = await this.#request<PaddleEnvelope<PaddleCustomerResponse>>(
      `/customers/${encodeURIComponent(customerId)}`,
      { method: 'PATCH', body },
    );
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  /**
   * Paddle has no endpoint that takes money. `POST /transactions` creates an unpaid
   * record whose only route to payment is the checkout URL it returns — which is exactly
   * what {@link createCheckout} does. Returning a `Payment` here would advertise a capture
   * that never happened.
   */
  async charge(_input: ChargeInput): Promise<Payment> {
    throw new Error(
      '[payments] Paddle cannot charge server-side — as merchant of record it collects ' +
        'every payment through Paddle Checkout. Use `createCheckout()` and act on the ' +
        '`transaction.completed` webhook.',
    );
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const { data } = await this.#request<PaddleEnvelope<PaddleTransactionResponse>>(
        `/transactions/${encodeURIComponent(gatewayId)}`,
      );
      return this.#mapPayment(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Refunds are adjustments (`POST /adjustments` with `action: 'refund'`). A full refund
   * needs no line items; a partial one is expressed **per line item**, which `amount`
   * alone cannot address — so a partial refund is only attempted when the transaction has
   * exactly one line item, and refuses otherwise rather than refunding the wrong line.
   *
   * On a live account most refunds come back `pending_approval` until Paddle reviews them,
   * so a `'pending'` status here is normal and not a failure.
   *
   * `options.idempotencyKey` is REFUSED, not ignored: Paddle deduplicates nothing, so
   * accepting the key would turn a caller's retry guarantee into a second refund.
   */
  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    this.#refuseIdempotencyKey(options?.idempotencyKey, 'refund');
    const body: Record<string, unknown> = {
      action: 'refund',
      transaction_id: paymentGatewayId,
      reason: 'Requested via @adonis-agora/payments',
    };
    if (amount === undefined) {
      body.type = 'full';
    } else {
      const { data: transaction } = await this.#request<PaddleEnvelope<PaddleTransactionResponse>>(
        `/transactions/${encodeURIComponent(paymentGatewayId)}`,
      );
      const lineItems = transaction.details?.line_items ?? [];
      const itemId = lineItems.length === 1 ? lineItems[0]?.id : undefined;
      if (itemId === undefined) {
        throw new Error(
          `[payments] Paddle refunds a partial amount per transaction line item, and transaction "${paymentGatewayId}" has ${lineItems.length} of them. Refund the full transaction (omit \`amount\`), or create the adjustment yourself with the item ids you want to refund.`,
        );
      }
      body.type = 'partial';
      // Same string-of-smallest-unit rule as the unit price above — not a decimal.
      body.items = [{ item_id: itemId, type: 'partial', amount: String(amount) }];
    }
    const { data } = await this.#request<PaddleEnvelope<PaddleAdjustmentResponse>>('/adjustments', {
      method: 'POST',
      body,
    });
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: {
        amount: this.#toCents(data.totals?.total) ?? amount ?? 0,
        currency: (data.totals?.currency_code ?? this.#currency).toLowerCase(),
      },
      status:
        data.status === 'approved'
          ? 'succeeded'
          : data.status === 'pending_approval'
            ? 'pending'
            : 'failed',
      createdAt: data.created_at ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a transaction and hands back the Paddle Checkout URL that pays it. Pass
   * `planId` to sell a catalog price (the only way to start a subscription); without one
   * the driver builds a non-catalog price against `productId`, so nothing is written to
   * your catalog per checkout.
   */
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCheckout');
    if (input.trialDays !== undefined) {
      // A Paddle trial lives on the price (`trial_period`), not on the transaction.
      // Accepting the option here would bill a customer who was promised a trial.
      throw new Error(
        '[payments] Paddle configures trials on the price (`trial_period`), not per ' +
          'checkout. Create a price with a trial period and pass its id as `planId`.',
      );
    }
    const currency = (input.currency ?? this.#currency).toUpperCase();
    const items =
      input.planId !== undefined ? this.#catalogItem(input) : this.#adHocItem(input, currency);
    const customData = this.#customData(input);
    const body: Record<string, unknown> = {
      items,
      currency_code: currency,
      collection_mode: 'automatic',
      ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
      ...(customData !== undefined ? { custom_data: customData } : {}),
      // Paddle's `checkout.url` is where the checkout *opens* (your page hosting
      // Paddle.js), not a post-payment redirect: Paddle returns it with `?_ptxn=<id>`
      // appended. `successUrl` is the only URL slot the shared input has, so it is used
      // for that unless `metadata.checkoutUrl` names the hosting page explicitly.
      checkout: { url: (input.metadata?.checkoutUrl as string | undefined) ?? input.successUrl },
    };
    const { data } = await this.#request<PaddleEnvelope<PaddleTransactionResponse>>(
      '/transactions',
      { method: 'POST', body },
    );
    const total = this.#toCents(data.details?.totals?.total);
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      url: data.checkout?.url ?? '',
      status: this.#mapCheckoutStatus(data.status),
      ...(total !== undefined
        ? { amount: { amount: total, currency: data.currency_code.toLowerCase() } }
        : {}),
      ...(data.subscription_id ? { subscriptionId: data.subscription_id } : {}),
      ...(data.customer_id ? { customerId: data.customer_id } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  /**
   * Paddle's API has no create-subscription endpoint: a subscription exists only once a
   * customer has completed a checkout (or a manually-collected invoice) for a recurring
   * price. Anything returned here would be a subscription Paddle has never heard of.
   */
  async createSubscription(_input: CreateSubscriptionInput): Promise<Subscription> {
    throw new Error(
      '[payments] Paddle cannot create a subscription over the API — it creates one when ' +
        'a customer completes a checkout for a recurring price. Call ' +
        "`createCheckout({ planId: '<paddle price id>' })` and read the id off the " +
        '`subscription.created` webhook.',
    );
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const { data } = await this.#request<PaddleEnvelope<PaddleSubscriptionResponse>>(
      `/subscriptions/${encodeURIComponent(subscriptionGatewayId)}/cancel`,
      {
        method: 'POST',
        body: {
          effective_from: options?.atPeriodEnd === false ? 'immediately' : 'next_billing_period',
        },
      },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  /**
   * Only `metadata` is writable. Paddle has no amount on a subscription — the price is a
   * catalog object and you change what a customer pays by swapping `items[].price_id`,
   * which the shared input has no room for — and no description field at all. Both are
   * refused instead of being dropped on the floor.
   */
  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'updateSubscription');
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Paddle has no editable amount on a subscription — you change what a ' +
          'customer pays by swapping the price on `items[].price_id`. Update the ' +
          'subscription items directly (`PATCH /subscriptions/{id}`) with a ' +
          '`proration_billing_mode`.',
      );
    }
    if (input.description !== undefined) {
      throw new Error('[payments] Paddle subscriptions have no description field.');
    }
    const { data } = await this.#request<PaddleEnvelope<PaddleSubscriptionResponse>>(
      `/subscriptions/${encodeURIComponent(subscriptionGatewayId)}`,
      { method: 'PATCH', body: { custom_data: input.metadata ?? {} } },
    );
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const { data } = await this.#request<PaddleEnvelope<PaddleSubscriptionResponse>>(
        `/subscriptions/${encodeURIComponent(gatewayId)}`,
      );
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  /**
   * Paddle has no invoice-list endpoint: a **billed or completed transaction is** the
   * invoice — it carries the `invoice_number` that is the legal record. So this lists the
   * customer's billed and completed transactions and maps them onto {@link Invoice}.
   */
  async listInvoices(customerId: string): Promise<Invoice[]> {
    const { data } = await this.#request<{ data: PaddleTransactionResponse[] }>(
      `/transactions?customer_id=${encodeURIComponent(customerId)}&status=billed,completed`,
    );
    return data.map((transaction) => {
      const total = this.#toCents(transaction.details?.totals?.total) ?? 0;
      return {
        id: transaction.id,
        gatewayId: transaction.id,
        provider: this.provider,
        ...(transaction.customer_id ? { customerId: transaction.customer_id } : {}),
        ...(transaction.subscription_id ? { subscriptionId: transaction.subscription_id } : {}),
        status: transaction.status === 'completed' ? ('paid' as const) : ('open' as const),
        amount: { amount: total, currency: transaction.currency_code.toLowerCase() },
        createdAt: transaction.created_at ?? new Date().toISOString(),
        ...(transaction.invoice_number ? { number: transaction.invoice_number } : {}),
        ...(transaction.billed_at ? { issuedAt: transaction.billed_at } : {}),
        payload: transaction as unknown as Record<string, unknown>,
      };
    });
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (this.#webhookSecret === undefined) {
      throw new Error(
        '[payments] Paddle webhook processing requires the notification setting secret ' +
          '(`pdl_ntfset_…`). Set `PADDLE_WEBHOOK_SECRET` or pass `webhookSecret` to ' +
          '`payments.paddle()`.',
      );
    }
    const header = headerValue(headers, 'paddle-signature');
    if (header === undefined || header === '') {
      throw new Error('[payments] Missing `Paddle-Signature` header on webhook request.');
    }
    const { ts, h1 } = this.#parseSignatureHeader(header);
    // Paddle signs `<ts>:<raw body>` with HMAC-SHA256 and sends the digest as hex. The
    // shared `verifyHmacSignature` helper digests to base64, so it does not fit here.
    const expected = createHmac('sha256', this.#webhookSecret)
      .update(`${ts}:${rawBody}`, 'utf8')
      .digest('hex');
    if (!safeCompare(h1, expected)) {
      throw new Error('[payments] Invalid Paddle webhook signature.');
    }
    // Replay protection is opt-in. Paddle documents the timestamp check as optional and
    // its own SDK rejects anything older than five seconds — a default that tight would
    // drop real money events on a retry or a skewed clock, and the billing layer already
    // deduplicates on `event_id`.
    if (this.#webhookMaxAgeSeconds !== undefined) {
      const age = Math.abs(Date.now() / 1000 - Number(ts));
      if (!Number.isFinite(age) || age > this.#webhookMaxAgeSeconds) {
        throw new Error('[payments] Paddle webhook timestamp is outside the accepted window.');
      }
    }

    const payload = JSON.parse(rawBody) as PaddleWebhookPayload;
    // Mapped once and passed down: the normalized type decides which dispute fields the
    // payload carries, so deriving it twice invites the two halves to disagree.
    const type = this.#mapWebhookType(payload.event_type, payload.data);
    return {
      id: payload.event_id,
      provider: this.provider,
      type,
      ...(payload.occurred_at !== undefined ? { createdAt: payload.occurred_at } : {}),
      data: this.#mapWebhookData(payload, type),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: PaddleCustomerResponse): Customer {
    return {
      id: data.id,
      email: data.email,
      ...(data.name ? { name: data.name } : {}),
      ...(data.custom_data ? { metadata: data.custom_data } : {}),
    };
  }

  #mapPayment(data: PaddleTransactionResponse): Payment {
    const statusMap: Record<PaddleTransactionResponse['status'], Payment['status']> = {
      draft: 'pending',
      ready: 'pending',
      billed: 'pending',
      paid: 'paid',
      completed: 'paid',
      canceled: 'canceled',
      past_due: 'failed',
    };
    // `total` is what this transaction is worth. `grand_total` can differ once credits or
    // a customer balance are involved; it stays available on `payment.payload`.
    const total = this.#toCents(data.details?.totals?.total) ?? 0;
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: total, currency: data.currency_code.toLowerCase() },
      status: statusMap[data.status] ?? 'pending',
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at ?? new Date().toISOString(),
    };
    if (data.customer_id) result.customerId = data.customer_id;
    if (data.subscription_id) result.subscriptionId = data.subscription_id;
    if (data.checkout?.url) result.hostedUrl = data.checkout.url;
    // Paddle reports the instrument only after an attempt. Every one of them now has a
    // category name, so PayPal, Apple Pay, iDEAL and the rest stop collapsing into silence.
    const method = this.#mapMethodType(data.payments?.[0]?.method_details?.type);
    if (method !== undefined) result.method = method;
    // Paddle has no "paid at": `billed_at` is when the invoice was raised, which for an
    // automatically-collected transaction is the moment it was paid.
    if ((data.status === 'paid' || data.status === 'completed') && data.billed_at) {
      result.paidAt = data.billed_at;
    }
    return result;
  }

  #mapSubscription(data: PaddleSubscriptionResponse): Subscription {
    const statusMap: Record<PaddleSubscriptionResponse['status'], Subscription['status']> = {
      active: 'active',
      trialing: 'trialing',
      past_due: 'past_due',
      canceled: 'canceled',
      // A paused Paddle subscription still exists and will bill again — but it is not
      // billing NOW, so reporting it as `active` entitled a subscriber who is not paying.
      paused: 'paused',
    };
    const item = data.items?.[0];
    const unitAmount = this.#toCents(item?.price?.unit_price?.amount);
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customer_id,
      status: statusMap[data.status] ?? 'active',
      planId: item?.price?.id ?? '',
      ...(unitAmount !== undefined
        ? {
            amount: {
              amount: unitAmount,
              currency: (
                item?.price?.unit_price?.currency_code ??
                data.currency_code ??
                this.#currency
              ).toLowerCase(),
            },
          }
        : {}),
      ...(data.trial_dates?.ends_at ? { trialEndsAt: data.trial_dates.ends_at } : {}),
      ...(data.canceled_at ? { endsAt: data.canceled_at } : {}),
      ...(data.current_billing_period?.starts_at
        ? { currentPeriodStart: data.current_billing_period.starts_at }
        : {}),
      ...(data.current_billing_period?.ends_at
        ? { currentPeriodEnd: data.current_billing_period.ends_at }
        : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at ?? new Date().toISOString(),
    };
  }

  #mapWebhookType(eventType: string, data: Record<string, unknown>): string {
    switch (eventType) {
      case 'transaction.completed':
      case 'transaction.paid':
        return 'payment.succeeded';
      case 'transaction.payment_failed':
        return 'payment.failed';
      case 'transaction.created':
      case 'transaction.updated':
      case 'transaction.ready':
      case 'transaction.billed':
      case 'transaction.canceled':
      case 'transaction.past_due':
      case 'transaction.revised':
        return 'payment.updated';
      case 'adjustment.created':
      case 'adjustment.updated': {
        // Paddle has no `dispute.*` event — checked against the current event-type
        // reference, not from memory. A chargeback IS an adjustment, and `action` is the
        // whole dispute vocabulary. (`developer.paddle.com/webhook-reference/
        // risk-dispute-alerts/*` is Paddle CLASSIC; this driver is Paddle Billing.)
        if (data.action === 'refund') return 'payment.refunded';
        // Only the CREATED event is a dispute moment. `adjustment.updated` fires for the
        // approval lifecycle of an adjustment that already exists, and a second
        // `payment.disputed` for the same chargeback is noise.
        if (eventType === 'adjustment.created') {
          const type = this.#disputeType(data.action);
          if (type !== undefined) return type;
        }
        // `credit`, `credit_reverse`, and every later status change on a chargeback
        // adjustment.
        return 'payment.updated';
      }
      case 'subscription.created':
      case 'subscription.imported':
        return 'subscription.created';
      case 'subscription.activated':
      case 'subscription.updated':
      case 'subscription.trialing':
      case 'subscription.past_due':
      case 'subscription.paused':
      case 'subscription.resumed':
        return 'subscription.updated';
      case 'subscription.canceled':
        return 'subscription.canceled';
      default:
        return eventType;
    }
  }

  /**
   * An adjustment `action` → the canonical dispute type, or `undefined` when the action
   * is not part of the dispute family.
   *
   * **`chargeback_warning` is not a funds-untouched warning.** That is the whole finding
   * here, and it runs the opposite way to Stripe's inquiry and Adyen's
   * `NOTIFICATION_OF_CHARGEBACK`, both of which leave the money in the account. Paddle is
   * the merchant of record, so it does not tell you a chargeback is coming and wait for
   * you to act — it acts. Paddle's own words: "If an early-stage dispute is detected, a
   * `chargeback_warning` adjustment is created. The disputed amount is refunded, and a
   * service fee is applied", and an adjustment is a money movement by definition —
   * `chargeback_reverse` exists to "return the amount **held**".
   *
   * So both `chargeback` and `chargeback_warning` are `payment.disputed`: the revenue is
   * gone in both, and mapping the warning to `payment.dispute_warning` — which writes
   * nothing — would leave a row saying `paid` over money Paddle has already refunded to
   * the buyer. Paddle sends no funds-untouched pre-dispute notification at all, and this
   * driver does not invent one.
   *
   * The `*_reverse` pair is the money coming back. Paddle spells it out for
   * `chargeback_reverse` ("Where a chargeback is contested successfully, Paddle creates an
   * adjustment with the type `chargeback_reverse` to return the amount held"); for
   * `chargeback_warning_reverse` the reference says only "Reversal of a chargeback
   * warning", so `won` is read from the reversal symmetry Paddle's own naming sets up —
   * every `*_reverse` action undoes its counterpart. Both are `won` because both put the
   * amount back, and leaving the row at `disputed` would write off money that returned.
   */
  #disputeType(action: unknown): string | undefined {
    if (action === 'chargeback' || action === 'chargeback_warning') return 'payment.disputed';
    if (action === 'chargeback_reverse' || action === 'chargeback_warning_reverse') {
      return 'payment.dispute_closed';
    }
    return undefined;
  }

  /**
   * The fields that make a dispute event actionable, added only to the dispute types.
   *
   * There is deliberately no `actionableUntil`: Paddle accepts no evidence from sellers,
   * so there is no response window that belongs to you, and no adjustment field carries
   * one. The deadline on a Paddle chargeback is Paddle's, and the honest normalized event
   * is one that does not pretend otherwise.
   */
  #disputeExtras(adjustment: PaddleAdjustmentResponse, type: string): Record<string, unknown> {
    if (type !== 'payment.disputed' && type !== 'payment.dispute_closed') return {};
    return {
      // The adjustment IS the dispute here; Paddle has no separate dispute resource.
      disputeId: adjustment.id,
      ...(adjustment.reason ? { reason: adjustment.reason } : {}),
      ...(type === 'payment.dispute_closed' ? { outcome: 'won' as const } : {}),
    };
  }

  #mapWebhookData(payload: PaddleWebhookPayload, type: string): Record<string, unknown> {
    const data = payload.data;
    const externalReference = this.#readExternalReference(
      data.custom_data as Record<string, unknown> | null | undefined,
    );
    if (payload.event_type.startsWith('subscription.')) {
      const subscription = this.#mapSubscription(data as unknown as PaddleSubscriptionResponse);
      return {
        gatewayId: subscription.gatewayId,
        customerId: subscription.customerId,
        status: subscription.status,
        planId: subscription.planId,
        ...(subscription.endsAt !== undefined ? { endsAt: subscription.endsAt } : {}),
        ...(externalReference !== undefined ? { externalReference } : {}),
      };
    }
    if (payload.event_type.startsWith('adjustment.')) {
      const adjustment = data as unknown as PaddleAdjustmentResponse;
      return {
        gatewayId: adjustment.transaction_id,
        adjustmentId: adjustment.id,
        amount: this.#toCents(adjustment.totals?.total) ?? 0,
        currency: (adjustment.totals?.currency_code ?? this.#currency).toLowerCase(),
        ...(externalReference !== undefined ? { externalReference } : {}),
        ...this.#disputeExtras(adjustment, type),
      };
    }
    const payment = this.#mapPayment(data as unknown as PaddleTransactionResponse);
    return {
      gatewayId: payment.gatewayId,
      amount: payment.amount.amount,
      currency: payment.amount.currency,
      ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
      ...(payment.subscriptionId !== undefined ? { subscriptionId: payment.subscriptionId } : {}),
      ...(externalReference !== undefined ? { externalReference } : {}),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  #catalogItem(input: CheckoutInput): Array<Record<string, unknown>> {
    return [{ price_id: input.planId, quantity: 1 }];
  }

  #adHocItem(input: CheckoutInput, currency: string): Array<Record<string, unknown>> {
    if (this.#productId === undefined) {
      throw new Error(
        '[payments] Paddle needs a product for a non-catalog checkout. Pass `planId` (a ' +
          'Paddle price id) on the checkout, or set `productId` in ' +
          '`payments.paddle({ productId })` / `PADDLE_PRODUCT_ID`.',
      );
    }
    return [
      {
        quantity: 1,
        price: {
          description: input.description ?? 'Payment',
          product_id: this.#productId,
          // Paddle's money is a string of the **smallest unit** — `"1990"` is $19.90, not
          // $1990. It reads like a decimal and is not one, so this is the package's own
          // integer stringified: no `formatDecimal`, no `toDecimal`, no division. (Paddle
          // API reference, "Data types": "Monetary values are returned as strings in the
          // lowest denomination for a currency.")
          unit_price: { amount: String(input.amount), currency_code: currency },
        },
      },
    ];
  }

  /**
   * The routing key is written to `custom_data.external_reference`, which Paddle echoes on
   * the transaction and on the subscription a recurring checkout creates — and which
   * `parseWebhook` reads back out. `metadata.externalReference` is still honoured as a
   * fallback for callers written before `CheckoutInput.externalReference` existed.
   */
  #customData(input: CheckoutInput): Record<string, unknown> | undefined {
    const {
      checkoutUrl: _checkoutUrl,
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

  /** `custom_data.external_reference` is where this driver puts the app's routing key. */
  #readExternalReference(
    customData: Record<string, unknown> | null | undefined,
  ): string | undefined {
    const value = customData?.external_reference;
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Paddle keeps tax identifiers on the customer's *business* — a separate resource with
   * its own endpoints — so a tax id written onto the customer would silently vanish.
   */
  #refuseTaxId(taxId: string | undefined): void {
    if (taxId === undefined) return;
    throw new Error(
      '[payments] Paddle stores tax ids on a business (`/customers/{id}/businesses`), ' +
        'not on the customer. Create or update the business directly.',
    );
  }

  /**
   * Paddle's `payments[].method_details.type` onto the contract's method **categories**.
   *
   * Paddle collects through a dozen local methods and only `card` used to have a name
   * here, so a PayPal or iDEAL payment came back with no `method` at all. The categories
   * close that: PayPal, the device wallets and the Asian super-app wallets are `wallet`;
   * iDEAL, Bancontact, BLIK, MB WAY and a wire are `bank_transfer`; Pix and UPI are
   * themselves. Paddle spells the same value hyphenated on some events (`apple-pay`) and
   * underscored on others, so both are normalized.
   */
  #mapMethodType(type: string | undefined): Payment['method'] | undefined {
    if (type === undefined) return undefined;
    switch (type.replace(/-/g, '_')) {
      case 'card':
      case 'korea_local':
      case 'south_korea_local_card':
        return 'card';
      case 'paypal':
      case 'apple_pay':
      case 'google_pay':
      case 'samsung_pay':
      case 'alipay':
      case 'wechat_pay':
      case 'kakao_pay':
      case 'naver_pay':
      case 'payco':
        return 'wallet';
      case 'ideal':
      case 'bancontact':
      case 'blik':
      case 'mb_way':
      case 'wire_transfer':
        return 'bank_transfer';
      case 'pix':
        return 'pix';
      case 'upi':
        return 'upi';
      default:
        // `offline`, `unknown`, and whatever Paddle adds next. Leaving `method` unset says
        // "Paddle did not tell us"; `'unknown'` would claim it did and the answer was none.
        return undefined;
    }
  }

  /**
   * Paddle has **no request deduplication of any kind** — no `Idempotency-Key` header, no
   * request-id body field, nothing on a transaction or an adjustment. So a key handed to
   * this driver is refused rather than accepted and dropped: silently dropping it turns a
   * caller's retry guarantee into a second refund.
   */
  #refuseIdempotencyKey(key: string | undefined, operation: string): void {
    if (key === undefined) return;
    throw new Error(
      `[payments] Paddle has no idempotency mechanism, so \`idempotencyKey\` cannot be honoured on ${operation}(). Paddle's API deduplicates nothing, and a retried request performs the operation a second time — deduplicate on your side (persist the key and check it) before calling.`,
    );
  }

  #mapCheckoutStatus(status: PaddleTransactionResponse['status']): CheckoutSession['status'] {
    if (status === 'completed' || status === 'paid') return 'complete';
    if (status === 'canceled') return 'expired';
    return 'open';
  }

  /** Paddle money is a string of the smallest unit; this package's `Money` is that integer. */
  #toCents(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  #parseSignatureHeader(header: string): { ts: string; h1: string } {
    const parts = new Map<string, string>();
    for (const segment of header.split(';')) {
      const index = segment.indexOf('=');
      if (index > 0) parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
    }
    const ts = parts.get('ts');
    const h1 = parts.get('h1');
    if (ts === undefined || h1 === undefined) {
      throw new Error('[payments] Malformed `Paddle-Signature` header — expected `ts=…;h1=…`.');
    }
    return { ts, h1 };
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      bearerToken: this.#apiKey,
      // The shared helper has no generic header option, so the raw-header slot pins the
      // API version — Paddle applies the account's default version without it, which is
      // whatever a future breaking change makes it.
      authHeader: { name: 'Paddle-Version', value: '1' },
    });
  }
}
