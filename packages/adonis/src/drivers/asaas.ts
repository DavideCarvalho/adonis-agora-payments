import { createHash } from 'node:crypto';
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
  TokenizeCardInput,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
  WebhookVerificationState,
} from '../driver.js';
import { headerValue, httpRequest, isNotFound } from '../http.js';
import type { EmitInvoiceContext } from '../invoice/emit_invoice.js';
import { emitInvoiceIfRequested } from '../invoice/emit_invoice.js';
import { fromDecimal, toDecimal } from '../money.js';
import type {
  CheckoutSession,
  Customer,
  Invoice,
  Money,
  Payment,
  Refund,
  Subscription,
  TokenizedCard,
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

/**
 * The `chargeback` object Asaas nests on a payment resource once one is filed. Asaas'
 * webhook reference sends the payment "object of the related entity" and points at the
 * `GET /payments/{id}` 200 response for its fields, so this is the same object — but no
 * published webhook example shows it, which is why every field here is optional and read
 * defensively rather than assumed.
 *
 * `deadlineToSendDisputeDocuments` is the only response deadline Asaas publishes anywhere:
 * a dispute answered after it is a dispute lost by default.
 */
interface AsaasChargebackResponse {
  id?: string;
  status?: 'REQUESTED' | 'IN_DISPUTE' | 'DISPUTE_LOST' | 'REVERSED' | 'DONE';
  /** One of Asaas' 33 reason enums (`FRAUD`, `COMMERCIAL_DISAGREEMENT`, …). */
  reason?: string;
  /** Chargeback opening date. */
  disputeStartDate?: string;
  /** Deadline to send dispute documents (`YYYY-MM-DD`). */
  deadlineToSendDisputeDocuments?: string;
  /** The CHARGEBACK's value, which a partial chargeback makes smaller than the payment's. */
  value?: number;
  disputeStatus?: 'REQUESTED' | 'ACCEPTED' | 'REJECTED';
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
  chargeback?: AsaasChargebackResponse;
  /**
   * The refunds filed against this payment. Asaas nests them on the payment resource, and
   * `PAYMENT_PARTIALLY_REFUNDED` is a notification about the payment — so this is where the
   * refunded figure lives, in reais, per refund.
   *
   * Read defensively (every field optional), the same posture as `chargeback` above and for
   * the same reason: no published Asaas webhook example shows the array. Only entries whose
   * status says the money actually went back are summed — an Asaas refund can be `PENDING`,
   * can await approval, and can be `CANCELLED`, and counting those would write off money that
   * is still in the account.
   */
  refunds?: Array<{
    value?: number;
    status?: 'PENDING' | 'AWAITING_CRITICAL_ACTION_APPROVAL' | 'CANCELLED' | 'DONE' | string;
  }>;
}

/** `POST /creditCard/tokenizeCreditCard` — CreditCardTokenizeResponseDTO. */
interface AsaasTokenizeCardResponse {
  /** Últimos 4 dígitos, apesar do nome. */
  creditCardNumber: string;
  creditCardBrand: string;
  creditCardToken: string;
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
  /**
   * Asaas' OWN event id (`evt_05b708f9…&368604920`), sent on the body of every notification
   * and stable across its retries of that notification.
   *
   * It was never declared here and never read, so `parseWebhook` synthesized an id out of the
   * event name and the payment id — which is not an event identity, it is a
   * (payment, event-type) identity. The ledger keys idempotency on it, so the SECOND
   * `PAYMENT_UPDATED` for a payment was silently discarded as a replay of the first, and a
   * partial refund arrives as exactly that type.
   *
   * Optional because a payload without it must still be processed — see the fallback in
   * `parseWebhook`, which hashes the body rather than inventing a number.
   */
  id?: string;
  /** When Asaas created the event (`YYYY-MM-DD HH:mm:ss`). Not an idempotency key. */
  dateCreated?: string;
  event: string;
  payment?: AsaasPaymentResponse;
  subscription?: AsaasSubscriptionResponse;
}

/** The envelope Asaas wraps every list endpoint in. */
interface AsaasListResponse<T> {
  data?: T[];
  /** Asaas' own "there is another page" flag — the loop's authority when it is present. */
  hasMore?: boolean;
  totalCount?: number;
  limit?: number;
  offset?: number;
}

/** Rows per page when iterating an Asaas list endpoint. 100 is Asaas' documented maximum. */
const ASAAS_PAGE_SIZE = 100;

/**
 * A runaway guard on the paging loop, not a result limit: a gateway that answered `hasMore`
 * forever would otherwise spin. Ten million charges for ONE customer is not a real number, so
 * reaching this means something is wrong — and the loop throws rather than truncating,
 * because a quietly partial list is the bug the paging was added to fix.
 */
const ASAAS_MAX_PAGES = 100_000;

/**
 * Asaas driver — Brazilian gateway (Pix, boleto, card) with native subscription billing.
 * Uses the REST API directly via `fetch` (no SDK dependency). The Asaas API key is sent
 * as a plain header; webhooks are validated by a configured token.
 */
export class AsaasDriver implements PaymentsDriver {
  readonly provider = 'asaas';
  readonly supportedMethods = ['pix', 'boleto', 'credit_card', 'debit_card', 'undefined'] as const;
  readonly capabilities = {
    refunds: true,
    invoices: true,
    subscriptions: true,
    cardTokenization: true,
  };

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

  /**
   * Create a charge — and, when the caller passes an `idempotencyKey`, do not create a second
   * one for the same key.
   *
   * **This method HONOURS `idempotencyKey`**, which is why it does not go through
   * `#refuseIdempotencyKey` like every other method here. It used to quietly repurpose the key
   * as an `externalReference` fallback and nothing else, so an app that passed
   * `idempotencyKey: order.id` on the one call that moves money — believing it was protected
   * against a double charge on a retry — got no protection at all and no warning either.
   *
   * Refusing it here (the consistent option) was the alternative and was rejected: `charge()`
   * is the single call where a silent duplicate costs the customer real money, and the
   * deduplication `#refuseIdempotencyKey`'s own message tells callers to do by hand —
   * "looking the record up by `externalReference` first" — is one request the driver can make
   * on their behalf, exactly and every time. Asaas still has no idempotency mechanism of its
   * own; this is that documented workaround, implemented rather than described.
   *
   * The key travels as the charge's `externalReference` (Asaas echoes it back and accepts it
   * as a query filter), so the guarantee is: **at most one Asaas charge per key**, scoped to
   * the customer. A hit returns the charge that already exists — enriched with its Pix code,
   * so the caller gets a usable payment — and deliberately re-runs NEITHER side effect: no
   * second fiscal invoice is emitted (an NFS-e is a legal document, not a retryable write) and
   * no `charge.created` diagnostic is published for a charge that was not created.
   *
   * What it is not: a lock. Two concurrent calls with the same key can both miss the lookup
   * and both create — Asaas offers nothing to prevent that. It closes the retry case, which is
   * the one that actually happens.
   */
  // ── Card tokenization ────────────────────────────────────────────────────────────────

  /**
   * `POST /creditCard/tokenizeCreditCard` — troca os dados do cartão por um token
   * reutilizável.
   *
   * O PAN passa pelo servidor de propósito, e não por descuido: o Asaas não tem chave
   * publicável, então não existe caminho que tokenize no browser. Quem chama isto está
   * em escopo PCI para esta requisição — nada aqui loga o corpo, e o que volta é só o
   * token, a bandeira e os quatro últimos dígitos.
   *
   * ⚠️ **Em produção a tokenização precisa ser habilitada pelo gerente da conta Asaas**
   * (no sandbox já vem ligada). Enquanto não for, este endpoint recusa — o erro que volta
   * é o do gateway, repassado como está.
   *
   * O token é preso ao `customer`: o próprio Asaas recusa usá-lo numa transação de outro
   * cliente. Por isso `customerId` é obrigatório aqui e não um detalhe opcional.
   */
  async tokenizeCard(input: TokenizeCardInput): Promise<TokenizedCard> {
    const data = await this.#request<AsaasTokenizeCardResponse>('/creditCard/tokenizeCreditCard', {
      method: 'POST',
      body: {
        customer: input.customerId,
        creditCard: {
          holderName: input.card.holderName,
          number: input.card.number,
          expiryMonth: input.card.expiryMonth,
          expiryYear: input.card.expiryYear,
          ccv: input.card.ccv,
        },
        creditCardHolderInfo: {
          name: input.holder.name,
          email: input.holder.email,
          cpfCnpj: input.holder.cpfCnpj,
          postalCode: input.holder.postalCode,
          addressNumber: input.holder.addressNumber,
          phone: input.holder.phone,
          ...(input.holder.addressComplement !== undefined
            ? { addressComplement: input.holder.addressComplement }
            : {}),
          ...(input.holder.mobilePhone !== undefined
            ? { mobilePhone: input.holder.mobilePhone }
            : {}),
        },
        remoteIp: input.remoteIp,
      },
    });

    return {
      token: data.creditCardToken,
      // `creditCardNumber` são os últimos 4 dígitos, não o número — o nome é do Asaas.
      last4: data.creditCardNumber,
      brand: data.creditCardBrand,
      provider: this.provider,
    };
  }

  async charge(input: ChargeInput): Promise<Payment> {
    if (!input.customerId) {
      throw new Error('[payments] Asaas requires a customer for every charge.');
    }
    const isCard =
      input.method === 'credit_card' ||
      input.paymentMethodId !== undefined ||
      input.card !== undefined;
    // The value that will land in `externalReference` — and therefore the value the
    // idempotency lookup below has to search on. They must be the same string or the second
    // call looks for a key the first one never wrote.
    const reference = input.externalReference ?? input.idempotencyKey;
    const body: Record<string, unknown> = {
      customer: input.customerId,
      value: toDecimal(input.amount),
      dueDate: this.#dueDate(input),
      billingType: this.#mapMethod(isCard ? 'credit_card' : input.method),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // `externalReference` is the app's own id echoed back on the payment — the routing
      // key webhook handlers read, AND the only thing Asaas can be asked to match a charge
      // on, which is what makes `idempotencyKey` honourable at all. An explicit reference
      // wins; the key stands in when there is none.
      ...(reference !== undefined ? { externalReference: reference } : {}),
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
    // The idempotency lookup, and it happens BEFORE the POST or it is worth nothing.
    const duplicate =
      input.idempotencyKey !== undefined && reference !== undefined
        ? await this.#findChargeByReference(reference, input.customerId)
        : null;
    if (duplicate !== null) {
      const existing = this.#mapPayment(duplicate);
      await this.#attachPixQrCode(existing);
      // No invoice, no diagnostic: nothing was charged. See the note on this method.
      return existing;
    }

    const data = await this.#request<AsaasPaymentResponse>('/payments', { method: 'POST', body });
    const payment = this.#mapPayment(data);
    await this.#attachPixQrCode(payment);

    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  /**
   * The charge already recorded under one `externalReference` for this customer, or `null`.
   *
   * The whole of Asaas' idempotency story: it documents no idempotency header and no
   * idempotency body field on any endpoint, and tells you to deduplicate on your side — so the
   * only handle is `externalReference`, which it echoes back and accepts as a query filter.
   * Scoped to the customer as well, because an app's own order ids are unique within the app,
   * not across every merchant's tenant.
   *
   * Newest first, which is Asaas' own ordering: if an app really did reuse a key across two
   * charges, the one it means is the last one it made.
   */
  async #findChargeByReference(
    reference: string,
    customerId: string,
  ): Promise<AsaasPaymentResponse | null> {
    const body = await this.#request<AsaasListResponse<AsaasPaymentResponse>>(
      `/payments?externalReference=${encodeURIComponent(reference)}&customer=${encodeURIComponent(customerId)}&limit=1`,
    );
    const rows = Array.isArray(body.data) ? body.data : [];
    return rows[0] ?? null;
  }

  /**
   * Fill in a Pix charge's QR code. Asaas does not return one from `POST /payments`, so it
   * takes a second request — best-effort, because the charge already exists either way and
   * failing here would report a failure over money that is already owed.
   */
  async #attachPixQrCode(payment: Payment): Promise<void> {
    if (payment.method !== 'pix') return;
    try {
      const qr = await this.#request<{
        encodedImage?: string | null;
        payload?: string | null;
        expirationDate?: string | null;
      }>(`/payments/${payment.gatewayId}/pixQrCode`);
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

  /**
   * Every charge Asaas holds for a customer — **all of them**, not the newest page.
   *
   * `GET /payments` is a paged endpoint (`limit`/`offset`, and an explicit `hasMore` in the
   * envelope). This asked for it with neither, took whatever default page Asaas felt like
   * returning, and handed it back as if it were the whole list — so `payments:sync` printed a
   * confident "N invoice(s) synced" over the most recent page and left every older charge
   * unreconciled, silently, with no way for the caller to tell.
   *
   * `hasMore` is the loop's authority; a short page ends it when the envelope omits one. The
   * page cap is a runaway guard, not a limit: it THROWS rather than truncating, because
   * returning a partial list quietly is the exact bug this replaced.
   */
  async listInvoices(customerId: string): Promise<Invoice[]> {
    const invoices: Invoice[] = [];
    for (let page = 0; ; page += 1) {
      if (page >= ASAAS_MAX_PAGES) {
        throw new Error(
          `[payments] Asaas listInvoices for customer ${customerId} did not stop after ${ASAAS_MAX_PAGES} pages of ${ASAAS_PAGE_SIZE}. Refusing to return a partial list — narrow the query at the gateway.`,
        );
      }
      const offset = page * ASAAS_PAGE_SIZE;
      const body = await this.#request<AsaasListResponse<AsaasPaymentResponse>>(
        `/payments?customer=${encodeURIComponent(customerId)}&limit=${ASAAS_PAGE_SIZE}&offset=${offset}`,
      );
      const rows = Array.isArray(body.data) ? body.data : [];
      for (const payment of rows) invoices.push(this.#mapInvoice(payment));
      // `hasMore` when Asaas states one; otherwise a page shorter than the limit is the end.
      const more =
        typeof body.hasMore === 'boolean' ? body.hasMore : rows.length >= ASAAS_PAGE_SIZE;
      if (!more || rows.length === 0) return invoices;
    }
  }

  /**
   * One Asaas payment as an `Invoice`.
   *
   * The status mapping is lossy in one direction worth naming: `Invoice['status']` has no
   * `refunded` and no `disputed` member, so a refunded or charged-back Asaas payment lands on
   * `draft` — "the gateway said something this vocabulary cannot spell". Nothing should read a
   * reversal out of this; `payments:sync` asks `findPayment` for the authoritative status,
   * which speaks `BillingStatus` and can say `refunded`.
   */
  #mapInvoice(payment: AsaasPaymentResponse): Invoice {
    return {
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
    };
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * The shared access token is the only thing authenticating an Asaas delivery; with the slot
   * empty the token comparison below never runs.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookToken !== undefined ? 'configured' : 'unconfigured';
  }

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
    // Asaas' own event id, which is what the ledger's idempotency is supposed to key on.
    //
    // The previous id was `${event}-${paymentId}`, and that is not an event identity: every
    // notification of the same type about the same payment collapsed onto one key, so the
    // SECOND `PAYMENT_UPDATED` for a charge was dropped as a replay of the first — and a
    // PARTIAL REFUND arrives as exactly that type. It also fell back to `Math.random()` when
    // the payload named neither a payment nor a subscription, which turns deduplication OFF
    // for those deliveries entirely: every retry of a failing one looked like a new event.
    //
    // The fallback below is used only when Asaas genuinely sends no `id`. It is a digest of
    // the RAW BODY, so it is deterministic (a redelivery of the same notification hashes to
    // the same key and is still deduplicated) while two genuinely different notifications —
    // the two `PAYMENT_UPDATED`s above — differ, which is the property the old key lacked.
    const id =
      payload.id ??
      `asaas:${payload.event}:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;
    const type = this.#mapWebhookType(payload.event);
    return {
      id,
      provider: this.provider,
      type,
      createdAt: new Date().toISOString(),
      data: this.#mapWebhookData(payload, type),
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
      // The chargeback was filed and is still open — contested or not. Whether Asaas has
      // already debited the balance at this point is NOT stated anywhere in its reference:
      // the developer docs describe `chargeback.status` and nothing about the money, and
      // the help centre says the balance is debited when the dispute is LOST while also
      // describing a won one as the value "returning" to the balance. `disputed` is the
      // safe reading either way — it stops counting as revenue while the outcome is open.
      CHARGEBACK_REQUESTED: 'disputed',
      CHARGEBACK_DISPUTE: 'disputed',
      // "Disputa vencida, aguardando repasse da adquirente" — Asaas' own English docs say
      // "Dispute won, awaiting acquirer settlement". The dispute is over and it was won, so
      // this is `paid`, matching the `payment.dispute_closed` (`won`) the matching webhook
      // emits — a driver that reported the same gateway state two different ways depending
      // on whether you read it or were told it is worse than either answer. The acquirer's
      // transfer has not landed yet, which is a reconciliation question, not an entitlement
      // one — the same reasoning as `RECEIVED_IN_CASH` below.
      AWAITING_CHARGEBACK_REVERSAL: 'paid',
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
      // "Chargeback recebido" — the chargeback has been FILED (unlike Adyen's
      // `NOTIFICATION_OF_CHARGEBACK`, which only announces one), and it is the only Asaas
      // event that opens a dispute. Asaas does not publish whether the balance is debited
      // here or only when the dispute is lost — its reference documents `chargeback.status`
      // and says nothing about the money — so this stays where it was rather than being
      // demoted to a warning on a guess. See the provider docs page.
      case 'PAYMENT_CHARGEBACK_REQUESTED':
        return 'payment.disputed';
      // "Disputa vencida, aguardando repasse da adquirente" / "Dispute won, awaiting
      // acquirer settlement". That is an outcome, in Asaas' own words, so it closes the
      // dispute as `won` instead of being flattened into an update the way it used to be.
      // Asaas sends no counterpart for a LOSS — there is no `PAYMENT_CHARGEBACK_LOST` in
      // its event list — so a lost dispute still reaches you only as `chargeback.status`
      // on the payment; the driver does not invent an event for it.
      case 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL':
        return 'payment.dispute_closed';
      case 'PAYMENT_CREATED':
      case 'PAYMENT_UPDATED':
      // Card authorized, awaiting capture (`authorizeOnly: true`). There is no canonical
      // authorization event, and the payment's own status already says `authorized`.
      case 'PAYMENT_AUTHORIZED':
      // "Chargeback em disputa após apresentação de documentos para contestação": you
      // contested it and the documents are in. Movement inside an open dispute, not a
      // resolution and not a second chargeback — `event.raw.event` still names it.
      case 'PAYMENT_CHARGEBACK_DISPUTE':
      // A partial refund is deliberately NOT `payment.refunded`. That handler writes the
      // charge off whole — status `refunded` — so a R$10 refund on a R$100 charge would
      // erase R$90 of revenue. It stays an update, and the update is now the handler that
      // records it honestly: `payment.updated` carries `refundedAmount` (integer minor
      // units, summed from the payment's settled `refunds`) onto `billing_payments`, so the
      // charge keeps its amount, its status and its settlement date, and the net is
      // `amount - refunded_amount`. Until that column existed this event reached a
      // `default:` that did nothing at all and the refund was simply lost.
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

  #mapWebhookData(payload: AsaasWebhookPayload, type: string): Record<string, unknown> {
    if (payload.payment) {
      const payment = this.#mapPayment(payload.payment);
      const refunded = this.#refundedAmount(payload.payment);
      return {
        gatewayId: payment.gatewayId,
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
        ...(payment.subscriptionId !== undefined ? { subscriptionId: payment.subscriptionId } : {}),
        ...(payload.payment.externalReference !== undefined
          ? { externalReference: payload.payment.externalReference }
          : {}),
        // The payment's CURRENT state, and the two figures that go with it. `payment.updated`
        // is the only event whose type does not state its own outcome — Asaas sends eight
        // different things through it — so without these the processor could keep nothing
        // current and a partial refund had nothing to record.
        status: payment.status,
        ...(payment.paidAt !== undefined ? { paidAt: payment.paidAt } : {}),
        ...(refunded !== null ? { refundedAmount: refunded } : {}),
        ...this.#disputeExtras(payload.payment, type),
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

  /**
   * The dispute fields, added to the payment payload on the two chargeback events that
   * carry a dispute — and to nothing else, so an ordinary `payment.updated` does not start
   * announcing a deadline.
   *
   * `gatewayId` stays the PAYMENT's id (the row the chargeback is about); the chargeback's
   * own id travels as `disputeId`. The amount deliberately stays the payment's too: a
   * PARTIAL chargeback's `chargeback.value` is smaller, and the processor writes `amount`
   * onto the row — the disputed figure is on `event.raw`.
   *
   * Every field is optional because no published Asaas webhook example shows the
   * `chargeback` object at all. The webhook reference sends the payment resource and points
   * at `GET /payments/{id}` for its schema, where `chargeback` lives; if Asaas omits it on
   * the notification, the event is still correct, just without the deadline.
   */
  #disputeExtras(payment: AsaasPaymentResponse, type: string): Record<string, unknown> {
    if (type !== 'payment.disputed' && type !== 'payment.dispute_closed') return {};
    const chargeback = payment.chargeback;
    const deadline = this.#toIso(chargeback?.deadlineToSendDisputeDocuments);
    return {
      // Asaas' only documented outcome event is the won one; `#mapWebhookType` sends
      // nothing else here, and the processor throws on a close with no outcome.
      ...(type === 'payment.dispute_closed' ? { outcome: 'won' } : {}),
      ...(chargeback?.id !== undefined ? { disputeId: chargeback.id } : {}),
      ...(chargeback?.reason !== undefined ? { reason: chargeback.reason } : {}),
      // The one deadline Asaas publishes: `deadlineToSendDisputeDocuments`. A dispute
      // answered after it is a dispute lost by default, which is the whole reason the
      // normalized event has a field for it.
      ...(deadline !== null ? { actionableUntil: deadline } : {}),
    };
  }

  /**
   * How much of this payment has actually gone back, in integer minor units — or `null` when
   * Asaas said nothing about refunds at all.
   *
   * `null` and `0` are different answers and the difference matters: `null` leaves whatever is
   * stored alone (the store's leave-alone rule), while `0` would assert that nothing has been
   * refunded — which is a claim a notification carrying no `refunds` array is not making.
   *
   * Only `DONE` entries count. Asaas can hold a refund `PENDING`, park it awaiting approval,
   * and deny it outright (`PAYMENT_REFUND_DENIED` is a real event) — summing those would write
   * off money still sitting in the account. `fromDecimal` per entry, then integer addition:
   * the reais never meet each other as floats.
   */
  #refundedAmount(payment: AsaasPaymentResponse): number | null {
    const refunds = payment.refunds;
    if (refunds === undefined || !Array.isArray(refunds)) return null;
    let total = 0;
    for (const refund of refunds) {
      if (refund?.status !== 'DONE') continue;
      if (typeof refund.value !== 'number') continue;
      total += fromDecimal(refund.value);
    }
    return total;
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
   * `charge()` is the one exception, and it earns it by actually DOING the deduplication this
   * message describes: it looks the charge up by `externalReference` before creating one, so
   * the key is honoured rather than accepted and ignored. See {@link AsaasDriver.charge}.
   * Every other method here would have to invent that lookup out of nothing, so it refuses
   * loudly instead — an accepted-and-dropped key on `refund()` is a second refund.
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
