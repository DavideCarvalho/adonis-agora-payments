/**
 * Shared domain types for the billing layer.
 *
 * These are the provider-agnostic shapes the drivers normalize into. Every gateway driver
 * (Stripe, AbacatePay, Asaas, Woovi) maps its own API response onto these types, so the
 * billing layer and application code never touch gateway-specific payloads.
 */

/** A monetary amount in the currency's smallest unit (e.g. cents for BRL/USD). */
export type Money = number;

/** ISO 4217 currency code, lowercase (e.g. `'brl'`, `'usd'`). */
export type Currency = string;

/**
 * Where a payment stands.
 *
 * `authorized` is NOT `paid`: the funds are held on the customer's card and nothing has
 * moved until a capture. Card gateways that separate the two (Razorpay, Square, Adyen,
 * PayPal) had no name for it, so it collapsed into `pending` — which understates it — or
 * `paid`, which grants access against money that can still evaporate.
 */
export type BillingStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'canceled'
  | 'disputed';

/**
 * `paused` is a real state, not a flavour of `active`: the subscription exists, will bill
 * again, and must NOT entitle the subscriber right now. Mapping it to `active` — which
 * several gateways forced — grants access to someone who is not paying.
 */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'paused'
  | 'past_due'
  | 'incomplete'
  | 'canceled'
  | 'ended';

/** How a payment was actually paid, as reported back on a {@link Payment}. */
export type PaymentMethodType =
  | 'card'
  | 'pix'
  | 'boleto'
  | 'debit_card'
  | 'wallet'
  | 'bank_transfer'
  | 'bank_debit'
  | 'upi'
  | 'bnpl'
  | 'voucher'
  | 'unknown';

/**
 * Canonical payment method names used to route charges to a provider (`config.methods`).
 * `undefined` means "let the customer choose at checkout" (gateway's `UNDEFINED`).
 *
 * These are CATEGORIES, not brands, and deliberately so. Enumerating every local method a
 * gateway offers — iDEAL, Bancontact, EPS, Przelewy24, BLIK, TWINT, MB Way, Multibanco,
 * Klarna, paysafecard, and a new one every quarter — is a union that never closes, and a
 * union that never closes cannot make routing a typo fail at the manager, which is the only
 * reason this type is closed at all.
 *
 * So route by category and name the brand where it belongs: the gateway's own field, via
 * `metadata`. `bank_transfer` covers the push-from-your-bank methods (iDEAL, Bancontact,
 * Multibanco, Trustly); `bank_debit` the pull-from-your-account ones (SEPA Direct Debit,
 * ACH); `wallet` the stored-balance and device wallets (PayPal, Apple Pay, Google Pay);
 * `bnpl` the buy-now-pay-later ones; `upi` is named outright because in India it is the
 * default way people pay, not a local alternative.
 */
export const PAYMENT_METHOD_NAMES = [
  'pix',
  'credit_card',
  'debit_card',
  'boleto',
  'wallet',
  'bank_transfer',
  'bank_debit',
  'upi',
  'bnpl',
  'voucher',
  'undefined',
] as const;

/**
 * The union, derived from the list above rather than written twice.
 *
 * The list exists because the routing error message used to spell the members out by hand,
 * and said "pix, credit_card, debit_card, boleto, undefined" long after six more were added
 * — so a reader routing `wallet` was told, by the library, that it was not a known method.
 */
export type PaymentMethodName = (typeof PAYMENT_METHOD_NAMES)[number];

export interface MoneyAmount {
  amount: Money;
  currency: Currency;
}

/**
 * Where a dispute stands. A chargeback is the only thing in this library that takes money
 * back AFTER it settled, and the window to answer is measured in days.
 *
 * `warning` is not a dispute yet — it is the pre-chargeback alert the card networks relay
 * (Stripe's Early Fraud Warning, Adyen's `NOTIFICATION_OF_FRAUD`), where refunding inside
 * the window stops the chargeback from ever being filed. That matters beyond the one sale:
 * a chargeback counts against the ratio that puts a merchant into a card network's
 * monitoring programme, so it can be worth refunding a dispute you would have won.
 */
export type DisputeStatus =
  | 'warning'
  | 'open'
  | 'under_review'
  | 'won'
  | 'lost'
  | 'canceled'
  | 'expired';

/** A chargeback or pre-chargeback alert, normalized across gateways. */
export interface Dispute {
  /** The gateway's id for the dispute itself — NOT the payment's. */
  id: string;
  provider: string;
  /** The disputed payment's gateway id. */
  paymentGatewayId: string;
  status: DisputeStatus;
  /**
   * How much is being disputed, in the currency's smallest unit. Not always the whole
   * payment: a partial chargeback is normal.
   */
  amount?: MoneyAmount;
  /** The gateway's own reason code, verbatim — the vocabulary is per-network. */
  reason?: string;
  /**
   * When evidence must be submitted by. The single most operationally important field
   * here: past it, the dispute is lost by default and nothing can be done.
   */
  evidenceDueBy?: string;
  /** Whether this gateway will still accept evidence — most accept it ONCE. */
  canSubmitEvidence?: boolean;
  createdAt?: string;
  payload: Record<string, unknown>;
}

/**
 * Evidence for a representment.
 *
 * Every field is optional because no gateway wants all of them and no app has all of them,
 * but the shape is deliberately concrete rather than a bag: a driver has to map onto the
 * gateway's own field names, and it cannot map what it cannot recognize.
 */
export interface DisputeEvidence {
  /** Free-text explanation. Most gateways weigh this heavily. */
  explanation?: string;
  shippingCarrier?: string;
  shippingTrackingNumber?: string;
  shippingDate?: string;
  serviceDate?: string;
  /** When the customer accepted the terms. The terms themselves are a {@link DisputeDocument}. */
  termsAcceptedAt?: string;
  customerName?: string;
  customerEmail?: string;
  customerIpAddress?: string;
  /**
   * Prior charges to the same customer that were never disputed — the strongest signal the
   * card networks accept, and the reason this is a list of transactions rather than a count.
   * Visa's Compelling Evidence 3.0 wants the charges themselves, each with the account, device
   * and IP it was made from; a number is not evidence of anything.
   */
  priorUndisputedPayments?: PriorUndisputedPayment[];
  /** Documents already uploaded to the gateway, each addressed by what it proves. */
  documents?: DisputeDocument[];
  /** Anything gateway-specific the shape above has no name for. */
  metadata?: Record<string, unknown>;
}

/**
 * What a piece of evidence proves, which is what every gateway files it by.
 *
 * Not a free-form label: a bare list of upload ids cannot be submitted anywhere, because
 * the gateway needs to know which id is the receipt and which is the shipping proof. Stripe
 * has nine separate file fields, Adyen has a `defenseDocumentTypeCode`, and neither can be
 * reached with "here are some files".
 */
export type DisputeDocumentKind =
  | 'receipt'
  | 'invoice'
  | 'customer_communication'
  | 'customer_signature'
  | 'shipping'
  | 'service'
  | 'refund_policy'
  | 'cancellation_policy'
  | 'terms'
  | 'duplicate_charge'
  | 'other';

/**
 * A document already uploaded to the gateway, by its own file id.
 *
 * A file id, never a URL. The banks reviewing a dispute do not follow links, and no gateway
 * in this package accepts one — the evidence has to be bytes the gateway already holds.
 */
export interface DisputeDocument {
  kind: DisputeDocumentKind;
  /** The gateway's own id for the uploaded file. */
  id: string;
}

/** A prior charge to the same customer that was never disputed. */
export interface PriorUndisputedPayment {
  /** The gateway's id for that charge. */
  paymentGatewayId: string;
  /** The account the customer was signed into, if the gateway asks for one. */
  customerAccountId?: string;
  customerIpAddress?: string;
  customerDeviceId?: string;
}

/** A customer as seen by the gateway. */
export interface Customer {
  id: string;
  email?: string;
  name?: string;
  /** CPF/CNPJ (BR gateways) or tax id. */
  taxId?: string;
  /** Provider-specific extra data. */
  metadata?: Record<string, unknown>;
}

export interface Payment {
  id: string;
  /** External gateway id. */
  gatewayId: string;
  provider: string;
  amount: MoneyAmount;
  status: BillingStatus;
  /** The customer the payment belongs to, when the gateway has one. */
  customerId?: string;
  /** Payment method type (pix, card, boleto...). */
  method?: PaymentMethodType;
  /** Provider-specific raw payload. */
  payload: Record<string, unknown>;
  createdAt: string;
  paidAt?: string;
  /**
   * Base64-encoded PNG of the Pix QR code, when the gateway returns one.
   * Render it directly (`data:image/png;base64,${pixQrCodeImage}`) — it is an image,
   * not something the customer can copy.
   */
  pixQrCodeImage?: string;
  /**
   * The Pix BR Code (EMV payload) — the plain-text string behind the QR code, and the
   * one the customer copies and pastes into their bank app ("Pix copia e cola").
   */
  pixCode?: string;
  /**
   * @deprecated Misleading name — it holds the QR **image**, not a code. Use {@link Payment.pixQrCodeImage}.
   * Still populated with the same value for backward compatibility.
   */
  pixQrCode?: string;
  /**
   * @deprecated Portuguese name for the BR Code payload. Use {@link Payment.pixCode}.
   * Still populated with the same value for backward compatibility.
   */
  pixCopiaECola?: string;
  /** URL to a hosted checkout/charge page when the gateway provides one. */
  hostedUrl?: string;
  /** The subscription this payment belongs to, when recurring. */
  subscriptionId?: string;
  /** Invoice emitted for this payment, when `invoice` was requested. */
  invoice?: Invoice;
}

export interface Refund {
  id: string;
  gatewayId: string;
  provider: string;
  amount: MoneyAmount;
  status: 'succeeded' | 'pending' | 'failed';
  createdAt: string;
}

/**
 * What comes back from {@link import('./driver.js').PaymentsDriver.tokenizeCard}.
 *
 * Deliberately narrow: a token to charge with, plus the two fields a UI needs to say
 * WHICH card is saved. Nothing else from the gateway's tokenization response belongs on
 * this side of the boundary — the point of tokenizing is that the card stops travelling.
 */
export interface TokenizedCard {
  /** The reusable token — what {@link import('./driver.js').CardInput.token} takes. */
  token: string;
  /** Last four digits, for "Mastercard •••• 4242". */
  last4: string;
  /** Card brand as the gateway reports it, e.g. `'VISA'`, `'MASTERCARD'`. */
  brand: string;
  provider: string;
}

export interface CheckoutSession {
  id: string;
  gatewayId: string;
  provider: string;
  /** URL to redirect the customer to (hosted checkout). */
  url: string;
  /**
   * Pix BR Code (EMV payload) for a checkout the gateway settles over Pix — the
   * string the payer copies. Same field as {@link Payment.pixCode}.
   */
  pixCode?: string;
  /** @deprecated Renamed to {@link CheckoutSession.pixCode}. Still populated. */
  pixCopiaECola?: string;
  status: 'open' | 'complete' | 'expired';
  amount?: MoneyAmount;
  /** The subscription created by this checkout, when it was a subscription checkout. */
  subscriptionId?: string;
  customerId?: string;
}

export interface Subscription {
  id: string;
  gatewayId: string;
  provider: string;
  customerId: string;
  status: SubscriptionStatus;
  /** Price id/plan id at the gateway. */
  planId: string;
  amount?: MoneyAmount;
  /** ISO date the trial ends (when on trial). */
  trialEndsAt?: string;
  /** ISO date the subscription ends (canceled/ended). */
  endsAt?: string;
  /** Current billing period start (ISO). */
  currentPeriodStart?: string;
  /** Current billing period end (ISO). */
  currentPeriodEnd?: string;
  /** Provider-specific raw payload. */
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Invoice {
  id: string;
  gatewayId: string;
  provider: string;
  customerId?: string;
  subscriptionId?: string;
  status:
    | 'draft'
    | 'open'
    | 'paid'
    | 'void'
    | 'uncollectible'
    | 'issued'
    | 'pending'
    | 'failed'
    | 'canceled';
  amount: MoneyAmount;
  /** ISO date the invoice was created. */
  createdAt: string;
  /** URL to download the invoice PDF, when the provider gives one. */
  hostedPdfUrl?: string;
  /** Invoice number, when issued. */
  number?: string;
  /** Access key (chave de acesso), when available. */
  key?: string;
  /** ISO date the invoice was issued. */
  issuedAt?: string;
  /** Provider-specific raw payload. */
  payload: Record<string, unknown>;
}

/** A normalized webhook event from a gateway. */
export interface WebhookEvent<T = unknown> {
  /** Stable event id — used for idempotency. */
  id: string;
  provider: string;
  /** Gateway event type, e.g. `checkout.completed`, `invoice.payment_succeeded`. */
  type: string;
  /** ISO timestamp of when the event happened at the gateway. */
  createdAt?: string;
  /** The normalized event payload. */
  data: T;
  /** The raw, unmodified gateway payload. */
  raw: Record<string, unknown>;
}

// ── Invoice emission ────────────────────────────────────────────────────────────────────

/**
 * Invoice emission options, passed to a charge/subscription call. The presence of the
 * option means "emit an invoice for this charge":
 *
 * - `true` — use the default invoice provider from `config/payments.ts` (`invoice.default`).
 * - `'focus'` — use the named invoice provider (a key of `invoice.providers`).
 * - `{ provider?, ... }` — use the named provider (or the default) with these overrides.
 *
 * ```ts
 * await payments.bill({
 *   customerId: 'cus_x',
 *   amount: 1990,
 *   invoice: {
 *     provider: 'focus',
 *     service: { description: 'Software license', code: '1.01' },
 *     tax: { iss: 5 },
 *   },
 * })
 * ```
 */
export interface InvoiceOptions {
  /** Named invoice provider (a key of `invoice.providers`). Defaults to `invoice.default`. */
  provider?: string;
  /** Service details for service invoices. Falls back to `invoice.defaults.service`. */
  service?: {
    description?: string;
    /** Service code (código de serviço). */
    code?: string;
    /** Municipal service code (código de serviço municipal). */
    cityServiceCode?: string;
  };
  /** Tax configuration. Falls back to `invoice.defaults.tax`. */
  tax?: Record<string, unknown>;
  /** Invoice recipient. Defaults to the billing customer's data. */
  customer?: {
    name?: string;
    taxId?: string;
    email?: string;
    address?: Record<string, unknown>;
  };
  /** Extra provider-specific fields. */
  metadata?: Record<string, unknown>;
}
