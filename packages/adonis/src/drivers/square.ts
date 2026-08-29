import { randomUUID } from 'node:crypto';
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
import { emitInvoiceIfRequested } from '../invoice/emit_invoice.js';
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
import { verifyHmacOverPayload } from '../webhook_security.js';
import { requireCredential, requireCurrency } from './shared.js';

/**
 * Config for {@link SquareDriver}.
 *
 * Declared here rather than in `define_config.ts` so the driver module type-checks on its
 * own; `define_config.ts` re-exports it with an `import type`, which is erased at compile
 * time and therefore keeps the driver lazily loaded.
 */
export interface SquareDriverConfig {
  /** Square access token. Defaults to `env.get('SQUARE_ACCESS_TOKEN')`. */
  accessToken?: string;
  /**
   * The seller location every call is scoped to (`L…`). Defaults to
   * `env.get('SQUARE_LOCATION_ID')`. **Required** — payments, payment links, subscriptions
   * and the invoice search all take a location, and Square's "defaults to the main
   * location" fallback silently books money against whichever location the account happens
   * to list first.
   */
  locationId?: string;
  /**
   * Currency for calls that don't name one (lowercase ISO 4217). **Required** — Square
   * sells in USD, CAD, GBP, EUR, AUD and JPY depending on the seller's country, so a
   * default here would be a guess, and a wrong guess is accepted by the API.
   */
  currency: string;
  /** Talk to `connect.squareupsandbox.com` instead of production. */
  sandbox?: boolean;
  /**
   * Webhook subscription's signature key (Developer Console → Webhooks). Defaults to
   * `env.get('SQUARE_WEBHOOK_SIGNATURE_KEY')`. When set, {@link notificationUrl} is
   * required too — see the class docblock.
   */
  webhookSignatureKey?: string;
  /**
   * The webhook subscription's notification URL, verbatim, including scheme and any path:
   * `https://app.example.com/webhooks/square`. Defaults to
   * `env.get('SQUARE_WEBHOOK_NOTIFICATION_URL')`.
   *
   * Square signs `notificationUrl + rawBody`, not the body alone, so this string is part
   * of the secret material. A driver that guessed it would reject every real webhook.
   */
  notificationUrl?: string;
  /**
   * `Square-Version` sent on every request. Defaults to {@link DEFAULT_API_VERSION}.
   * Pinning it here means a Square release cannot change response shapes underneath the
   * mappings below; omitting the header entirely would let Square pick the account's
   * default version, which is exactly the drift this avoids.
   */
  apiVersion?: string;
}

/** The `Square-Version` these mappings were written against. */
const DEFAULT_API_VERSION = '2026-08-19';

/** `idempotency_key` on the Payments and Refunds APIs. Payment links allow 192. */
const IDEMPOTENCY_MAX_LENGTH = 45;

/** `reference_id` on a Payment and on an Order. */
const REFERENCE_MAX_LENGTH = 40;

/** `note` on a Payment. */
const NOTE_MAX_LENGTH = 500;

interface SquareMoney {
  amount?: number;
  currency?: string;
}

interface SquarePaymentResponse {
  id: string;
  created_at?: string;
  updated_at?: string;
  amount_money?: SquareMoney;
  refunded_money?: SquareMoney;
  status?: 'APPROVED' | 'PENDING' | 'COMPLETED' | 'CANCELED' | 'FAILED';
  /** `CARD` | `BANK_ACCOUNT` | `WALLET` | `BUY_NOW_PAY_LATER` | `SQUARE_ACCOUNT` | `CASH` | `EXTERNAL`. */
  source_type?: string;
  card_details?: { card?: { card_type?: string } } | null;
  location_id?: string;
  order_id?: string;
  customer_id?: string;
  reference_id?: string;
  note?: string;
  receipt_url?: string;
}

interface SquareRefundResponse {
  id: string;
  status?: 'PENDING' | 'COMPLETED' | 'REJECTED' | 'FAILED';
  amount_money?: SquareMoney;
  payment_id?: string;
  order_id?: string;
  created_at?: string;
  reason?: string;
}

interface SquareCustomerResponse {
  id: string;
  given_name?: string;
  family_name?: string;
  company_name?: string;
  email_address?: string;
  phone_number?: string;
  reference_id?: string;
  note?: string;
  tax_ids?: { eu_vat?: string } | null;
  created_at?: string;
}

interface SquareOrderResponse {
  id?: string;
  location_id?: string;
  reference_id?: string;
  customer_id?: string;
  state?: string;
  total_money?: SquareMoney;
  metadata?: Record<string, string> | null;
  created_at?: string;
}

interface SquarePaymentLinkResponse {
  id: string;
  version?: number;
  description?: string;
  order_id?: string;
  url: string;
  long_url?: string;
  payment_note?: string;
  created_at?: string;
}

interface SquareSubscriptionResponse {
  id: string;
  location_id?: string;
  plan_variation_id?: string;
  customer_id?: string;
  start_date?: string;
  canceled_date?: string;
  charged_through_date?: string;
  status?: 'PENDING' | 'ACTIVE' | 'CANCELED' | 'DEACTIVATED' | 'PAUSED' | 'COMPLETED';
  price_override_money?: SquareMoney;
  card_id?: string;
  timezone?: string;
  version?: number;
  created_at?: string;
  invoice_ids?: string[];
}

interface SquareInvoiceResponse {
  id: string;
  version?: number;
  location_id?: string;
  order_id?: string;
  subscription_id?: string;
  primary_recipient?: { customer_id?: string } | null;
  payment_requests?: Array<{ computed_amount_money?: SquareMoney }> | null;
  invoice_number?: string;
  public_url?: string;
  next_payment_amount_money?: SquareMoney;
  status?: string;
  created_at?: string;
}

/**
 * The Dispute object as it arrives on `dispute.created`. The payment it is about is nested
 * (`disputed_payment.payment_id`), not a top-level field — reading `payment_id` off the
 * dispute itself finds nothing.
 */
interface SquareDisputeResponse {
  id?: string;
  amount_money?: SquareMoney;
  disputed_payment?: { payment_id?: string } | null;
  state?: string;
  reason?: string;
  card_brand?: string;
  due_at?: string;
  location_id?: string;
  created_at?: string;
  updated_at?: string;
}

interface SquareWebhookPayload {
  merchant_id?: string;
  type: string;
  event_id?: string;
  created_at?: string;
  data?: {
    type?: string;
    id?: string;
    object?: {
      payment?: SquarePaymentResponse;
      refund?: SquareRefundResponse;
      subscription?: SquareSubscriptionResponse;
      invoice?: SquareInvoiceResponse;
      order?: SquareOrderResponse;
      dispute?: SquareDisputeResponse;
      order_created?: { order_id?: string; location_id?: string; state?: string };
      order_updated?: { order_id?: string; location_id?: string; state?: string };
    };
  };
}

/**
 * Square driver — the US-first seller platform (`connect.squareup.com/v2`), Bearer token,
 * multi-currency, everything scoped to one seller location.
 *
 * Three shapes of this API drive the mappings below:
 *
 * **A charge needs a token you cannot mint server-side.** `POST /v2/payments` takes a
 * `source_id`: a single-use card nonce from the Web Payments SDK, or a `ccof:`/card-on-file
 * id. There is no "charge this customer for this amount" call, so `charge()` requires
 * `paymentMethodId` (or `card.token`) and refuses without one rather than inventing a flow.
 *
 * **`idempotency_key` is a body field, not a header** — on payments, refunds, subscriptions
 * and payment links alike. Square also *requires* it on payments and refunds, so a call
 * that arrives without one gets a generated UUID; that protects the retry inside a single
 * call, not a retry from your own job queue, which is what `idempotencyKey` is for.
 *
 * **Webhook signatures cover `notificationUrl + body`.** The URL is part of the signed
 * material, which means the driver has to be told its own public URL. Configure
 * `webhookSignatureKey` without `notificationUrl` and the constructor throws: the
 * alternative is a driver that rejects every genuine webhook, or worse, one that decides
 * to skip verification because it lacks a piece of the input.
 *
 * Money is an integer in the currency's minor unit on both sides (`{ amount: 1990,
 * currency: 'USD' }`), so this driver converts nothing — see {@link SquareDriver.charge}.
 */
export class SquareDriver implements PaymentsDriver {
  readonly provider = 'square';
  /**
   * `source_id` decides the instrument, and it is minted in the browser — the driver hands
   * Square an opaque token and learns what it was only from `source_type` on the way back.
   * The Web Payments SDK mints more than card tokens, though: Cash App Pay and the device
   * wallets (`WALLET`), ACH bank tokens (`BANK_ACCOUNT`) and Afterpay/Clearpay
   * (`BUY_NOW_PAY_LATER`) all arrive at `POST /v2/payments` through the same `source_id`,
   * so `charge()` genuinely produces those categories. `undefined` covers the hosted
   * payment link, where the payer picks. Pix and boleto are absent because Square does not
   * sell in Brazil.
   */
  readonly supportedMethods = [
    'credit_card',
    'debit_card',
    'wallet',
    'bank_debit',
    'bnpl',
    'undefined',
  ] as const;
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true };

  #baseUrl: string;
  #accessToken: string;
  #locationId: string;
  #currency: string;
  #apiVersion: string;
  #webhookSignatureKey: string | undefined;
  #notificationUrl: string | undefined;
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: SquareDriverConfig) {
    this.#invoiceCtx = ctx;
    this.#accessToken = requireCredential({
      driver: 'square',
      option: 'accessToken',
      env: 'SQUARE_ACCESS_TOKEN',
      value: config.accessToken,
    });
    this.#locationId = requireCredential({
      driver: 'square',
      option: 'locationId',
      env: 'SQUARE_LOCATION_ID',
      value: config.locationId,
    });
    this.#currency = requireCurrency('square', config.currency);
    this.#apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.#webhookSignatureKey =
      config.webhookSignatureKey ?? process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    this.#notificationUrl = config.notificationUrl ?? process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
    if (this.#webhookSignatureKey !== undefined && this.#notificationUrl === undefined) {
      throw new Error(
        '[payments] Driver "square" has a webhookSignatureKey but no notificationUrl. Square signs `notificationUrl + body`, so the URL is part of the secret: set `SQUARE_WEBHOOK_NOTIFICATION_URL` (or pass `notificationUrl`) to the exact URL registered on the webhook subscription.',
      );
    }
    this.#baseUrl =
      config.sandbox === true
        ? 'https://connect.squareupsandbox.com/v2'
        : 'https://connect.squareup.com/v2';
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const body: Record<string, unknown> = {
      idempotency_key: this.#idempotencyKey(input.idempotencyKey),
      // Square splits a person into `given_name`/`family_name` and has no single "name"
      // field. Splitting on whitespace guesses which token is the surname, which is wrong
      // for most of the world's names, so the whole string goes in `given_name` and the
      // caller can pass `metadata.familyName` when it genuinely knows the split.
      ...(input.name !== undefined ? { given_name: input.name } : {}),
      ...(typeof input.metadata?.familyName === 'string'
        ? { family_name: input.metadata.familyName }
        : {}),
      ...(typeof input.metadata?.companyName === 'string'
        ? { company_name: input.metadata.companyName }
        : {}),
      ...(input.email !== undefined ? { email_address: input.email } : {}),
      ...(typeof input.metadata?.phone === 'string' ? { phone_number: input.metadata.phone } : {}),
      ...(typeof input.metadata?.referenceId === 'string'
        ? { reference_id: input.metadata.referenceId }
        : {}),
      ...this.#taxIds(input.taxId, input.metadata),
    };
    const data = await this.#request<{ customer: SquareCustomerResponse }>('/customers', {
      method: 'POST',
      body,
    });
    return this.#mapCustomer(data.customer);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<{ customer: SquareCustomerResponse }>(
        `/customers/${customerId}`,
      );
      return this.#mapCustomer(data.customer);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const body: Record<string, unknown> = {
      ...(input.name !== undefined ? { given_name: input.name } : {}),
      ...(typeof input.metadata?.familyName === 'string'
        ? { family_name: input.metadata.familyName }
        : {}),
      ...(input.email !== undefined ? { email_address: input.email } : {}),
      ...(typeof input.metadata?.phone === 'string' ? { phone_number: input.metadata.phone } : {}),
      ...this.#taxIds(input.taxId, input.metadata),
    };
    const data = await this.#request<{ customer: SquareCustomerResponse }>(
      `/customers/${customerId}`,
      { method: 'PUT', body },
    );
    return this.#mapCustomer(data.customer);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    const sourceId = input.paymentMethodId ?? input.card?.token;
    if (sourceId === undefined) {
      throw new Error(
        '[payments] Square needs a `source_id` to charge: a single-use card token from the Web Payments SDK, or a saved card id (`ccof:…`) together with `customerId`. Pass it as `paymentMethodId` (or `card.token`) — there is no server-side "charge this customer" call.',
      );
    }
    if (
      input.method !== undefined &&
      !['credit_card', 'debit_card', 'wallet', 'bank_debit', 'bnpl', 'undefined'].includes(
        input.method,
      )
    ) {
      throw new Error(
        `[payments] Square has no "${input.method}" payment method. The instrument is fixed by the token in \`paymentMethodId\`, so \`method\` is a declaration, not an instruction: it may name a card (\`credit_card\`/\`debit_card\`), a wallet, \`bank_debit\` (ACH) or \`bnpl\` (Afterpay), and Square — not this call — decides which the token turns out to be.`,
      );
    }
    if (input.split !== undefined && input.split.length > 0) {
      throw new Error(
        '[payments] Square does not split a payment across recipients. `app_fee_money` takes a single application fee for an OAuth-connected seller, which is not the same thing; pass it as `metadata.appFeeAmount` if that is what you want.',
      );
    }
    const currency = (input.currency ?? this.#currency).toUpperCase();
    const referenceId = this.#reference(input.externalReference, 'charge');
    const body: Record<string, unknown> = {
      source_id: sourceId,
      // Square requires an idempotency key and takes it in the BODY, not a header. A
      // generated UUID only makes Square's own retry safe; a caller that wants a job retry
      // to be safe has to pass its own `idempotencyKey`.
      idempotency_key: this.#idempotencyKey(input.idempotencyKey),
      // No conversion anywhere in this driver: Square's `amount_money.amount` is already the
      // integer minor unit, the same unit as this package's `Money`. The Brazilian drivers
      // next door divide by 100 because their gateways want decimal reais — doing that here
      // would bill a hundredth of the charge, and Square would accept it.
      amount_money: { amount: input.amount, currency },
      location_id: this.#locationId,
      ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
      ...(referenceId !== undefined ? { reference_id: referenceId } : {}),
      ...(input.description !== undefined
        ? { note: input.description.slice(0, NOTE_MAX_LENGTH) }
        : {}),
      ...(input.card?.holder?.email !== undefined
        ? { buyer_email_address: input.card.holder.email }
        : {}),
      // Delayed capture: `autocomplete: false` leaves the payment APPROVED (money held, not
      // moved) until `completePayment` runs. See that method for why it is not on the
      // driver contract.
      ...(input.metadata?.autocomplete === false ? { autocomplete: false } : {}),
      ...(typeof input.metadata?.appFeeAmount === 'number'
        ? { app_fee_money: { amount: input.metadata.appFeeAmount, currency } }
        : {}),
    };
    const data = await this.#request<{ payment: SquarePaymentResponse }>('/payments', {
      method: 'POST',
      body,
    });
    const payment = this.#mapPayment(data.payment);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#request<{ payment: SquarePaymentResponse }>(
        `/payments/${gatewayId}`,
      );
      return this.#mapPayment(data.payment);
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
    // `RefundPayment` has no "refund everything" mode — `amount_money` is mandatory. So a
    // full refund is a read followed by a write, and the amount refunded is the amount
    // Square reports for the payment, never a number this driver computed.
    const target =
      amount !== undefined
        ? { amount, currency: this.#currency.toUpperCase() }
        : await this.#paymentAmount(paymentGatewayId);
    const data = await this.#request<{ refund: SquareRefundResponse }>('/refunds', {
      method: 'POST',
      body: {
        // Square requires the key and takes it in the BODY. Generating one made Square's
        // own retry safe and a retried job double-refund; the caller's key is what makes
        // the second call return the first refund instead of issuing another.
        idempotency_key: this.#idempotencyKey(options?.idempotencyKey),
        payment_id: paymentGatewayId,
        amount_money: target,
      },
    });
    const refund: Refund = {
      id: data.refund.id,
      gatewayId: data.refund.id,
      provider: this.provider,
      amount: {
        amount: data.refund.amount_money?.amount ?? target.amount,
        currency: (data.refund.amount_money?.currency ?? target.currency).toLowerCase(),
      },
      // `PENDING` is the usual first answer for a card refund; `refund.updated` carrying
      // `COMPLETED` is the only thing that means the money left.
      status:
        data.refund.status === 'COMPLETED'
          ? 'succeeded'
          : data.refund.status === 'REJECTED' || data.refund.status === 'FAILED'
            ? 'failed'
            : 'pending',
      createdAt: data.refund.created_at ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  /**
   * Capture a payment created with `metadata: { autocomplete: false }`.
   *
   * Not part of {@link PaymentsDriver}: the contract has one verb for taking money, and a
   * driver-specific second half does not fit it. It is public because the alternative is
   * worse — an `APPROVED` payment now reads as `authorized`, and Square voids the
   * authorization on its own when `delay_duration` runs out, so something has to be able
   * to finish the job.
   */
  async completePayment(paymentGatewayId: string): Promise<Payment> {
    const data = await this.#request<{ payment: SquarePaymentResponse }>(
      `/payments/${paymentGatewayId}/complete`,
      { method: 'POST', body: {} },
    );
    const payment = this.#mapPayment(data.payment);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (input.cancelUrl !== undefined) {
      throw new Error(
        '[payments] A Square payment link has one redirect (`checkout_options.redirect_url`) and no cancel URL — a buyer who abandons it stays on the link. Drop `cancelUrl` rather than letting it look configured.',
      );
    }
    if (input.trialDays !== undefined) {
      throw new Error(
        '[payments] Square puts a free trial in the subscription plan variation as a free phase, not on the checkout. Remove `trialDays` and point `planId` at a variation whose first phase is free.',
      );
    }
    const currency = (input.currency ?? this.#currency).toUpperCase();
    const referenceId = this.#reference(input.externalReference, 'checkout');
    const body: Record<string, unknown> = {
      idempotency_key: this.#idempotencyKey(input.idempotencyKey),
      // The `order` form rather than `quick_pay`, for one reason: a PaymentLink has no
      // reference field of its own, and an Order has `reference_id` plus `metadata`. With
      // `quick_pay` there is nowhere to put `externalReference` at all.
      order: {
        location_id: this.#locationId,
        line_items: [
          {
            name: input.description ?? 'Payment',
            // Square wants the quantity as a string.
            quantity: '1',
            base_price_money: { amount: input.amount, currency },
          },
        ],
        ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
        ...(referenceId !== undefined ? { reference_id: referenceId } : {}),
        ...(referenceId !== undefined || input.metadata !== undefined
          ? { metadata: this.#orderMetadata(referenceId, input.metadata) }
          : {}),
      },
      checkout_options: {
        redirect_url: input.successUrl,
        // A plan VARIATION id, not a plan id: Square subscribes buyers to variations.
        ...(input.planId !== undefined ? { subscription_plan_id: input.planId } : {}),
      },
      // Also carried onto the resulting Payment's `note`, which is the one place a
      // reference survives into `payment.created`. See the docs page for why both.
      ...(referenceId !== undefined ? { payment_note: referenceId } : {}),
    };
    const data = await this.#request<{ payment_link: SquarePaymentLinkResponse }>(
      '/online-checkout/payment-links',
      { method: 'POST', body },
    );
    return {
      id: data.payment_link.id,
      gatewayId: data.payment_link.id,
      provider: this.provider,
      url: data.payment_link.url,
      // Square has no status on a payment link — it either exists or it does not.
      status: 'open',
      amount: { amount: input.amount, currency: currency.toLowerCase() },
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    if (input.cycle !== undefined) {
      throw new Error(
        '[payments] Square takes the billing cadence from the subscription plan variation, not from the call. Remove `cycle` and point `planId` at a variation with that cadence.',
      );
    }
    if (input.method !== undefined) {
      throw new Error(
        '[payments] Square bills a subscription from a card on file or by emailing an invoice; there is no method to name. Remove `method` and pass `metadata.cardId` for the card-on-file flow.',
      );
    }
    if (input.trialDays !== undefined) {
      throw new Error(
        '[payments] Square expresses a trial as a free phase on the plan variation, not as a number of days on the subscription. Remove `trialDays` and use a variation whose first phase is free.',
      );
    }
    if (input.card !== undefined) {
      throw new Error(
        '[payments] A Web Payments SDK card token is single-use and cannot become a subscription card. Save it first with `POST /v2/cards`, then pass the resulting `card_…` id as `metadata.cardId`.',
      );
    }
    if (input.externalReference !== undefined) {
      throw new Error(
        '[payments] A Square subscription has no reference or metadata field, so `externalReference` would be silently dropped and could never come back on `subscription.updated`. Key your record on `customerId` plus the returned subscription id instead.',
      );
    }
    const body: Record<string, unknown> = {
      idempotency_key: this.#idempotencyKey(input.idempotencyKey),
      location_id: this.#locationId,
      plan_variation_id: input.planId,
      customer_id: input.customerId,
      ...(input.startDate !== undefined ? { start_date: this.#startDate(input.startDate) } : {}),
      ...(typeof input.metadata?.cardId === 'string' ? { card_id: input.metadata.cardId } : {}),
      ...(typeof input.metadata?.timezone === 'string'
        ? { timezone: input.metadata.timezone }
        : {}),
      // A real Square field, and the one place the contract's `amount` fits: it overrides
      // the variation's price for a statically-priced plan. Minor units, no conversion.
      ...(input.amount !== undefined
        ? {
            price_override_money: {
              amount: input.amount,
              currency: this.#currency.toUpperCase(),
            },
          }
        : {}),
    };
    const data = await this.#request<{ subscription: SquareSubscriptionResponse }>(
      '/subscriptions',
      { method: 'POST', body },
    );
    const subscription = this.#mapSubscription(data.subscription, input.customerId);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    if (options?.atPeriodEnd === false) {
      throw new Error(
        '[payments] Square cannot end a subscription mid-period: `POST /v2/subscriptions/{id}/cancel` sets `canceled_date` to the end of the current billing period and the status stays ACTIVE until then. Call it without `atPeriodEnd: false`, and refund the last invoice if the buyer should not have been billed for the period.',
      );
    }
    const data = await this.#request<{ subscription: SquareSubscriptionResponse }>(
      `/subscriptions/${subscriptionGatewayId}/cancel`,
      { method: 'POST', body: {} },
    );
    const subscription = this.#mapSubscription(data.subscription);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    if (input.idempotencyKey !== undefined) {
      throw new Error(
        '[payments] Square has no idempotency key on a subscription update: neither `PUT /v2/subscriptions/{id}` nor `POST /v2/subscriptions/{id}/swap-plan` takes an `idempotency_key`, unlike the create call. Accepting one here would turn your retry guarantee into a second plan swap, so it is refused rather than dropped.',
      );
    }
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Square will not reprice a live subscription: `price_override_money` is set at creation and `UpdateSubscription` documents only `card_id` and `canceled_date` as changeable. Swap to a plan variation at the new price with `metadata: { planVariationId: "…" }`, which is a change Square actually applies.',
      );
    }
    if (input.description !== undefined) {
      throw new Error(
        '[payments] A Square subscription has no description field. Keep it on your own record.',
      );
    }
    const planVariationId = input.metadata?.planVariationId;
    const cardId = input.metadata?.cardId;
    if (typeof planVariationId !== 'string' && typeof cardId !== 'string') {
      throw new Error(
        '[payments] Nothing to update on a Square subscription. It accepts a plan swap (`metadata: { planVariationId }`) or a new card on file (`metadata: { cardId }`); anything else would be a change the gateway never sees.',
      );
    }
    if (typeof planVariationId === 'string') {
      const swapped = await this.#request<{ subscription: SquareSubscriptionResponse }>(
        `/subscriptions/${subscriptionGatewayId}/swap-plan`,
        { method: 'POST', body: { new_plan_variation_id: planVariationId } },
      );
      return this.#mapSubscription(swapped.subscription);
    }
    const data = await this.#request<{ subscription: SquareSubscriptionResponse }>(
      `/subscriptions/${subscriptionGatewayId}`,
      { method: 'PUT', body: { subscription: { card_id: cardId } } },
    );
    return this.#mapSubscription(data.subscription);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<{ subscription: SquareSubscriptionResponse }>(
        `/subscriptions/${gatewayId}`,
      );
      return this.#mapSubscription(data.subscription);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(customerId: string): Promise<Invoice[]> {
    // `GET /v2/invoices` filters by location only; the search endpoint is the one that
    // takes a customer. Square documents the filter as accepting one location and one
    // customer, which is exactly this call.
    const data = await this.#request<{ invoices?: SquareInvoiceResponse[] }>('/invoices/search', {
      method: 'POST',
      body: {
        query: { filter: { location_ids: [this.#locationId], customer_ids: [customerId] } },
        limit: 100,
      },
    });
    return (data.invoices ?? []).map((invoice) => this.#mapInvoice(invoice));
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * Square signs `notificationUrl + body`, so BOTH are needed — a signature key with no URL
   * verifies nothing, which is why the check below tests for both.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookSignatureKey !== undefined && this.#notificationUrl !== undefined
      ? 'configured'
      : 'unconfigured';
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (this.#webhookSignatureKey !== undefined && this.#notificationUrl !== undefined) {
      const signature = headerValue(headers, 'x-square-hmacsha256-signature');
      if (signature === undefined || signature === '') {
        throw new Error(
          '[payments] Missing x-square-hmacsha256-signature on Square webhook request.',
        );
      }
      // The notification URL is prepended to the raw body BEFORE hashing — Square signs
      // `url + body`, so a signature lifted from another endpoint of the same account does
      // not verify here.
      const signed = `${this.#notificationUrl}${rawBody}`;
      if (
        !verifyHmacOverPayload(signed, signature, this.#webhookSignatureKey, 'sha256', 'base64')
      ) {
        throw new Error('[payments] Invalid Square webhook signature.');
      }
    }
    const payload = JSON.parse(rawBody) as SquareWebhookPayload;
    return {
      id: payload.event_id ?? `${payload.type}-${payload.data?.id ?? ''}`,
      provider: this.provider,
      type: this.#mapWebhookType(payload),
      createdAt: payload.created_at ?? new Date().toISOString(),
      data: this.#mapWebhookData(payload),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: SquareCustomerResponse): Customer {
    const name = [data.given_name, data.family_name].filter(Boolean).join(' ');
    return {
      id: data.id,
      ...(name !== '' ? { name } : {}),
      ...(data.email_address ? { email: data.email_address } : {}),
      ...(data.tax_ids?.eu_vat ? { taxId: data.tax_ids.eu_vat } : {}),
    };
  }

  #mapPayment(data: SquarePaymentResponse): Payment {
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: {
        amount: data.amount_money?.amount ?? 0,
        currency: (data.amount_money?.currency ?? this.#currency).toLowerCase(),
      },
      status: this.#mapPaymentStatus(data),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at ?? new Date().toISOString(),
    };
    const method = this.#mapMethodToType(data);
    if (method !== undefined) result.method = method;
    if (data.customer_id) result.customerId = data.customer_id;
    const paidAt = data.updated_at ?? data.created_at;
    if (data.status === 'COMPLETED' && paidAt !== undefined) result.paidAt = paidAt;
    if (data.receipt_url) result.hostedUrl = data.receipt_url;
    return result;
  }

  /**
   * `APPROVED` means Square is holding the funds on the buyer's card and nothing has moved
   * to the seller; the authorization expires on its own if `CompletePayment` never runs.
   * That is exactly `authorized` — it used to collapse into `pending`, which reads like a
   * payment nobody has attempted rather than one whose money is reserved and ticking.
   * `PENDING` stays `pending`: Square has not approved anything yet.
   *
   * A refunded payment stays `COMPLETED` at Square with a non-zero `refunded_money`, so
   * that is read separately — otherwise a full refund would keep reporting as `paid`.
   */
  #mapPaymentStatus(data: SquarePaymentResponse): Payment['status'] {
    const refunded = data.refunded_money?.amount ?? 0;
    const total = data.amount_money?.amount ?? 0;
    if (refunded > 0 && refunded >= total) return 'refunded';
    switch (data.status) {
      case 'COMPLETED':
        return 'paid';
      case 'APPROVED':
        return 'authorized';
      case 'FAILED':
        return 'failed';
      case 'CANCELED':
        return 'canceled';
      default:
        return 'pending';
    }
  }

  /**
   * Square's `source_type` → the canonical {@link PaymentMethodType}.
   *
   * All of these now have a name: a Cash App payment is a `wallet`, an ACH one is a
   * `bank_debit` (pulled from the buyer's account), Afterpay is `bnpl`. They used to come
   * back unset, which is indistinguishable from "Square did not say" — and the Square
   * balance (`SQUARE_ACCOUNT`) is a stored balance, which is what `wallet` means.
   *
   * `CASH` and `EXTERNAL` stay unset on purpose: they are money recorded as taken outside
   * Square altogether, and no member of the union describes that.
   */
  #mapMethodToType(data: SquarePaymentResponse): Payment['method'] | undefined {
    switch (data.source_type) {
      case 'CARD':
        return data.card_details?.card?.card_type === 'DEBIT' ? 'debit_card' : 'card';
      case 'WALLET':
      case 'SQUARE_ACCOUNT':
        return 'wallet';
      case 'BANK_ACCOUNT':
        return 'bank_debit';
      case 'BUY_NOW_PAY_LATER':
        return 'bnpl';
      default:
        return undefined;
    }
  }

  #mapSubscription(data: SquareSubscriptionResponse, customerId?: string): Subscription {
    const statusMap: Record<string, Subscription['status']> = {
      PENDING: 'incomplete',
      ACTIVE: 'active',
      // A paused Square subscription bills nothing and will bill again when it resumes.
      // `past_due` said the buyer owed money they did not; the subscriber is entitled to
      // nothing either way, which is the part that must not change.
      PAUSED: 'paused',
      CANCELED: 'canceled',
      DEACTIVATED: 'canceled',
      COMPLETED: 'ended',
    };
    const result: Subscription = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customer_id ?? customerId ?? '',
      status: (data.status !== undefined ? statusMap[data.status] : undefined) ?? 'active',
      planId: data.plan_variation_id ?? '',
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.created_at ?? new Date().toISOString(),
    };
    if (data.price_override_money?.amount !== undefined) {
      result.amount = {
        amount: data.price_override_money.amount,
        currency: (data.price_override_money.currency ?? this.#currency).toLowerCase(),
      };
    }
    // Square's dates are `YYYY-MM-DD`, not timestamps; they are widened to UTC midnight so
    // the whole package keeps holding ISO instants.
    const startsAt = this.#toIso(data.start_date);
    const endsAt = this.#toIso(data.canceled_date);
    const chargedThrough = this.#toIso(data.charged_through_date);
    if (startsAt !== undefined) result.currentPeriodStart = startsAt;
    if (chargedThrough !== undefined) result.currentPeriodEnd = chargedThrough;
    if (endsAt !== undefined) result.endsAt = endsAt;
    return result;
  }

  #mapInvoice(data: SquareInvoiceResponse): Invoice {
    const statusMap: Record<string, Invoice['status']> = {
      DRAFT: 'draft',
      UNPAID: 'open',
      SCHEDULED: 'open',
      PARTIALLY_PAID: 'open',
      PAID: 'paid',
      PARTIALLY_REFUNDED: 'paid',
      REFUNDED: 'paid',
      CANCELED: 'canceled',
      FAILED: 'failed',
      PAYMENT_PENDING: 'pending',
    };
    const amount =
      data.payment_requests?.[0]?.computed_amount_money?.amount ??
      data.next_payment_amount_money?.amount ??
      0;
    const currency =
      data.payment_requests?.[0]?.computed_amount_money?.currency ??
      data.next_payment_amount_money?.currency ??
      this.#currency;
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      ...(data.primary_recipient?.customer_id
        ? { customerId: data.primary_recipient.customer_id }
        : {}),
      ...(data.subscription_id ? { subscriptionId: data.subscription_id } : {}),
      status: (data.status !== undefined ? statusMap[data.status] : undefined) ?? 'draft',
      amount: { amount, currency: currency.toLowerCase() },
      createdAt: data.created_at ?? new Date().toISOString(),
      // `public_url` is Square's hosted invoice page, not a PDF; it is the closest thing
      // the API offers and the field a reader will go looking in.
      ...(data.public_url ? { hostedPdfUrl: data.public_url } : {}),
      ...(data.invoice_number ? { number: data.invoice_number } : {}),
      payload: data as unknown as Record<string, unknown>,
    };
  }

  #mapWebhookType(payload: SquareWebhookPayload): string {
    const object = payload.data?.object;
    switch (payload.type) {
      case 'payment.created':
      case 'payment.updated': {
        const payment = object?.payment;
        if (payment === undefined) return 'payment.updated';
        const status = this.#mapPaymentStatus(payment);
        if (status === 'paid') return 'payment.succeeded';
        if (status === 'refunded') return 'payment.refunded';
        if (status === 'failed' || status === 'canceled') return 'payment.failed';
        return 'payment.updated';
      }
      case 'refund.created':
      case 'refund.updated':
        // Only a COMPLETED refund means money left; `PENDING` and `REJECTED` are not a
        // refund the ledger should record as one.
        return object?.refund?.status === 'COMPLETED' ? 'payment.refunded' : 'payment.updated';
      case 'invoice.payment_made':
        return 'payment.succeeded';
      // ── The dispute family ───────────────────────────────────────────────────────────
      // Square answers the money question outright for a chargeback: when the bank notifies
      // it of one, "Square withholds the disputed funds from the seller's Square account
      // balance until the bank issues a final resolution on the case. If there are
      // insufficient funds in the Square account balance, the funds are removed (debited)
      // from the seller's most recently linked bank account." So `dispute.created` is
      // `payment.disputed` — unless the state says this is an inquiry, see
      // {@link SquareDriver.#disputeType}. `dispute.state.updated` carries the whole Dispute
      // object, so it is read the same way and is where the resolution arrives.
      case 'dispute.created':
      case 'dispute.state.updated':
      // The deprecated spelling of `dispute.state.updated`; an app still subscribed to it
      // should not silently miss the resolution.
      case 'dispute.state.changed':
        return this.#disputeType(object?.dispute, payload.type);
      // Evidence going in and out is paperwork inside an open dispute, not a resolution of
      // it. `.created`/`.deleted` are the current names, `.added`/`.removed` the deprecated
      // ones Square still publishes.
      case 'dispute.evidence.added':
      case 'dispute.evidence.created':
      case 'dispute.evidence.deleted':
      case 'dispute.evidence.removed':
        return 'payment.updated';
      case 'subscription.created':
        return 'subscription.created';
      case 'subscription.updated': {
        const status = object?.subscription?.status;
        return status === 'CANCELED' || status === 'DEACTIVATED'
          ? 'subscription.canceled'
          : 'subscription.updated';
      }
      default:
        return payload.type;
    }
  }

  /**
   * A Dispute's `state` → the canonical event type.
   *
   * Square's `DisputeState` enum has eight values and splits cleanly in two. Four of them
   * are a real chargeback — `EVIDENCE_REQUIRED` ("the initial state of a dispute with
   * evidence required"), `PROCESSING` ("dispute evidence has been submitted and the bank is
   * processing the dispute"), `WON` and `LOST` — and three more are prefixed `INQUIRY_`,
   * which Square's own enum descriptions call "an inquiry" rather than a dispute.
   *
   * The inquiry states become `payment.dispute_warning`. **Square's reference does not say
   * in words whether an inquiry withholds funds**: the "Square withholds the disputed funds"
   * sentence is written about a cardholder requesting a charge reversal, and the support
   * article on information requests says nothing about money at all. What the reference does
   * do is name these states inquiries and keep them out of the dispute states, which is the
   * same distinction Stripe draws with its `warning_*` statuses and the networks draw
   * between a retrieval request and a chargeback. Reporting an inquiry as a warning writes
   * nothing to the ledger; reporting it as `payment.disputed` moves a paid row.
   *
   * `INQUIRY_CLOSED` is "the inquiry is complete" and names no winner, so it stays a
   * `payment.updated` — the processor throws on a close with no outcome precisely so a
   * driver that cannot read one emits an update instead.
   *
   * `ACCEPTED` is a **loss**: `AcceptDispute` is documented as "Square returns the disputed
   * amount to the cardholder and updates the dispute state to `ACCEPTED`. The dispute is now
   * closed." The seller accepted liability and the money is gone, exactly as with Adyen's
   * `Accepted` disputeStatus.
   *
   * With no state at all — Square marks the field nullable — `dispute.created` keeps the
   * `payment.disputed` it has always had, and a state change with nothing to change stays an
   * update.
   */
  #disputeType(dispute: SquareDisputeResponse | undefined, eventType: string): string {
    switch (dispute?.state) {
      case 'INQUIRY_EVIDENCE_REQUIRED':
      case 'INQUIRY_PROCESSING':
        return 'payment.dispute_warning';
      case 'EVIDENCE_REQUIRED':
      case 'PROCESSING':
        return 'payment.disputed';
      case 'WON':
      case 'LOST':
      case 'ACCEPTED':
        return 'payment.dispute_closed';
      default:
        return eventType === 'dispute.created' ? 'payment.disputed' : 'payment.updated';
    }
  }

  /** The three terminal states, and only those. `INQUIRY_CLOSED` names no winner. */
  #disputeOutcome(state: string | undefined): 'won' | 'lost' | undefined {
    if (state === 'WON') return 'won';
    if (state === 'LOST' || state === 'ACCEPTED') return 'lost';
    return undefined;
  }

  #mapWebhookData(payload: SquareWebhookPayload): Record<string, unknown> {
    const object = payload.data?.object;
    const subscription = object?.subscription;
    if (subscription !== undefined) {
      const mapped = this.#mapSubscription(subscription);
      return {
        gatewayId: mapped.gatewayId,
        customerId: mapped.customerId,
        status: mapped.status,
        planId: mapped.planId,
        ...(mapped.endsAt !== undefined ? { endsAt: mapped.endsAt } : {}),
      };
    }
    const payment = object?.payment;
    if (payment !== undefined) {
      const mapped = this.#mapPayment(payment);
      const externalReference = this.#externalReferenceOf(payment);
      return {
        gatewayId: mapped.gatewayId,
        amount: mapped.amount.amount,
        currency: mapped.amount.currency,
        status: mapped.status,
        ...(mapped.customerId !== undefined ? { customerId: mapped.customerId } : {}),
        ...(payment.order_id ? { orderId: payment.order_id } : {}),
        ...(externalReference !== undefined ? { externalReference } : {}),
      };
    }
    const dispute = object?.dispute;
    if (dispute !== undefined) {
      // Keyed on the DISPUTED PAYMENT, not on the dispute: the ledger row that has to stop
      // saying `paid` is the payment's. `amount_money` is the disputed amount, which for a
      // partial dispute is less than the payment — `event.raw` carries the reason, the
      // state and the evidence deadline.
      const outcome = this.#disputeOutcome(dispute.state);
      return {
        gatewayId: dispute.disputed_payment?.payment_id ?? '',
        amount: dispute.amount_money?.amount ?? 0,
        currency: (dispute.amount_money?.currency ?? this.#currency).toLowerCase(),
        ...(dispute.id !== undefined ? { disputeId: dispute.id } : {}),
        ...(dispute.reason !== undefined ? { reason: dispute.reason } : {}),
        // "The deadline by which the seller must respond to the dispute", already RFC 3339
        // — and if it passes with no action Square automatically challenges on the seller's
        // behalf, which is not the same as the seller having decided anything.
        ...(dispute.due_at !== undefined ? { actionableUntil: dispute.due_at } : {}),
        ...(dispute.state !== undefined ? { disputeState: dispute.state } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
      };
    }
    const refund = object?.refund;
    if (refund !== undefined) {
      return {
        // The ledger keys refunds on the PAYMENT, which is the row the amount came off.
        gatewayId: refund.payment_id ?? refund.id,
        amount: refund.amount_money?.amount ?? 0,
        currency: (refund.amount_money?.currency ?? this.#currency).toLowerCase(),
        refundId: refund.id,
      };
    }
    const invoice = object?.invoice;
    if (invoice !== undefined) {
      const mapped = this.#mapInvoice(invoice);
      return {
        gatewayId: mapped.gatewayId,
        amount: mapped.amount.amount,
        currency: mapped.amount.currency,
        ...(mapped.customerId !== undefined ? { customerId: mapped.customerId } : {}),
        ...(mapped.subscriptionId !== undefined ? { subscriptionId: mapped.subscriptionId } : {}),
      };
    }
    const order = object?.order;
    if (order?.id !== undefined) {
      return {
        gatewayId: order.id,
        amount: order.total_money?.amount ?? 0,
        currency: (order.total_money?.currency ?? this.#currency).toLowerCase(),
        ...(order.customer_id ? { customerId: order.customer_id } : {}),
        ...(this.#orderReference(order) !== undefined
          ? { externalReference: this.#orderReference(order) }
          : {}),
      };
    }
    return {};
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  /**
   * Where a Square payment carries the app's own reference.
   *
   * `reference_id` is what {@link SquareDriver.charge} sets, and it comes back on the
   * payment. A payment made through a hosted link is the awkward case: the reference lives
   * on the ORDER, and Square's published `payment.created`/`payment.updated` examples do
   * not show `reference_id` on the payment — which is why `createCheckout` also sends
   * `payment_note`, read here as a fallback.
   */
  #externalReferenceOf(payment: SquarePaymentResponse): string | undefined {
    return payment.reference_id ?? payment.note ?? undefined;
  }

  #orderReference(order: SquareOrderResponse): string | undefined {
    return order.reference_id ?? order.metadata?.external_reference ?? undefined;
  }

  /** Order metadata keys are `[a-zA-Z0-9_-]`, values 255 chars, ten entries at most. */
  #orderMetadata(
    externalReference: string | undefined,
    extra: Record<string, unknown> | undefined,
  ): Record<string, string> {
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value === undefined || value === null) continue;
      metadata[key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)] = String(value).slice(0, 255);
    }
    if (externalReference !== undefined) metadata.external_reference = externalReference;
    return metadata;
  }

  #reference(externalReference: string | undefined, where: string): string | undefined {
    if (externalReference === undefined) return undefined;
    if (externalReference.length > REFERENCE_MAX_LENGTH) {
      throw new Error(
        `[payments] Square carries \`externalReference\` as \`reference_id\`, capped at ${REFERENCE_MAX_LENGTH} characters; the ${where} got ${externalReference.length}.`,
      );
    }
    return externalReference;
  }

  #idempotencyKey(key: string | undefined): string {
    if (key === undefined) return randomUUID();
    if (key.length > IDEMPOTENCY_MAX_LENGTH) {
      throw new Error(
        `[payments] Square caps \`idempotency_key\` at ${IDEMPOTENCY_MAX_LENGTH} characters; got ${key.length}.`,
      );
    }
    return key;
  }

  /** Square's tax id field is EU VAT and nothing else, so an arbitrary tax id is refused. */
  #taxIds(
    taxId: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (taxId === undefined) return {};
    if (metadata?.taxIdType !== 'eu_vat') {
      throw new Error(
        '[payments] A Square customer has exactly one tax field, `tax_ids.eu_vat`, and no general-purpose one. Pass `metadata: { taxIdType: "eu_vat" }` if that is what `taxId` is; otherwise keep the tax id on your own record rather than having it silently dropped here.',
      );
    }
    return { tax_ids: { eu_vat: taxId } };
  }

  /** Square subscription dates are `YYYY-MM-DD`; the contract wants an ISO instant. */
  #startDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`[payments] Square: \`startDate\` "${value}" is not a date.`);
    }
    return date.toISOString().slice(0, 10);
  }

  #toIso(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined;
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
  }

  async #paymentAmount(paymentGatewayId: string): Promise<{ amount: number; currency: string }> {
    const data = await this.#request<{ payment: SquarePaymentResponse }>(
      `/payments/${paymentGatewayId}`,
    );
    const amount = data.payment.amount_money?.amount;
    if (amount === undefined) {
      throw new Error(
        `[payments] Square payment "${paymentGatewayId}" has no amount to refund. \`RefundPayment\` requires \`amount_money\`, so pass the amount explicitly.`,
      );
    }
    return {
      amount,
      currency: (data.payment.amount_money?.currency ?? this.#currency).toUpperCase(),
    };
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      bearerToken: this.#accessToken,
      headers: { 'Square-Version': this.#apiVersion },
    });
  }
}
