import type {
  CheckoutSession,
  Customer,
  Invoice,
  InvoiceOptions,
  Money,
  Payment,
  PaymentMethodName,
  Refund,
  Subscription,
  WebhookEvent,
} from './types.js';

/**
 * The provider-agnostic payment driver contract (Omnipay-style).
 *
 * Every gateway driver (Stripe, AbacatePay, Asaas, Woovi) implements this interface,
 * normalizing its own API onto the shared domain types. The billing layer and application
 * code depend only on this contract, so swapping gateways is a config change.
 */
export interface PaymentsDriver {
  /** Stable provider name, e.g. `'stripe'`, `'abacate'`, `'asaas'`, `'woovi'`. */
  readonly provider: string;

  /**
   * The payment methods this gateway supports (canonical names). Used by the router to
   * reject a method the provider can't handle — e.g. routing `credit_card` to a Pix-only
   * gateway (AbacatePay, Woovi) throws a clear error.
   */
  readonly supportedMethods: readonly PaymentMethodName[];

  /**
   * Optional capabilities beyond the core contract. A driver that lacks a capability
   * still implements the method (it must — the interface demands it) but throws a clear
   * "not supported" error; the manager checks this before delegating so callers discover
   * the limitation early instead of at the gateway.
   */
  readonly capabilities?: {
    /** Full refunds against a payment. Woovi/OpenPix lacks it. */
    refunds?: boolean;
    /** Lists gateway invoices. Woovi/OpenPix has no invoice concept. */
    invoices?: boolean;
    /** Recurring subscriptions. InfinitePay-style links lack it. */
    subscriptions?: boolean;
  };

  // ── Customers ────────────────────────────────────────────────────────────────────────

  /** Create a customer at the gateway. Returns the gateway customer. */
  createCustomer(input: CreateCustomerInput): Promise<Customer>;
  /** Look up a customer by its gateway id. */
  findCustomer(customerId: string): Promise<Customer | null>;
  /** Update customer details at the gateway. */
  updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer>;

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  /** Charge a customer (or a standalone amount) and return the payment. */
  charge(input: ChargeInput): Promise<Payment>;
  /** Find a payment by its gateway id. */
  findPayment(gatewayId: string): Promise<Payment | null>;
  /** Refund a payment, optionally a partial amount. */
  refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund>;

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  /** Create a hosted checkout session and return the redirect URL. */
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  /** Create a recurring subscription at the gateway. */
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription>;
  /** Cancel a subscription (optionally immediately, skipping the grace period). */
  cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription>;
  /** Update a subscription's amount/description at the gateway. */
  updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription>;
  /** Find a subscription by its gateway id. */
  findSubscription(gatewayId: string): Promise<Subscription | null>;

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  /** List invoices for a customer. */
  listInvoices(customerId: string): Promise<Invoice[]>;

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Verify the webhook signature and normalize the raw payload into a {@link WebhookEvent}.
   * Throws when the signature is invalid.
   *
   * May return a promise. Most gateways sign a self-describing payload, so this is a pure
   * function of the body and headers — but not all: Mollie's webhook is a bare payment id
   * with no status and no signature, and the ONLY way to learn what happened, or that the
   * call is genuine, is an authenticated fetch of that payment. A synchronous signature
   * forced such a driver to report `payment.updated` and nothing else, so the mounted route
   * ledgered the event and never marked the payment paid. The mounted route awaits this.
   */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent | Promise<WebhookEvent>;
}

// ── Input types ─────────────────────────────────────────────────────────────────────────

export interface CreateCustomerInput {
  /**
   * Idempotency key — reusing it must not perform the operation twice.
   *
   * A driver whose gateway has no deduplication mechanism must REFUSE this rather than
   * accept and ignore it: silently dropping it turns a caller's retry guarantee into a
   * second charge, a second refund, or a second subscription.
   */
  idempotencyKey?: string;
  email?: string;
  name?: string;
  /** CPF/CNPJ (BR gateways) or tax id. */
  taxId?: string;
  /** Extra provider-specific fields, e.g. phone, address. */
  metadata?: Record<string, unknown>;
}

export interface UpdateCustomerInput {
  email?: string;
  name?: string;
  taxId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Checkout transparente: a card tokenized in the frontend, plus the holder info most BR
 * gateways require (Asaas `creditCardToken`/`creditCardHolderInfo`, Stripe
 * `payment_method`). First-class so drivers map it without metadata hacks — shared by
 * one-off {@link ChargeInput.card} and recurring {@link CreateSubscriptionInput.card}.
 */
export interface CardInput {
  token: string;
  holder?: {
    name: string;
    email: string;
    cpfCnpj: string;
    postalCode: string;
    addressNumber: string;
    phone: string;
  };
  remoteIp?: string;
}

export interface ChargeInput {
  /** Gateway customer id. When absent, some gateways charge without a customer. */
  customerId?: string;
  amount: Money;
  /** ISO 4217 code, lowercase (defaults to the driver's configured currency). */
  currency?: string;
  description?: string;
  /** Payment method (e.g. `'pix'`, `'credit_card'`, `'boleto'`). Gateway-dependent. */
  method?: string;
  /** For card payments: the payment method/token id at the gateway. */
  paymentMethodId?: string;
  /**
   * Checkout transparente: card tokenized in the frontend, plus the holder info most BR
   * gateways require. First-class so drivers map it without metadata hacks.
   */
  card?: CardInput;
  /**
   * The payer's fiscal data — the single source used when an invoice is emitted with
   * this charge. Falls back to `card.holder` (cpfCnpj/name/email) when absent, so a
   * card checkout that also wants a fiscal note doesn't restate the holder.
   */
  customer?: {
    name?: string;
    taxId?: string;
    email?: string;
  };
  /** Idempotency key — reusing it must not double-charge. */
  idempotencyKey?: string;
  /**
   * Split the payment across recipients (marketplace-style). Each entry names the gateway
   * wallet/account receiving a share, by percent and/or a fixed amount. Asaas maps it to
   * the `split` array on the charge; other gateways accept it when supported.
   */
  split?: Array<{
    /** Gateway wallet/recipient id. */
    walletId: string;
    /** Percent of the charge value this wallet receives (0–100). */
    percentualValue?: number;
    /** Fixed amount (cents) this wallet receives. */
    fixedValue?: number;
  }>;
  /**
   * Your own reference echoed back on the gateway payment — the stable id webhook
   * handlers use to route a payment back to your local record. Many BR gateways expose
   * it as `externalReference` (Asaas) or `correlationID` (Woovi); Stripe maps it into
   * metadata. Distinct from `idempotencyKey`: idempotency protects against duplicate
   * charges, `externalReference` is for routing. Prefer it over digging into `event.raw`.
   */
  externalReference?: string;
  /**
   * Emit an invoice for this charge: `true` uses the default invoice provider, a string
   * names one from `invoice.providers`, or pass {@link InvoiceOptions} for overrides.
   */
  invoice?: boolean | string | InvoiceOptions;
  /** Extra provider-specific fields. */
  metadata?: Record<string, unknown>;
}

export interface CheckoutInput {
  /** Gateway customer id. */
  customerId?: string;
  amount: Money;
  currency?: string;
  description?: string;
  successUrl: string;
  cancelUrl?: string;
  /** For subscription checkouts: the price/plan id. */
  planId?: string;
  /** Trial days for a subscription checkout. */
  trialDays?: number;
  /** Idempotency key — reusing it must not create a duplicate session. */
  idempotencyKey?: string;
  /**
   * Your own id for this purchase, echoed back on the gateway's webhooks.
   *
   * The same contract as {@link ChargeInput.externalReference}, and it matters MORE here:
   * several gateways (Paddle, Lemon Squeezy, PayPal, and any merchant-of-record) have no
   * server-side charge at all, so a hosted session is the only way a purchase starts. A
   * session opened without a reference produces a confirmation the handler cannot route
   * back to an order, and the failure is a silent `return`.
   */
  externalReference?: string;
  /**
   * The payer's identity, for gateways that demand it up front rather than collecting it
   * on the hosted page.
   *
   * Most checkouts ask the payer who they are, so this is usually unnecessary. PagBank's
   * Orders API is the counter-example: every order carries the payer inline and is refused
   * without a CPF/CNPJ, so a checkout there cannot be opened at all without it. Same shape
   * as {@link ChargeInput.customer}, so a flow that already has the data passes it either way.
   */
  customer?: {
    name?: string;
    taxId?: string;
    email?: string;
  };
  /** Emit an invoice for this checkout: `true`/name/options. */
  invoice?: boolean | string | InvoiceOptions;
  /** Extra provider-specific fields. */
  metadata?: Record<string, unknown>;
}

export interface CreateSubscriptionInput {
  /**
   * Idempotency key — reusing it must not perform the operation twice.
   *
   * A driver whose gateway has no deduplication mechanism must REFUSE this rather than
   * accept and ignore it: silently dropping it turns a caller's retry guarantee into a
   * second charge, a second refund, or a second subscription.
   */
  idempotencyKey?: string;
  customerId: string;
  /** Price/plan id at the gateway. */
  planId: string;
  /** Amount in the currency's smallest unit (e.g. cents) — required by BR gateways. */
  amount?: Money;
  /** Billing cycle. Defaults to `'MONTHLY'` (Asaas, AbacatePay). */
  cycle?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'YEARLY';
  /** Payment method for the recurring charges (e.g. `'pix'`, `'credit_card'`). */
  method?: string;
  /** Description shown on the recurring charges. */
  description?: string;
  /** Trial days before the first charge. */
  trialDays?: number;
  /** First due date (ISO date) — required by some BR gateways (e.g. Asaas). */
  startDate?: string;
  /**
   * Checkout transparente for recurring charges: a card tokenized in the frontend (plus
   * holder info) so the gateway auto-charges the card each cycle. Asaas maps it to
   * `creditCardToken`/`creditCardHolderInfo`; other gateways accept it when supported.
   */
  card?: CardInput;
  /**
   * The payer's fiscal/identity data. Gateways that create subscriptions with an inline
   * customer (Woovi, AbacatePay) use it instead of a pre-created `customerId`.
   */
  customer?: {
    name?: string;
    email?: string;
    taxId?: string;
  };
  /**
   * Your own reference echoed on the gateway subscription (and its generated charges) —
   * the stable id webhook handlers use to route a subscription payment back to your
   * local record. Asaas propagates it to every installment payment's `externalReference`.
   */
  externalReference?: string;
  /** Emit an invoice for this subscription's charges: `true`/name/options. */
  invoice?: boolean | string | InvoiceOptions;
  /** Extra provider-specific fields. */
  metadata?: Record<string, unknown>;
}

export interface UpdateSubscriptionInput {
  /**
   * Idempotency key — reusing it must not perform the operation twice.
   *
   * A driver whose gateway has no deduplication mechanism must REFUSE this rather than
   * accept and ignore it: silently dropping it turns a caller's retry guarantee into a
   * second charge, a second refund, or a second subscription.
   */
  idempotencyKey?: string;
  /** New amount in the currency's smallest unit. */
  amount?: Money;
  /** New description. */
  description?: string;
  /** Extra provider-specific fields. */
  metadata?: Record<string, unknown>;
}
