import type { PagarmeDriverConfig } from '../define_config.js';
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
  PaymentMethodType,
  Refund,
  Subscription,
  WebhookEvent,
} from '../types.js';
import { requireMatchingCredential } from '../webhook_security.js';
import { requireCredential } from './shared.js';

// ── Gateway response shapes (only the fields the driver reads) ────────────────────────

interface PagarmeCustomerResponse {
  id: string;
  name?: string;
  email?: string;
  document?: string;
  document_type?: string;
  code?: string;
  metadata?: Record<string, unknown>;
}

interface PagarmeTransactionResponse {
  id?: string;
  transaction_type?: string;
  status?: string;
  /** Pix: the BR Code (EMV payload) the payer copies. */
  qr_code?: string;
  /** Pix: URL of the QR code image. */
  qr_code_url?: string;
  /** Boleto: hosted page, PDF, digitable line and barcode. */
  url?: string;
  pdf?: string;
  line?: string;
  barcode?: string;
}

interface PagarmeChargeResponse {
  id: string;
  code?: string;
  /** `pending`, `paid`, `canceled`, `processing`, `failed`, `overpaid`, `underpaid`, … */
  status: string;
  amount: number;
  paid_amount?: number;
  canceled_amount?: number;
  currency?: string;
  /** `credit_card`, `debit_card`, `boleto`, `pix` (the API also returns `Pix`). */
  payment_method?: string;
  customer?: PagarmeCustomerResponse;
  order?: { id?: string; code?: string };
  last_transaction?: PagarmeTransactionResponse;
  created_at?: string;
  paid_at?: string;
  canceled_at?: string;
  metadata?: Record<string, unknown>;
}

interface PagarmeOrderResponse {
  id: string;
  code?: string;
  amount: number;
  currency?: string;
  status: string;
  customer?: PagarmeCustomerResponse;
  charges?: PagarmeChargeResponse[];
  created_at?: string;
  metadata?: Record<string, unknown>;
}

interface PagarmeSubscriptionResponse {
  id: string;
  code?: string;
  status: string;
  interval?: string;
  interval_count?: number;
  currency?: string;
  payment_method?: string;
  start_at?: string;
  next_billing_at?: string;
  canceled_at?: string;
  created_at?: string;
  customer?: PagarmeCustomerResponse;
  plan?: { id?: string; name?: string };
  items?: Array<{
    id?: string;
    name?: string;
    description?: string;
    quantity?: number;
    pricing_scheme?: { price?: number };
  }>;
  current_cycle?: { start_at?: string; end_at?: string; billing_at?: string };
  metadata?: Record<string, unknown>;
}

interface PagarmeInvoiceResponse {
  id: string;
  code?: string;
  url?: string;
  amount: number;
  status: string;
  due_at?: string;
  created_at?: string;
  customer?: PagarmeCustomerResponse;
  subscription?: { id?: string };
  charge?: PagarmeChargeResponse;
}

interface PagarmePaymentLinkResponse {
  id: string;
  url: string;
  status?: string;
  name?: string;
  cart_settings?: { total_cost?: number };
}

/** The envelope every Pagar.me webhook arrives in. */
interface PagarmeWebhookPayload {
  id?: string;
  type?: string;
  created_at?: string;
  account?: { id?: string; name?: string };
  data?: PagarmeChargeResponse & PagarmeOrderResponse & PagarmeSubscriptionResponse;
}

/**
 * Pagar.me driver — the Stone group's Brazilian gateway (Core API v5).
 *
 * Speaks the REST API directly via `fetch` (no SDK dependency), authenticated with HTTP
 * Basic: the secret key is the username and the password is empty.
 *
 * Two things separate it from the other Brazilian drivers:
 *
 * - **Money is already integer centavos.** Asaas, AbacatePay and Woovi take decimal reais,
 *   so their drivers convert; Pagar.me's `amount` fields are in the same unit as the
 *   library's {@link Money}, and this driver deliberately does no conversion at all.
 * - **Charges hang off orders.** `POST /orders` creates an order carrying one `payments[]`
 *   entry, and the gateway answers with the order plus the `charges[]` it generated. The
 *   driver returns the first charge as the {@link Payment}, which is what `findPayment`
 *   (`GET /charges/{id}`) and the `charge.*` webhooks then talk about.
 */
export class PagarmeDriver implements PaymentsDriver {
  readonly provider = 'pagarme';
  /**
   * No `'undefined'`: an order must name its `payment_method`, so "let the customer pick"
   * exists only on a payment link — {@link PagarmeDriver.createCheckout} — never on a charge.
   */
  readonly supportedMethods = ['pix', 'boleto', 'credit_card', 'debit_card'] as const;
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true };

  #baseUrl: string;
  #authHeader: { name: string; value: string };
  #invoiceCtx: EmitInvoiceContext;
  /** Optional HTTP Basic credentials configured on the webhook endpoint in the dashboard. */
  #webhookUser: string | undefined;
  #webhookPassword: string | undefined;
  /** Default Pix expiry (seconds) when the charge doesn't name one. */
  #pixExpiresIn: number;

  constructor(ctx: EmitInvoiceContext, config: PagarmeDriverConfig = {}) {
    this.#invoiceCtx = ctx;
    const secretKey = requireCredential({
      driver: 'pagarme',
      option: 'secretKey',
      env: 'PAGARME_SECRET_KEY',
      value: config.secretKey,
    });
    this.#baseUrl = config.baseUrl ?? 'https://api.pagar.me/core/v5';
    // HTTP Basic with the secret key as the username and an empty password.
    this.#authHeader = {
      name: 'Authorization',
      value: `Basic ${Buffer.from(`${secretKey}:`, 'utf8').toString('base64')}`,
    };
    this.#webhookUser = config.webhookUser ?? process.env.PAGARME_WEBHOOK_USER;
    this.#webhookPassword = config.webhookPassword ?? process.env.PAGARME_WEBHOOK_PASSWORD;
    this.#pixExpiresIn = config.pixExpiresIn ?? 86_400;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCustomer', 'POST /customers');
    const data = await this.#request<PagarmeCustomerResponse>('/customers', {
      method: 'POST',
      body: this.#customerBody(input),
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<PagarmeCustomerResponse>(
        `/customers/${encodeURIComponent(customerId)}`,
      );
      return this.#mapCustomer(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const data = await this.#request<PagarmeCustomerResponse>(
      `/customers/${encodeURIComponent(customerId)}`,
      { method: 'PUT', body: this.#customerBody(input) },
    );
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    const method = this.#resolveMethod(input);
    const reference = input.externalReference ?? input.idempotencyKey;
    const body: Record<string, unknown> = {
      // One line per order: the contract charges an amount, not a cart.
      items: [
        {
          // Pagar.me is integer centavos, the same unit as `Money` — unlike the
          // decimal-reais Brazilian gateways, nothing here goes through `toDecimal`.
          amount: input.amount,
          quantity: 1,
          description: input.description ?? 'Charge',
          ...(reference !== undefined ? { code: reference } : {}),
        },
      ],
      payments: [this.#paymentEntry(input, method)],
      // Closed orders are billed as created; an open order waits for more charges.
      closed: true,
      ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
      ...(input.customerId === undefined ? { customer: this.#inlineCustomer(input) } : {}),
      // `code` is the store's own identifier for the order, echoed on the order and on
      // every charge it generates — plus a metadata copy, because order metadata is
      // repeated on the charge object the webhooks deliver.
      ...(reference !== undefined ? { code: reference } : {}),
      metadata: {
        ...(input.metadata as Record<string, unknown> | undefined),
        ...(reference !== undefined ? { external_reference: reference } : {}),
      },
    };

    const order = await this.#request<PagarmeOrderResponse>('/orders', {
      method: 'POST',
      body,
      // The `Idempotency-key` header, which Pagar.me documents for order creation and
      // nothing else. It is separate from the `code` above: `code` routes the webhook
      // back to your record, this stops a retry becoming a second order. Two footguns
      // worth knowing — Pagar.me does NOT compare the bodies, so the same key with a
      // different payload still returns the first order; and the key lives 24h in
      // production but only 5 minutes in sandbox.
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const charge = order.charges?.[0];
    if (!charge) {
      throw new Error(
        `[payments] Pagar.me created order "${order.id}" without a charge. Check the account is enabled for the requested payment method.`,
      );
    }
    const payment = this.#mapCharge(charge, order);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#request<PagarmeChargeResponse>(
        `/charges/${encodeURIComponent(gatewayId)}`,
      );
      return this.#mapCharge(data);
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
    this.#refuseIdempotencyKey(options?.idempotencyKey, 'refund', 'DELETE /charges/{id}');
    // Pagar.me has one endpoint for both: cancelling an unsettled charge and refunding a
    // paid one. Omitting `amount` cancels/refunds the full value.
    const data = await this.#request<PagarmeChargeResponse>(
      `/charges/${encodeURIComponent(paymentGatewayId)}`,
      { method: 'DELETE', ...(amount !== undefined ? { body: { amount } } : {}) },
    );
    const refunded =
      data.status === 'canceled' ||
      data.status === 'refunded' ||
      data.status === 'partial_canceled' ||
      data.status === 'partial_refunded';
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: amount ?? data.canceled_amount ?? data.amount, currency: 'brl' },
      status: refunded ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending',
      createdAt: this.#toIso(data.canceled_at) ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a Pagar.me payment link (`POST /paymentlinks`) — the hosted checkout page.
   *
   * `planId` switches the link to a subscription link, which the API only accepts with
   * `credit_card`. There is no cancel URL in the API: a link has `flow_settings.success_url`
   * and nothing else, so {@link CheckoutInput.cancelUrl} is ignored rather than faked.
   */
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const recurring = input.planId !== undefined;
    const methods = recurring ? ['credit_card'] : this.#checkoutMethods(input);
    const body: Record<string, unknown> = {
      type: recurring ? 'subscription' : 'order',
      name: (input.description ?? 'Checkout').slice(0, 64),
      // `order_code` is the link's correlation id: the store's own identifier, echoed as
      // the `code` of every order the link generates and read back out of the webhook.
      ...((input.externalReference ?? input.idempotencyKey) !== undefined
        ? { order_code: input.externalReference ?? input.idempotencyKey }
        : {}),
      payment_settings: {
        accepted_payment_methods: methods,
        ...(methods.includes('credit_card')
          ? { credit_card_settings: { operation_type: 'auth_and_capture' } }
          : {}),
      },
      cart_settings: {
        items: [
          {
            name: (input.description ?? 'Checkout').slice(0, 64),
            amount: input.amount,
            default_quantity: 1,
          },
        ],
        ...(recurring
          ? {
              recurrences: [
                {
                  plan_id: input.planId,
                  ...(input.trialDays !== undefined ? { start_in: input.trialDays } : {}),
                },
              ],
            }
          : {}),
      },
      ...(input.customerId !== undefined
        ? { customer_settings: { customer_id: input.customerId } }
        : {}),
      flow_settings: { success_url: input.successUrl },
    };

    const link = await this.#request<PagarmePaymentLinkResponse>('/paymentlinks', {
      method: 'POST',
      body,
    });
    return {
      id: link.id,
      gatewayId: link.id,
      provider: this.provider,
      url: link.url,
      status: link.status === 'expired' || link.status === 'canceled' ? 'expired' : 'open',
      amount: { amount: link.cart_settings?.total_cost ?? input.amount, currency: 'brl' },
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  /**
   * Creates a subscription (`POST /subscriptions`), in whichever of the API's two shapes
   * the call describes:
   *
   * - `planId` naming a Pagar.me plan (`plan_…`) creates a subscription from that plan;
   *   the plan owns the interval and the price.
   * - Any other `planId` creates a plan-less ("avulsa") subscription built from `amount`
   *   and `cycle`, with `planId` kept as the subscription's `code`. `amount` is required
   *   in that shape — there is no plan to read a price from.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createSubscription', 'POST /subscriptions');
    const fromPlan = input.planId.startsWith('plan_');
    const method = this.#mapMethodOut(input.method ?? 'credit_card');
    const body: Record<string, unknown> = {
      customer_id: input.customerId,
      payment_method: method,
      ...(input.startDate !== undefined ? { start_at: input.startDate } : {}),
      ...(input.card !== undefined ? { card_token: input.card.token } : {}),
      // Pagar.me's own identifier for the subscription in your system — the routing key,
      // echoed on the subscription and on the invoices/charges it generates.
      ...(input.externalReference !== undefined
        ? { code: input.externalReference }
        : fromPlan
          ? {}
          : { code: input.planId }),
      metadata: {
        ...(input.metadata as Record<string, unknown> | undefined),
        ...(input.externalReference !== undefined
          ? { external_reference: input.externalReference }
          : {}),
      },
    };

    if (fromPlan) {
      body.plan_id = input.planId;
    } else {
      if (input.amount === undefined) {
        throw new Error(
          '[payments] Pagar.me needs an `amount` to create a subscription without a plan. ' +
            `Pass \`amount\`, or set \`planId\` to a Pagar.me plan id ("plan_…").`,
        );
      }
      const { interval, intervalCount } = this.#mapCycle(input.cycle);
      body.interval = interval;
      body.interval_count = intervalCount;
      body.billing_type = 'prepaid';
      body.items = [
        {
          description: input.description ?? input.planId,
          quantity: 1,
          pricing_scheme: { price: input.amount },
        },
      ];
    }

    const data = await this.#request<PagarmeSubscriptionResponse>('/subscriptions', {
      method: 'POST',
      body,
    });
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  /**
   * Cancels a subscription. Pagar.me cancels **immediately** — the API has no period-end
   * flag — so `atPeriodEnd` cannot keep the subscription running. What it does control is
   * the invoices already issued for the current cycle: `atPeriodEnd: true` sends
   * `cancel_pending_invoices: false`, leaving them payable; the default cancels them too.
   */
  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const data = await this.#request<PagarmeSubscriptionResponse>(
      `/subscriptions/${encodeURIComponent(subscriptionGatewayId)}`,
      { method: 'DELETE', body: { cancel_pending_invoices: options?.atPeriodEnd !== true } },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  /**
   * Not supported. A Pagar.me subscription has no amount or description of its own — the
   * price lives on its items, each with its own `pricing_scheme`, and the API changes one
   * through the subscription-item sub-resource rather than through the subscription. There
   * is no request this method could make that means what the contract says it means, so it
   * refuses instead of returning a subscription the gateway never changed.
   */
  async updateSubscription(
    subscriptionGatewayId: string,
    _input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    throw new Error(
      `[payments] Pagar.me cannot update subscription "${subscriptionGatewayId}": its price lives on its items, not on the subscription. ` +
        `Cancel "${subscriptionGatewayId}" and create a new subscription, or edit its item in the dashboard.`,
    );
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<PagarmeSubscriptionResponse>(
        `/subscriptions/${encodeURIComponent(gatewayId)}`,
      );
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  /** Lists the gateway's subscription invoices (`GET /invoices?customer_id=…`). */
  async listInvoices(customerId: string): Promise<Invoice[]> {
    const data = await this.#request<{ data?: PagarmeInvoiceResponse[] }>(
      `/invoices?customer_id=${encodeURIComponent(customerId)}`,
    );
    return (data.data ?? []).map((invoice) => {
      const result: Invoice = {
        id: invoice.id,
        gatewayId: invoice.id,
        provider: this.provider,
        status: this.#mapInvoiceStatus(invoice.status),
        amount: { amount: invoice.amount, currency: 'brl' },
        createdAt: this.#toIso(invoice.created_at) ?? new Date().toISOString(),
        payload: invoice as unknown as Record<string, unknown>,
      };
      if (invoice.customer?.id !== undefined) result.customerId = invoice.customer.id;
      if (invoice.subscription?.id !== undefined) result.subscriptionId = invoice.subscription.id;
      if (invoice.code !== undefined) result.number = invoice.code;
      // `url` is a dashboard path (`/invoices/in_…`), not a PDF — only surface it when the
      // gateway hands back something absolute.
      if (invoice.url?.startsWith('http')) result.hostedPdfUrl = invoice.url;
      return result;
    });
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Pagar.me signs nothing: the dashboard's webhook configuration offers optional HTTP
   * Basic credentials and no HMAC. When `webhookUser`/`webhookPassword` are configured,
   * every request must carry the matching `Authorization: Basic …`; when they are not,
   * the payload is accepted as-is — so configure them in production.
   */
  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * Pagar.me authenticates with HTTP Basic on the callback; with neither half configured the
   * credentials are not checked.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookUser !== undefined || this.#webhookPassword !== undefined
      ? 'configured'
      : 'unconfigured';
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (this.#webhookUser !== undefined || this.#webhookPassword !== undefined) {
      this.#requireBasicAuth(headers);
    }
    const payload = JSON.parse(rawBody) as PagarmeWebhookPayload;
    const type = payload.type ?? 'unknown';
    return {
      id: payload.id ?? `${type}-${payload.data?.id ?? Math.random()}`,
      provider: this.provider,
      type: this.#mapWebhookType(type),
      createdAt: this.#toIso(payload.created_at) ?? new Date().toISOString(),
      data: this.#mapWebhookData(type, payload.data),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #customerBody(input: CreateCustomerInput | UpdateCustomerInput): Record<string, unknown> {
    const document = input.taxId?.replace(/\D/g, '');
    return {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(document !== undefined
        ? {
            document,
            document_type: document.length > 11 ? 'CNPJ' : 'CPF',
            type: document.length > 11 ? 'company' : 'individual',
          }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
  }

  #mapCustomer(data: PagarmeCustomerResponse): Customer {
    const customer: Customer = { id: data.id };
    if (data.name !== undefined) customer.name = data.name;
    if (data.email !== undefined) customer.email = data.email;
    if (data.document !== undefined) customer.taxId = data.document;
    if (data.metadata !== undefined) customer.metadata = data.metadata;
    return customer;
  }

  /** The payer data an order carries when no `customer_id` was given. */
  #inlineCustomer(input: ChargeInput): Record<string, unknown> {
    const name = input.customer?.name ?? input.card?.holder?.name;
    const email = input.customer?.email ?? input.card?.holder?.email;
    const taxId = input.customer?.taxId ?? input.card?.holder?.cpfCnpj;
    if (name === undefined) {
      throw new Error(
        '[payments] Pagar.me needs a payer on every order. Pass `customerId`, or `customer.name` on the charge.',
      );
    }
    const document = taxId?.replace(/\D/g, '');
    return {
      name,
      ...(email !== undefined ? { email } : {}),
      ...(document !== undefined
        ? {
            document,
            document_type: document.length > 11 ? 'CNPJ' : 'CPF',
            type: document.length > 11 ? 'company' : 'individual',
          }
        : {}),
    };
  }

  /** The single `payments[]` entry an order carries, built for the resolved method. */
  #paymentEntry(input: ChargeInput, method: string): Record<string, unknown> {
    const entry: Record<string, unknown> = { payment_method: method };

    if (method === 'credit_card' || method === 'debit_card') {
      const token = input.card?.token ?? undefined;
      const cardId = input.paymentMethodId ?? undefined;
      if (token === undefined && cardId === undefined) {
        throw new Error(
          `[payments] Pagar.me needs a tokenized card for a ${method} charge. Pass \`card.token\` (checkout transparente) or \`paymentMethodId\` (a saved \`card_…\` id).`,
        );
      }
      entry[method] = {
        operation_type: 'auth_and_capture',
        installments: Number(input.metadata?.installments ?? 1),
        ...(input.metadata?.statementDescriptor !== undefined
          ? { statement_descriptor: input.metadata.statementDescriptor }
          : {}),
        ...(token !== undefined ? { card_token: token } : {}),
        ...(cardId !== undefined ? { card_id: cardId } : {}),
      };
    } else if (method === 'pix') {
      // `expires_in` is mandatory on a Pix payment — the driver always sends one.
      entry.pix = { expires_in: Number(input.metadata?.expiresIn ?? this.#pixExpiresIn) };
    } else if (method === 'boleto') {
      entry.boleto = {
        ...(input.metadata?.dueDate !== undefined ? { due_at: input.metadata.dueDate } : {}),
        ...(input.description !== undefined ? { instructions: input.description } : {}),
      };
    }

    const split = this.#mapSplit(input);
    if (split !== undefined) entry.split = split;
    return entry;
  }

  /**
   * Marketplace split. A Pagar.me rule carries exactly one `type` — `percentage` or
   * `flat` — so an entry that names both a percent and a fixed value has no honest
   * mapping and is refused rather than silently halved.
   */
  #mapSplit(input: ChargeInput): Array<Record<string, unknown>> | undefined {
    if (input.split === undefined || input.split.length === 0) return undefined;
    return input.split.map((entry) => {
      if (entry.percentualValue !== undefined && entry.fixedValue !== undefined) {
        throw new Error(
          `[payments] Pagar.me split rules are either \`percentage\` or \`flat\`, never both. Wallet "${entry.walletId}" set percentualValue and fixedValue — pick one.`,
        );
      }
      if (entry.percentualValue === undefined && entry.fixedValue === undefined) {
        throw new Error(
          `[payments] Pagar.me split rule for wallet "${entry.walletId}" has no value. Set \`percentualValue\` or \`fixedValue\`.`,
        );
      }
      const percentage = entry.percentualValue !== undefined;
      return {
        recipient_id: entry.walletId,
        type: percentage ? 'percentage' : 'flat',
        // Pagar.me is centavos throughout, so a `flat` share needs no conversion.
        amount: percentage ? entry.percentualValue : entry.fixedValue,
      };
    });
  }

  #mapCharge(data: PagarmeChargeResponse, order?: PagarmeOrderResponse): Payment {
    const method = this.#mapMethodIn(data.payment_method);
    const transaction = data.last_transaction;
    const payment: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: data.amount, currency: 'brl' },
      status: this.#chargeStatus(data, transaction),
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
    };
    const customerId = data.customer?.id ?? order?.customer?.id;
    if (customerId !== undefined) payment.customerId = customerId;
    if (method !== 'unknown') payment.method = method;
    if (transaction?.qr_code !== undefined) {
      payment.pixCode = transaction.qr_code;
      payment.pixCopiaECola = transaction.qr_code;
    }
    if (transaction?.qr_code_url !== undefined) {
      payment.pixQrCodeImage = transaction.qr_code_url;
      payment.pixQrCode = transaction.qr_code_url;
    }
    // Boleto: `url` is the hosted slip, `pdf` the printable one.
    const hosted = transaction?.url ?? transaction?.pdf;
    if (hosted !== undefined) payment.hostedUrl = hosted;
    const paidAt = this.#toIso(data.paid_at);
    if (paidAt !== null) payment.paidAt = paidAt;
    return payment;
  }

  /**
   * A charge's canonical status — which Pagar.me's `charge.status` alone cannot give.
   *
   * Pagar.me has no `authorized` charge status: a card taken with `operation_type:
   * "auth_only"` leaves the CHARGE at `pending`, exactly like a boleto nobody has paid,
   * and only `last_transaction.status` says `authorized_pending_capture`. So `pending`
   * here is overloaded — "waiting for the payer" and "money held on the card, waiting for
   * you to capture it" are the same word — and reading only the charge collapses a hold
   * the issuer has already granted into a charge that may never happen.
   */
  #chargeStatus(
    data: PagarmeChargeResponse,
    transaction: PagarmeTransactionResponse | undefined,
  ): Payment['status'] {
    const statusMap: Record<string, Payment['status']> = {
      pending: 'pending',
      processing: 'pending',
      waiting_payment: 'pending',
      paid: 'paid',
      overpaid: 'paid',
      underpaid: 'paid',
      canceled: 'canceled',
      partial_canceled: 'refunded',
      refunded: 'refunded',
      partial_refunded: 'refunded',
      voided: 'canceled',
      failed: 'failed',
      payment_failed: 'failed',
      not_authorized: 'failed',
      with_error: 'failed',
      chargedback: 'disputed',
    };
    const mapped = statusMap[data.status] ?? 'pending';
    if (mapped !== 'pending') return mapped;
    // Both transaction statuses mean the same thing: authorized, nothing captured.
    return transaction?.status === 'authorized_pending_capture' ||
      transaction?.status === 'waiting_capture'
      ? 'authorized'
      : 'pending';
  }

  #mapSubscription(data: PagarmeSubscriptionResponse): Subscription {
    const statusMap: Record<string, Subscription['status']> = {
      active: 'active',
      future: 'incomplete',
      canceled: 'canceled',
    };
    const price = data.items?.[0]?.pricing_scheme?.price;
    const subscription: Subscription = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customer?.id ?? '',
      status: statusMap[data.status] ?? 'active',
      planId: data.plan?.id ?? data.code ?? data.id,
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.created_at) ?? new Date().toISOString(),
    };
    if (price !== undefined) subscription.amount = { amount: price, currency: 'brl' };
    const endsAt = this.#toIso(data.canceled_at);
    if (endsAt !== null) subscription.endsAt = endsAt;
    const periodStart = this.#toIso(data.current_cycle?.start_at);
    if (periodStart !== null) subscription.currentPeriodStart = periodStart;
    const periodEnd = this.#toIso(data.current_cycle?.end_at);
    if (periodEnd !== null) subscription.currentPeriodEnd = periodEnd;
    return subscription;
  }

  #mapInvoiceStatus(status: string): Invoice['status'] {
    switch (status) {
      case 'paid':
        return 'paid';
      case 'pending':
      case 'scheduled':
      case 'partial_paid':
        return 'open';
      case 'canceled':
        return 'canceled';
      case 'failed':
        return 'failed';
      default:
        return 'draft';
    }
  }

  #mapWebhookType(type: string): string {
    switch (type) {
      case 'charge.paid':
      case 'order.paid':
      case 'invoice.paid':
        return 'payment.succeeded';
      case 'charge.payment_failed':
      case 'order.payment_failed':
      case 'invoice.payment_failed':
        return 'payment.failed';
      case 'charge.refunded':
      case 'charge.partial_canceled':
        return 'payment.refunded';
      case 'charge.created':
      case 'charge.pending':
      case 'charge.processing':
      case 'charge.updated':
      case 'charge.underpaid':
      case 'charge.overpaid':
      case 'order.created':
      case 'order.updated':
      case 'order.closed':
        return 'payment.updated';
      // The chargeback: the issuer has pulled the money back. The charge's own status
      // becomes `chargedback` too, and only the charge's — Pagar.me leaves the order's
      // status alone. Note the spelling: `chargedback`, with the `d` in the middle, which
      // Pagar.me's own docs call out because everyone gets it wrong.
      //
      // The charge payload carries no defense deadline. Pagar.me's response window lives
      // only on the Disputes API (`responseDeadline` on `GET /v1/disputes/{id}`), which is
      // not on the driver contract — so this event has no `actionableUntil` to carry, and
      // inventing one would be worse than the operator going to look.
      case 'charge.chargedback':
        return 'payment.disputed';
      // `chargeback.received` REPLACES `charge.chargedback` — Pagar.me's own event list
      // marks the latter "será descontinuado", migration due **30/09/2026**. As of this
      // reading (August 2026) the event exists in that list with a one-line description
      // and nothing else: **no payload is documented anywhere**, and no example is
      // published. The neighbouring Disputes API documents a dispute as
      // `{ disputeId, chargeId, responseDeadline, chargebackAmount, status, … }`, which
      // would map cleanly if that is what arrives — but "would map cleanly if" is not a
      // reference. Filing `payment.disputed` against an id that turns out to be the
      // dispute's rather than the charge's writes a `disputed` row nothing reconciles,
      // so this keeps its own name until one real payload is seen.
      case 'chargeback.received':
        return type;
      // A cancel is not a dispute. The contract has no cancel event either, and inventing
      // one would route straight to the processor's no-op branch under a name nothing
      // reads — these land as `payment.updated` with `event.raw.type` intact.
      case 'order.canceled':
      case 'invoice.canceled':
        return 'payment.updated';
      case 'subscription.created':
        return 'subscription.created';
      case 'subscription.updated':
        return 'subscription.updated';
      case 'subscription.canceled':
        return 'subscription.canceled';
      default:
        return type;
    }
  }

  #mapWebhookData(type: string, data: PagarmeWebhookPayload['data']): Record<string, unknown> {
    if (data === undefined) return {};
    // An undocumented payload passes through UNTOUCHED. Running `chargeback.received`
    // through the charge mapper below fabricated a `{ gatewayId, amount, currency }` out of
    // fields a dispute object does not have — an empty id and a zero — and handed it to any
    // app handler registered for the event. What Pagar.me sent is the only honest answer
    // until its shape is documented, and it is also what you need to report the shape.
    if (type === 'chargeback.received') return data as unknown as Record<string, unknown>;
    if (type.startsWith('subscription.')) {
      const subscription = this.#mapSubscription(data);
      return {
        gatewayId: subscription.gatewayId,
        customerId: subscription.customerId,
        status: subscription.status,
        planId: subscription.planId,
        ...(subscription.endsAt !== undefined ? { endsAt: subscription.endsAt } : {}),
        ...(this.#reference(data) !== undefined
          ? { externalReference: this.#reference(data) }
          : {}),
      };
    }
    // `order.*` delivers the order with its charges; `charge.*` delivers the charge
    // itself. Both normalize onto the charge, which is what a Payment row tracks.
    const charge = type.startsWith('order.')
      ? (data.charges?.[0] ?? undefined)
      : (data as PagarmeChargeResponse);
    if (charge === undefined) return {};
    const payment = this.#mapCharge(charge, type.startsWith('order.') ? data : undefined);
    const reference = this.#reference(charge) ?? this.#reference(data);
    return {
      gatewayId: payment.gatewayId,
      amount: payment.amount.amount,
      currency: payment.amount.currency,
      ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
      ...(reference !== undefined ? { externalReference: reference } : {}),
    };
  }

  /**
   * The app's own id echoed back — `metadata.external_reference` first (order metadata is
   * repeated on every charge), then the `code` the order/subscription was created with.
   */
  #reference(data: {
    code?: string;
    metadata?: Record<string, unknown>;
  }): string | undefined {
    const fromMetadata = data.metadata?.external_reference;
    if (typeof fromMetadata === 'string' && fromMetadata !== '') return fromMetadata;
    return data.code;
  }

  /** Resolve the order's `payment_method` from the charge input, refusing what an order can't express. */
  #resolveMethod(input: ChargeInput): string {
    if (input.method === undefined) {
      // A card was handed over without naming a method — that is unambiguous.
      if (input.card !== undefined || input.paymentMethodId !== undefined) return 'credit_card';
      throw new Error(
        '[payments] Pagar.me needs an explicit `method` on every charge — an order names its ' +
          "`payment_method`. Pass 'pix', 'boleto', 'credit_card' or 'debit_card'.",
      );
    }
    return this.#mapMethodOut(input.method);
  }

  #mapMethodOut(method: string): string {
    switch (method) {
      case 'pix':
        return 'pix';
      case 'boleto':
        return 'boleto';
      case 'credit_card':
        return 'credit_card';
      case 'debit_card':
        return 'debit_card';
      default:
        throw new Error(
          `[payments] Pagar.me does not support payment method "${method}". Supported: pix, boleto, credit_card, debit_card.`,
        );
    }
  }

  #mapMethodIn(paymentMethod: string | undefined): PaymentMethodType {
    switch (paymentMethod?.toLowerCase()) {
      case 'pix':
        return 'pix';
      case 'boleto':
        return 'boleto';
      case 'credit_card':
        return 'card';
      case 'debit_card':
        return 'debit_card';
      default:
        return 'unknown';
    }
  }

  /** Map the contract's cycle onto Pagar.me's `interval` + `interval_count` pair. */
  #mapCycle(cycle: CreateSubscriptionInput['cycle']): {
    interval: string;
    intervalCount: number;
  } {
    switch (cycle) {
      case 'WEEKLY':
        return { interval: 'week', intervalCount: 1 };
      case 'BIWEEKLY':
        return { interval: 'week', intervalCount: 2 };
      case 'QUARTERLY':
        return { interval: 'month', intervalCount: 3 };
      case 'SEMIANNUALLY':
        return { interval: 'month', intervalCount: 6 };
      case 'YEARLY':
        return { interval: 'year', intervalCount: 1 };
      default:
        return { interval: 'month', intervalCount: 1 };
    }
  }

  /** Which methods a payment link accepts, from the charge's routing hint. */
  #checkoutMethods(input: CheckoutInput): string[] {
    const named = (input.metadata?.methods ?? undefined) as string[] | undefined;
    if (Array.isArray(named) && named.length > 0) {
      return named.map((method) => this.#mapMethodOut(method));
    }
    return ['credit_card', 'pix', 'boleto'];
  }

  /**
   * Pagar.me documents `Idempotency-key` for **order creation and nothing else** — the
   * reference for `DELETE /charges/{id}`, `POST /customers` and `POST /subscriptions`
   * lists no header but `Authorization`. The header might well be honoured there too, on
   * the same gateway; "might" is not a retry guarantee, and quietly forwarding a key the
   * reference does not promise anything about turns a caller's retry into a second
   * refund. So those operations refuse it and say where it does work.
   */
  #refuseIdempotencyKey(key: string | undefined, operation: string, endpoint: string): void {
    if (key === undefined) return;
    throw new Error(
      `[payments] Pagar.me documents idempotency only for order creation, so \`${operation}\` cannot honour an idempotencyKey — its \`${endpoint}\` reference documents no such header. Only \`charge()\` (POST /orders) deduplicates; for the rest, deduplicate before you call.`,
    );
  }

  /** Parse a gateway timestamp into an ISO string, or `null` when absent/invalid. */
  #toIso(value: string | undefined): string | null {
    if (value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  #requireBasicAuth(headers: Record<string, string | string[] | undefined>): void {
    const header = headerValue(headers, 'authorization');
    if (header === undefined || !header.toLowerCase().startsWith('basic ')) {
      throw new Error('[payments] Missing webhook Basic credentials on Pagar.me request.');
    }
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const user = separator === -1 ? decoded : decoded.slice(0, separator);
    const password = separator === -1 ? '' : decoded.slice(separator + 1);
    requireMatchingCredential(user, this.#webhookUser ?? '', 'Pagar.me', 'user');
    requireMatchingCredential(password, this.#webhookPassword ?? '', 'Pagar.me', 'password');
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown>; idempotencyKey?: string } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      authHeader: this.#authHeader,
      // Pagar.me spells it `Idempotency-key`; the value is case-sensitive, and two
      // concurrent requests carrying the same one get a 409 rather than two orders.
      ...(options.idempotencyKey !== undefined
        ? { headers: { 'Idempotency-key': options.idempotencyKey } }
        : {}),
    });
  }
}
