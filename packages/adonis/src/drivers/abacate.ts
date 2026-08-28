import { createHash } from 'node:crypto';
import type { AbacateDriverConfig } from '../define_config.js';
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

interface AbacateCustomerResponse {
  id: string;
  name?: string;
  email?: string;
  taxId?: string;
}

interface AbacateBillingResponse {
  id: string;
  status: string;
  amount?: number;
  currency?: string;
  methods?: string[];
  customer?: AbacateCustomerResponse;
  createdAt?: string;
  paidAt?: string;
  url?: string;
  pix?: { qrCode?: string; copiaECola?: string };
}

interface AbacateSubscriptionResponse {
  id: string;
  status: string;
  amount?: number;
  frequency?: string;
  customer?: AbacateCustomerResponse;
  createdAt?: string;
  nextBillingAt?: string;
}

/** The `POST /v2/transparents/create` response — inline PIX/Boleto, no redirect. */
interface AbacateTransparentResponse {
  id: string;
  /** PIX: QR code image (base64 PNG). */
  brCodeBase64?: string;
  /** PIX copy-and-paste code (also the Boleto's alternative PIX). */
  brCode?: string;
  /** Boleto: bar code (linha digitável). */
  barCode?: string;
  /** Boleto: URL to view/print the PDF. */
  url?: string;
  expiresAt?: string;
}

/**
 * AbacatePay driver — Brazilian gateway for Pix and card payments with a developer-first
 * API (REST v2, `https://api.abacatepay.com/v2`). Uses `fetch` directly (no SDK
 * dependency). Webhooks are validated with an HMAC-SHA256 signature using the public key.
 */
export class AbacateDriver implements PaymentsDriver {
  readonly provider = 'abacate';
  // AbacatePay is Pix-first — no credit card.
  readonly supportedMethods = ['pix', 'boleto', 'undefined'] as const;
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true };

  #baseUrl: string;
  #publicKey: string | undefined;
  #invoiceCtx: EmitInvoiceContext;
  #bearerToken: string;

  constructor(ctx: EmitInvoiceContext, config: AbacateDriverConfig = {}) {
    this.#invoiceCtx = ctx;
    const apiKey = config.apiKey ?? process.env.ABACATE_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[payments] AbacatePay driver requires an API key. Set `ABACATE_API_KEY` env or pass `apiKey` to `payments.abacate()`.',
      );
    }
    this.#baseUrl = 'https://api.abacatepay.com/v2';
    // `webhookSecret` is the Agora-convention alias for AbacatePay's dashboard
    // "public key" (the HMAC secret used to sign webhooks).
    this.#publicKey = config.webhookSecret ?? config.publicKey ?? process.env.ABACATE_PUBLIC_KEY;
    this.#bearerToken = apiKey;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCustomer');
    const data = await this.#request<AbacateCustomerResponse>('/customer/create', {
      method: 'POST',
      body: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
      },
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<AbacateCustomerResponse>(`/customer/get/${customerId}`);
      return this.#mapCustomer(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const data = await this.#request<AbacateCustomerResponse>(`/customer/update/${customerId}`, {
      method: 'PATCH',
      body: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
      },
    });
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    if (!input.customerId) {
      throw new Error('[payments] AbacatePay requires a customer for every charge.');
    }
    // Transparent checkout (`POST /v2/transparents/create`): PIX/Boleto inline, no
    // redirect — the response carries the QR/barcode directly. Needs the payer's
    // name + taxId, resolved from the charge's fiscal `customer` or the gateway customer.
    const method = input.method ?? 'pix';
    const customer = await this.#resolveTransparentCustomer(input);
    const data = await this.#request<AbacateTransparentResponse>('/v2/transparents/create', {
      method: 'POST',
      body: {
        method: this.#mapMethod(method),
        data: {
          amount: input.amount,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.externalReference !== undefined ? { externalId: input.externalReference } : {}),
          ...(input.externalReference === undefined && input.idempotencyKey !== undefined
            ? { externalId: input.idempotencyKey }
            : {}),
          customer,
        },
      },
    });
    const payment = this.#mapTransparentPayment(data, input);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  /** The transparent checkout needs `{ name, taxId }` — from `input.customer` or the gateway customer. */
  async #resolveTransparentCustomer(
    input: ChargeInput,
  ): Promise<{ name: string; taxId: string; email?: string }> {
    if (input.customer?.name && input.customer.taxId) {
      return {
        name: input.customer.name,
        taxId: input.customer.taxId,
        ...(input.customer.email !== undefined ? { email: input.customer.email } : {}),
      };
    }
    const customer = await this.findCustomer(input.customerId!);
    if (!customer?.name || !customer.taxId) {
      throw new Error(
        '[payments] AbacatePay transparent checkout needs the payer name + taxId — pass `customer` on the charge, or create the gateway customer with them.',
      );
    }
    return {
      name: customer.name,
      taxId: customer.taxId,
      ...(customer.email !== undefined ? { email: customer.email } : {}),
    };
  }

  #mapTransparentPayment(data: AbacateTransparentResponse, input: ChargeInput): Payment {
    const method = input.method === 'boleto' ? 'boleto' : 'pix';
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: input.amount, currency: 'brl' },
      status: 'pending',
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      method,
      createdAt: new Date().toISOString(),
      payload: data as unknown as Record<string, unknown>,
    };
    if (data.brCodeBase64) {
      result.pixQrCodeImage = data.brCodeBase64;
      result.pixQrCode = data.brCodeBase64;
    }
    if (data.brCode) {
      result.pixCode = data.brCode;
      result.pixCopiaECola = data.brCode;
    }
    if (data.url) result.hostedUrl = data.url;
    return result;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#request<AbacateBillingResponse>(`/billing/get/${gatewayId}`);
      return this.#mapPayment(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async refund(
    paymentGatewayId: string,
    _amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    this.#refuseIdempotencyKey(options?.idempotencyKey, 'refund');
    const data = await this.#request<AbacateBillingResponse>(
      `/billing/refund/${paymentGatewayId}`,
      {
        method: 'POST',
        body: {},
      },
    );
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: {
        amount: data.amount !== undefined ? Math.round(data.amount) : 0,
        currency: data.currency ?? 'brl',
      },
      status: 'succeeded',
      createdAt: data.createdAt ?? new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (!input.customerId) {
      throw new Error('[payments] AbacatePay requires a customer for checkout.');
    }
    const data = await this.#request<AbacateBillingResponse>('/billing/create', {
      method: 'POST',
      body: {
        customerId: input.customerId,
        // Centavos, straight through. AbacatePay documents it outright — "valores
        // monetários são sempre em centavos (ex.: 10000 = R$ 100,00)" — which is the same
        // integer minor unit this package uses, so there is nothing to convert.
        //
        // This ran `toDecimal` and created a checkout for **1/100 of the amount**: R$19,90
        // went out as `19.9` and AbacatePay read 19 centavos. `charge()` on the neighbouring
        // v2 endpoint always passed the integer through, so the driver disagreed with itself
        // and the two paths were never compared.
        amount: input.amount,
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      url: data.url ?? '',
      status: 'open',
      amount: {
        amount: data.amount !== undefined ? Math.round(data.amount) : input.amount,
        currency: data.currency ?? 'brl',
      },
      customerId: input.customerId,
      ...(data.pix?.copiaECola !== undefined
        ? { pixCode: data.pix.copiaECola, pixCopiaECola: data.pix.copiaECola }
        : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createSubscription');
    const data = await this.#request<AbacateSubscriptionResponse>('/subscription/create', {
      method: 'POST',
      body: {
        customerId: input.customerId,
        // Centavos — see the note in `createCheckout`.
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        frequency: input.cycle ?? 'MONTHLY',
        ...(input.startDate !== undefined ? { nextBillingAt: input.startDate } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    const subscription = this.#mapSubscription(data, input.customerId);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const data = await this.#request<AbacateSubscriptionResponse>(
      `/subscription/cancel/${subscriptionGatewayId}`,
      { method: 'POST', body: {} },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<AbacateSubscriptionResponse>(
        `/subscription/get/${gatewayId}`,
      );
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'updateSubscription');
    const data = await this.#request<AbacateSubscriptionResponse>(
      `/subscription/update/${subscriptionGatewayId}`,
      {
        method: 'PATCH',
        body: {
          // Centavos — see the note in `createCheckout`.
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      },
    );
    return this.#mapSubscription(data);
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(customerId: string): Promise<Invoice[]> {
    const data = await this.#request<{ billings: AbacateBillingResponse[] }>(
      `/billing/list?customerId=${encodeURIComponent(customerId)}`,
    );
    return (data.billings ?? []).map((billing) => ({
      id: billing.id,
      gatewayId: billing.id,
      provider: this.provider,
      customerId,
      status: billing.status === 'PAID' ? 'paid' : billing.status === 'CANCELED' ? 'void' : 'open',
      amount: {
        amount: billing.amount !== undefined ? Math.round(billing.amount) : 0,
        currency: billing.currency ?? 'brl',
      },
      createdAt: billing.createdAt ?? new Date().toISOString(),
      ...(billing.url !== undefined ? { hostedPdfUrl: billing.url } : {}),
      payload: billing as unknown as Record<string, unknown>,
    }));
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    // AbacatePay signs the raw body with HMAC-SHA256 (base64) in `x-webhook-signature`,
    // keyed by the public key from the dashboard. Strict when a key is configured.
    if (this.#publicKey !== undefined) {
      const signature = headerValue(headers, 'x-webhook-signature');
      if (!verifyHmacSignature(rawBody, signature, this.#publicKey, 'sha256')) {
        throw new Error('[payments] Invalid or missing AbacatePay webhook signature.');
      }
    }
    const payload = JSON.parse(rawBody) as {
      id?: string;
      event?: string;
      data?: Record<string, unknown>;
    };
    const event = payload.event ?? 'unknown';
    return {
      // A CONTENT hash, never a random id. A payload with no id used to get a fresh
      // `Math.random()` on every delivery, so the ledger saw each redelivery as a new
      // event and processed it again — the exact double-grant the ledger exists to stop.
      id:
        payload.id ??
        `${event}-${createHash('sha256').update(rawBody, 'utf8').digest('hex').slice(0, 32)}`,
      provider: this.provider,
      type: this.#mapWebhookType(event),
      createdAt: new Date().toISOString(),
      data: this.#mapWebhookData(payload.data),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  /**
   * The normalized shape the built-in sync needs (`gatewayId`, `amount`, `currency`).
   *
   * This used to hand the processor AbacatePay's raw `data`, which its shape guard
   * rejected — so every AbacatePay webhook was ledgered, threw `Malformed`, and was retried
   * forever while the billing tables never learned the payment was paid. `raw` still
   * carries the original.
   */
  #mapWebhookData(data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (data === undefined) return {};
    const billing = (data.billing ?? data) as AbacateBillingResponse;
    if (billing?.id === undefined) return data;
    const payment = this.#mapPayment(billing);
    return {
      gatewayId: payment.gatewayId,
      amount: payment.amount.amount,
      currency: payment.amount.currency,
      ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
      ...(typeof (billing as unknown as { externalId?: unknown }).externalId === 'string'
        ? { externalReference: (billing as unknown as { externalId: string }).externalId }
        : {}),
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: AbacateCustomerResponse): Customer {
    return {
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.taxId !== undefined ? { taxId: data.taxId } : {}),
    };
  }

  #mapPayment(data: AbacateBillingResponse, fallbackCustomerId?: string): Payment {
    const customerId = data.customer?.id ?? fallbackCustomerId;
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: {
        amount: data.amount !== undefined ? Math.round(data.amount) : 0,
        currency: data.currency ?? 'brl',
      },
      status:
        data.status === 'PAID' || data.status === 'COMPLETED'
          ? 'paid'
          : data.status === 'REFUNDED'
            ? 'refunded'
            : data.status === 'CANCELED'
              ? 'canceled'
              : 'pending',
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.createdAt ?? new Date().toISOString(),
    };
    if (customerId !== undefined) result.customerId = customerId;
    if (data.pix?.qrCode !== undefined) {
      result.pixQrCodeImage = data.pix.qrCode;
      result.pixQrCode = data.pix.qrCode;
    }
    if (data.pix?.copiaECola !== undefined) {
      result.pixCode = data.pix.copiaECola;
      result.pixCopiaECola = data.pix.copiaECola;
    }
    if (data.url !== undefined) result.hostedUrl = data.url;
    if (data.paidAt !== undefined) result.paidAt = data.paidAt;
    return result;
  }

  #mapSubscription(data: AbacateSubscriptionResponse, fallbackCustomerId?: string): Subscription {
    const statusMap: Record<string, Subscription['status']> = {
      ACTIVE: 'active',
      COMPLETED: 'active',
      CANCELLED: 'canceled',
      EXPIRED: 'ended',
    };
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customer?.id ?? fallbackCustomerId ?? '',
      status: statusMap[data.status] ?? 'active',
      planId: data.frequency ?? '',
      amount: {
        amount: data.amount !== undefined ? Math.round(data.amount) : 0,
        currency: 'brl',
      },
      ...(data.nextBillingAt !== undefined ? { endsAt: data.nextBillingAt } : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.createdAt ?? new Date().toISOString(),
    };
  }

  #mapWebhookType(event: string): string {
    switch (event) {
      case 'checkout.completed':
      case 'transparent.completed':
        return 'payment.succeeded';
      case 'checkout.refunded':
      case 'transparent.refunded':
        return 'payment.refunded';
      // "Disputa/chargeback aberta em um checkout" / "…em um pagamento transparente" — the
      // dispute is OPENED here. It used to arrive as `payment.failed`, which files a
      // chargeback as a payment that never went through: the row stopped saying `paid`, but
      // it said the wrong thing, and the customer whose access has to be reconsidered was
      // never flagged.
      //
      // These two are AbacatePay's ENTIRE dispute vocabulary. Its published webhook event
      // list has no fraud alert, no retrieval request, no "chargeback incoming" — so there
      // is no `payment.dispute_warning` to map — and no won/lost/reversed event either, so
      // no `payment.dispute_closed`: the outcome never reaches you as a webhook at all.
      //
      // AbacatePay also does not say whether the funds are withdrawn when this fires, and
      // publishes no payload example for it and no response deadline anywhere. The mapping
      // therefore stays where it is rather than being demoted to a warning on a guess: a
      // filed dispute is what `payment.disputed` names. See the provider docs page.
      case 'checkout.disputed':
      case 'transparent.disputed':
        return 'payment.disputed';
      case 'subscription.completed':
        return 'subscription.created';
      case 'subscription.renewed':
        return 'subscription.updated';
      case 'subscription.cancelled':
        return 'subscription.canceled';
      default:
        return event;
    }
  }

  /**
   * AbacatePay documents no idempotency mechanism — the only request header on any
   * endpoint is `Authorization`, and its own guidance mentions idempotency solely for
   * consuming webhooks (dedupe on the event `id`). Accepting the key and dropping it
   * would turn a caller's retry guarantee into a second refund or a second subscription,
   * so the driver refuses it instead.
   *
   * `charge()` is not an exception to this: there `idempotencyKey` has never meant
   * deduplication, it is a legacy fallback for `externalReference` (sent as the
   * transparent checkout's `externalId`) and is documented as such.
   */
  #refuseIdempotencyKey(key: string | undefined, operation: string): void {
    if (key === undefined) return;
    throw new Error(
      `[payments] AbacatePay has no idempotency mechanism, so \`${operation}\` cannot honour an idempotencyKey — no AbacatePay endpoint documents an idempotency header or field. Deduplicate before you call.`,
    );
  }

  #mapMethod(method: string): string {
    switch (method) {
      case 'pix':
        return 'PIX';
      case 'credit_card':
        return 'CARD';
      case 'boleto':
        return 'BOLETO';
      default:
        return 'PIX';
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
