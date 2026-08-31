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
  WebhookVerificationState,
} from '../driver.js';
import { headerValue, httpRequest, isNotFound } from '../http.js';
import type { EmitInvoiceContext } from '../invoice/emit_invoice.js';
import { emitInvoiceIfRequested } from '../invoice/emit_invoice.js';
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

export interface DodoDriverConfig {
  /** Dodo Payments API key. Defaults to `env.get('DODO_PAYMENTS_API_KEY')`. */
  apiKey?: string;
  /**
   * Currency charges are billed in (lowercase ISO 4217), sent as Dodo's
   * `billing_currency`. **Required** — Dodo settles in 140+ currencies and bills in
   * whatever you hand it, so a default would be a guess at the app's country.
   */
  currency: string;
  /**
   * Use Dodo's test mode (`https://test.dodopayments.com`). Defaults to
   * `NODE_ENV !== 'production'`. Test and live keys are not interchangeable.
   */
  sandbox?: boolean;
  /**
   * Default billing-address country (ISO 3166-1 alpha-2) for charges that do not carry
   * one. Dodo requires a country on every payment; per-charge
   * `metadata.billingCountry`/`metadata.billing` wins over this. Defaults to
   * `env.get('DODO_PAYMENTS_BILLING_COUNTRY')`.
   */
  billingCountry?: string;
  /**
   * Webhook signing key from the dashboard (`whsec_...`). Defaults to
   * `env.get('DODO_PAYMENTS_WEBHOOK_KEY')`. Required to parse Dodo webhooks.
   */
  webhookKey?: string;
}

/** `GET/POST/PATCH /customers`. */
interface DodoCustomer {
  customer_id: string;
  business_id: string;
  name: string;
  email: string;
  created_at: string;
  phone_number?: string | null;
  metadata?: Record<string, unknown>;
}

/** The trimmed customer Dodo embeds in payments, subscriptions and refunds. */
interface DodoCustomerRef {
  customer_id: string;
  email: string;
  name: string;
}

/**
 * `IntentStatus` — the payment status enum. Note `cancelled` (double l); Dodo spells the
 * British form everywhere, including `subscription.cancelled`.
 */
type DodoIntentStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'processing'
  | 'requires_customer_action'
  | 'requires_merchant_action'
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_capture'
  | 'partially_captured'
  | 'partially_captured_and_capturable';

/** `POST /payments` — the create response is much thinner than the read response. */
interface DodoPaymentCreated {
  payment_id: string;
  /** Charged to the customer, tax included, in the currency's smallest unit. */
  total_amount: number;
  customer: DodoCustomerRef;
  metadata?: Record<string, unknown>;
  payment_link?: string | null;
  client_secret?: string | null;
  expires_on?: string | null;
}

/** `GET /payments/{id}` (and, minus a few fields, the `payment.*` webhook `data`). */
interface DodoPayment {
  payment_id: string;
  business_id: string;
  created_at: string;
  currency: string;
  total_amount: number;
  customer: DodoCustomerRef;
  metadata?: Record<string, unknown>;
  status?: DodoIntentStatus | null;
  subscription_id?: string | null;
  payment_method?: string | null;
  payment_method_type?: string | null;
  payment_link?: string | null;
  invoice_id?: string | null;
  invoice_url?: string | null;
  refund_status?: 'partial' | 'full' | null;
  error_message?: string | null;
  updated_at?: string | null;
}

/** `POST /refunds`. */
interface DodoRefund {
  refund_id: string;
  payment_id: string;
  status: 'succeeded' | 'failed' | 'pending' | 'review';
  created_at: string;
  is_partial: boolean;
  customer: DodoCustomerRef;
  amount?: number | null;
  currency?: string | null;
  reason?: string | null;
}

/** `POST /checkouts` — a checkout session. */
interface DodoCheckoutSession {
  session_id: string;
  checkout_url?: string | null;
  client_secret?: string | null;
  payment_id?: string | null;
}

/** `POST /subscriptions` — again thinner than the read response (no status, no currency). */
interface DodoSubscriptionCreated {
  subscription_id: string;
  payment_id: string;
  recurring_pre_tax_amount: number;
  customer: DodoCustomerRef;
  metadata?: Record<string, unknown>;
  payment_link?: string | null;
  expires_on?: string | null;
}

/** `GET/PATCH /subscriptions/{id}` (and the `subscription.*` webhook `data`). */
interface DodoSubscription {
  subscription_id: string;
  created_at: string;
  status: 'pending' | 'active' | 'on_hold' | 'paused' | 'cancelled' | 'failed' | 'expired';
  currency: string;
  /** Per-cycle amount BEFORE tax, in the currency's smallest unit. */
  recurring_pre_tax_amount: number;
  product_id: string;
  quantity: number;
  customer: DodoCustomerRef;
  next_billing_date: string;
  previous_billing_date: string;
  trial_period_days: number;
  cancel_at_next_billing_date: boolean;
  metadata?: Record<string, unknown>;
  cancelled_at?: string | null;
  expires_at?: string | null;
}

/**
 * The `dispute.*` webhook payload (`payload_type: 'Dispute'`).
 *
 * Dodo is a merchant of record and still tells you: unlike Polar and Lemon Squeezy it
 * forwards the chargeback lifecycle, and you get ten days to respond to `dispute.opened`.
 */
interface DodoDispute {
  dispute_id: string;
  payment_id: string;
  business_id?: string;
  /** Dodo has sent this as both a number and a decimal string; normalized on the way in. */
  amount: number | string;
  currency: string;
  dispute_stage?: 'pre_dispute' | 'dispute' | 'pre_arbitration' | string;
  dispute_status?: string;
  created_at?: string;
  remarks?: string | null;
}

/** Every Dodo list endpoint answers `{ items }`. */
interface DodoList<T> {
  items: T[];
}

/** The webhook envelope. `data` carries a `payload_type` discriminator. */
interface DodoWebhookPayload {
  business_id?: string;
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

/**
 * Dodo Payments driver — merchant-of-record billing for SaaS (dodopayments.com), written
 * against the REST API with `fetch`; the `dodopayments` peer dependency is deliberately
 * not used.
 *
 * Dodo is the legal seller of your digital products: it registers for, calculates and
 * remits sales tax/VAT worldwide, and pays you net. That is a business arrangement the
 * library does not model — it only changes which driver you configure.
 *
 * The consequence for the driver is that **every charge names a product you created in
 * Dodo**. There is no amount-only endpoint anywhere in the API, so `charge()` and
 * `createCheckout()` require a product id, and an arbitrary `amount` is only honored on a
 * product with Pay What You Want enabled.
 */
export class DodoDriver implements PaymentsDriver {
  readonly provider = 'dodo';
  /**
   * `allowed_payment_method_types` is the field that restricts the hosted checkout, and
   * Dodo's supported-methods table reaches well past cards: wallets (Apple/Google/Amazon
   * Pay, Cash App, Revolut Pay, WeChat Pay), bank redirects (iDEAL, Bancontact, EPS,
   * Multibanco, BLIK, Satispay), direct debit (SEPA, ACH), BNPL (Klarna,
   * Afterpay/Clearpay, Billie), UPI and Pix. Every one of those now has a **category**
   * name in the contract, so they stop being unroutable.
   *
   * Boleto appears in the raw processor-level enum but not in Dodo's table, so it is not
   * advertised; `voucher` has no Dodo equivalent at all. Note Dodo's own wording: naming a
   * method never *guarantees* it — eligibility still depends on the customer's country and
   * your merchant settings, which is why {@link DodoDriver.#allowedMethods} keeps the card
   * fallbacks Dodo tells you to keep.
   */
  readonly supportedMethods = [
    'credit_card',
    'debit_card',
    'pix',
    'upi',
    'wallet',
    'bank_transfer',
    'bank_debit',
    'bnpl',
    'undefined',
  ] as const;
  /**
   * `disputes: false` even though Dodo forwards the whole chargeback lifecycle over
   * webhooks. The capability gates the *API* half — `findDispute` and
   * `submitDisputeEvidence` — and Dodo's own dispute reference says evidence "must occur
   * within this window **through the Dodo dashboard**". There is no representment endpoint
   * to call, so a driver that claimed one would be lying about the only part that matters.
   */
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true, disputes: false };

  #baseUrl: string;
  #bearerToken: string;
  #currency: string;
  #billingCountry: string | undefined;
  #webhookKey: string | undefined;
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: DodoDriverConfig) {
    this.#invoiceCtx = ctx;
    this.#bearerToken = requireCredential({
      driver: 'dodo',
      option: 'apiKey',
      env: 'DODO_PAYMENTS_API_KEY',
      value: config.apiKey,
    });
    this.#currency = requireCurrency('dodo', config.currency);
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com';
    this.#billingCountry = config.billingCountry ?? process.env.DODO_PAYMENTS_BILLING_COUNTRY;
    this.#webhookKey = config.webhookKey ?? process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCustomer');
    if (!input.email || !input.name) {
      throw new Error(
        '[payments] Dodo Payments requires both `email` and `name` to create a customer.',
      );
    }
    const data = await this.#request<DodoCustomer>('/customers', {
      method: 'POST',
      body: {
        email: input.email,
        name: input.name,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<DodoCustomer>(
        `/customers/${encodeURIComponent(customerId)}`,
      );
      return this.#mapCustomer(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    if (input.taxId !== undefined) {
      // A Dodo customer has no tax id; a tax id belongs to the individual purchase
      // (`tax_id` on a payment/subscription for a B2B sale). Accepting it here would drop
      // it silently.
      throw new Error(
        '[payments] Dodo Payments customers carry no tax id — pass it per purchase instead (B2B `tax_id` on the payment).',
      );
    }
    const data = await this.#request<DodoCustomer>(`/customers/${encodeURIComponent(customerId)}`, {
      method: 'PATCH',
      body: {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  /**
   * `POST /payments` — Dodo marks this endpoint deprecated in favour of checkout sessions,
   * but it is the only call that hands back a payment id up front, which is what this
   * contract returns. {@link DodoDriver.createCheckout} uses the newer `/checkouts` route.
   *
   * The payment is created **pending**: the response carries a `payment_link` the customer
   * still has to pay on. Settlement arrives as a `payment.succeeded` webhook.
   */
  async charge(input: ChargeInput): Promise<Payment> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'charge');
    const productId = this.#requireProductId(input.metadata);
    const body: Record<string, unknown> = {
      product_cart: [
        {
          product_id: productId,
          quantity: (input.metadata?.quantity as number | undefined) ?? 1,
          // Honored only when the Dodo product has Pay What You Want enabled; on a
          // fixed-price product Dodo ignores it and charges the product's price.
          amount: input.amount,
        },
      ],
      customer: this.#resolveCustomer(input.customerId, input.customer),
      billing: this.#resolveBilling(input.metadata),
      billing_currency: (input.currency ?? this.#currency).toUpperCase(),
      payment_link: true,
      ...(input.metadata?.returnUrl !== undefined ? { return_url: input.metadata.returnUrl } : {}),
      ...(this.#allowedMethods(input.method) !== undefined
        ? { allowed_payment_method_types: this.#allowedMethods(input.method) }
        : {}),
      metadata: this.#metadataWithReference(input),
    };
    const data = await this.#request<DodoPaymentCreated>('/payments', { method: 'POST', body });
    const payment = this.#mapCreatedPayment(data, input);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#request<DodoPayment>(`/payments/${encodeURIComponent(gatewayId)}`);
      return this.#mapPayment(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * `POST /refunds` has no top-level amount: a partial refund is expressed per line item
   * (`items[].item_id` = the product or addon id, plus its own amount), which this
   * contract's single `amount` cannot address. So a full refund works and a partial one is
   * refused, rather than quietly refunding everything.
   *
   * `options.idempotencyKey` is REFUSED, not ignored: Dodo documents no deduplication
   * mechanism, so accepting the key would turn a retry guarantee into a second refund.
   */
  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    this.#refuseIdempotencyKey(options?.idempotencyKey, 'refund');
    if (amount !== undefined) {
      throw new Error(
        '[payments] Dodo Payments refunds a partial amount per line item, not per payment — ' +
          '`POST /refunds` takes `items[{ item_id, amount }]`, which needs the product id of the line to refund. ' +
          'Call `refund(paymentId)` with no amount for a full refund, or use the Dodo API directly for a partial one.',
      );
    }
    const data = await this.#request<DodoRefund>('/refunds', {
      method: 'POST',
      body: { payment_id: paymentGatewayId },
    });
    const refund: Refund = {
      id: data.refund_id,
      gatewayId: data.refund_id,
      provider: this.provider,
      amount: {
        amount: data.amount ?? 0,
        currency: (data.currency ?? this.#currency).toLowerCase(),
      },
      status:
        data.status === 'succeeded'
          ? 'succeeded'
          : data.status === 'failed'
            ? 'failed'
            : // `review` is a refund Dodo has not decided on yet — not settled, not refused.
              'pending',
      createdAt: data.created_at,
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCheckout');
    const productId = input.planId ?? (input.metadata?.productId as string | undefined);
    if (!productId) {
      throw new Error(
        '[payments] Dodo Payments checkout needs a product — pass the Dodo product id as `planId` (or `metadata.productId`). ' +
          'Every price lives on a product; there is no ad-hoc line item.',
      );
    }
    const metadata = this.#metadataWithReference(input);
    const data = await this.#request<DodoCheckoutSession>('/checkouts', {
      method: 'POST',
      body: {
        product_cart: [{ product_id: productId, quantity: 1, amount: input.amount }],
        return_url: input.successUrl,
        ...(input.cancelUrl !== undefined ? { cancel_url: input.cancelUrl } : {}),
        billing_currency: (input.currency ?? this.#currency).toUpperCase(),
        ...(input.customerId !== undefined ? { customer: { customer_id: input.customerId } } : {}),
        ...(input.trialDays !== undefined
          ? { subscription_data: { trial_period_days: input.trialDays } }
          : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    });
    return {
      id: data.session_id,
      gatewayId: data.session_id,
      provider: this.provider,
      url: data.checkout_url ?? '',
      // `/checkouts` returns no status; a session that was just created is open.
      status: 'open',
      amount: { amount: input.amount, currency: (input.currency ?? this.#currency).toLowerCase() },
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createSubscription');
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Dodo Payments takes the recurring price from the product, so `amount` cannot be set on a subscription. ' +
          'Create the product with the price you want and pass its id as `planId`.',
      );
    }
    if (input.cycle !== undefined) {
      throw new Error(
        '[payments] Dodo Payments takes the billing interval from the product, so `cycle` cannot be set on a subscription. ' +
          'Create a product with the interval you want and pass its id as `planId`.',
      );
    }
    if (input.card !== undefined) {
      throw new Error(
        '[payments] Dodo Payments has no tokenized-card input — as a merchant of record it collects the card on its own checkout. ' +
          'Use the `payment_link` the subscription returns, or `createCheckout({ planId })`.',
      );
    }
    const data = await this.#request<DodoSubscriptionCreated>('/subscriptions', {
      method: 'POST',
      body: {
        product_id: input.planId,
        quantity: (input.metadata?.quantity as number | undefined) ?? 1,
        customer: this.#resolveCustomer(input.customerId, input.customer),
        billing: this.#resolveBilling(input.metadata),
        billing_currency: this.#currency.toUpperCase(),
        payment_link: true,
        ...(input.trialDays !== undefined ? { trial_period_days: input.trialDays } : {}),
        ...(this.#allowedMethods(input.method) !== undefined
          ? { allowed_payment_method_types: this.#allowedMethods(input.method) }
          : {}),
        metadata: this.#metadataWithReference(input),
      },
    });
    const subscription = this.#mapCreatedSubscription(data, input);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  /**
   * Cancelling is a `PATCH`, and Dodo separates the two meanings: `status: 'cancelled'`
   * ends it now, `cancel_at_next_billing_date: true` lets the paid period run out. There
   * is no `DELETE /subscriptions/{id}`.
   */
  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const data = await this.#request<DodoSubscription>(
      `/subscriptions/${encodeURIComponent(subscriptionGatewayId)}`,
      {
        method: 'PATCH',
        body:
          options?.atPeriodEnd === false
            ? { status: 'cancelled', cancel_reason: 'cancelled_by_merchant' }
            : { cancel_at_next_billing_date: true },
      },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  /**
   * What a customer pays is decided by the product, so the only real change is a plan
   * switch — `POST /subscriptions/{id}/change-plan`, expressed here as
   * `metadata.productId`. Everything else in `UpdateSubscriptionInput` that Dodo has no
   * field for is refused instead of dropped.
   */
  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'updateSubscription');
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Dodo Payments has no subscription amount to update — the price belongs to the product. ' +
          'Switch plans with `updateSubscription(id, { metadata: { productId: <new dodo product id> } })`.',
      );
    }
    if (input.description !== undefined) {
      throw new Error(
        '[payments] Dodo Payments subscriptions carry no description — the product supplies the name shown to the customer.',
      );
    }
    const id = encodeURIComponent(subscriptionGatewayId);
    const { productId, quantity, prorationBillingMode, effectiveAt, ...metadata } =
      (input.metadata ?? {}) as Record<string, unknown>;
    if (productId !== undefined) {
      // change-plan answers with the payment link for the difference, not the subscription,
      // so the updated subscription is read back to satisfy the contract.
      await this.#request<unknown>(`/subscriptions/${id}/change-plan`, {
        method: 'POST',
        body: {
          product_id: productId,
          quantity: (quantity as number | undefined) ?? 1,
          proration_billing_mode:
            (prorationBillingMode as string | undefined) ?? 'prorated_immediately',
          ...(effectiveAt !== undefined ? { effective_at: effectiveAt } : {}),
        },
      });
      return this.#mapSubscription(await this.#request<DodoSubscription>(`/subscriptions/${id}`));
    }
    if (Object.keys(metadata).length === 0) {
      throw new Error(
        '[payments] Nothing to update on a Dodo Payments subscription. Pass `metadata.productId` to switch plans, ' +
          'or other `metadata` keys to store your own data on it.',
      );
    }
    const data = await this.#request<DodoSubscription>(`/subscriptions/${id}`, {
      method: 'PATCH',
      body: { metadata },
    });
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<DodoSubscription>(
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
   * Dodo issues an invoice per payment (it is the merchant of record, so the invoice is
   * its own). `invoice_url` on the payment is the PDF, which saves a call to
   * `GET /invoices/payments/{id}`.
   */
  async listInvoices(customerId: string): Promise<Invoice[]> {
    const data = await this.#request<DodoList<DodoPayment>>(
      `/payments?customer_id=${encodeURIComponent(customerId)}&page_size=100`,
    );
    return (data.items ?? []).map((payment) => ({
      id: payment.invoice_id ?? payment.payment_id,
      gatewayId: payment.payment_id,
      provider: this.provider,
      customerId,
      ...(payment.subscription_id ? { subscriptionId: payment.subscription_id } : {}),
      status:
        payment.status === 'succeeded'
          ? 'paid'
          : payment.status === 'failed' || payment.status === 'cancelled'
            ? 'canceled'
            : 'pending',
      amount: { amount: payment.total_amount, currency: payment.currency.toLowerCase() },
      createdAt: payment.created_at,
      ...(payment.invoice_url ? { hostedPdfUrl: payment.invoice_url } : {}),
      ...(payment.invoice_id ? { number: payment.invoice_id } : {}),
      payload: payment as unknown as Record<string, unknown>,
    }));
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * `parseWebhook` already refuses without the key — declaring it moves the refusal to boot,
   * where it is a config error rather than a lost webhook.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookKey !== undefined ? 'configured' : 'unconfigured';
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (!this.#webhookKey) {
      throw new Error(
        '[payments] Dodo Payments webhook processing requires a webhook key. Set `DODO_PAYMENTS_WEBHOOK_KEY` env or pass `webhookKey` to `payments.dodo()`.',
      );
    }
    const id = this.#verifiedEventId(rawBody, headers, this.#webhookKey);
    const payload = JSON.parse(rawBody) as DodoWebhookPayload;
    return {
      id,
      provider: this.provider,
      type: this.#mapWebhookType(payload.type, payload.data ?? {}),
      createdAt: payload.timestamp ?? new Date().toISOString(),
      data: this.#mapWebhookData(payload.type, payload.data ?? {}),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  /**
   * Verify the delivery and return the event id, which for Standard Webhooks lives in the
   * `webhook-id` header rather than the body — it is what the idempotency ledger
   * deduplicates on, and what Dodo's own docs tell you to use.
   *
   * `keyEncoding: 'base64'` is the Dodo-specific half: strip `whsec_` and base64-decode
   * the rest, the spec default. (Polar, on the same spec, uses the raw string.)
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
        '[payments] Missing Standard Webhooks headers on Dodo Payments request (webhook-id, webhook-timestamp, webhook-signature).',
      );
    }
    if (!verifyStandardWebhookSignature({ rawBody, headers, secret, keyEncoding: 'base64' })) {
      throw new Error('[payments] Invalid Dodo Payments webhook signature.');
    }
    return id;
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: DodoCustomer): Customer {
    return {
      id: data.customer_id,
      email: data.email,
      name: data.name,
      ...(data.metadata !== undefined && Object.keys(data.metadata).length > 0
        ? { metadata: data.metadata }
        : {}),
    };
  }

  #mapCreatedPayment(data: DodoPaymentCreated, input: ChargeInput): Payment {
    const result: Payment = {
      id: data.payment_id,
      gatewayId: data.payment_id,
      provider: this.provider,
      // The create response carries no currency, so the one the charge was billed in is
      // the only truthful answer.
      amount: {
        amount: data.total_amount,
        currency: (input.currency ?? this.#currency).toLowerCase(),
      },
      // Nothing is settled yet — the customer still has to pay on `payment_link`.
      status: 'pending',
      customerId: data.customer.customer_id,
      payload: data as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
    if (data.payment_link) result.hostedUrl = data.payment_link;
    return result;
  }

  #mapPayment(data: DodoPayment): Payment {
    const statusMap: Record<string, Payment['status']> = {
      succeeded: 'paid',
      failed: 'failed',
      cancelled: 'canceled',
      processing: 'pending',
      requires_customer_action: 'pending',
      requires_merchant_action: 'pending',
      requires_payment_method: 'pending',
      requires_confirmation: 'pending',
      // Funds are held on the card and NOTHING has been captured — money has not moved,
      // but it is a great deal more than `pending`, which is what this used to say.
      requires_capture: 'authorized',
      // NOT `authorized`: part of the authorization HAS been captured, so claiming
      // "nothing captured" would be as wrong as `pending` was understated. The API
      // reference does not say how much settled, so `pending` remains the reading that
      // does not claim a figure arrived.
      partially_captured: 'pending',
      partially_captured_and_capturable: 'pending',
    };
    const result: Payment = {
      id: data.payment_id,
      gatewayId: data.payment_id,
      provider: this.provider,
      amount: { amount: data.total_amount, currency: data.currency.toLowerCase() },
      status:
        data.refund_status === 'full' ? 'refunded' : (statusMap[data.status ?? ''] ?? 'pending'),
      customerId: data.customer.customer_id,
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at,
    };
    const method = this.#mapMethodToType(data.payment_method_type ?? data.payment_method);
    if (method !== undefined && method !== 'unknown') result.method = method;
    if (data.subscription_id) result.subscriptionId = data.subscription_id;
    if (data.payment_link) result.hostedUrl = data.payment_link;
    // Dodo has no settlement timestamp; `updated_at` is when it last moved, which for a
    // succeeded payment is when it succeeded.
    if (data.status === 'succeeded') result.paidAt = data.updated_at ?? data.created_at;
    return result;
  }

  #mapCreatedSubscription(
    data: DodoSubscriptionCreated,
    input: CreateSubscriptionInput,
  ): Subscription {
    return {
      id: data.subscription_id,
      gatewayId: data.subscription_id,
      provider: this.provider,
      customerId: data.customer.customer_id,
      // The create response has no status. A Dodo subscription starts `pending` until its
      // first payment clears, and `trialing` would claim a trial that may not exist.
      status: 'incomplete',
      planId: input.planId,
      amount: { amount: data.recurring_pre_tax_amount, currency: this.#currency.toLowerCase() },
      payload: data as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    };
  }

  #mapSubscription(data: DodoSubscription): Subscription {
    const statusMap: Record<string, Subscription['status']> = {
      pending: 'incomplete',
      active: 'active',
      // `on_hold` is a subscription whose payment did not go through.
      on_hold: 'past_due',
      // A paused Dodo subscription still exists and will bill again — but it is not
      // billing NOW, so reporting it as `active` entitled a subscriber who is not paying.
      paused: 'paused',
      cancelled: 'canceled',
      failed: 'canceled',
      expired: 'ended',
    };
    return {
      id: data.subscription_id,
      gatewayId: data.subscription_id,
      provider: this.provider,
      customerId: data.customer.customer_id,
      status: statusMap[data.status] ?? 'active',
      planId: data.product_id,
      amount: {
        amount: data.recurring_pre_tax_amount,
        currency: data.currency.toLowerCase(),
      },
      ...(data.cancelled_at ? { endsAt: data.cancelled_at } : {}),
      ...(data.expires_at && !data.cancelled_at ? { endsAt: data.expires_at } : {}),
      ...(data.previous_billing_date ? { currentPeriodStart: data.previous_billing_date } : {}),
      ...(data.next_billing_date ? { currentPeriodEnd: data.next_billing_date } : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at,
    };
  }

  #mapWebhookType(event: string, data: Record<string, unknown>): string {
    // The dispute family is normalized off the `Dispute` payload, and a `dispute.*` event
    // whose body is not one cannot supply an outcome — `payment.dispute_closed` without an
    // outcome makes the processor throw, on purpose. So an unrecognizable body degrades to
    // `payment.updated` rather than producing an event the processor will reject.
    if (event.startsWith('dispute.')) {
      return data.payload_type === 'Dispute' ? this.#disputeType(event) : 'payment.updated';
    }
    switch (event) {
      case 'payment.succeeded':
        return 'payment.succeeded';
      case 'payment.failed':
      case 'payment.cancelled':
        return 'payment.failed';
      case 'payment.processing':
        return 'payment.updated';
      case 'refund.succeeded':
        return 'payment.refunded';
      // Dodo has no `subscription.created`: `active` is the first event, fired once the
      // subscription's first payment clears.
      case 'subscription.active':
        return 'subscription.created';
      case 'subscription.updated':
      case 'subscription.renewed':
      case 'subscription.plan_changed':
      case 'subscription.on_hold':
      case 'subscription.paused':
      case 'subscription.unpaused':
      case 'subscription.update_payment_method':
        return 'subscription.updated';
      case 'subscription.cancelled':
      case 'subscription.expired':
      case 'subscription.failed':
        return 'subscription.canceled';
      default:
        // refund.failed, license_key.*, payout.*, credit.*, dunning.*,
        // abandoned_checkout.*, entitlement_grant.* — passed through so an app handler can
        // subscribe to them by their Dodo name.
        return event;
    }
  }

  /**
   * The dispute lifecycle → the canonical dispute types.
   *
   * Dodo is a merchant of record, which usually means the chargeback is the MoR's to
   * fight and you hear about it as a balance line. Dodo is the exception, and its own
   * dispute reference is explicit about both halves: **"Cardholder initiates dispute;
   * funds are held"** on `dispute.opened`, and **"You have 10 days to respond after a
   * dispute opens"**, with the evidence submitted by you.
   *
   * So `dispute.opened` is a real `payment.disputed` — the money is already gone — and
   * there is no funds-untouched warning to map. Dodo carries a `dispute_stage`
   * (`pre_dispute` → `dispute` → `pre_arbitration`), but its reference states the funds
   * hold for `dispute.opened` without qualifying it by stage, so the driver does NOT
   * downgrade a `pre_dispute` open to `payment.dispute_warning`. Guessing that Dodo's
   * `pre_dispute` behaves like a Stripe inquiry would leave a row saying `paid` over
   * money Dodo says it has already held.
   */
  #disputeType(event: string): string {
    if (event === 'dispute.opened') return 'payment.disputed';
    // Evidence submitted, network reviewing. Movement inside an open dispute, not a
    // resolution of it.
    if (event === 'dispute.challenged') return 'payment.updated';
    return this.#disputeOutcome(event) === undefined ? 'payment.updated' : 'payment.dispute_closed';
  }

  /**
   * The outcome each closing event reports, in Dodo's own words.
   *
   * - `dispute.won` — "Resolved in your favor; funds retained".
   * - `dispute.lost` — "Resolved for cardholder; funds returned". Visa RDR auto-refunds
   *   arrive here too, flagged `is_resolved_by_rdr: true` on the payload.
   * - `dispute.accepted` — "Dispute accepted without contest; funds returned". You chose
   *   not to defend, so the cardholder keeps the money: a loss, not a cancellation.
   * - `dispute.expired` — "Response window closed without resolution", which Dodo's own
   *   table glosses as "typically resolves against you". `expired` rather than `lost`,
   *   because nothing was decided — the clock ran out.
   * - `dispute.cancelled` — "Dispute withdrawn; no action needed". `canceled` does not
   *   return the row to `paid` on its own, which is deliberate: a withdrawn dispute is
   *   not an acquirer returning funds.
   */
  #disputeOutcome(event: string): 'won' | 'lost' | 'canceled' | 'expired' | undefined {
    switch (event) {
      case 'dispute.won':
        return 'won';
      case 'dispute.lost':
      case 'dispute.accepted':
        return 'lost';
      case 'dispute.expired':
        return 'expired';
      case 'dispute.cancelled':
        return 'canceled';
      default:
        return undefined;
    }
  }

  /**
   * Normalize the event body onto the shapes the billing layer's built-in sync expects,
   * using the `payload_type` discriminator Dodo puts on every `data` object.
   * `externalReference` comes back out of `metadata.external_reference`.
   */
  #mapWebhookData(event: string, data: Record<string, unknown>): Record<string, unknown> {
    const payloadType = data.payload_type;
    if (payloadType === 'Payment') {
      const payment = data as unknown as DodoPayment;
      return {
        gatewayId: payment.payment_id,
        amount: payment.total_amount,
        currency: (payment.currency ?? this.#currency).toLowerCase(),
        customerId: payment.customer?.customer_id,
        ...(payment.subscription_id ? { subscriptionId: payment.subscription_id } : {}),
        ...this.#referenceFrom(payment.metadata),
      };
    }
    if (payloadType === 'Refund') {
      const refund = data as unknown as DodoRefund;
      // Keyed by the PAYMENT, not the refund: the payment is the row an app handler holds.
      return {
        gatewayId: refund.payment_id,
        amount: refund.amount ?? 0,
        currency: (refund.currency ?? this.#currency).toLowerCase(),
        customerId: refund.customer?.customer_id,
      };
    }
    if (payloadType === 'Dispute') {
      const dispute = data as unknown as DodoDispute;
      const outcome = this.#disputeOutcome(event);
      // Keyed by the PAYMENT, not the dispute: the payment is the row whose status has to
      // move to `disputed`, and the amount/currency are what the processor writes back.
      //
      // No `actionableUntil`. Dodo's ten-day clock is real and it is YOURS — but Dodo
      // sends no deadline field: the dispute object is `dispute_id`, `payment_id`,
      // `business_id`, `amount`, `currency`, `dispute_status`, `dispute_stage`,
      // `created_at`, `remarks`, `payment_provider`, `is_resolved_by_rdr` and nothing
      // else. Deriving `created_at + 10 days` would put a date this driver invented into
      // the one field an operator is meant to trust, so the deadline stays documented
      // rather than fabricated.
      return {
        gatewayId: dispute.payment_id,
        amount: Number(dispute.amount) || 0,
        currency: (dispute.currency ?? this.#currency).toLowerCase(),
        disputeId: dispute.dispute_id,
        ...(dispute.remarks ? { reason: dispute.remarks } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        ...(dispute.dispute_stage !== undefined ? { disputeStage: dispute.dispute_stage } : {}),
        ...(dispute.dispute_status !== undefined ? { disputeStatus: dispute.dispute_status } : {}),
      };
    }
    if (payloadType === 'Subscription') {
      const subscription = data as unknown as DodoSubscription;
      const mapped = this.#mapSubscription(subscription);
      return {
        gatewayId: mapped.gatewayId,
        customerId: mapped.customerId,
        status: mapped.status,
        planId: mapped.planId,
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

  // ── Request helpers ──────────────────────────────────────────────────────────────────

  /**
   * Dodo echoes `metadata` on the payment/subscription and on every webhook about it,
   * which makes it the only place `externalReference` survives the round trip. Values must
   * be scalars, so anything else is dropped by Dodo rather than by this driver.
   */
  #metadataWithReference(input: {
    metadata?: Record<string, unknown>;
    externalReference?: string;
  }): Record<string, unknown> {
    // The keys this driver reads as arguments are consumed here, not forwarded, so they
    // don't turn up as stray metadata on the Dodo record.
    const {
      productId: _productId,
      product_id: _snakeProductId,
      quantity: _quantity,
      returnUrl: _returnUrl,
      billing: _billing,
      billingCountry: _billingCountry,
      ...rest
    } = input.metadata ?? {};
    return {
      ...rest,
      ...(input.externalReference !== undefined
        ? { external_reference: input.externalReference }
        : {}),
    };
  }

  /**
   * Dodo documents **no request deduplication** — no `Idempotency-Key` header, no
   * request-id field; its only idempotency guidance is the `webhook-id` header on the
   * receiving side. So a key handed to this driver is refused rather than accepted and
   * dropped: silently dropping it turns a caller's retry guarantee into a second charge.
   */
  #refuseIdempotencyKey(key: string | undefined, operation: string): void {
    if (key === undefined) return;
    throw new Error(
      `[payments] Dodo Payments has no idempotency mechanism, so \`idempotencyKey\` cannot be honoured on ${operation}(). Its API deduplicates nothing (the \`webhook-id\` header only covers events it sends you), and a retried request performs the operation a second time — deduplicate on your side before calling.`,
    );
  }

  #requireProductId(metadata: Record<string, unknown> | undefined): string {
    const productId = metadata?.productId ?? metadata?.product_id;
    if (typeof productId !== 'string' || productId === '') {
      throw new Error(
        '[payments] Dodo Payments has no amount-only charge — every payment names a product you created in Dodo. ' +
          'Pass `metadata.productId`, and enable Pay What You Want on that product if the amount varies per charge.',
      );
    }
    return productId;
  }

  /** `POST /payments` and `POST /subscriptions` both demand a billing address country. */
  #resolveBilling(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
    const billing = metadata?.billing as Record<string, unknown> | undefined;
    const country =
      (billing?.country as string | undefined) ??
      (metadata?.billingCountry as string | undefined) ??
      this.#billingCountry;
    if (!country) {
      throw new Error(
        '[payments] Dodo Payments requires a billing country (ISO 3166-1 alpha-2) on every payment. ' +
          'Pass `metadata.billingCountry` (or a full `metadata.billing` address), or set `billingCountry` on `payments.dodo()`.',
      );
    }
    return { ...(billing ?? {}), country };
  }

  #resolveCustomer(
    customerId: string | undefined,
    customer: { name?: string; email?: string; taxId?: string } | undefined,
  ): Record<string, unknown> {
    if (customerId !== undefined) return { customer_id: customerId };
    if (customer?.email !== undefined) {
      return {
        email: customer.email,
        ...(customer.name !== undefined ? { name: customer.name } : {}),
      };
    }
    throw new Error(
      '[payments] Dodo Payments needs a customer — pass `customerId`, or `customer.email` to create one at checkout.',
    );
  }

  /**
   * Canonical method → the `allowed_payment_method_types` entries that restrict the hosted
   * checkout to it. Dodo's own guidance is to always leave the card methods available as a
   * fallback, because a checkout whose every listed method is unavailable simply fails.
   */
  #allowedMethods(method?: string): string[] | undefined {
    switch (method) {
      case 'credit_card':
        return ['credit'];
      case 'debit_card':
        return ['debit'];
      // Pix additionally requires `billing_currency: BRL` and a Brazilian billing country;
      // Dodo rejects the payment otherwise.
      case 'pix':
        return ['pix', 'credit', 'debit'];
      // The category methods below keep `credit`/`debit` alongside them for the reason
      // Dodo documents: a checkout whose every listed method is unavailable in the buyer's
      // country simply fails, and a category is a set of local methods by definition.
      case 'upi':
        return ['upi_collect', 'credit', 'debit'];
      case 'wallet':
        return [
          'apple_pay',
          'google_pay',
          'amazon_pay',
          'cashapp',
          'revolut_pay',
          'credit',
          'debit',
        ];
      case 'bank_transfer':
        return ['ideal', 'bancontact_card', 'eps', 'multibanco', 'blik', 'credit', 'debit'];
      case 'bank_debit':
        return ['sepa', 'ach', 'credit', 'debit'];
      case 'bnpl':
        return ['klarna', 'afterpay_clearpay', 'credit', 'debit'];
      default:
        return undefined;
    }
  }

  /**
   * The instrument Dodo reports back on a payment, onto the contract's method categories.
   * Only `card`, `pix` and `boleto` had names before, so an iDEAL or Klarna payment came
   * back `unknown` — every method Dodo can produce now lands in a category.
   */
  #mapMethodToType(method: string | null | undefined): Payment['method'] {
    switch (method) {
      case 'card':
      case 'credit':
      case 'debit':
      case 'visa':
      case 'mastercard':
        return 'card';
      case 'pix':
        return 'pix';
      case 'boleto':
        return 'boleto';
      case 'upi':
      case 'upi_collect':
      case 'upi_intent':
        return 'upi';
      case 'apple_pay':
      case 'google_pay':
      case 'amazon_pay':
      case 'cashapp':
      case 'revolut_pay':
      case 'we_chat_pay':
      case 'payco':
      case 'naver_pay':
      case 'kakao_pay':
        return 'wallet';
      case 'ideal':
      case 'bancontact_card':
      case 'eps':
      case 'multibanco':
      case 'blik':
      case 'satispay':
        return 'bank_transfer';
      case 'sepa':
      case 'ach':
        return 'bank_debit';
      case 'klarna':
      case 'afterpay_clearpay':
      case 'billie':
        return 'bnpl';
      default:
        return 'unknown';
    }
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
    });
  }
}
