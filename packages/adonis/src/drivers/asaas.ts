import type { AsaasDriverConfig } from '../define_config.js';
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
  WebhookEvent,
} from '../types.js';
import { requireMatchingCredential } from '../webhook_security.js';

interface AsaasCustomerResponse {
  id: string;
  name?: string;
  email?: string;
  cpfCnpj?: string;
  externalReference?: string;
}

interface AsaasPaymentResponse {
  id: string;
  customer: string;
  value: number;
  billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD' | 'UNDEFINED';
  status:
    | 'PENDING'
    | 'RECEIVED'
    | 'CONFIRMED'
    | 'OVERDUE'
    | 'REFUNDED'
    | 'CANCELED'
    | 'FAILED'
    | 'PROCESSING';
  dueDate: string;
  description?: string;
  invoiceUrl?: string;
  pixQrCode?: string;
  pixCopiaECola?: string;
  subscription?: string;
  paymentDate?: string;
  externalReference?: string;
}

interface AsaasSubscriptionResponse {
  id: string;
  customer: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELED' | 'PENDING' | 'SUSPENDED';
  billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD' | 'UNDEFINED';
  value: number;
  cycle: string;
  nextDueDate: string;
  endDate?: string;
  description?: string;
}

interface AsaasWebhookPayload {
  event: string;
  payment?: AsaasPaymentResponse;
  subscription?: AsaasSubscriptionResponse;
}

/**
 * Asaas driver — Brazilian gateway (Pix, boleto, card) with native subscription billing.
 * Uses the REST API directly via `fetch` (no SDK dependency). The Asaas API key is sent
 * as a plain header; webhooks are validated by a configured token.
 */
export class AsaasDriver implements PaymentsDriver {
  readonly provider = 'asaas';
  readonly supportedMethods = ['pix', 'boleto', 'credit_card', 'debit_card', 'undefined'] as const;
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true };

  #baseUrl: string;
  #webhookToken: string | undefined;
  #invoiceCtx: EmitInvoiceContext;
  #authHeader: { name: string; value: string };

  constructor(ctx: EmitInvoiceContext, config: AsaasDriverConfig = {}) {
    this.#invoiceCtx = ctx;
    const apiKey = config.apiKey ?? process.env.ASAAS_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[payments] Asaas driver requires an API key. Set `ASAAS_API_KEY` env or pass `apiKey` to `payments.asaas()`.',
      );
    }
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';
    // Accepts both the Agora convention (`ASAAS_WEBHOOK_TOKEN`) and the Asaas-docs name
    // the ecosystem apps use (`ASAAS_WEBHOOK_ACCESS_TOKEN`).
    this.#webhookToken =
      config.webhookToken ??
      process.env.ASAAS_WEBHOOK_ACCESS_TOKEN ??
      process.env.ASAAS_WEBHOOK_TOKEN;
    this.#authHeader = { name: 'access_token', value: apiKey };
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const body: Record<string, unknown> = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.taxId !== undefined ? { cpfCnpj: input.taxId.replace(/\D/g, '') } : {}),
      ...(input.metadata !== undefined
        ? { externalReference: JSON.stringify(input.metadata) }
        : {}),
    };
    const data = await this.#request<AsaasCustomerResponse>('/customers', { method: 'POST', body });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#request<AsaasCustomerResponse>(`/customers/${customerId}`);
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
      ...(input.taxId !== undefined ? { cpfCnpj: input.taxId.replace(/\D/g, '') } : {}),
    };
    const data = await this.#request<AsaasCustomerResponse>(`/customers/${customerId}`, {
      method: 'POST',
      body,
    });
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    if (!input.customerId) {
      throw new Error('[payments] Asaas requires a customer for every charge.');
    }
    const isCard =
      input.method === 'credit_card' ||
      input.paymentMethodId !== undefined ||
      input.card !== undefined;
    const body: Record<string, unknown> = {
      customer: input.customerId,
      value: toDecimal(input.amount),
      dueDate: this.#dueDate(input),
      billingType: this.#mapMethod(isCard ? 'credit_card' : input.method),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // `externalReference` is the app's own id echoed back on the payment — the routing
      // key webhook handlers read. `idempotencyKey` doubles as it only when the app
      // didn't pass an explicit reference (legacy behavior).
      ...(input.externalReference !== undefined || input.idempotencyKey !== undefined
        ? { externalReference: input.externalReference ?? input.idempotencyKey }
        : {}),
      // Checkout transparente: cartão tokenizado no front (Asaas tokenization).
      ...(input.card !== undefined ? { creditCardToken: input.card.token } : {}),
      ...(input.paymentMethodId !== undefined ? { creditCardToken: input.paymentMethodId } : {}),
      ...(input.card?.holder !== undefined ? { creditCardHolderInfo: input.card.holder } : {}),
      ...(input.card?.remoteIp !== undefined ? { remoteIp: input.card.remoteIp } : {}),
      // Marketplace split: each entry shares the charge with a wallet (percent and/or fixed).
      ...(input.split !== undefined && input.split.length > 0
        ? {
            split: input.split.map((entry) => ({
              walletId: entry.walletId,
              ...(entry.percentualValue !== undefined
                ? { percentualValue: entry.percentualValue }
                : {}),
              ...(entry.fixedValue !== undefined ? { fixedValue: entry.fixedValue / 100 } : {}),
            })),
          }
        : {}),
    };
    const data = await this.#request<AsaasPaymentResponse>('/payments', { method: 'POST', body });
    const payment = this.#mapPayment(data);

    // PIX: busca o QR code da cobrança (o Asaas não retorna no create).
    if (payment.method === 'pix') {
      try {
        const qr = await this.#request<{
          encodedImage?: string | null;
          payload?: string | null;
          expirationDate?: string | null;
        }>(`/payments/${data.id}/pixQrCode`);
        if (qr.payload) payment.pixCopiaECola = qr.payload;
        if (qr.encodedImage) payment.pixQrCode = qr.encodedImage;
      } catch {
        // QR code é best-effort — a cobrança já existe.
      }
    }

    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#request<AsaasPaymentResponse>(`/payments/${gatewayId}`);
      return this.#mapPayment(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async refund(paymentGatewayId: string, amount?: Money): Promise<Refund> {
    const body: Record<string, unknown> = {
      ...(amount !== undefined ? { value: toDecimal(amount) } : {}),
    };
    const data = await this.#request<AsaasPaymentResponse>(`/payments/${paymentGatewayId}/refund`, {
      method: 'POST',
      body,
    });
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: fromDecimal(data.value), currency: 'brl' },
      status: data.status === 'REFUNDED' ? 'succeeded' : 'pending',
      createdAt: new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (!input.customerId) {
      throw new Error('[payments] Asaas requires a customer for checkout.');
    }
    const body: Record<string, unknown> = {
      customer: input.customerId,
      value: toDecimal(input.amount),
      billingType: 'UNDEFINED',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.cancelUrl !== undefined
        ? {
            callback: {
              cancelUrl: input.cancelUrl,
              successUrl: input.successUrl,
              autoRedirect: true,
            },
          }
        : {}),
    };
    const data = await this.#request<AsaasPaymentResponse>('/payments', { method: 'POST', body });
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      url: data.invoiceUrl ?? '',
      status: 'open',
      amount: { amount: fromDecimal(data.value), currency: 'brl' },
      customerId: data.customer,
      ...(data.pixCopiaECola !== undefined ? { pixCopiaECola: data.pixCopiaECola } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    const body: Record<string, unknown> = {
      customer: input.customerId,
      billingType: this.#mapMethod(input.method),
      cycle: input.cycle ?? 'MONTHLY',
      ...(input.amount !== undefined ? { value: toDecimal(input.amount) } : {}),
      ...(input.startDate !== undefined ? { nextDueDate: input.startDate } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // Asaas propagates the subscription's externalReference to every installment
      // payment — the routing key webhook handlers read on each charge.
      ...(input.externalReference !== undefined
        ? { externalReference: input.externalReference }
        : {}),
      // Checkout transparente de assinatura: cartão tokenizado cobrado a cada ciclo.
      ...(input.card !== undefined ? { creditCardToken: input.card.token } : {}),
      ...(input.card?.holder !== undefined ? { creditCardHolderInfo: input.card.holder } : {}),
      ...(input.card?.remoteIp !== undefined ? { remoteIp: input.card.remoteIp } : {}),
    };
    const data = await this.#request<AsaasSubscriptionResponse>('/subscriptions', {
      method: 'POST',
      body,
    });
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    // Asaas cancels immediately (no period-end flag).
    const data = await this.#request<AsaasSubscriptionResponse>(
      `/subscriptions/${subscriptionGatewayId}`,
      {
        method: 'DELETE',
      },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    const body: Record<string, unknown> = {
      ...(input.amount !== undefined ? { value: toDecimal(input.amount) } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // Also update already-created pending charges so the change takes effect this cycle.
      updatePendingPayments: true,
    };
    const data = await this.#request<AsaasSubscriptionResponse>(
      `/subscriptions/${subscriptionGatewayId}`,
      {
        method: 'POST',
        body,
      },
    );
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#request<AsaasSubscriptionResponse>(`/subscriptions/${gatewayId}`);
      return this.#mapSubscription(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(customerId: string): Promise<Invoice[]> {
    const data = await this.#request<{ data: AsaasPaymentResponse[] }>(
      `/payments?customer=${encodeURIComponent(customerId)}`,
    );
    return data.data.map((payment) => ({
      id: payment.id,
      gatewayId: payment.id,
      provider: this.provider,
      customerId: payment.customer,
      ...(payment.subscription !== undefined ? { subscriptionId: payment.subscription } : {}),
      status:
        payment.status === 'RECEIVED' || payment.status === 'CONFIRMED'
          ? 'paid'
          : payment.status === 'PENDING'
            ? 'open'
            : payment.status === 'CANCELED'
              ? 'void'
              : 'draft',
      amount: { amount: fromDecimal(payment.value), currency: 'brl' },
      createdAt: new Date(payment.dueDate).toISOString(),
      ...(payment.invoiceUrl !== undefined ? { hostedPdfUrl: payment.invoiceUrl } : {}),
      payload: payment as unknown as Record<string, unknown>,
    }));
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    // Asaas authenticates webhooks with a shared token you set in the dashboard; when
    // one is configured the request must carry it (timing-safe compare).
    if (this.#webhookToken !== undefined) {
      const token =
        headerValue(headers, 'asaas-access-token') ?? headerValue(headers, 'asaas-webhook-token');
      requireMatchingCredential(token, this.#webhookToken, 'Asaas', 'token');
    }
    const payload = JSON.parse(rawBody) as AsaasWebhookPayload;
    const id = `${payload.event}-${payload.payment?.id ?? payload.subscription?.id ?? Math.random()}`;
    return {
      id,
      provider: this.provider,
      type: this.#mapWebhookType(payload.event),
      createdAt: new Date().toISOString(),
      data: this.#mapWebhookData(payload),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: AsaasCustomerResponse): Customer {
    return {
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.cpfCnpj !== undefined ? { taxId: data.cpfCnpj } : {}),
    };
  }

  #mapPayment(data: AsaasPaymentResponse): Payment {
    const statusMap: Record<string, Payment['status']> = {
      PENDING: 'pending',
      RECEIVED: 'paid',
      CONFIRMED: 'paid',
      PROCESSING: 'pending',
      OVERDUE: 'failed',
      REFUNDED: 'refunded',
      CANCELED: 'canceled',
      FAILED: 'failed',
    };
    const method = this.#mapMethodToType(data.billingType);
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: fromDecimal(data.value), currency: 'brl' },
      status: statusMap[data.status] ?? 'pending',
      customerId: data.customer,
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.dueDate) ?? new Date().toISOString(),
    };
    if (method !== undefined && method !== 'unknown') result.method = method;
    if (data.subscription !== undefined) result.subscriptionId = data.subscription;
    if (data.pixQrCode !== undefined) result.pixQrCode = data.pixQrCode;
    if (data.pixCopiaECola !== undefined) result.pixCopiaECola = data.pixCopiaECola;
    if (data.invoiceUrl !== undefined) result.hostedUrl = data.invoiceUrl;
    if (data.paymentDate !== undefined) {
      const paidAt = this.#toIso(data.paymentDate);
      if (paidAt !== null) result.paidAt = paidAt;
    }
    return result;
  }

  /** Parse a gateway date (`YYYY-MM-DD` or ISO) into an ISO string, or `null` when absent/invalid. */
  #toIso(value: string | undefined): string | null {
    if (value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  #mapSubscription(data: AsaasSubscriptionResponse): Subscription {
    const statusMap: Record<string, Subscription['status']> = {
      ACTIVE: 'active',
      PENDING: 'trialing',
      EXPIRED: 'ended',
      CANCELED: 'canceled',
      SUSPENDED: 'past_due',
    };
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customer,
      status: statusMap[data.status] ?? 'active',
      planId: data.description ?? data.cycle,
      amount: { amount: fromDecimal(data.value), currency: 'brl' },
      ...(this.#toIso(data.endDate) !== null ? { endsAt: this.#toIso(data.endDate)! } : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: this.#toIso(data.nextDueDate) ?? new Date().toISOString(),
    };
  }

  #mapWebhookType(event: string): string {
    switch (event) {
      case 'PAYMENT_RECEIVED':
      case 'PAYMENT_CONFIRMED':
        return 'payment.succeeded';
      case 'PAYMENT_OVERDUE':
        return 'payment.failed';
      case 'PAYMENT_REFUNDED':
        return 'payment.refunded';
      case 'PAYMENT_CREATED':
      case 'PAYMENT_UPDATED':
        return 'payment.updated';
      case 'SUBSCRIPTION_CREATED':
        return 'subscription.created';
      case 'SUBSCRIPTION_UPDATED':
        return 'subscription.updated';
      case 'SUBSCRIPTION_DELETED':
        return 'subscription.canceled';
      default:
        return event.toLowerCase();
    }
  }

  #mapWebhookData(payload: AsaasWebhookPayload): Record<string, unknown> {
    if (payload.payment) {
      const payment = this.#mapPayment(payload.payment);
      return {
        gatewayId: payment.gatewayId,
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
        ...(payment.subscriptionId !== undefined ? { subscriptionId: payment.subscriptionId } : {}),
        ...(payload.payment.externalReference !== undefined
          ? { externalReference: payload.payment.externalReference }
          : {}),
      };
    }
    if (payload.subscription) {
      const subscription = this.#mapSubscription(payload.subscription);
      return {
        gatewayId: subscription.gatewayId,
        customerId: subscription.customerId,
        status: subscription.status,
        planId: subscription.planId,
        ...(subscription.endsAt !== undefined ? { endsAt: subscription.endsAt } : {}),
      };
    }
    return {};
  }

  #mapMethod(method?: string): string {
    switch (method) {
      case 'pix':
        return 'PIX';
      case 'boleto':
        return 'BOLETO';
      case 'credit_card':
        return 'CREDIT_CARD';
      default:
        return 'UNDEFINED';
    }
  }

  #mapMethodToType(billingType: AsaasPaymentResponse['billingType']): Payment['method'] {
    switch (billingType) {
      case 'PIX':
        return 'pix';
      case 'BOLETO':
        return 'boleto';
      case 'CREDIT_CARD':
        return 'card';
      default:
        return 'unknown';
    }
  }

  #dueDate(input: ChargeInput): string {
    return (
      (input.metadata?.dueDate as string | undefined) ??
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    );
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
