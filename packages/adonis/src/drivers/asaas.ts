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
    | 'PROCESSING'
    /** `authorizeOnly: true` — the card is held and nothing is captured yet. */
    | 'AUTHORIZED'
    /** The three chargeback states of a payment, in the order Asaas moves through them. */
    | 'CHARGEBACK_REQUESTED'
    | 'CHARGEBACK_DISPUTE'
    | 'AWAITING_CHARGEBACK_REVERSAL'
    /** Confirmed by hand in the Asaas UI: the customer paid the merchant in cash. */
    | 'RECEIVED_IN_CASH'
    /** A refund asked for, and a refund scheduled. Neither has settled. */
    | 'REFUND_REQUESTED'
    | 'REFUND_IN_PROGRESS'
    /** Negativação: the debt went to a credit bureau, and was then paid through it. */
    | 'DUNNING_REQUESTED'
    | 'DUNNING_RECEIVED'
    /** A card charge held for Asaas' manual risk review. */
    | 'AWAITING_RISK_ANALYSIS';
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
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createCustomer');
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
        if (qr.payload) {
          payment.pixCode = qr.payload;
          payment.pixCopiaECola = qr.payload;
        }
        if (qr.encodedImage) {
          payment.pixQrCodeImage = qr.encodedImage;
          payment.pixQrCode = qr.encodedImage;
        }
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

  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    this.#refuseIdempotencyKey(options?.idempotencyKey, 'refund');
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
      ...(data.pixCopiaECola !== undefined
        ? { pixCode: data.pixCopiaECola, pixCopiaECola: data.pixCopiaECola }
        : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    this.#refuseIdempotencyKey(input.idempotencyKey, 'createSubscription');
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
    this.#refuseIdempotencyKey(input.idempotencyKey, 'updateSubscription');
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
      // A pre-authorized card charge (`authorizeOnly: true`, captured later through
      // `POST /payments/{id}/captureAuthorizedPayment`). The money is held, not moved:
      // `pending` understated it and `paid` would grant access against a hold that
      // expires — Asaas reserves it for three days by default.
      AUTHORIZED: 'authorized',
      // All three chargeback states are the payment being disputed. Asaas has taken the
      // money back in every one of them; only the outcome is still open.
      CHARGEBACK_REQUESTED: 'disputed',
      CHARGEBACK_DISPUTE: 'disputed',
      AWAITING_CHARGEBACK_REVERSAL: 'disputed',
      // The two ways an Asaas charge is paid without Asaas moving the money. Both fell
      // through to the `pending` default, so a customer who had paid — in cash at the
      // counter, or through the credit bureau after being negativado — read as never
      // having paid, and stayed locked out of what they bought. `RECEIVED_IN_CASH`
      // deliberately generates no balance in the Asaas account; that is a reconciliation
      // question, not an entitlement one.
      RECEIVED_IN_CASH: 'paid',
      DUNNING_RECEIVED: 'paid',
      // A refund that has been asked for or scheduled, and has settled in neither case.
      // `pending` claimed the charge was never paid, and `refunded` would write off money
      // that is still in the account — Asaas can deny a refund (`PAYMENT_REFUND_DENIED`).
      // It stays `paid` until `REFUNDED` says otherwise.
      REFUND_REQUESTED: 'paid',
      REFUND_IN_PROGRESS: 'paid',
      // Overdue and escalated to a credit bureau. Still unpaid, same as OVERDUE.
      DUNNING_REQUESTED: 'failed',
      // Held for manual risk review: nothing is captured, and Asaas' own docs say to wait
      // before releasing the product. `pending` is right — it is spelled out because the
      // default silently agreed by accident.
      AWAITING_RISK_ANALYSIS: 'pending',
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
    if (data.pixQrCode !== undefined) {
      result.pixQrCodeImage = data.pixQrCode;
      result.pixQrCode = data.pixQrCode;
    }
    if (data.pixCopiaECola !== undefined) {
      result.pixCode = data.pixCopiaECola;
      result.pixCopiaECola = data.pixCopiaECola;
    }
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
      // Negativação paid: the customer settled through the credit bureau. Money arrived,
      // and this fell through to the unknown branch — so the one event announcing that a
      // written-off debt came back ran no sync at all.
      case 'PAYMENT_DUNNING_RECEIVED':
        return 'payment.succeeded';
      case 'PAYMENT_OVERDUE':
      // The card was refused at capture, and the manual risk review rejected it. Both are
      // the charge failing, and both used to arrive as an unrecognized type.
      case 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED':
      case 'PAYMENT_REPROVED_BY_RISK_ANALYSIS':
        return 'payment.failed';
      case 'PAYMENT_REFUNDED':
        return 'payment.refunded';
      // The chargeback is filed and the money is gone — the one webhook that takes
      // revenue away, and the only Asaas event that opens a dispute.
      case 'PAYMENT_CHARGEBACK_REQUESTED':
        return 'payment.disputed';
      case 'PAYMENT_CREATED':
      case 'PAYMENT_UPDATED':
      // Card authorized, awaiting capture (`authorizeOnly: true`). There is no canonical
      // authorization event, and the payment's own status already says `authorized`.
      case 'PAYMENT_AUTHORIZED':
      // What happens AFTER a dispute is opened: documents submitted, and the dispute won
      // with the acquirer's transfer still pending. The contract deliberately has no
      // resolution event — every gateway reports one differently — so these stay
      // `payment.updated`; `event.raw.event` still names which one it was. Asaas sends no
      // "dispute lost" webhook at all: that shows up as `chargeback.status` on the payment.
      case 'PAYMENT_CHARGEBACK_DISPUTE':
      case 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL':
      // A partial refund is deliberately NOT `payment.refunded`. That handler overwrites
      // the row's status with `refunded` and its amount with the refunded amount, so a
      // R$10 refund on a R$100 charge would erase R$90 of revenue. Until the tables carry
      // a refunded amount this stays an update and the arithmetic stays right — see the
      // roadmap.
      case 'PAYMENT_PARTIALLY_REFUNDED':
      // Asked for, scheduled, denied. No money has moved back on any of the three; only
      // `PAYMENT_REFUNDED` means it did.
      case 'PAYMENT_REFUND_IN_PROGRESS':
      case 'PAYMENT_REFUND_DENIED':
      // Manual risk review, start to finish. Approval is not receipt — the charge still
      // has to be confirmed — so neither end of it grants anything.
      case 'PAYMENT_AWAITING_RISK_ANALYSIS':
      case 'PAYMENT_APPROVED_BY_RISK_ANALYSIS':
      // The debt was sent to a credit bureau. Nothing was paid; the charge is still overdue.
      case 'PAYMENT_DUNNING_REQUESTED':
      // A cash receipt confirmed by hand and then taken back. The payment reverts to
      // unpaid, and the synced row follows the payload's own status — which is why this is
      // an update rather than a refund: Asaas never held the money.
      case 'PAYMENT_RECEIVED_IN_CASH_UNDONE':
      // Deleted and restored are the charge existing or not, not money moving.
      case 'PAYMENT_DELETED':
      case 'PAYMENT_RESTORED':
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

  /**
   * Asaas documents no idempotency mechanism — no header, no body field, on any endpoint;
   * its own guidance is to deduplicate on your side before you retry. Accepting the key
   * and dropping it would turn a caller's retry guarantee into a second refund or a
   * second subscription, so the driver refuses it instead.
   *
   * `charge()` is the one exception, and it is not an exception to this rule: there
   * `idempotencyKey` has never meant deduplication, it is a legacy fallback for
   * `externalReference` (the routing key echoed on the payment) and is documented as such.
   */
  #refuseIdempotencyKey(key: string | undefined, operation: string): void {
    if (key === undefined) return;
    throw new Error(
      `[payments] Asaas has no idempotency mechanism, so \`${operation}\` cannot honour an idempotencyKey — no Asaas endpoint documents an idempotency header or field. Deduplicate before you call, e.g. by looking the record up by \`externalReference\` first.`,
    );
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
