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

export type BillingStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'canceled' | 'disputed';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'incomplete'
  | 'canceled'
  | 'ended';

export type PaymentMethodType = 'card' | 'pix' | 'boleto' | 'debit_card' | 'unknown';

/**
 * Canonical payment method names used to route charges to a provider (`config.methods`).
 * `undefined` means "let the customer choose at checkout" (gateway's `UNDEFINED`).
 */
export type PaymentMethodName = 'pix' | 'credit_card' | 'debit_card' | 'boleto' | 'undefined';

export interface MoneyAmount {
  amount: Money;
  currency: Currency;
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
