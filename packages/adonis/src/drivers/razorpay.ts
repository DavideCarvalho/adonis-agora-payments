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
import { verifyHmacSignature } from '../webhook_security.js';
import { requireCredential, requireCurrency } from './shared.js';

/**
 * Config for {@link RazorpayDriver}.
 *
 * Declared here rather than in `define_config.ts` so the driver module type-checks on its
 * own; `define_config.ts` re-exports it with an `import type`, which is erased at compile
 * time and therefore keeps the driver lazily loaded.
 */
export interface RazorpayDriverConfig {
  /** Razorpay key id (`rzp_live_…` / `rzp_test_…`). Defaults to `env.get('RAZORPAY_KEY_ID')`. */
  keyId?: string;
  /** Razorpay key secret. Defaults to `env.get('RAZORPAY_KEY_SECRET')`. */
  keySecret?: string;
  /**
   * Currency for charges that don't name one (lowercase ISO 4217). **Required** — Razorpay
   * accepts international currencies alongside INR, so a default here would be a guess at
   * which country the app bills in, and a wrong guess succeeds silently.
   */
  currency: string;
  /**
   * Secret of the webhook you configured in the Razorpay dashboard, used to verify
   * `X-Razorpay-Signature`. Defaults to `env.get('RAZORPAY_WEBHOOK_SECRET')`. When set,
   * webhooks without a valid signature are rejected.
   */
  webhookSecret?: string;
}

/** Razorpay stamps every id with its entity: `order_…`, `pay_…`, `plink_…`, `sub_…`. */
const ORDER_PREFIX = 'order_';
const PAYMENT_PREFIX = 'pay_';
const PAYMENT_LINK_PREFIX = 'plink_';

/** Razorpay rejects a `receipt` longer than this, so catch it before the round trip. */
const RECEIPT_MAX_LENGTH = 40;

interface RazorpayOrderResponse {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt?: string | null;
  status: 'created' | 'attempted' | 'paid';
  attempts?: number;
  notes?: Record<string, string> | unknown[] | null;
  created_at: number;
}

interface RazorpayPaymentResponse {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id?: string | null;
  invoice_id?: string | null;
  /** `card` | `netbanking` | `wallet` | `emi` | `upi`. */
  method?: string;
  captured?: boolean;
  description?: string | null;
  card?: { type?: string } | null;
  customer_id?: string | null;
  notes?: Record<string, string> | unknown[] | null;
  created_at: number;
}

interface RazorpayCustomerResponse {
  id: string;
  entity: 'customer';
  name?: string | null;
  email?: string | null;
  contact?: string | null;
  gstin?: string | null;
  notes?: Record<string, string> | unknown[] | null;
  created_at: number;
}

interface RazorpayRefundResponse {
  id: string;
  entity: 'refund';
  amount: number;
  currency: string;
  payment_id: string;
  status: 'pending' | 'processed' | 'failed';
  created_at: number;
}

interface RazorpayPaymentLinkResponse {
  id: string;
  amount: number;
  amount_paid?: number;
  currency: string;
  description?: string | null;
  reference_id?: string | null;
  short_url: string;
  status: 'created' | 'partially_paid' | 'expired' | 'cancelled' | 'paid';
  notes?: Record<string, string> | unknown[] | null;
  created_at: number;
}

interface RazorpaySubscriptionResponse {
  id: string;
  entity: 'subscription';
  plan_id: string;
  customer_id?: string | null;
  status:
    | 'created'
    | 'authenticated'
    | 'active'
    | 'pending'
    | 'halted'
    | 'cancelled'
    | 'completed'
    | 'expired'
    | 'paused';
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  quantity?: number;
  notes?: Record<string, string> | unknown[] | null;
  charge_at?: number | null;
  start_at?: number | null;
  end_at?: number | null;
  total_count?: number;
  paid_count?: number;
  created_at: number;
  short_url?: string | null;
}

interface RazorpayInvoiceResponse {
  id: string;
  entity: 'invoice';
  customer_id?: string | null;
  subscription_id?: string | null;
  order_id?: string | null;
  status: string;
  amount: number;
  currency: string;
  short_url?: string | null;
  invoice_number?: string | null;
  issued_at?: number | null;
  created_at: number;
}

interface RazorpayWebhookPayload {
  entity?: string;
  account_id?: string;
  event: string;
  contains?: string[];
  payload: {
    payment?: { entity: RazorpayPaymentResponse };
    order?: { entity: RazorpayOrderResponse };
    refund?: { entity: RazorpayRefundResponse };
    subscription?: { entity: RazorpaySubscriptionResponse };
    payment_link?: { entity: RazorpayPaymentLinkResponse };
  };
  created_at?: number;
}

/**
 * Razorpay driver — the dominant Indian gateway (UPI, cards, netbanking, wallets) with
 * native subscription billing. Plain REST over `fetch`, no SDK.
 *
 * Two shapes of this API are worth knowing before reading the mappings:
 *
 * **Orders, not charges.** Razorpay has no "charge this customer" endpoint for a normal
 * integration: you create an *order* (an amount you expect to collect) and the payer
 * settles it in Razorpay Checkout, which produces a *payment* against that order. So
 * `charge()` creates an order and returns a `pending` payment whose `gatewayId` is the
 * `order_…` id — the id you hand to Checkout. `findPayment` accepts either id and branches
 * on the prefix.
 *
 * **Authorize then capture.** A Razorpay payment is `authorized` (funds held on the
 * instrument) before it is `captured` (money moving to you). This package's
 * `BillingStatus` has no name for that middle state, so `authorized` maps to `pending` —
 * see {@link RazorpayDriver.capturePayment}.
 *
 * Test mode is chosen by the key pair (`rzp_test_…`), not by a different host, so there is
 * no `sandbox` option: point the driver at test keys and it talks to the test account.
 */
export class RazorpayDriver implements PaymentsDriver {
  readonly provider = 'razorpay';
  /**
   * A Razorpay order carries no payment method — the payer picks card, UPI, netbanking or
   * a wallet inside Checkout — so `undefined` ("let the customer choose") is the only
   * honest entry. Routing `methods: { credit_card: 'razorpay' }` therefore fails at the
   * manager, and it should: nothing in the Orders API can promise a card was used. Read
   * the method the payer actually chose off `payment.method` on the webhook.
   */
  readonly supportedMethods = ['undefined'] as const;
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true };

  #baseUrl = 'https://api.razorpay.com/v1';
  #authHeader: { name: string; value: string };
  #currency: string;
  #webhookSecret: string | undefined;
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: RazorpayDriverConfig) {
    this.#invoiceCtx = ctx;
    const keyId = requireCredential({
      driver: 'razorpay',
      option: 'keyId',
      env: 'RAZORPAY_KEY_ID',
      value: config.keyId,
    });
    const keySecret = requireCredential({
      driver: 'razorpay',
      option: 'keySecret',
      env: 'RAZORPAY_KEY_SECRET',
      value: config.keySecret,
    });
    this.#currency = requireCurrency('razorpay', config.currency);
    this.#webhookSecret = config.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET;
    this.#authHeader = {
      name: 'Authorization',
      value: `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`,
    };
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const body: Record<string, unknown> = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(typeof input.metadata?.contact === 'string' ? { contact: input.metadata.contact } : {}),
      // GSTIN is the only tax id a Razorpay customer has a field for; a PAN or anything
      // else the app calls `taxId` would be silently dropped, so it goes to notes instead.
      ...(input.taxId !== undefined ? { notes: { tax_id: input.taxId } } : {}),
      // Returning the existing customer is friendlier than a 400 on a retried signup, and
      // matches how every other driver here treats create-customer.
      fail_existing: '0',
    };
    const data = await this.#request<RazorpayCustomerResponse>('/customers', {
      method: 'POST',
      body,
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<RazorpayCustomerResponse>(`/customers/${customerId}`);
      return this.#mapCustomer(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const body: Record<string, unknown> = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(typeof input.metadata?.contact === 'string' ? { contact: input.metadata.contact } : {}),
    };
    const data = await this.#request<RazorpayCustomerResponse>(`/customers/${customerId}`, {
      method: 'PUT',
      body,
    });
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    if (input.card !== undefined || input.paymentMethodId !== undefined) {
      throw new Error(
        '[payments] Razorpay does not accept a card token server-side on a normal account: ' +
          'the payer authorizes the card inside Razorpay Checkout. Create the charge without ' +
          '`card`/`paymentMethodId` and hand the returned `order_…` id to Checkout.',
      );
    }
    if (input.method !== undefined && input.method !== 'undefined') {
      throw new Error(
        `[payments] Razorpay cannot pin a payment method on an order: the payer picks card, UPI, netbanking or a wallet inside Checkout, so "${input.method}" is a promise the Orders API cannot keep. Drop \`method\` and read \`payment.method\` off the webhook.`,
      );
    }
    if (input.split !== undefined && input.split.length > 0) {
      throw new Error(
        '[payments] Razorpay splits payments through Route transfers, which this driver does ' +
          'not implement. Create the transfers directly against the Razorpay Route API.',
      );
    }
    if (input.idempotencyKey !== undefined && input.idempotencyKey.length > RECEIPT_MAX_LENGTH) {
      throw new Error(
        `[payments] Razorpay carries \`idempotencyKey\` as the order's \`receipt\`, capped at ${RECEIPT_MAX_LENGTH} characters; got ${input.idempotencyKey.length}.`,
      );
    }
    const notes = this.#notes(input.externalReference, {
      ...(input.description !== undefined ? { description: input.description } : {}),
      // Razorpay orders have no customer field at all, so the id is recorded as a note.
      // It documents the intent; it does not link the two entities at the gateway.
      ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
      ...(input.metadata as Record<string, string> | undefined),
    });
    const body: Record<string, unknown> = {
      // No conversion: Razorpay's `amount` is already the integer minor unit (paise for INR),
      // the same unit as this package's `Money`. The BR drivers around this one divide by 100
      // because their gateways want decimal reais; doing it here would bill a hundredth.
      amount: input.amount,
      currency: (input.currency ?? this.#currency).toUpperCase(),
      // Razorpay has no idempotency header; `receipt` is the account-level uniqueness key —
      // a second create with the same receipt is rejected instead of creating a twin order.
      ...(input.idempotencyKey !== undefined ? { receipt: input.idempotencyKey } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
    const data = await this.#request<RazorpayOrderResponse>('/orders', { method: 'POST', body });
    const payment = this.#mapOrder(data, input.customerId);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      if (gatewayId.startsWith(ORDER_PREFIX)) {
        return this.#mapOrder(await this.#request<RazorpayOrderResponse>(`/orders/${gatewayId}`));
      }
      if (gatewayId.startsWith(PAYMENT_LINK_PREFIX)) {
        return this.#mapPaymentLink(
          await this.#request<RazorpayPaymentLinkResponse>(`/payment_links/${gatewayId}`),
        );
      }
      return this.#mapPayment(
        await this.#request<RazorpayPaymentResponse>(`/payments/${gatewayId}`),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async refund(paymentGatewayId: string, amount?: Money): Promise<Refund> {
    if (!paymentGatewayId.startsWith(PAYMENT_PREFIX)) {
      throw new Error(
        `[payments] Razorpay refunds a payment (\`pay_…\`), not "${paymentGatewayId}". An order or payment link is what the payer settles; read the resulting payment id off the \`payment.captured\` webhook (or \`GET /orders/:id/payments\`) and refund that.`,
      );
    }
    const body: Record<string, unknown> = {
      ...(amount !== undefined ? { amount } : {}),
    };
    const data = await this.#request<RazorpayRefundResponse>(
      `/payments/${paymentGatewayId}/refund`,
      { method: 'POST', body },
    );
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      // `pending` is the normal first answer here — Razorpay confirms the final state on
      // the `refund.processed` webhook, which is the only thing that means money moved.
      status:
        data.status === 'processed' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending',
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  /**
   * Capture an authorized payment — the second half of Razorpay's authorize/capture split.
   *
   * Not part of {@link PaymentsDriver}: no other gateway here separates the two, and the
   * canonical `BillingStatus` has no `authorized` member to hang it off. It is public
   * because the alternative is worse — an account with auto-capture switched off would have
   * `pending` payments that this package could never settle, and Razorpay voids an
   * uncaptured authorization on its own after a few days.
   *
   * `amount` must equal the authorized amount; Razorpay rejects a partial capture.
   */
  async capturePayment(
    paymentGatewayId: string,
    amount: Money,
    currency?: string,
  ): Promise<Payment> {
    const data = await this.#request<RazorpayPaymentResponse>(
      `/payments/${paymentGatewayId}/capture`,
      {
        method: 'POST',
        body: { amount, currency: (currency ?? this.#currency).toUpperCase() },
      },
    );
    const payment = this.#mapPayment(data);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (input.cancelUrl !== undefined) {
      throw new Error(
        '[payments] A Razorpay Payment Link has one redirect (`callback_url`) and no cancel ' +
          'URL — a payer who abandons it simply stays on the link. Drop `cancelUrl` rather ' +
          'than letting it look configured.',
      );
    }
    if (input.planId !== undefined || input.trialDays !== undefined) {
      throw new Error(
        '[payments] Razorpay does not create subscriptions through a Payment Link. Call ' +
          '`createSubscription()` instead — the hosted authorization link comes back on the ' +
          "subscription's `short_url` (in `subscription.payload`).",
      );
    }
    if (input.idempotencyKey !== undefined && input.idempotencyKey.length > RECEIPT_MAX_LENGTH) {
      throw new Error(
        `[payments] Razorpay carries \`idempotencyKey\` as the link's \`reference_id\`, capped at ${RECEIPT_MAX_LENGTH} characters; got ${input.idempotencyKey.length}.`,
      );
    }
    if (
      input.externalReference !== undefined &&
      input.externalReference.length > RECEIPT_MAX_LENGTH
    ) {
      throw new Error(
        `[payments] Razorpay carries \`externalReference\` as the link's \`reference_id\`, capped at ${RECEIPT_MAX_LENGTH} characters; got ${input.externalReference.length}.`,
      );
    }
    const notes = this.#notes(input.externalReference, {
      ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
      ...(input.metadata as Record<string, string> | undefined),
    });
    const reference = input.externalReference ?? input.idempotencyKey;
    const body: Record<string, unknown> = {
      // Paise, straight through — same integer unit on both sides, nothing to convert.
      amount: input.amount,
      currency: (input.currency ?? this.#currency).toUpperCase(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // `reference_id` is echoed on `payment_link.paid`, so it is the routing key here —
      // and it is also unique per link, which makes it Razorpay's idempotency for links.
      ...(reference !== undefined ? { reference_id: reference } : {}),
      callback_url: input.successUrl,
      callback_method: 'get',
      ...(notes !== undefined ? { notes } : {}),
    };
    const data = await this.#request<RazorpayPaymentLinkResponse>('/payment_links', {
      method: 'POST',
      body,
    });
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      url: data.short_url,
      status: data.status === 'paid' ? 'complete' : data.status === 'expired' ? 'expired' : 'open',
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Razorpay prices a subscription from its plan, not from the call. Remove ' +
          '`amount` and point `planId` at a plan created with that amount (`POST /v1/plans`); ' +
          'passing it here would be a price the gateway never applies.',
      );
    }
    if (input.cycle !== undefined) {
      throw new Error(
        '[payments] Razorpay takes the billing cycle from the plan (`period`/`interval`), not ' +
          'from the subscription. Remove `cycle` and use a plan with that cycle.',
      );
    }
    if (input.method !== undefined) {
      throw new Error(
        '[payments] Razorpay does not let the API pin the mandate method — the payer picks ' +
          'card, UPI or e-mandate on the hosted authorization link. Remove `method`.',
      );
    }
    if (input.card !== undefined) {
      throw new Error(
        '[payments] Razorpay authorizes a subscription mandate on its own hosted link, not ' +
          'from a card token you hold. Remove `card` and send the payer to the subscription ' +
          '`short_url`.',
      );
    }
    // Razorpay has no "until cancelled" subscription: `total_count` is required and fixes
    // how many cycles are billed. There is no field for it on CreateSubscriptionInput, so
    // it comes through the provider-specific escape hatch and is refused when absent —
    // guessing a number here would silently cap (or over-run) the customer's billing.
    const totalCount = input.metadata?.totalCount;
    if (typeof totalCount !== 'number' || !Number.isInteger(totalCount) || totalCount < 1) {
      throw new Error(
        '[payments] Razorpay requires the number of billing cycles up front. Pass it as ' +
          '`metadata: { totalCount: 12 }` — the API has no open-ended subscription.',
      );
    }
    const startAt = this.#subscriptionStart(input);
    const notes = this.#notes(input.externalReference, {
      ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    const body: Record<string, unknown> = {
      plan_id: input.planId,
      total_count: totalCount,
      ...(typeof input.metadata?.quantity === 'number'
        ? { quantity: input.metadata.quantity }
        : {}),
      ...(startAt !== undefined ? { start_at: startAt } : {}),
      ...(input.customer?.email !== undefined
        ? { customer_notify: true, notify_info: { notify_email: input.customer.email } }
        : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
    const data = await this.#request<RazorpaySubscriptionResponse>('/subscriptions', {
      method: 'POST',
      body,
    });
    const subscription = this.#mapSubscription(data, input.customerId);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const data = await this.#request<RazorpaySubscriptionResponse>(
      `/subscriptions/${subscriptionGatewayId}/cancel`,
      { method: 'POST', body: { cancel_at_cycle_end: options?.atPeriodEnd === true } },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    if (input.amount !== undefined) {
      throw new Error(
        '[payments] Razorpay cannot change a subscription amount: the price lives on the plan ' +
          'and plans are immutable. Create a new plan and swap it with ' +
          '`metadata: { planId: "plan_…" }`, which is a real, billed change.',
      );
    }
    if (input.description !== undefined) {
      throw new Error(
        '[payments] A Razorpay subscription has no description, and `PATCH /v1/subscriptions` ' +
          'does not update `notes`. Keep the description on your own record.',
      );
    }
    const planId = input.metadata?.planId;
    const quantity = input.metadata?.quantity;
    if (typeof planId !== 'string' && typeof quantity !== 'number') {
      throw new Error(
        '[payments] Nothing to update on a Razorpay subscription. It accepts a plan swap ' +
          '(`metadata: { planId }`) or a quantity change (`metadata: { quantity }`); anything ' +
          'else would be a change the gateway never sees.',
      );
    }
    const body: Record<string, unknown> = {
      ...(typeof planId === 'string' ? { plan_id: planId } : {}),
      ...(typeof quantity === 'number' ? { quantity } : {}),
      // Razorpay otherwise schedules the change for the next cycle and answers with the
      // *old* subscription, which reads exactly like a silent no-op.
      schedule_change_at:
        typeof input.metadata?.scheduleChangeAt === 'string'
          ? input.metadata.scheduleChangeAt
          : 'now',
    };
    const data = await this.#request<RazorpaySubscriptionResponse>(
      `/subscriptions/${subscriptionGatewayId}`,
      { method: 'PATCH', body },
    );
    // No diagnostics event here: `publishSubscriptionDiagnostics` only knows
    // `subscription.created` and `subscription.canceled`, and inventing a third would mean
    // widening a shared type this driver does not own.
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<RazorpaySubscriptionResponse>(`/subscriptions/${gatewayId}`);
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(customerId: string): Promise<Invoice[]> {
    const data = await this.#request<{ items?: RazorpayInvoiceResponse[] }>(
      `/invoices?customer_id=${encodeURIComponent(customerId)}&count=100`,
    );
    // `customer_id` is a documented filter on this endpoint, and the same check is repeated
    // locally so a silently-ignored query parameter cannot hand one tenant another's
    // invoices. `count` caps at 100 and this driver does not paginate past it.
    return (data.items ?? [])
      .filter((invoice) => invoice.customer_id === customerId)
      .map((invoice) => this.#mapInvoice(invoice));
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (this.#webhookSecret !== undefined) {
      const signature = headerValue(headers, 'x-razorpay-signature');
      if (signature === undefined || signature === '') {
        throw new Error('[payments] Missing X-Razorpay-Signature on Razorpay webhook request.');
      }
      // Razorpay hex-encodes the digest; the shared helper compares it timing-safe.
      if (!verifyHmacSignature(rawBody, signature, this.#webhookSecret, 'sha256', 'hex')) {
        throw new Error('[payments] Invalid Razorpay webhook signature.');
      }
    }
    const payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
    const entity =
      payload.payload?.payment?.entity ??
      payload.payload?.payment_link?.entity ??
      payload.payload?.order?.entity ??
      payload.payload?.subscription?.entity ??
      payload.payload?.refund?.entity;
    return {
      id: headerValue(headers, 'x-razorpay-event-id') ?? `${payload.event}-${entity?.id ?? ''}`,
      provider: this.provider,
      type: this.#mapWebhookType(payload.event),
      createdAt: this.#toIso(payload.created_at) ?? new Date().toISOString(),
      data: this.#mapWebhookData(payload),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: RazorpayCustomerResponse): Customer {
    const notes = this.#readNotes(data.notes);
    return {
      id: data.id,
      ...(data.name ? { name: data.name } : {}),
      ...(data.email ? { email: data.email } : {}),
      ...(data.gstin ? { taxId: data.gstin } : notes?.tax_id ? { taxId: notes.tax_id } : {}),
    };
  }

  /**
   * An order rendered as a `Payment`. An order is an amount Razorpay expects to collect,
   * so it is `pending` until a payment against it succeeds; `paid` is the only settled
   * state (`attempted` means someone tried and it did not go through).
   */
  #mapOrder(data: RazorpayOrderResponse, customerId?: string): Payment {
    const notes = this.#readNotes(data.notes);
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      status: data.status === 'paid' ? 'paid' : 'pending',
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
    };
    const owner = customerId ?? notes?.customer_id;
    if (owner !== undefined) result.customerId = owner;
    return result;
  }

  #mapPayment(data: RazorpayPaymentResponse): Payment {
    const method = this.#mapMethodToType(data);
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      status: this.#mapPaymentStatus(data.status),
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
    };
    if (method !== undefined) result.method = method;
    if (data.customer_id) result.customerId = data.customer_id;
    if (data.status === 'captured') {
      const paidAt = this.#toIso(data.created_at);
      if (paidAt !== null) result.paidAt = paidAt;
    }
    return result;
  }

  #mapPaymentLink(data: RazorpayPaymentLinkResponse): Payment {
    const statusMap: Record<RazorpayPaymentLinkResponse['status'], Payment['status']> = {
      created: 'pending',
      partially_paid: 'pending',
      paid: 'paid',
      cancelled: 'canceled',
      expired: 'failed',
    };
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      status: statusMap[data.status] ?? 'pending',
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
      hostedUrl: data.short_url,
    };
  }

  /**
   * `authorized` means the funds are held on the payer's instrument and nothing has moved
   * to the merchant yet — Razorpay voids the hold on its own if it is never captured.
   * `BillingStatus` has no member for that, and of the six it does have, `pending` is the
   * only one that says "not settled, not failed". Calling it `paid` would let an app ship
   * goods against money it may never receive, so it is `pending` until `captured`.
   */
  #mapPaymentStatus(status: RazorpayPaymentResponse['status']): Payment['status'] {
    switch (status) {
      case 'captured':
        return 'paid';
      case 'refunded':
        return 'refunded';
      case 'failed':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * Razorpay's `method` is `card`, `netbanking`, `wallet`, `emi` or `upi`. Only cards have
   * a name in `PaymentMethodType`; UPI — the method most Indian payers actually use — has
   * none, and mapping it onto `pix` because both are instant bank rails would put a
   * Brazilian label on an Indian payment. It stays `unknown` (omitted) until the union
   * gains a `upi` member.
   */
  #mapMethodToType(data: RazorpayPaymentResponse): Payment['method'] | undefined {
    if (data.method !== 'card') return undefined;
    return data.card?.type === 'debit' ? 'debit_card' : 'card';
  }

  #mapSubscription(data: RazorpaySubscriptionResponse, customerId?: string): Subscription {
    const statusMap: Record<RazorpaySubscriptionResponse['status'], Subscription['status']> = {
      created: 'incomplete',
      authenticated: 'trialing',
      active: 'active',
      pending: 'past_due',
      halted: 'past_due',
      paused: 'past_due',
      cancelled: 'canceled',
      completed: 'ended',
      expired: 'ended',
    };
    const notes = this.#readNotes(data.notes);
    const result: Subscription = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customer_id ?? customerId ?? notes?.customer_id ?? '',
      status: statusMap[data.status] ?? 'active',
      planId: data.plan_id,
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
    };
    const currentStart = this.#toIso(data.current_start);
    const currentEnd = this.#toIso(data.current_end);
    const endedAt = this.#toIso(data.ended_at);
    if (currentStart !== null) result.currentPeriodStart = currentStart;
    if (currentEnd !== null) result.currentPeriodEnd = currentEnd;
    if (endedAt !== null) result.endsAt = endedAt;
    return result;
  }

  #mapInvoice(data: RazorpayInvoiceResponse): Invoice {
    const statusMap: Record<string, Invoice['status']> = {
      draft: 'draft',
      issued: 'open',
      partially_paid: 'open',
      paid: 'paid',
      cancelled: 'canceled',
      expired: 'void',
      deleted: 'void',
    };
    const issuedAt = this.#toIso(data.issued_at);
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      ...(data.customer_id ? { customerId: data.customer_id } : {}),
      ...(data.subscription_id ? { subscriptionId: data.subscription_id } : {}),
      status: statusMap[data.status] ?? 'draft',
      amount: { amount: data.amount, currency: data.currency.toLowerCase() },
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
      ...(data.short_url ? { hostedPdfUrl: data.short_url } : {}),
      ...(data.invoice_number ? { number: data.invoice_number } : {}),
      ...(issuedAt !== null ? { issuedAt } : {}),
      payload: data as unknown as Record<string, unknown>,
    };
  }

  #mapWebhookType(event: string): string {
    switch (event) {
      case 'payment.captured':
      case 'order.paid':
      case 'payment_link.paid':
      case 'subscription.charged':
        return 'payment.succeeded';
      case 'payment.failed':
      case 'payment_link.expired':
        return 'payment.failed';
      case 'refund.processed':
        return 'payment.refunded';
      // `payment.authorized` is money held, not money moved — reporting it as a success
      // would have the billing layer settle an order the merchant has not been paid for.
      case 'payment.authorized':
      case 'refund.created':
      case 'refund.failed':
      case 'payment_link.cancelled':
      case 'payment_link.partially_paid':
        return 'payment.updated';
      case 'subscription.authenticated':
        return 'subscription.created';
      case 'subscription.cancelled':
        return 'subscription.canceled';
      case 'subscription.activated':
      case 'subscription.updated':
      case 'subscription.pending':
      case 'subscription.halted':
      case 'subscription.paused':
      case 'subscription.resumed':
      case 'subscription.completed':
        return 'subscription.updated';
      default:
        return event;
    }
  }

  #mapWebhookData(payload: RazorpayWebhookPayload): Record<string, unknown> {
    const paymentEntity = payload.payload?.payment?.entity;
    const linkEntity = payload.payload?.payment_link?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const subscriptionEntity = payload.payload?.subscription?.entity;
    const refundEntity = payload.payload?.refund?.entity;
    // The app's own reference can arrive on any of the entities the event carries: notes on
    // the order/payment/subscription, `reference_id` on a payment link. The API reference
    // does not state that an order's notes are copied onto the payment it produces, so
    // every entity in the envelope is checked rather than trusting one of them.
    const externalReference =
      this.#readNotes(paymentEntity?.notes)?.external_reference ??
      linkEntity?.reference_id ??
      this.#readNotes(orderEntity?.notes)?.external_reference ??
      this.#readNotes(subscriptionEntity?.notes)?.external_reference ??
      this.#readNotes(linkEntity?.notes)?.external_reference;

    if (subscriptionEntity !== undefined && paymentEntity === undefined) {
      const subscription = this.#mapSubscription(subscriptionEntity);
      return {
        gatewayId: subscription.gatewayId,
        customerId: subscription.customerId,
        status: subscription.status,
        planId: subscription.planId,
        ...(subscription.endsAt !== undefined ? { endsAt: subscription.endsAt } : {}),
        ...(externalReference !== undefined ? { externalReference } : {}),
      };
    }
    const source = paymentEntity ?? linkEntity ?? orderEntity ?? refundEntity;
    if (source === undefined) return {};
    const payment =
      paymentEntity !== undefined
        ? this.#mapPayment(paymentEntity)
        : linkEntity !== undefined
          ? this.#mapPaymentLink(linkEntity)
          : orderEntity !== undefined
            ? this.#mapOrder(orderEntity)
            : undefined;
    return {
      gatewayId: source.id,
      amount: source.amount,
      currency: source.currency.toLowerCase(),
      ...(payment?.customerId !== undefined ? { customerId: payment.customerId } : {}),
      ...(paymentEntity?.order_id ? { orderId: paymentEntity.order_id } : {}),
      ...(subscriptionEntity !== undefined
        ? { subscriptionId: subscriptionEntity.id, planId: subscriptionEntity.plan_id }
        : {}),
      ...(externalReference !== undefined ? { externalReference } : {}),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  /**
   * Razorpay answers with `"notes": []` — an empty *array* — when an entity has none, so
   * every read goes through here rather than treating it as an object.
   */
  #readNotes(
    notes: Record<string, string> | unknown[] | null | undefined,
  ): Record<string, string> | undefined {
    if (notes === null || notes === undefined || Array.isArray(notes)) return undefined;
    return notes;
  }

  /** Build the `notes` object, with `externalReference` under a stable key. */
  #notes(
    externalReference: string | undefined,
    extra: Record<string, unknown>,
  ): Record<string, string> | undefined {
    const notes: Record<string, string> = {};
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) notes[key] = String(value);
    }
    if (externalReference !== undefined) notes.external_reference = externalReference;
    return Object.keys(notes).length > 0 ? notes : undefined;
  }

  /** `startDate` wins over `trialDays`; both become Razorpay's Unix-second `start_at`. */
  #subscriptionStart(input: CreateSubscriptionInput): number | undefined {
    if (input.startDate !== undefined) {
      const date = new Date(input.startDate);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`[payments] Razorpay: \`startDate\` "${input.startDate}" is not a date.`);
      }
      return Math.floor(date.getTime() / 1000);
    }
    if (input.trialDays !== undefined) {
      return Math.floor((Date.now() + input.trialDays * 24 * 60 * 60 * 1000) / 1000);
    }
    return undefined;
  }

  /** Razorpay timestamps are Unix seconds. */
  #toIso(value: number | null | undefined): string | null {
    if (value === null || value === undefined || value === 0) return null;
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      authHeader: this.#authHeader,
    });
  }
}
