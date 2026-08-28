import { createHmac, randomUUID } from 'node:crypto';
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
import { fromDecimal, toDecimal } from '../money.js';
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
import { safeCompare } from '../webhook_security.js';
import { requireCredential, requireCurrency } from './shared.js';

/**
 * Config for {@link MercadoPagoDriver}. Declared here rather than in `define_config.ts` so
 * the driver module type-checks on its own; the factory re-exports it.
 */
export interface MercadoPagoDriverConfig {
  /** Access token (private credential). Defaults to `env.get('MERCADOPAGO_ACCESS_TOKEN')`. */
  accessToken?: string;
  /**
   * Currency for calls that don't name one (lowercase ISO 4217: `brl`, `ars`, `mxn`,
   * `clp`, `cop`, `pen`, `uyu`). **Required** — Mercado Pago runs seven country sites and
   * bills in whatever you hand it, so a default here would be a guess at which one.
   */
  currency: string;
  /**
   * The "secret signature" from Your integrations → Webhooks, used to verify the
   * `x-signature` header. Defaults to `env.get('MERCADOPAGO_WEBHOOK_SECRET')`. When set,
   * notifications without a valid signature are rejected.
   */
  webhookSecret?: string;
}

interface MercadoPagoCustomerResponse {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  identification?: { type?: string; number?: string };
}

interface MercadoPagoPaymentResponse {
  id: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number | string;
  currency_id?: string;
  description?: string;
  external_reference?: string;
  date_created?: string;
  date_approved?: string;
  payment_method_id?: string;
  payment_type_id?: string;
  payer?: { id?: number | string; email?: string };
  transaction_details?: { external_resource_url?: string };
  point_of_interaction?: {
    transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string };
  };
}

interface MercadoPagoRefundResponse {
  id: number | string;
  payment_id?: number | string;
  amount?: number | string;
  status?: string;
  date_created?: string;
}

interface MercadoPagoPreferenceResponse {
  id: string;
  init_point?: string;
  external_reference?: string;
}

interface MercadoPagoPreapprovalResponse {
  id: string;
  status?: string;
  reason?: string;
  external_reference?: string;
  preapproval_plan_id?: string;
  payer_id?: number | string;
  init_point?: string;
  date_created?: string;
  next_payment_date?: string;
  auto_recurring?: {
    frequency?: number;
    frequency_type?: string;
    transaction_amount?: number | string;
    currency_id?: string;
    start_date?: string;
    end_date?: string;
  };
}

interface MercadoPagoNotification {
  id?: number | string;
  type?: string;
  action?: string;
  /** `topic_chargebacks_wh` sends this instead of `action`, as an array. */
  actions?: string[];
  date_created?: string;
  live_mode?: boolean;
  user_id?: number | string;
  /**
   * `id` is the id of whatever changed — a payment for `payment`, a preapproval for
   * `subscription_preapproval`, the CHARGEBACK CASE for `topic_chargebacks_wh`. Only the
   * chargeback topic also names the payment the case is about, and it has to: the case id
   * is not a payment id, and filing a dispute under it would write a row nothing
   * reconciles.
   */
  data?: { id?: string | number; payment_id?: string | number };
}

/** Mercado Pago rejects an `external_reference` outside this shape (max 64 chars). */
const EXTERNAL_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Mercado Pago driver — the largest gateway in Latin America, over the Checkout API
 * (`/v1/payments`), Checkout Pro preferences and preapproval subscriptions. Plain REST,
 * no SDK.
 *
 * Unlike the BRL-only Brazilian drivers this one is multi-currency across BR/AR/MX/CL/
 * CO/PE/UY, so `currency` is required. Money crosses the boundary as a decimal
 * `transaction_amount`.
 *
 * The one thing to know before reading {@link parseWebhook}: a Mercado Pago notification
 * carries **only the id of the resource that changed**. Nothing else — no amount, no
 * status, no `external_reference`.
 */
export class MercadoPagoDriver implements PaymentsDriver {
  readonly provider = 'mercadopago';
  /**
   * What `charge()` actually creates. `undefined` is absent on purpose: Mercado Pago
   * requires a `payment_method_id` on every payment, so "let the customer choose" is the
   * Checkout Pro flow ({@link createCheckout}), not a charge.
   */
  readonly supportedMethods = ['pix', 'boleto', 'credit_card', 'debit_card'] as const;
  readonly capabilities = { refunds: true, invoices: false, subscriptions: true };

  #baseUrl = 'https://api.mercadopago.com';
  #accessToken: string;
  #currency: string;
  #webhookSecret: string | undefined;
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: MercadoPagoDriverConfig) {
    this.#invoiceCtx = ctx;
    this.#accessToken = requireCredential({
      driver: 'mercadopago',
      option: 'accessToken',
      env: 'MERCADOPAGO_ACCESS_TOKEN',
      value: config.accessToken,
    });
    this.#currency = requireCurrency('mercadopago', config.currency);
    this.#webhookSecret = config.webhookSecret ?? process.env.MERCADOPAGO_WEBHOOK_SECRET;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCustomer', 'POST /v1/customers');
    const [firstName, ...rest] = (input.name ?? '').split(' ');
    const body: Record<string, unknown> = {
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(firstName !== undefined && firstName !== '' ? { first_name: firstName } : {}),
      ...(rest.length > 0 ? { last_name: rest.join(' ') } : {}),
      ...(input.taxId !== undefined ? { identification: this.#identification(input.taxId) } : {}),
      ...(input.metadata !== undefined ? input.metadata : {}),
    };
    const data = await this.#request<MercadoPagoCustomerResponse>('/v1/customers', {
      method: 'POST',
      body,
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<MercadoPagoCustomerResponse>(`/v1/customers/${customerId}`);
      return this.#mapCustomer(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const [firstName, ...rest] = (input.name ?? '').split(' ');
    const body: Record<string, unknown> = {
      // Mercado Pago only accepts `email` on a customer that has none yet; sending it for
      // one that already has an email comes back as error 126.
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(firstName !== undefined && firstName !== '' ? { first_name: firstName } : {}),
      ...(rest.length > 0 ? { last_name: rest.join(' ') } : {}),
      ...(input.taxId !== undefined ? { identification: this.#identification(input.taxId) } : {}),
      ...(input.metadata !== undefined ? input.metadata : {}),
    };
    const data = await this.#request<MercadoPagoCustomerResponse>(`/v1/customers/${customerId}`, {
      method: 'PUT',
      body,
    });
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    const currency = input.currency ?? this.#currency;
    const token = input.card?.token ?? input.paymentMethodId;
    const paymentMethodId = this.#paymentMethodId(input, token !== undefined);
    if (input.externalReference !== undefined) {
      this.#assertExternalReference(input.externalReference);
    }
    const body: Record<string, unknown> = {
      transaction_amount: this.#toAmount(input.amount, currency),
      payment_method_id: paymentMethodId,
      payer: this.#payer(input),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.externalReference !== undefined
        ? { external_reference: input.externalReference }
        : {}),
      ...(token !== undefined
        ? {
            token,
            // Mercado Pago rejects a card payment with no `installments` (error 4004);
            // one is the single-payment case, not a guess at the shopper's choice.
            installments: this.#numberOption(input.metadata?.installments) ?? 1,
            ...(typeof input.metadata?.issuerId === 'string'
              ? { issuer_id: input.metadata.issuerId }
              : {}),
          }
        : {}),
      ...(typeof input.metadata?.dateOfExpiration === 'string'
        ? { date_of_expiration: input.metadata.dateOfExpiration }
        : {}),
      ...(typeof input.metadata?.notificationUrl === 'string'
        ? { notification_url: input.metadata.notificationUrl }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const data = await this.#request<MercadoPagoPaymentResponse>('/v1/payments', {
      method: 'POST',
      body,
      // Mercado Pago requires the header on every payment. A key the caller did not give
      // us cannot deduplicate their retry — pass `idempotencyKey` to actually get that.
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    });
    const payment = this.#mapPayment(data, currency);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#request<MercadoPagoPaymentResponse>(`/v1/payments/${gatewayId}`);
      return this.#mapPayment(data, this.#currency);
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
    // No `amount` is a full refund, per Mercado Pago's own wording.
    const body: Record<string, unknown> =
      amount !== undefined ? { amount: this.#toAmount(amount, currency) } : {};
    const data = await this.#request<MercadoPagoRefundResponse>(
      `/v1/payments/${paymentGatewayId}/refunds`,
      {
        method: 'POST',
        body,
        // The header is required here too, so a caller's key finally reaches it. The
        // generated fallback stays for the callers who pass none, and it is deliberately
        // random rather than derived from the payment id: two partial refunds of the same
        // amount are a normal thing to want, and a per-payment key would collapse the
        // second into the first and report a success for a refund never made.
        idempotencyKey: options?.idempotencyKey ?? randomUUID(),
      },
    );
    const refund: Refund = {
      id: String(data.id),
      gatewayId: String(data.id),
      provider: this.provider,
      amount: { amount: this.#fromAmount(data.amount, currency), currency },
      status:
        data.status === 'approved'
          ? 'succeeded'
          : data.status === 'rejected' || data.status === 'cancelled'
            ? 'failed'
            : 'pending',
      createdAt: data.date_created ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  /**
   * Checkout Pro: a hosted preference the payer completes on Mercado Pago, choosing the
   * method there. `back_urls` must be https — Mercado Pago silently discards http ones.
   */
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const currency = input.currency ?? this.#currency;
    const externalReference = input.externalReference;
    if (externalReference !== undefined) this.#assertExternalReference(externalReference);
    const body: Record<string, unknown> = {
      items: [
        {
          title: input.description ?? 'Payment',
          quantity: 1,
          currency_id: currency.toUpperCase(),
          unit_price: this.#toAmount(input.amount, currency),
        },
      ],
      back_urls: {
        success: input.successUrl,
        pending: input.successUrl,
        ...(input.cancelUrl !== undefined ? { failure: input.cancelUrl } : {}),
      },
      auto_return: 'approved',
      ...(externalReference !== undefined ? { external_reference: externalReference } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const data = await this.#request<MercadoPagoPreferenceResponse>('/checkout/preferences', {
      method: 'POST',
      body,
    });
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      // `sandbox_init_point` is documented as "do not use" — test credentials go through
      // `init_point` too.
      url: data.init_point ?? '',
      status: 'open',
      amount: { amount: input.amount, currency },
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  /**
   * A preapproval. With an `amount` the driver creates a subscription with an inline
   * recurrence; without one, `planId` is used as an existing `preapproval_plan_id` and the
   * plan defines the price and the cycle.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createSubscription', 'POST /preapproval');
    const currency = this.#currency;
    if (input.externalReference !== undefined) {
      this.#assertExternalReference(input.externalReference);
    }
    const endDate =
      typeof input.metadata?.endDate === 'string' ? input.metadata.endDate : undefined;
    // Mercado Pago documents that `start_date` is only honoured alongside `end_date`.
    // Sending it alone would start the billing on a date the gateway silently ignores.
    if (input.startDate !== undefined && endDate === undefined) {
      throw new Error(
        '[payments] Mercado Pago ignores a subscription `start_date` unless an end date is ' +
          'sent with it. Pass `metadata.endDate` (ISO) alongside `startDate`, or drop ' +
          '`startDate` and let it start now.',
      );
    }
    const email = input.customer?.email ?? input.card?.holder?.email;
    const body: Record<string, unknown> = {
      ...(input.amount !== undefined
        ? {
            reason: input.description ?? 'Subscription',
            auto_recurring: {
              ...this.#recurrence(input.cycle),
              transaction_amount: this.#toAmount(input.amount, currency),
              currency_id: currency.toUpperCase(),
              ...(input.startDate !== undefined ? { start_date: input.startDate } : {}),
              ...(endDate !== undefined ? { end_date: endDate } : {}),
              ...(input.trialDays !== undefined
                ? { free_trial: { frequency: input.trialDays, frequency_type: 'days' } }
                : {}),
            },
          }
        : { preapproval_plan_id: input.planId }),
      ...(email !== undefined ? { payer_email: email } : {}),
      ...(input.card !== undefined ? { card_token_id: input.card.token } : {}),
      ...(input.externalReference !== undefined
        ? { external_reference: input.externalReference }
        : {}),
      ...(typeof input.metadata?.backUrl === 'string' ? { back_url: input.metadata.backUrl } : {}),
      // `authorized` needs a payment method; without a card the payer authorizes it at the
      // `init_point` and Mercado Pago flips it itself.
      status: input.card !== undefined ? 'authorized' : 'pending',
    };
    if (input.amount !== undefined && body.back_url === undefined) {
      throw new Error(
        '[payments] Mercado Pago requires `back_url` on a subscription created without a ' +
          'plan — pass `metadata.backUrl`, or create a preapproval plan and pass its id as ' +
          '`planId` with no `amount`.',
      );
    }
    const data = await this.#request<MercadoPagoPreapprovalResponse>('/preapproval', {
      method: 'POST',
      body,
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
        '[payments] Mercado Pago cancels a preapproval immediately and irreversibly — there ' +
          'is no cancel-at-period-end flag. Pause it instead (`status: "paused"`) and cancel ' +
          'when the period ends, or keep the grace period on your own records.',
      );
    }
    const data = await this.#request<MercadoPagoPreapprovalResponse>(
      `/preapproval/${subscriptionGatewayId}`,
      // Preapproval spells it `canceled` with one L, unlike a payment's `cancelled`.
      { method: 'PUT', body: { status: 'canceled' } },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'updateSubscription', 'PUT /preapproval/{id}');
    const currency = this.#currency;
    const body: Record<string, unknown> = {
      ...(input.amount !== undefined
        ? {
            auto_recurring: {
              transaction_amount: this.#toAmount(input.amount, currency),
              currency_id: currency.toUpperCase(),
            },
          }
        : {}),
      // `reason` is the subscription's own description, the one the payer sees.
      ...(input.description !== undefined ? { reason: input.description } : {}),
    };
    const data = await this.#request<MercadoPagoPreapprovalResponse>(
      `/preapproval/${subscriptionGatewayId}`,
      { method: 'PUT', body },
    );
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<MercadoPagoPreapprovalResponse>(`/preapproval/${gatewayId}`);
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    throw new Error(
      '[payments] Mercado Pago has no invoices for a customer. `GET /authorized_payments/' +
        'search` lists the charges of a *subscription* and filters by `payer_id`, which is a ' +
        'Mercado Pago user id, not the `/v1/customers` id. Use `findPayment`, or an invoice ' +
        'provider with `invoice: true`.',
    );
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Verify the `x-signature` HMAC, then fetch the resource the notification names.
   *
   * A Mercado Pago notification is an id and nothing more — no amount, no status, no
   * `external_reference` — so the fetch is not an optimization to skip: without it this
   * could only ever return `payment.updated`, and a payment that settled would be
   * ledgered and never marked paid. It costs one API call per notification, which is
   * Mercado Pago's design rather than an inefficiency of this driver.
   *
   * A failed fetch throws, so the mounted route answers 400 and Mercado Pago retries.
   * Reporting a status the gateway did not confirm would be worse than a retry.
   */
  async parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent> {
    const payload = this.#verified(rawBody, headers);
    const type = payload.type ?? '';
    const resourceId = payload.data?.id === undefined ? '' : String(payload.data.id);
    const event: WebhookEvent = {
      id: payload.id !== undefined ? String(payload.id) : `${payload.action ?? type}-${resourceId}`,
      provider: this.provider,
      type: this.#mapWebhookType(type),
      createdAt: payload.date_created ?? new Date().toISOString(),
      data: { gatewayId: resourceId },
      raw: payload as unknown as Record<string, unknown>,
    };
    if (resourceId === '') return event;

    if (type === 'payment') {
      return this.#paymentEvent(event, resourceId);
    }
    // A chargeback case: opened, or its status changed. Mercado Pago sends one action for
    // both (`actions: ["changed_case_status"]`), so the notification itself cannot say
    // whether this is the opening — the payment can, and it is the payment this library
    // has a row for. `data.id` here is the CASE id (`GET /v1/chargebacks/{id}`), so the
    // payment is read from `data.payment_id`; without it there is no payment to dispute
    // and the event stays the `payment.updated` above rather than filing one under a case
    // id that matches nothing.
    if (type === 'topic_chargebacks_wh') {
      const paymentId = payload.data?.payment_id;
      if (paymentId === undefined) return event;
      return this.#paymentEvent(event, String(paymentId));
    }
    if (type === 'subscription_preapproval') {
      const preapproval = await this.#request<MercadoPagoPreapprovalResponse>(
        `/preapproval/${resourceId}`,
      );
      const subscription = this.#mapSubscription(preapproval);
      return {
        ...event,
        type: preapproval.status === 'canceled' ? 'subscription.canceled' : 'subscription.updated',
        data: {
          gatewayId: subscription.gatewayId,
          customerId: subscription.customerId,
          status: subscription.status,
          planId: subscription.planId,
          ...(preapproval.external_reference !== undefined
            ? { externalReference: preapproval.external_reference }
            : {}),
        },
      };
    }
    // `subscription_authorized_payment` (a subscription's recurring charge) is left as
    // `payment.updated` with its id: it is read from `/authorized_payments/{id}`, whose
    // response shape this driver has not verified against the reference. Guessing the
    // field names of a settled charge is exactly the mistake that ships wrong money.
    return event;
  }

  /**
   * Fetch a payment and turn it into the webhook event for whatever happened to it.
   *
   * Shared by the `payment` topic (where the notification names the payment) and the
   * chargeback topic (where it names the case and the payment separately), so a dispute
   * is normalized through exactly the same status mapping as everything else.
   */
  async #paymentEvent(event: WebhookEvent, paymentId: string): Promise<WebhookEvent> {
    const payment = await this.#request<MercadoPagoPaymentResponse>(`/v1/payments/${paymentId}`);
    const currency = payment.currency_id?.toLowerCase() ?? this.#currency;
    return {
      ...event,
      type: this.#paymentEventType(payment.status),
      data: {
        gatewayId: String(payment.id),
        amount: this.#fromAmount(payment.transaction_amount, currency),
        currency,
        ...(payment.payer?.id !== undefined ? { customerId: String(payment.payer.id) } : {}),
        ...(payment.external_reference !== undefined
          ? { externalReference: payment.external_reference }
          : {}),
      },
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  /**
   * Check the `x-signature` HMAC and return the parsed notification.
   *
   * The manifest Mercado Pago signs is `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`,
   * with any absent part left out. The `id` in it is the `data.id` **query parameter**,
   * which `parseWebhook` never sees — the driver contract passes the body and the headers
   * and nothing else — so the same id is read from the body, where Mercado Pago puts it
   * too. The docs say to lowercase an alphanumeric id while the official SDK hashes
   * whatever it is handed, so both spellings are accepted.
   */
  #verified(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): MercadoPagoNotification {
    const payload = JSON.parse(rawBody) as MercadoPagoNotification;
    if (this.#webhookSecret === undefined) return payload;

    const header = headerValue(headers, 'x-signature');
    if (header === undefined || header === '') {
      throw new Error('[payments] Missing `x-signature` header on Mercado Pago webhook request.');
    }
    let timestamp: string | undefined;
    let received: string | undefined;
    for (const part of header.split(',')) {
      const separator = part.indexOf('=');
      if (separator === -1) continue;
      const key = part.slice(0, separator).trim().toLowerCase();
      const value = part.slice(separator + 1).trim();
      if (key === 'ts') timestamp = value;
      else if (key === 'v1') received = value;
    }
    if (timestamp === undefined || received === undefined) {
      throw new Error('[payments] Malformed `x-signature` header on Mercado Pago webhook.');
    }

    const requestId = headerValue(headers, 'x-request-id');
    const dataId = payload.data?.id === undefined ? undefined : String(payload.data.id);
    const candidates =
      dataId !== undefined && dataId !== dataId.toLowerCase()
        ? [dataId.toLowerCase(), dataId]
        : [dataId];
    const matched = candidates.some((candidate) =>
      safeCompare(received, this.#signature(candidate, requestId, timestamp)),
    );
    if (!matched) {
      throw new Error('[payments] Invalid Mercado Pago webhook signature.');
    }
    return payload;
  }

  #signature(dataId: string | undefined, requestId: string | undefined, timestamp: string): string {
    const parts: string[] = [];
    if (dataId !== undefined && dataId !== '') parts.push(`id:${dataId}`);
    if (requestId !== undefined && requestId !== '') parts.push(`request-id:${requestId}`);
    parts.push(`ts:${timestamp}`);
    return createHmac('sha256', this.#webhookSecret ?? '')
      .update(`${parts.join(';')};`)
      .digest('hex');
  }

  #mapWebhookType(type: string): string {
    switch (type) {
      // Both carry a payment id and neither says what happened to it.
      case 'payment':
      case 'subscription_authorized_payment':
        return 'payment.updated';
      case 'subscription_preapproval':
        return 'subscription.updated';
      // Deliberately not `payment.disputed`: the notification carries the chargeback case
      // id, not the payment id, and the only honest dispute event is the one built after
      // the payment named by `data.payment_id` has been fetched. This is what the topic
      // degrades to when that id is missing.
      case 'topic_chargebacks_wh':
        return 'payment.updated';
      default:
        return type === '' ? 'unknown' : type.toLowerCase();
    }
  }

  #paymentEventType(status: string | undefined): string {
    switch (status) {
      case 'approved':
        return 'payment.succeeded';
      case 'rejected':
      case 'cancelled':
        return 'payment.failed';
      case 'refunded':
        return 'payment.refunded';
      // Both are the payment being disputed, and `charged_back` used to arrive as
      // `payment.refunded` — which says the seller gave the money back voluntarily and
      // leaves nothing to distinguish a refund from revenue taken away by the issuer.
      // `in_mediation` is a claim opened inside Mercado Pago; `charged_back` is the card
      // chargeback. How it ENDS is `status_detail` — `settled` (lost) or `reimbursed`
      // (won) — which stays on `payment.payload`: the contract has no resolution event,
      // by design, because no two gateways report one the same way.
      case 'in_mediation':
      case 'charged_back':
        return 'payment.disputed';
      default:
        return 'payment.updated';
    }
  }

  #mapCustomer(data: MercadoPagoCustomerResponse): Customer {
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
    return {
      id: String(data.id),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(name !== '' ? { name } : {}),
      ...(data.identification?.number !== undefined ? { taxId: data.identification.number } : {}),
    };
  }

  #mapPayment(data: MercadoPagoPaymentResponse, fallbackCurrency: string): Payment {
    const statusMap: Record<string, Payment['status']> = {
      approved: 'paid',
      // The card was held (`status_detail: pending_capture`) and nothing was captured —
      // the money has NOT moved. It used to collapse into `pending`, which understates a
      // hold the issuer already granted; `paid` would have granted access against money
      // that can still evaporate when the authorization expires uncaptured.
      authorized: 'authorized',
      pending: 'pending',
      in_process: 'pending',
      in_mediation: 'disputed',
      rejected: 'failed',
      cancelled: 'canceled',
      refunded: 'refunded',
      charged_back: 'disputed',
    };
    const currency = data.currency_id?.toLowerCase() ?? fallbackCurrency;
    const method = this.#mapMethodToType(data.payment_method_id, data.payment_type_id);
    const result: Payment = {
      id: String(data.id),
      gatewayId: String(data.id),
      provider: this.provider,
      amount: { amount: this.#fromAmount(data.transaction_amount, currency), currency },
      status: statusMap[data.status ?? ''] ?? 'pending',
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.date_created ?? new Date().toISOString(),
    };
    if (method !== 'unknown') result.method = method;
    if (data.payer?.id !== undefined) result.customerId = String(data.payer.id);
    if (data.date_approved !== undefined) result.paidAt = data.date_approved;
    const pix = data.point_of_interaction?.transaction_data;
    if (pix?.qr_code !== undefined) {
      result.pixCode = pix.qr_code;
      result.pixCopiaECola = pix.qr_code;
    }
    if (pix?.qr_code_base64 !== undefined) {
      result.pixQrCodeImage = pix.qr_code_base64;
      result.pixQrCode = pix.qr_code_base64;
    }
    const hostedUrl = pix?.ticket_url ?? data.transaction_details?.external_resource_url;
    if (hostedUrl !== undefined) result.hostedUrl = hostedUrl;
    return result;
  }

  #mapSubscription(data: MercadoPagoPreapprovalResponse): Subscription {
    const statusMap: Record<string, SubscriptionStatus> = {
      authorized: 'active',
      // The payer has not authorized it yet — nothing has been charged.
      pending: 'incomplete',
      // Billing has stopped and the preapproval is still alive — it can be resumed, and
      // it must not entitle the payer meanwhile. It used to map to `past_due`, which says
      // a charge failed; nothing failed here, Mercado Pago was told to stop.
      paused: 'paused',
      canceled: 'canceled',
    };
    const currency = data.auto_recurring?.currency_id?.toLowerCase() ?? this.#currency;
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.payer_id === undefined ? '' : String(data.payer_id),
      status: statusMap[data.status ?? ''] ?? 'incomplete',
      planId: data.preapproval_plan_id ?? data.reason ?? '',
      ...(data.auto_recurring?.transaction_amount !== undefined
        ? {
            amount: {
              amount: this.#fromAmount(data.auto_recurring.transaction_amount, currency),
              currency,
            },
          }
        : {}),
      ...(data.auto_recurring?.start_date !== undefined
        ? { currentPeriodStart: data.auto_recurring.start_date }
        : {}),
      ...(data.next_payment_date !== undefined ? { currentPeriodEnd: data.next_payment_date } : {}),
      ...(data.auto_recurring?.end_date !== undefined
        ? { endsAt: data.auto_recurring.end_date }
        : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.date_created ?? new Date().toISOString(),
    };
  }

  /** `WEEKLY` and friends onto the only two frequency types Mercado Pago accepts. */
  #recurrence(cycle: CreateSubscriptionInput['cycle']): {
    frequency: number;
    frequency_type: string;
  } {
    switch (cycle) {
      case 'WEEKLY':
        return { frequency: 7, frequency_type: 'days' };
      case 'BIWEEKLY':
        return { frequency: 14, frequency_type: 'days' };
      case 'QUARTERLY':
        return { frequency: 3, frequency_type: 'months' };
      case 'SEMIANNUALLY':
        return { frequency: 6, frequency_type: 'months' };
      case 'YEARLY':
        return { frequency: 12, frequency_type: 'months' };
      default:
        return { frequency: 1, frequency_type: 'months' };
    }
  }

  /**
   * The `payment_method_id` for this charge. Pix and boleto have fixed ids; a card is
   * identified by its brand (`visa`, `master`, `debvisa`…), which the tokenizer in the
   * frontend returns alongside the token and only the caller can know.
   */
  #paymentMethodId(input: ChargeInput, hasToken: boolean): string {
    if (typeof input.metadata?.paymentMethodId === 'string') return input.metadata.paymentMethodId;
    switch (input.method) {
      case 'pix':
        return 'pix';
      case 'boleto':
        return 'bolbradesco';
      case 'credit_card':
      case 'debit_card':
        throw new Error(
          '[payments] Mercado Pago identifies a card payment by its brand, not by "card". ' +
            'Pass the `payment_method_id` the card tokenizer returned (e.g. "visa", "master", ' +
            '"debvisa") as `metadata.paymentMethodId`.',
        );
      default:
        throw new Error(
          hasToken
            ? '[payments] Mercado Pago needs the card brand for a tokenized charge — pass it ' +
                'as `metadata.paymentMethodId` (e.g. "visa").'
            : '[payments] Mercado Pago requires a payment method on every charge. Pass ' +
                '`method: "pix"` or `"boleto"`, or use `createCheckout()` to let the payer ' +
                'choose on Checkout Pro.',
        );
    }
  }

  #payer(input: ChargeInput): Record<string, unknown> {
    const holder = input.card?.holder;
    const email = input.customer?.email ?? holder?.email;
    const name = input.customer?.name ?? holder?.name;
    const taxId = input.customer?.taxId ?? holder?.cpfCnpj;
    const [firstName, ...rest] = (name ?? '').split(' ');
    return {
      ...(input.customerId !== undefined ? { id: input.customerId, type: 'customer' } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(firstName !== undefined && firstName !== '' ? { first_name: firstName } : {}),
      ...(rest.length > 0 ? { last_name: rest.join(' ') } : {}),
      ...(taxId !== undefined ? { identification: this.#identification(taxId) } : {}),
      // The reference documents the payer address under `additional_info.payer.address`
      // while the Pix and boleto guides nest it here; boleto rejects a payment without it.
      // The guides are the ones with working end-to-end examples.
      ...(typeof input.metadata?.address === 'object' && input.metadata.address !== null
        ? { address: input.metadata.address }
        : {}),
    };
  }

  /**
   * A tax id and its Mercado Pago `identification.type`. Only Brazil's CPF/CNPJ can be
   * told apart by length; every other country has its own document types, so those must
   * be passed explicitly.
   */
  #identification(taxId: string): { type: string; number: string } {
    const digits = taxId.replace(/\D/g, '');
    return { type: digits.length > 11 ? 'CNPJ' : 'CPF', number: digits };
  }

  #assertExternalReference(value: string): void {
    if (!EXTERNAL_REFERENCE_PATTERN.test(value)) {
      throw new Error(
        `[payments] Mercado Pago rejects the externalReference "${value}". It allows at most ` +
          `64 characters — letters, numbers, hyphens and underscores — and got ${value.length}.`,
      );
    }
  }

  #mapMethodToType(
    paymentMethodId: string | undefined,
    paymentTypeId: string | undefined,
  ): NonNullable<Payment['method']> {
    if (paymentMethodId?.toLowerCase() === 'pix') return 'pix';
    switch (paymentTypeId) {
      case 'credit_card':
      case 'prepaid_card':
        return 'card';
      case 'debit_card':
        return 'debit_card';
      case 'ticket':
        return 'boleto';
      default:
        return 'unknown';
    }
  }

  /**
   * `X-Idempotency-Key` is documented — and mandatory — on `POST /v1/payments` and
   * `POST /v1/payments/{id}/refunds`, and on nothing else: the reference for
   * `/v1/customers` and `/preapproval` lists `Authorization` and no more. Sending it
   * there anyway would be harmless and unspecified, which is the worst combination — the
   * caller would believe their retry is safe. So those operations refuse it.
   */
  #refuseIdempotencyKey(key: string | undefined, operation: string, endpoint: string): void {
    if (key === undefined) return;
    throw new Error(
      `[payments] Mercado Pago documents \`X-Idempotency-Key\` only for payments and refunds, so \`${operation}\` cannot honour an idempotencyKey — its \`${endpoint}\` reference documents no such header. \`charge()\` and \`refund()\` do honour it; for the rest, deduplicate before you call (a preapproval can be looked up by \`external_reference\`).`,
    );
  }

  #numberOption(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
  }

  // ── Money ────────────────────────────────────────────────────────────────────────────

  /**
   * Minor units → the decimal `transaction_amount` Mercado Pago wants (a JSON number, not
   * a string). The currency has to travel with it: CLP has no cents, so dividing a
   * Chilean amount by 100 bills 1% of it — and Mercado Pago accepts that happily.
   *
   * COP is not a special case here: ISO 4217 gives it two minor units even though
   * Colombian prices are quoted in whole pesos. Check a COP charge in sandbox.
   */
  #toAmount(amount: Money, currency: string): number {
    return toDecimal(amount, currency);
  }

  /** Mercado Pago's decimal amount → minor units. It sometimes quotes them as strings. */
  #fromAmount(value: number | string | undefined, currency: string): Money {
    const parsed = typeof value === 'string' ? Number(value) : (value ?? 0);
    if (Number.isNaN(parsed)) return 0;
    return fromDecimal(parsed, currency);
  }

  // ── Transport ────────────────────────────────────────────────────────────────────────

  async #request<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      bearerToken: this.#accessToken,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      // Mercado Pago's idempotency key is a header — written into the body it would
      // deduplicate nothing.
      ...(options.idempotencyKey !== undefined
        ? { headers: { 'X-Idempotency-Key': options.idempotencyKey } }
        : {}),
    });
  }
}
