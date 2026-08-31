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
import { formatDecimal, fromDecimal } from '../money.js';
import type {
  CheckoutSession,
  Customer,
  Invoice,
  Money,
  Payment,
  Refund,
  Subscription,
  SubscriptionStatus,
  WebhookEvent,
} from '../types.js';
import { requireCredential, requireCurrency } from './shared.js';

/**
 * Config for {@link PayPalDriver}. Declared here rather than in `define_config.ts` so the
 * driver module type-checks on its own; the factory re-exports it.
 */
export interface PayPalDriverConfig {
  /** REST app client id. Defaults to `env.get('PAYPAL_CLIENT_ID')`. */
  clientId?: string;
  /** REST app client secret. Defaults to `env.get('PAYPAL_CLIENT_SECRET')`. */
  clientSecret?: string;
  /**
   * Currency for calls that don't name one (lowercase ISO 4217). **Required** — PayPal
   * settles in whatever currency you hand it, so a default here would be a guess at the
   * app's country, and a wrong guess charges instead of failing.
   */
  currency: string;
  /** Use `api-m.sandbox.paypal.com`. Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
  /**
   * The webhook id from the developer dashboard, sent to PayPal's
   * `/v1/notifications/verify-webhook-signature`. Defaults to
   * `env.get('PAYPAL_WEBHOOK_ID')`. Without it no webhook can be verified.
   */
  webhookId?: string;
}

/** PayPal returns money as a decimal string plus its ISO code. */
interface PayPalMoney {
  currency_code: string;
  value: string;
}

interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

interface PayPalCapture {
  id: string;
  status?: string;
  amount?: PayPalMoney;
  custom_id?: string;
  invoice_id?: string;
  create_time?: string;
  update_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
}

interface PayPalOrder {
  id: string;
  status: string;
  links?: PayPalLink[];
  /** Which funding source settled it — one populated key out of `paypal`, `card`, … */
  payment_source?: Record<string, unknown>;
  purchase_units?: Array<{
    custom_id?: string;
    invoice_id?: string;
    amount?: PayPalMoney;
    payments?: { captures?: PayPalCapture[] };
  }>;
}

interface PayPalRefund {
  id: string;
  status?: string;
  amount?: PayPalMoney;
  create_time?: string;
}

interface PayPalBillingCycle {
  sequence?: number;
  tenure_type?: string;
  pricing_scheme?: { fixed_price?: PayPalMoney };
}

interface PayPalSubscription {
  id: string;
  status: string;
  plan_id?: string;
  custom_id?: string;
  start_time?: string;
  create_time?: string;
  links?: PayPalLink[];
  subscriber?: { payer_id?: string; email_address?: string };
  billing_info?: { next_billing_time?: string; last_payment?: { amount?: PayPalMoney } };
  plan?: { billing_cycles?: PayPalBillingCycle[] };
}

/** The `resource` of a `PAYMENT.SALE.*` event — subscription charges are sales, not captures. */
interface PayPalSale {
  id: string;
  state?: string;
  custom?: string;
  billing_agreement_id?: string;
  amount?: { total?: string; currency?: string };
}

/** The `resource` of a `CUSTOMER.DISPUTE.*` event. */
interface PayPalDispute {
  dispute_id?: string;
  dispute_amount?: PayPalMoney;
  reason?: string;
  status?: string;
  dispute_state?: string;
  dispute_life_cycle_stage?: string;
  /**
   * "The date and time by when the merchant must respond to the dispute… If the merchant
   * does not respond by this date and time, the dispute is closed in the customer's
   * favor." RFC 3339, which is already the ISO 8601 `actionableUntil` wants.
   */
  seller_response_due_date?: string;
  dispute_outcome?: { outcome_code?: string; amount_refunded?: PayPalMoney };
  create_time?: string;
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    custom?: string;
  }>;
}

interface PayPalWebhookPayload {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
}

/**
 * The two currencies where PayPal disagrees with ISO 4217. PayPal's currency-codes table
 * marks HUF, JPY and TWD as "does not support decimals"; ISO gives HUF and TWD two minor
 * units, so `formatDecimal` would send `1990.00` and PayPal would reject it. JPY needs no
 * entry here — ISO already says zero.
 */
const PAYPAL_UNDIVIDED_CURRENCIES = new Set(['huf', 'twd']);

/** Refresh the OAuth token this many ms before PayPal's own expiry. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/** What PayPal's idempotency guidance says a `PayPal-Request-Id` fits in — a UUID. */
const REQUEST_ID_MAX_LENGTH = 38;

/**
 * PayPal driver — Orders v2 for money in, Payments v2 for refunds, Subscriptions v1 for
 * recurring billing. Multi-currency, OAuth2 client credentials, plain REST (no SDK).
 *
 * Two things about PayPal shape this driver more than anything else:
 *
 * 1. It is a **wallet**. A payment normally needs the payer to approve it on paypal.com,
 *    so {@link createCheckout} is the real entry point; {@link charge} only works against
 *    a payment method the payer already vaulted, and refuses otherwise.
 * 2. Webhook verification is an **API call**, not a local HMAC — see {@link parseWebhook}.
 */
export class PayPalDriver implements PaymentsDriver {
  readonly provider = 'paypal';
  /**
   * `wallet` and `undefined`, and the split is which call is being routed.
   *
   * {@link PayPalDriver.createCheckout} hands the payer to PayPal, who picks the funding
   * source on their own page — a card, a bank, a local method — so `undefined` ("let the
   * customer choose") is the only promise that call can keep. {@link PayPalDriver.charge}
   * is different: it charges a **vaulted PayPal account** (`payment_source.paypal.vault_id`)
   * and nothing else, which is a stored-balance wallet by definition. `credit_card` is
   * still absent — the driver never sends card data, so routing a card charge here would
   * reach a driver that cannot make one.
   */
  readonly supportedMethods = ['wallet', 'undefined'] as const;
  readonly capabilities = { refunds: true, invoices: false, subscriptions: true };

  #baseUrl: string;
  #basicAuth: string;
  #currency: string;
  #webhookId: string | undefined;
  #invoiceCtx: EmitInvoiceContext;
  /** Cached client-credentials token. `expiresAt` comes from PayPal's own `expires_in`. */
  #token: { value: string; expiresAt: number } | undefined;

  constructor(ctx: EmitInvoiceContext, config: PayPalDriverConfig) {
    this.#invoiceCtx = ctx;
    const clientId = requireCredential({
      driver: 'paypal',
      option: 'clientId',
      env: 'PAYPAL_CLIENT_ID',
      value: config.clientId,
    });
    const clientSecret = requireCredential({
      driver: 'paypal',
      option: 'clientSecret',
      env: 'PAYPAL_CLIENT_SECRET',
      value: config.clientSecret,
    });
    this.#basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    this.#currency = requireCurrency('paypal', config.currency);
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
    this.#webhookId = config.webhookId ?? process.env.PAYPAL_WEBHOOK_ID;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(_input: CreateCustomerInput): Promise<Customer> {
    throw new Error(
      '[payments] PayPal has no customer resource to create. A customer only comes into ' +
        'existence as a side effect of vaulting a payment method (`POST /v3/vault/setup-tokens`), ' +
        'and its id is one you choose. Keep customers on your own records and pass the vault ' +
        'token id as `paymentMethodId` on the charge.',
    );
  }

  async findCustomer(_customerId: string): Promise<Customer | null> {
    throw new Error(
      '[payments] PayPal cannot look a customer up. The Vault only lists the payment tokens ' +
        'belonging to a customer id you assigned (`GET /v3/vault/payment-tokens?customer_id=`); ' +
        'there is no customer to read back.',
    );
  }

  async updateCustomer(_customerId: string, _input: UpdateCustomerInput): Promise<Customer> {
    throw new Error(
      '[payments] PayPal has no customer resource to update. Keep customer details on your ' +
        'own records.',
    );
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  /**
   * Charge a vaulted payment method server-to-server. PayPal calls this the "single shot"
   * flow: an order with `payment_source.paypal.vault_id` is created and captured without
   * the payer being present. Everything else needs approval on paypal.com, which no
   * server-side call can stand in for.
   */
  async charge(input: ChargeInput): Promise<Payment> {
    const vaultId =
      input.paymentMethodId ??
      input.card?.token ??
      (typeof input.metadata?.vaultId === 'string' ? input.metadata.vaultId : undefined);
    if (vaultId === undefined) {
      throw new Error(
        '[payments] PayPal cannot charge without the payer approving the payment. Use ' +
          '`createCheckout()` and redirect them, or pass an already-vaulted payment method ' +
          'token as `paymentMethodId` for a server-side charge.',
      );
    }
    if (input.method !== undefined && input.method !== 'wallet' && input.method !== 'undefined') {
      throw new Error(
        `[payments] PayPal charges the vaulted PayPal account behind the token and nothing else, so "${input.method}" is a promise this call cannot keep — the funding source is whatever the payer has attached to that account. Drop \`method\`, or route the charge as \`wallet\`.`,
      );
    }
    // PayPal documents `PayPal-Request-Id` as mandatory for single-step create-order calls.
    // Generating one here would defeat it: a retry would mint a new key and charge twice.
    if (input.idempotencyKey === undefined) {
      throw new Error(
        '[payments] PayPal requires an idempotency key on a vaulted server-side charge — ' +
          'pass `idempotencyKey`. It becomes the `PayPal-Request-Id` header, which is the ' +
          'only thing PayPal deduplicates a repeated charge on.',
      );
    }
    const currency = input.currency ?? this.#currency;
    const body: Record<string, unknown> = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: currency.toUpperCase(),
            value: this.#toValue(input.amount, currency),
          },
          ...(input.externalReference !== undefined ? { custom_id: input.externalReference } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      ],
      payment_source: { paypal: { vault_id: vaultId } },
    };
    let order = await this.#request<PayPalOrder>('/v2/checkout/orders', {
      method: 'POST',
      body,
      headers: { ...this.#requestId(input.idempotencyKey), Prefer: 'return=representation' },
    });
    // A vaulted CAPTURE order usually comes back COMPLETED; when PayPal only authorized it,
    // capture explicitly rather than reporting a charge that never took the money.
    if (order.status !== 'COMPLETED') {
      order = await this.#request<PayPalOrder>(`/v2/checkout/orders/${order.id}/capture`, {
        method: 'POST',
        headers: { ...this.#requestId(input.idempotencyKey), Prefer: 'return=representation' },
      });
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (capture === undefined) {
      throw new Error(
        `[payments] PayPal order ${order.id} came back "${order.status}" with no capture. ` +
          `The money was not taken — inspect order ${order.id} before retrying.`,
      );
    }
    const payment = this.#mapCapture(capture, currency);
    // The order was created with `payment_source.paypal`, so the money came out of a PayPal
    // account. `order.payment_source` says which one when PayPal echoes it back.
    payment.method = this.#mapPaymentSource(order.payment_source) ?? 'wallet';
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  /** Find a payment by its **capture** id — the id `charge()` and the webhooks return. */
  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const capture = await this.#request<PayPalCapture>(`/v2/payments/captures/${gatewayId}`);
      return this.#mapCapture(capture, this.#currency);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    const currency = this.#currency;
    // An empty body means "refund everything left"; an `amount` makes it partial.
    const body: Record<string, unknown> =
      amount !== undefined
        ? {
            amount: {
              currency_code: currency.toUpperCase(),
              value: this.#toValue(amount, currency),
            },
          }
        : {};
    const data = await this.#request<PayPalRefund>(
      `/v2/payments/captures/${paymentGatewayId}/refund`,
      {
        method: 'POST',
        body,
        headers: {
          Prefer: 'return=representation',
          // The refund endpoint documents `PayPal-Request-Id`, the same header the charge
          // uses. Without it a retried refund job refunds the capture twice.
          ...this.#requestId(options?.idempotencyKey),
        },
      },
    );
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: this.#mapMoney(data.amount, currency),
      status:
        data.status === 'COMPLETED'
          ? 'succeeded'
          : data.status === 'FAILED' || data.status === 'CANCELLED'
            ? 'failed'
            : 'pending',
      createdAt: data.create_time ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  /**
   * The real entry point for PayPal. Returns the URL to send the payer to; the money only
   * moves once they approve it there and you capture the order (or, for `planId`, once
   * they approve the subscription).
   */
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const currency = input.currency ?? this.#currency;
    // `custom_id` and not `reference_id`: the capture PayPal sends on the webhook carries
    // `custom_id`, while `reference_id` stays behind on the purchase unit.
    const externalReference = input.externalReference;

    if (input.planId !== undefined) {
      const subscription = await this.#createSubscription({
        planId: input.planId,
        returnUrl: input.successUrl,
        ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
        ...(externalReference !== undefined ? { customId: externalReference } : {}),
        ...(input.idempotencyKey !== undefined ? { requestId: input.idempotencyKey } : {}),
      });
      return {
        id: subscription.id,
        gatewayId: subscription.id,
        provider: this.provider,
        url: this.#approvalUrl(subscription.links),
        status: subscription.status === 'ACTIVE' ? 'complete' : 'open',
        subscriptionId: subscription.id,
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      };
    }

    const body: Record<string, unknown> = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: currency.toUpperCase(),
            value: this.#toValue(input.amount, currency),
          },
          ...(externalReference !== undefined ? { custom_id: externalReference } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: input.successUrl,
            ...(input.cancelUrl !== undefined ? { cancel_url: input.cancelUrl } : {}),
            user_action: 'PAY_NOW',
          },
        },
      },
    };
    const order = await this.#request<PayPalOrder>('/v2/checkout/orders', {
      method: 'POST',
      body,
      headers: {
        Prefer: 'return=representation',
        ...this.#requestId(input.idempotencyKey),
      },
    });
    return {
      id: order.id,
      gatewayId: order.id,
      provider: this.provider,
      url: this.#approvalUrl(order.links),
      status: order.status === 'COMPLETED' ? 'complete' : 'open',
      amount: { amount: input.amount, currency },
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  /**
   * Create a subscription against an existing PayPal **plan** (`P-…`). It comes back
   * `APPROVAL_PENDING`: the payer still has to approve it, and the link to send them to
   * is in `subscription.payload.links` (rel `approve`). `createCheckout({ planId })`
   * returns that URL directly and is usually what you want.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    // Amount, cycle and trial all live on the PayPal plan, not on the subscription.
    // Accepting them here would report a price the gateway never charges.
    const planLevel = [
      input.amount !== undefined ? 'amount' : undefined,
      input.cycle !== undefined ? 'cycle' : undefined,
      input.trialDays !== undefined ? 'trialDays' : undefined,
    ].filter((field): field is string => field !== undefined);
    if (planLevel.length > 0) {
      throw new Error(
        `[payments] PayPal prices subscriptions on the plan, so ${planLevel.join(', ')} cannot ` +
          `be applied here. Create a plan with that price, cycle and trial (\`POST /v1/billing/plans\`) and pass its \`P-…\` id as \`planId\` (yours was ${input.planId}).`,
      );
    }
    const data = await this.#createSubscription({
      planId: input.planId,
      ...(input.externalReference !== undefined ? { customId: input.externalReference } : {}),
      ...(input.startDate !== undefined ? { startTime: input.startDate } : {}),
      // `POST /v1/billing/subscriptions` takes `PayPal-Request-Id` and holds the key for 72
      // hours; without it a retry starts a second subscription billing the same person.
      ...(input.idempotencyKey !== undefined ? { requestId: input.idempotencyKey } : {}),
    });
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    if (options?.atPeriodEnd === true) {
      throw new Error(
        '[payments] PayPal cancels a subscription immediately — there is no cancel-at-period-end ' +
          'flag. Cancel it when the period ends, or suspend it (`POST /v1/billing/subscriptions/' +
          '{id}/suspend`) and keep the grace period on your own records.',
      );
    }
    await this.#requestNoContent(`/v1/billing/subscriptions/${subscriptionGatewayId}/cancel`, {
      reason: 'Canceled by the merchant.',
    });
    // The cancel call answers 204 with no body; read the subscription back rather than
    // inventing the post-cancel state.
    const data = await this.#request<PayPalSubscription>(
      `/v1/billing/subscriptions/${subscriptionGatewayId}`,
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  /**
   * Change the recurring price. PayPal applies it as a JSON Patch against the plan's
   * REGULAR billing cycle — the sequence is read off the subscription first, because
   * patching sequence 1 blindly rewrites the *trial* price on a plan that has one.
   */
  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    if (input.idempotencyKey !== undefined) {
      throw new Error(
        '[payments] PayPal does not deduplicate a subscription update: `PATCH /v1/billing/subscriptions/{id}` documents no `PayPal-Request-Id`, unlike the create call. The patch is a price replacement, so a repeat is harmless in itself — but accepting a key the API never sees would promise a guarantee nothing enforces, so it is refused rather than dropped.',
      );
    }
    if (input.description !== undefined) {
      throw new Error(
        '[payments] PayPal subscriptions have no description — it belongs to the catalog ' +
          'product behind the plan. Update the product, or keep the description on your ' +
          'own record.',
      );
    }
    if (input.amount === undefined) {
      throw new Error(
        '[payments] PayPal subscription update needs an `amount`; there is nothing else on ' +
          'the shared input it can change.',
      );
    }
    const current = await this.#request<PayPalSubscription>(
      `/v1/billing/subscriptions/${subscriptionGatewayId}?fields=plan`,
    );
    const regular = current.plan?.billing_cycles?.find(
      (cycle) => cycle.tenure_type === 'REGULAR' && cycle.sequence !== undefined,
    );
    if (regular === undefined) {
      throw new Error(
        `[payments] PayPal subscription ${subscriptionGatewayId} exposes no REGULAR billing ` +
          `cycle to reprice. Change the price on the plan behind ${subscriptionGatewayId}, or move the subscriber to a new plan (\`POST /v1/billing/subscriptions/{id}/revise\`).`,
      );
    }
    const currency =
      regular.pricing_scheme?.fixed_price?.currency_code?.toLowerCase() ?? this.#currency;
    const patch = [
      {
        op: 'replace',
        path: `/plan/billing_cycles/@sequence==${regular.sequence}/pricing_scheme/fixed_price`,
        value: {
          currency_code: currency.toUpperCase(),
          value: this.#toValue(input.amount, currency),
        },
      },
    ];
    await this.#requestNoContent(`/v1/billing/subscriptions/${subscriptionGatewayId}`, patch, {
      method: 'PATCH',
    });
    const data = await this.#request<PayPalSubscription>(
      `/v1/billing/subscriptions/${subscriptionGatewayId}?fields=plan`,
    );
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<PayPalSubscription>(
        `/v1/billing/subscriptions/${gatewayId}?fields=plan`,
      );
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    throw new Error(
      '[payments] PayPal cannot list invoices for a customer: `GET /v2/invoicing/invoices` ' +
        'takes only paging, and `POST /v2/invoicing/search-invoices` filters by recipient ' +
        'email, not by a customer id. Search by email yourself, or use an invoice provider ' +
        'with `invoice: true`.',
    );
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Verify the webhook with PayPal and normalize it.
   *
   * PayPal has no local signature to check: verification is a POST to
   * `/v1/notifications/verify-webhook-signature`, so **every webhook costs a round trip**
   * (plus the OAuth call when the cached token has expired). That is PayPal's scheme —
   * there is no offline HMAC to substitute for it.
   *
   * Without a `webhookId` there is nothing to verify against at all, so the event is
   * parsed unverified — the same "unconfigured means unenforced" rule the other drivers
   * follow, and what makes local development work without a dashboard webhook.
   */
  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * Without the webhook id `parseWebhook` normalizes the body without ever calling PayPal's
   * verify-signature endpoint.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookId !== undefined ? 'configured' : 'unconfigured';
  }

  async parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent> {
    if (this.#webhookId === undefined) return this.#normalize(rawBody);

    const body = {
      auth_algo: headerValue(headers, 'paypal-auth-algo') ?? '',
      cert_url: headerValue(headers, 'paypal-cert-url') ?? '',
      transmission_id: headerValue(headers, 'paypal-transmission-id') ?? '',
      transmission_sig: headerValue(headers, 'paypal-transmission-sig') ?? '',
      transmission_time: headerValue(headers, 'paypal-transmission-time') ?? '',
      webhook_id: this.#webhookId,
      // PayPal takes the event as JSON, not as the raw string; it re-serializes it its own
      // way, so a body that does not parse can never verify.
      webhook_event: JSON.parse(rawBody) as unknown,
    };
    const result = await this.#request<{ verification_status?: string }>(
      '/v1/notifications/verify-webhook-signature',
      { method: 'POST', body },
    );
    if (result.verification_status !== 'SUCCESS') {
      throw new Error('[payments] Invalid PayPal webhook signature.');
    }
    return this.#normalize(rawBody);
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #normalize(rawBody: string): WebhookEvent {
    const payload = JSON.parse(rawBody) as PayPalWebhookPayload;
    const eventType = payload.event_type ?? 'unknown';
    const resource = payload.resource ?? {};
    // The dispute events decide their type from the resource (the lifecycle stage), and
    // the payload then has to know which type it is producing to carry the outcome.
    const type = this.#mapWebhookType(eventType, resource);
    return {
      id: payload.id ?? `${eventType}-${Date.now()}`,
      provider: this.provider,
      type,
      createdAt: payload.create_time ?? new Date().toISOString(),
      data: this.#mapWebhookData(eventType, resource, type),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  /**
   * PayPal's `payment_source` → the canonical {@link PaymentMethodType}.
   *
   * Exactly one key of the object is populated, and it names the funding source: `paypal`
   * and `venmo` are stored-balance wallets, `apple_pay`/`google_pay` device ones, `card`
   * is a card, and the European local methods push from the payer's own bank. Anything
   * unrecognized is left unset rather than guessed at.
   */
  #mapPaymentSource(source: Record<string, unknown> | undefined): Payment['method'] | undefined {
    if (source === undefined) return undefined;
    const key = Object.keys(source)[0];
    switch (key) {
      case 'paypal':
      case 'venmo':
      case 'apple_pay':
      case 'google_pay':
        return 'wallet';
      case 'card':
        return 'card';
      case 'ideal':
      case 'bancontact':
      case 'eps':
      case 'giropay':
      case 'p24':
      case 'sofort':
      case 'blik':
      case 'trustly':
      case 'multibanco':
      case 'mybank':
        return 'bank_transfer';
      default:
        return undefined;
    }
  }

  #mapWebhookType(eventType: string, resource: Record<string, unknown>): string {
    switch (eventType) {
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.SALE.COMPLETED':
        return 'payment.succeeded';
      case 'PAYMENT.CAPTURE.DECLINED':
      case 'PAYMENT.SALE.DENIED':
        return 'payment.failed';
      // ── The dispute family ───────────────────────────────────────────────────────────
      // PayPal's dispute is NOT a card-scheme chargeback: it has a lifecycle of its own,
      // and `CUSTOMER.DISPUTE.CREATED` fires at two very different points in it. PayPal's
      // own sandbox guide has you assert `dispute_life_cycle_stage` is `INQUIRY` for one
      // test and `CHARGEBACK` for the next, on the same event.
      //
      // `INQUIRY` is PayPal's own words "a customer and merchant interact in an attempt to
      // resolve a dispute without escalation to PayPal" — a 20-day window in the Resolution
      // Center that a refund closes. Nothing is adjudicated and nothing is debited; calling
      // it `payment.disputed` moves a paid row over money still in the account, which is
      // the same bug Stripe's inquiry and Adyen's notification-of-chargeback had.
      // `CHARGEBACK` and the two appeal stages are the claim: PayPal is now investigating
      // and will debit the account if it decides for the buyer.
      //
      // With no stage on the resource this stays `payment.disputed` — the mapping it has
      // always had — rather than downgrading a dispute the driver could not read.
      case 'CUSTOMER.DISPUTE.CREATED':
      // The deprecated spelling PayPal's own reference says `CUSTOMER.DISPUTE.CREATED`
      // supersedes; an account still subscribed to it should not silently miss the dispute.
      case 'RISK.DISPUTE.CREATED':
        return this.#disputeStage(resource) === 'INQUIRY'
          ? 'payment.dispute_warning'
          : 'payment.disputed';
      // PayPal sends **no dedicated "escalated to a claim" event**: an inquiry becoming a
      // chargeback arrives as a plain `CUSTOMER.DISPUTE.UPDATED` carrying the new stage. It
      // is therefore the only place a row that opened as a warning can learn the money is
      // now at stake, so an UPDATED past the inquiry stage is the chargeback. An UPDATED
      // still in `INQUIRY` (a message, evidence, an offer) moves nothing, and one on an
      // already `RESOLVED` dispute is bookkeeping after the fact.
      case 'CUSTOMER.DISPUTE.UPDATED': {
        const dispute = resource as unknown as PayPalDispute;
        const stage = this.#disputeStage(resource);
        return stage === undefined || stage === 'INQUIRY' || dispute.status === 'RESOLVED'
          ? 'payment.updated'
          : 'payment.disputed';
      }
      // The outcome lives in `dispute_outcome.outcome_code`, and only three of the seven
      // codes say who kept the money — see {@link PayPalDriver.#disputeOutcome}. Without a
      // readable one this stays an update rather than inventing a result.
      case 'CUSTOMER.DISPUTE.RESOLVED':
        return this.#disputeOutcome(resource) === undefined
          ? 'payment.updated'
          : 'payment.dispute_closed';
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED':
      case 'PAYMENT.SALE.REFUNDED':
      case 'PAYMENT.SALE.REVERSED':
        return 'payment.refunded';
      case 'CHECKOUT.ORDER.APPROVED':
      case 'CHECKOUT.ORDER.COMPLETED':
      case 'PAYMENT.CAPTURE.PENDING':
      case 'PAYMENT.SALE.PENDING':
      // An authorization is money HELD, not money moved: PayPal reserves it for about 29
      // days and voids it if nobody captures. There is deliberately no `payment.authorized`
      // event for it to become, so it is an update — the `status: 'authorized'` on the
      // payload is what a handler reads to tell it apart from the others here.
      case 'PAYMENT.AUTHORIZATION.CREATED':
      case 'PAYMENT.AUTHORIZATION.VOIDED':
        return 'payment.updated';
      case 'BILLING.SUBSCRIPTION.CREATED':
        return 'subscription.created';
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
      case 'BILLING.SUBSCRIPTION.UPDATED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        return 'subscription.updated';
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        return 'subscription.canceled';
      default:
        return eventType.toLowerCase();
    }
  }

  /**
   * The dispute's lifecycle stage — `INQUIRY`, `CHARGEBACK`, `PRE_ARBITRATION` or
   * `ARBITRATION` — or `undefined` when the resource is not a dispute or does not carry
   * one.
   *
   * A caveat worth knowing: PayPal documents the stages and the fund holds separately, and
   * never in the same sentence. The dispute guide says PayPal "holds the disputed payment
   * until resolution" for internal disputes, while its own sandbox matrix enumerates both
   * "Dispute NO HOLD" and "Dispute WITH HOLD" scenarios, and only ever says "PayPal debits
   * the merchant's account" on a case resolved in the buyer's favour. So the reference
   * does **not** state that a `CHARGEBACK`-stage dispute has already taken the money — it
   * states that the claim is being adjudicated and that losing it debits the account. The
   * split here follows the stage PayPal itself uses to separate "you and the buyer are
   * talking" from "PayPal is deciding", which is the line an operator can act on.
   */
  #disputeStage(resource: Record<string, unknown>): string | undefined {
    const stage = (resource as unknown as PayPalDispute).dispute_life_cycle_stage;
    return typeof stage === 'string' ? stage : undefined;
  }

  /**
   * `dispute_outcome.outcome_code` → the canonical outcome, or `undefined`.
   *
   * PayPal's enum has seven values and only three of them name who ends up with the money:
   * `RESOLVED_SELLER_FAVOUR`, `RESOLVED_BUYER_FAVOUR` and `CANCELED_BY_BUYER` ("the
   * customer canceled the dispute"). The rest deliberately return `undefined`:
   *
   * - `RESOLVED_WITH_PAYOUT` is "PayPal provided the merchant **or customer** with
   *   protection and the case is resolved" — it does not say which, and guessing decides
   *   whether the row goes back to `paid`.
   * - `ACCEPTED` and `DENIED` are marked DEPRECATED in PayPal's current schema and their
   *   descriptions ("PayPal accepted the dispute" / "PayPal denied the dispute") name the
   *   dispute rather than the party, unlike every other code in the same enum.
   * - `NONE` is "a dispute was created for the same transaction ID, and the previous
   *   dispute was closed **without any decision**", which is the definition of no outcome.
   *
   * Each of those stays `payment.updated` carrying the full resource on `event.raw`.
   */
  #disputeOutcome(resource: Record<string, unknown>): 'won' | 'lost' | 'canceled' | undefined {
    switch ((resource as unknown as PayPalDispute).dispute_outcome?.outcome_code) {
      case 'RESOLVED_SELLER_FAVOUR':
        return 'won';
      case 'RESOLVED_BUYER_FAVOUR':
        return 'lost';
      case 'CANCELED_BY_BUYER':
        return 'canceled';
      default:
        return undefined;
    }
  }

  #mapWebhookData(
    eventType: string,
    resource: Record<string, unknown>,
    type: string,
  ): Record<string, unknown> {
    if (eventType.startsWith('BILLING.SUBSCRIPTION.')) {
      const subscription = resource as unknown as PayPalSubscription;
      return {
        gatewayId: subscription.id,
        customerId:
          subscription.subscriber?.payer_id ?? subscription.subscriber?.email_address ?? '',
        status: this.#mapSubscriptionStatus(subscription.status),
        ...(subscription.plan_id !== undefined ? { planId: subscription.plan_id } : {}),
        ...(subscription.custom_id !== undefined
          ? { externalReference: subscription.custom_id }
          : {}),
      };
    }
    if (eventType.startsWith('PAYMENT.SALE.')) {
      // Sales carry money as `amount.total` + `amount.currency`, and the app's own
      // reference as `custom` — neither spelled the way captures spell them.
      const sale = resource as unknown as PayPalSale;
      const currency = (sale.amount?.currency ?? this.#currency).toLowerCase();
      return {
        gatewayId: sale.id,
        amount: this.#fromValue(sale.amount?.total, currency),
        currency,
        ...(sale.billing_agreement_id !== undefined
          ? { subscriptionId: sale.billing_agreement_id }
          : {}),
        ...(sale.custom !== undefined ? { externalReference: sale.custom } : {}),
      };
    }
    if (eventType.endsWith('DISPUTE.CREATED') || eventType.startsWith('CUSTOMER.DISPUTE.')) {
      // The dispute names the money as `dispute_amount` and the payment as the SELLER's
      // side of the disputed transaction — `seller_transaction_id` is the capture id this
      // driver keys payments on, and `buyer_transaction_id` is the buyer's view of the same
      // money, which would find no row here. A dispute can cover several transactions; the
      // first is the one the row is written against and `event.raw` carries the rest.
      const dispute = resource as unknown as PayPalDispute;
      const currency = (dispute.dispute_amount?.currency_code ?? this.#currency).toLowerCase();
      const transaction = dispute.disputed_transactions?.[0];
      const outcome =
        type === 'payment.dispute_closed' ? this.#disputeOutcome(resource) : undefined;
      return {
        gatewayId: transaction?.seller_transaction_id ?? '',
        amount: this.#fromValue(dispute.dispute_amount?.value, currency),
        currency,
        ...(dispute.dispute_id !== undefined ? { disputeId: dispute.dispute_id } : {}),
        ...(dispute.reason !== undefined ? { reason: dispute.reason } : {}),
        // The whole value of an inquiry: PayPal closes an unanswered dispute in the
        // customer's favour when this passes, so it is the date the alert is worth acting
        // on. Already RFC 3339, which is the ISO 8601 `actionableUntil` is declared as.
        ...(dispute.seller_response_due_date !== undefined
          ? { actionableUntil: dispute.seller_response_due_date }
          : {}),
        ...(dispute.dispute_life_cycle_stage !== undefined
          ? { disputeStage: dispute.dispute_life_cycle_stage }
          : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        ...(transaction?.custom !== undefined ? { externalReference: transaction.custom } : {}),
      };
    }
    if (eventType.startsWith('PAYMENT.AUTHORIZATION.')) {
      // An Authorization is shaped like a Capture — `id`, `status`, `amount`, `custom_id` —
      // so the same reader works; what differs is that the money is only held.
      const authorization = resource as unknown as PayPalCapture;
      const currency = (authorization.amount?.currency_code ?? this.#currency).toLowerCase();
      return {
        gatewayId: authorization.id,
        amount: this.#fromValue(authorization.amount?.value, currency),
        currency,
        status: 'authorized',
        ...(authorization.custom_id !== undefined
          ? { externalReference: authorization.custom_id }
          : {}),
      };
    }
    if (eventType.startsWith('CHECKOUT.ORDER.')) {
      const order = resource as unknown as PayPalOrder;
      const unit = order.purchase_units?.[0];
      const currency = (unit?.amount?.currency_code ?? this.#currency).toLowerCase();
      return {
        gatewayId: order.id,
        amount: this.#fromValue(unit?.amount?.value, currency),
        currency,
        ...(unit?.custom_id !== undefined ? { externalReference: unit.custom_id } : {}),
      };
    }
    const capture = resource as unknown as PayPalCapture;
    const currency = (capture.amount?.currency_code ?? this.#currency).toLowerCase();
    return {
      gatewayId: capture.id,
      amount: this.#fromValue(capture.amount?.value, currency),
      currency,
      ...(capture.custom_id !== undefined ? { externalReference: capture.custom_id } : {}),
    };
  }

  #mapCapture(data: PayPalCapture, fallbackCurrency: string): Payment {
    const statusMap: Record<string, Payment['status']> = {
      COMPLETED: 'paid',
      // The canonical set has no partial-refund state and the money did settle, so this
      // stays `paid`; the refund is a Refund of its own.
      PARTIALLY_REFUNDED: 'paid',
      PENDING: 'pending',
      DECLINED: 'failed',
      FAILED: 'failed',
      REFUNDED: 'refunded',
    };
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: this.#mapMoney(data.amount, fallbackCurrency),
      status: statusMap[data.status ?? ''] ?? 'pending',
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.create_time ?? new Date().toISOString(),
    };
    if (data.status === 'COMPLETED') {
      result.paidAt = data.update_time ?? data.create_time ?? new Date().toISOString();
    }
    return result;
  }

  #mapSubscription(data: PayPalSubscription): Subscription {
    const regular = data.plan?.billing_cycles?.find((cycle) => cycle.tenure_type === 'REGULAR');
    const price = regular?.pricing_scheme?.fixed_price;
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.subscriber?.payer_id ?? data.subscriber?.email_address ?? '',
      status: this.#mapSubscriptionStatus(data.status),
      planId: data.plan_id ?? '',
      ...(price !== undefined
        ? { amount: this.#mapMoney(price, price.currency_code.toLowerCase()) }
        : {}),
      ...(data.start_time !== undefined ? { currentPeriodStart: data.start_time } : {}),
      ...(data.billing_info?.next_billing_time !== undefined
        ? { currentPeriodEnd: data.billing_info.next_billing_time }
        : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.create_time ?? data.start_time ?? new Date().toISOString(),
    };
  }

  #mapSubscriptionStatus(status: string | undefined): SubscriptionStatus {
    switch (status) {
      case 'ACTIVE':
        return 'active';
      // Suspended is PayPal's pause: it exists, it bills nothing today, and `/activate`
      // starts it again. `past_due` said the subscriber owed money, which a merchant-
      // initiated suspension does not — and this driver's own `cancelSubscription` points
      // at suspend as the way to hold a subscription open. Either way it entitles nobody.
      case 'SUSPENDED':
        return 'paused';
      case 'CANCELLED':
        return 'canceled';
      case 'EXPIRED':
        return 'ended';
      // APPROVAL_PENDING and APPROVED both mean "the payer has not finished" — PayPal
      // has not charged anything yet.
      default:
        return 'incomplete';
    }
  }

  #mapMoney(money: PayPalMoney | undefined, fallbackCurrency: string): Payment['amount'] {
    const currency = (money?.currency_code ?? fallbackCurrency).toLowerCase();
    return { amount: this.#fromValue(money?.value, currency), currency };
  }

  /** The link the payer must be sent to; PayPal names it `payer-action` or `approve`. */
  #approvalUrl(links: PayPalLink[] | undefined): string {
    const link =
      links?.find((candidate) => candidate.rel === 'payer-action') ??
      links?.find((candidate) => candidate.rel === 'approve');
    return link?.href ?? '';
  }

  async #createSubscription(options: {
    planId: string;
    customId?: string;
    startTime?: string;
    returnUrl?: string;
    cancelUrl?: string;
    requestId?: string;
  }): Promise<PayPalSubscription> {
    const body: Record<string, unknown> = {
      plan_id: options.planId,
      ...(options.customId !== undefined ? { custom_id: options.customId } : {}),
      ...(options.startTime !== undefined ? { start_time: options.startTime } : {}),
      ...(options.returnUrl !== undefined
        ? {
            application_context: {
              return_url: options.returnUrl,
              ...(options.cancelUrl !== undefined ? { cancel_url: options.cancelUrl } : {}),
              user_action: 'SUBSCRIBE_NOW',
            },
          }
        : {}),
    };
    return this.#request<PayPalSubscription>('/v1/billing/subscriptions', {
      method: 'POST',
      body,
      headers: {
        Prefer: 'return=representation',
        ...this.#requestId(options.requestId),
      },
    });
  }

  /**
   * PayPal's idempotency header, with the limit its own guidance names.
   *
   * The per-endpoint schemas allow up to 10 000 characters, but PayPal's idempotency page
   * recommends a UUID "because it meets the 38 single-byte character limit" — so 38 is the
   * number that survives every endpoint, and a longer key is refused here rather than
   * accepted by one call and rejected by the next.
   */
  #requestId(key: string | undefined): Record<string, string> {
    if (key === undefined) return {};
    if (key.length > REQUEST_ID_MAX_LENGTH) {
      throw new Error(
        `[payments] PayPal's \`PayPal-Request-Id\` is documented at ${REQUEST_ID_MAX_LENGTH} single-byte characters (a UUID); got ${key.length}.`,
      );
    }
    return { 'PayPal-Request-Id': key };
  }

  // ── Money ────────────────────────────────────────────────────────────────────────────

  /** Minor units → the decimal string PayPal's `amount.value` wants for that currency. */
  #toValue(amount: Money, currency: string): string {
    if (PAYPAL_UNDIVIDED_CURRENCIES.has(currency.toLowerCase())) {
      if (amount % 100 !== 0) {
        throw new Error(
          `[payments] PayPal does not accept decimals in ${currency.toUpperCase()}, and ` +
            `${amount} is not a whole ${currency.toUpperCase()}. Charge a round amount.`,
        );
      }
      return String(amount / 100);
    }
    return formatDecimal(amount, currency);
  }

  /** PayPal's decimal string → minor units. */
  #fromValue(value: string | undefined, currency: string): Money {
    const parsed = Number(value ?? 0);
    if (Number.isNaN(parsed)) return 0;
    return fromDecimal(parsed, currency);
  }

  // ── Transport ────────────────────────────────────────────────────────────────────────

  async #request<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      bearerToken: await this.#accessToken(),
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    });
  }

  /**
   * The two calls PayPal answers with `204 No Content` (cancel, JSON Patch). `httpRequest`
   * always parses a JSON body, which throws on an empty one — and the JSON Patch body is
   * an array, not an object. Errors are shaped the same way so `isNotFound` still works.
   */
  async #requestNoContent(
    path: string,
    body: unknown,
    options: { method?: string } = {},
  ): Promise<void> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await this.#accessToken()}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await this.#error(response);
  }

  /** Error normalization matching `httpRequest`, for the two calls that bypass it. */
  async #error(response: Response): Promise<Error> {
    const text = await response.text();
    return Object.assign(
      new Error(`[payments] HTTP request failed (${response.status}): ${text}`),
      { status: response.status },
    );
  }

  /**
   * The client-credentials token, cached until PayPal's own `expires_in` says it is spent
   * (minus a safety margin). Caching it for any fixed period of our own choosing is how a
   * deploy works fine for an hour and then 401s on every charge.
   */
  async #accessToken(): Promise<string> {
    const cached = this.#token;
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.value;
    const response = await fetch(`${this.#baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.#basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) throw await this.#error(response);
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (data.access_token === undefined) {
      throw new Error('[payments] PayPal returned no access token for the client credentials.');
    }
    // No `expires_in` means we know nothing about the lifetime, so don't cache it.
    const ttlMs = typeof data.expires_in === 'number' ? data.expires_in * 1000 : 0;
    this.#token = {
      value: data.access_token,
      expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_SAFETY_MARGIN_MS),
    };
    return data.access_token;
  }
}
