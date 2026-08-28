import type { PagBankDriverConfig } from '../define_config.js';
import { publishPaymentDiagnostics, publishRefundDiagnostics } from '../diagnostics.js';
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
  PaymentMethodType,
  Refund,
  Subscription,
  WebhookEvent,
} from '../types.js';
import { verifyPagBankAuthenticityToken } from '../webhook_security.js';
import { requireCredential } from './shared.js';

interface PagBankAmount {
  value: number;
  currency?: string;
  summary?: { total?: number; paid?: number; refunded?: number };
}

interface PagBankLink {
  rel: string;
  href: string;
  media?: string;
  type?: string;
}

interface PagBankCharge {
  id: string;
  reference_id?: string;
  status: 'AUTHORIZED' | 'PAID' | 'IN_ANALYSIS' | 'DECLINED' | 'CANCELED' | 'WAITING';
  created_at?: string;
  paid_at?: string;
  amount: PagBankAmount;
  payment_method?: {
    type?: 'CREDIT_CARD' | 'DEBIT_CARD' | 'BOLETO' | 'PIX';
    installments?: number;
    boleto?: { id?: string; barcode?: string; formatted_barcode?: string };
    pix?: { expiration_date?: string };
  };
  /** Pix charges carry the BR Code here; `links` carry URLs to the rendered image. */
  qr_code?: { id?: string; text?: string };
  payment_response?: { code?: string; message?: string; reference?: string };
  links?: PagBankLink[];
}

interface PagBankQrCode {
  id?: string;
  expiration_date?: string;
  amount: PagBankAmount;
  /** The Pix BR Code (EMV payload) — what the payer copies. */
  text?: string;
  /** Links to the rendered QR image (`QRCODE.PNG`, `QRCODE.BASE64`) — URLs, not content. */
  links?: PagBankLink[];
}

interface PagBankOrder {
  id: string;
  reference_id?: string;
  created_at?: string;
  customer?: { name?: string; email?: string; tax_id?: string };
  charges?: PagBankCharge[];
  qr_codes?: PagBankQrCode[];
  links?: PagBankLink[];
}

/**
 * PagBank (PagSeguro) driver — the **Orders API v4** (`api.pagseguro.com/orders`), Bearer
 * token, money as integer centavos in `amount.value` (no decimal conversion anywhere in
 * this file). Uses `fetch` directly, no SDK.
 *
 * Two things about this gateway shape the whole driver:
 *
 * 1. **An order is not a charge.** Every payment — Pix included, since the v2 Pix flow —
 *    is a `charges[]` entry inside an order, and each has its own id. The webhook delivers
 *    the *order*, so this driver uses the **order id** (`ORDE_…`) as the `gatewayId`
 *    everywhere; keying on the charge id would file the charge you created and the webhook
 *    that confirms it under two different ids, and nothing would reconcile. `refund()`
 *    accepts either id and resolves the charge (`CHAR_…`) itself.
 * 2. **There is no customer resource and no subscription.** Customer data is inline on
 *    each order, and recurring billing is a different PagBank product (the Assinaturas
 *    API). Those methods throw instead of pretending.
 */
export class PagBankDriver implements PaymentsDriver {
  readonly provider = 'pagbank';
  // No `'undefined'`: the Orders API makes you choose up front — a Pix order carries
  // `qr_codes`, a card/boleto order carries `charges`. There is no "payer decides later".
  readonly supportedMethods = ['pix', 'credit_card', 'debit_card', 'boleto'] as const;
  readonly capabilities = { refunds: true, invoices: false, subscriptions: false };

  #baseUrl: string;
  #token: string;
  #webhookToken: string;
  #verifyWebhooks: boolean;
  #notificationUrls: string[];
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: PagBankDriverConfig = {}) {
    this.#invoiceCtx = ctx;
    const token = requireCredential({
      driver: 'pagbank',
      option: 'token',
      env: 'PAGBANK_TOKEN',
      value: config.token,
    });
    this.#token = token;
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
    // PagBank signs the webhook with the SAME token that authenticates API calls — there
    // is no separate webhook secret to configure, so this defaults to the API token and
    // verification is on unless you turn it off.
    this.#webhookToken = config.webhookToken ?? process.env.PAGBANK_WEBHOOK_TOKEN ?? token;
    this.#verifyWebhooks = config.verifyWebhooks ?? true;
    this.#notificationUrls = config.notificationUrls ?? [];
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(_input: CreateCustomerInput): Promise<Customer> {
    throw new Error(
      '[payments] PagBank has no customer resource — the Orders API carries the payer inline on each order. ' +
        'Pass `customer: { name, email, taxId }` on the charge instead, and keep the mapping in your own table.',
    );
  }

  async findCustomer(_customerId: string): Promise<Customer | null> {
    throw new Error(
      '[payments] PagBank has no customer resource to look up — the payer lives on the order. ' +
        'Read it from `payment.payload.customer`, or from your own records.',
    );
  }

  async updateCustomer(_customerId: string, _input: UpdateCustomerInput): Promise<Customer> {
    throw new Error(
      '[payments] PagBank has no customer resource to update — the payer is sent inline with every order.',
    );
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    const method = this.#resolveMethod(input);
    const body: Record<string, unknown> = {
      // `reference_id` is the app's own id, echoed back on the order and on the webhook —
      // the routing key handlers read. `idempotencyKey` doubles as it only when no
      // explicit reference was given (same rule as the Asaas driver).
      ...(input.externalReference !== undefined || input.idempotencyKey !== undefined
        ? { reference_id: input.externalReference ?? input.idempotencyKey }
        : {}),
      customer: this.#requireCustomer(input),
      items: [
        {
          name: input.description ?? 'Payment',
          quantity: 1,
          // Centavos, straight through: PagBank speaks the same unit this library does.
          unit_amount: input.amount,
        },
      ],
      ...(this.#notificationUrls.length > 0 ? { notification_urls: this.#notificationUrls } : {}),
      charges: [this.#buildCharge(input, method)],
    };

    const order = await this.#request<PagBankOrder>('/orders', {
      method: 'POST',
      body,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const payment = this.#mapOrder(order);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      // Accept either id: the driver hands out order ids, but a charge id (`CHAR_…`) read
      // off a payload should not be a dead end.
      if (gatewayId.startsWith('CHAR_')) {
        const charge = await this.#request<PagBankCharge>(`/charges/${gatewayId}`);
        return this.#mapOrder({ id: gatewayId, charges: [charge] });
      }
      const order = await this.#request<PagBankOrder>(`/orders/${gatewayId}`);
      return this.#mapOrder(order);
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
    const charge = await this.#resolveCharge(paymentGatewayId);
    // PagBank wants the amount on every cancel, so a "full refund" is spelled out as the
    // amount actually paid rather than left to a default this driver cannot see.
    const value = amount ?? charge.amount.summary?.paid ?? charge.amount.value;
    const data = await this.#request<PagBankCharge>(`/charges/${charge.id}/cancel`, {
      method: 'POST',
      body: { amount: { value } },
      // Same `x-idempotency-key` the charge uses: a retried cancel with the key returns
      // the original refund instead of taking the money out a second time.
      ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    });
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: { amount: value, currency: 'brl' },
      // A full cancel flips the charge to CANCELED; a partial one leaves it PAID with a
      // non-zero `refunded` summary. Either way PagBank accepted the refund.
      status:
        data.status === 'CANCELED' || (data.amount.summary?.refunded ?? 0) > 0
          ? 'succeeded'
          : 'pending',
      createdAt: new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    // PagBank's hosted, "we render the payment page" product is Checkout PagBank — a
    // different API (`/checkouts`) with its own contract. From the Orders API the closest
    // honest thing is a Pix order: the payer gets a BR Code, not a redirect, so `url` is
    // empty rather than pointing somewhere that does not exist.
    const order = await this.#request<PagBankOrder>('/orders', {
      method: 'POST',
      body: {
        // Same routing key as a charge: PagBank echoes `reference_id` on the order and on
        // every webhook it sends about it.
        ...(input.externalReference !== undefined || input.idempotencyKey !== undefined
          ? { reference_id: input.externalReference ?? input.idempotencyKey }
          : {}),
        customer: this.#requireCustomer(input),
        items: [{ name: input.description ?? 'Checkout', quantity: 1, unit_amount: input.amount }],
        ...(this.#notificationUrls.length > 0 ? { notification_urls: this.#notificationUrls } : {}),
        charges: [
          {
            ...(input.description !== undefined ? { description: input.description } : {}),
            amount: { value: input.amount, currency: 'BRL' },
            payment_method: {
              type: 'PIX',
              pix: { expiration_date: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
            },
          },
        ],
      },
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const brCode = order.charges?.[0]?.qr_code?.text ?? order.qr_codes?.[0]?.text;
    return {
      id: order.id,
      gatewayId: order.id,
      provider: this.provider,
      url: '',
      status: 'open',
      amount: { amount: input.amount, currency: 'brl' },
      ...(brCode !== undefined ? { pixCode: brCode, pixCopiaECola: brCode } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(_input: CreateSubscriptionInput): Promise<Subscription> {
    throw new Error(
      '[payments] PagBank recurring billing is a separate product (the Assinaturas API), not the Orders API this driver speaks. ' +
        'Charge each cycle yourself, or add a driver for the Assinaturas API.',
    );
  }

  async cancelSubscription(
    _subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    throw new Error(
      '[payments] PagBank subscriptions live in the Assinaturas API, which this driver does not speak.',
    );
  }

  async updateSubscription(
    _subscriptionGatewayId: string,
    _input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    throw new Error(
      '[payments] PagBank subscriptions live in the Assinaturas API, which this driver does not speak.',
    );
  }

  async findSubscription(_gatewayId: string): Promise<Subscription | null> {
    throw new Error(
      '[payments] PagBank subscriptions live in the Assinaturas API, which this driver does not speak.',
    );
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    // `capabilities.invoices` is false, so this throws rather than returning `[]`: an
    // empty array is indistinguishable from "this customer has no invoices", which is
    // not something PagBank told us. The Orders API has no invoice concept and no
    // per-customer index to list over — orders are found by their own id or by
    // `reference_id`.
    throw new Error(
      '[payments] PagBank has no invoices to list. The Orders API indexes orders by their own id ' +
        'or by `reference_id`, not by customer, and has no invoice resource. Use `findPayment`, or ' +
        'an invoice provider with `invoice: true` for a fiscal note.',
    );
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (this.#verifyWebhooks) {
      const received = headerValue(headers, 'x-authenticity-token');
      if (!verifyPagBankAuthenticityToken(rawBody, received, this.#webhookToken)) {
        throw new Error(
          '[payments] Invalid or missing PagBank webhook authenticity token (`x-authenticity-token`).',
        );
      }
    }

    let payload: PagBankOrder;
    try {
      payload = JSON.parse(rawBody) as PagBankOrder;
    } catch {
      // PagBank's *post-transaction* events (balance released, chargeback) still use the
      // legacy form-encoded `notificationCode=…&notificationType=transaction` shape, which
      // is a different API with a different lookup and no authenticity token at all.
      throw new Error(
        '[payments] PagBank webhook body is not JSON. This driver handles Orders API notifications; ' +
          'legacy `notificationCode` notifications (post-transaction events) need their own route.',
      );
    }
    if (typeof payload.id !== 'string') {
      throw new Error('[payments] PagBank webhook payload has no order id.');
    }

    const charge = payload.charges?.[0];
    const status = charge?.status;
    const refunded = charge?.amount.summary?.refunded ?? 0;
    const payment = this.#mapOrder(payload);
    return {
      // PagBank sends no event id, so it is derived from what changed: the same state
      // transition redelivered dedupes in the ledger, a later transition does not.
      id: `${payload.id}:${charge?.id ?? 'order'}:${status ?? 'CREATED'}:${refunded}`,
      provider: this.provider,
      type: this.#mapWebhookType(status, refunded),
      createdAt: charge?.paid_at ?? charge?.created_at ?? new Date().toISOString(),
      data: {
        gatewayId: payment.gatewayId,
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        ...(payload.reference_id !== undefined ? { externalReference: payload.reference_id } : {}),
        ...(charge !== undefined
          ? { metadata: { chargeId: charge.id, status: charge.status } }
          : {}),
      },
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  /**
   * Normalize an order (the shape both the API and the webhook return) into a
   * {@link Payment}. `gatewayId` is the ORDER id — see the class doc for why.
   */
  #mapOrder(order: PagBankOrder): Payment {
    const charge = order.charges?.[0];
    const qr = order.qr_codes?.[0];
    // Integer centavos on both sides — unlike the Asaas/Woovi drivers there is no
    // `fromDecimal` here, and that is deliberate: PagBank's `amount.value` already IS the
    // currency's smallest unit, so converting would divide the money by a hundred.
    const amount = charge?.amount.value ?? qr?.amount.value ?? 0;
    const refunded = charge?.amount.summary?.refunded ?? 0;
    const result: Payment = {
      id: order.id,
      gatewayId: order.id,
      provider: this.provider,
      amount: { amount, currency: 'brl' },
      status: this.#mapStatus(charge?.status, refunded),
      payload: order as unknown as Record<string, unknown>,
      createdAt: order.created_at ?? charge?.created_at ?? new Date().toISOString(),
    };
    const method = this.#mapMethodToType(charge, qr);
    if (method !== 'unknown') result.method = method;
    // v2 Pix puts the BR Code on the charge; the older order-level `qr_codes` shape is
    // still read, because an account or an old webhook can still deliver it.
    const brCode = charge?.qr_code?.text ?? qr?.text;
    if (brCode !== undefined) {
      result.pixCode = brCode;
      result.pixCopiaECola = brCode;
    }
    // No `pixQrCodeImage`: PagBank returns *links* to the rendered PNG/base64, not the
    // image itself, and this field is documented as base64 content. The links stay in
    // `payload.qr_codes[0].links` rather than being passed off as something they are not.
    const payLink = charge?.links?.find((link) => link.rel === 'PAY');
    if (payLink !== undefined) result.hostedUrl = payLink.href;
    if (charge?.paid_at !== undefined) result.paidAt = charge.paid_at;
    return result;
  }

  #mapStatus(status: PagBankCharge['status'] | undefined, refunded: number): Payment['status'] {
    if (refunded > 0) return 'refunded';
    switch (status) {
      case 'PAID':
        return 'paid';
      case 'DECLINED':
        return 'failed';
      case 'CANCELED':
        return 'canceled';
      // A pre-authorization: PagBank is holding the money on the card and nothing has
      // been captured. It used to collapse into `pending`, which understates a hold the
      // acquirer has already granted — and `paid` would have been worse, since an
      // authorization expires. IN_ANALYSIS and WAITING are plainly not paid either, and
      // an unpaid Pix order has no charge at all.
      case 'AUTHORIZED':
        return 'authorized';
      default:
        return 'pending';
    }
  }

  #mapWebhookType(status: PagBankCharge['status'] | undefined, refunded: number): string {
    if (refunded > 0) return 'payment.refunded';
    switch (status) {
      case 'PAID':
        return 'payment.succeeded';
      case 'DECLINED':
      case 'CANCELED':
        return 'payment.failed';
      default:
        return 'payment.updated';
    }
  }

  #mapMethodToType(
    charge: PagBankCharge | undefined,
    qr: PagBankQrCode | undefined,
  ): PaymentMethodType {
    switch (charge?.payment_method?.type) {
      case 'PIX':
        return 'pix';
      case 'CREDIT_CARD':
        return 'card';
      case 'DEBIT_CARD':
        return 'debit_card';
      case 'BOLETO':
        return 'boleto';
      default:
        return qr !== undefined ? 'pix' : 'unknown';
    }
  }

  // ── Request building ─────────────────────────────────────────────────────────────────

  /** Which PagBank flow this charge is: Pix (a QR code) or a charge (card/boleto). */
  #resolveMethod(input: ChargeInput): 'pix' | 'boleto' | 'credit_card' | 'debit_card' {
    if (input.method === 'pix') return 'pix';
    if (input.method === 'boleto') return 'boleto';
    if (input.method === 'debit_card') return 'debit_card';
    if (
      input.method === 'credit_card' ||
      input.paymentMethodId !== undefined ||
      input.card !== undefined
    ) {
      return 'credit_card';
    }
    return 'pix';
  }

  #buildCharge(
    input: ChargeInput,
    method: 'pix' | 'boleto' | 'credit_card' | 'debit_card',
  ): Record<string, unknown> {
    const paymentMethod: Record<string, unknown> =
      method === 'pix'
        ? // Pix is a charge with its own `payment_method`, not an order-level `qr_codes`
          // entry: PagBank's v2 Pix flow returns the BR Code on `charges[].qr_code.text`.
          { type: 'PIX', pix: { expiration_date: this.#pixExpiration(input) } }
        : method === 'boleto'
          ? { type: 'BOLETO', boleto: this.#buildBoleto(input) }
          : {
              type: method === 'debit_card' ? 'DEBIT_CARD' : 'CREDIT_CARD',
              installments: Number(input.metadata?.installments ?? 1),
              capture: input.metadata?.capture !== false,
              card: this.#buildCard(input),
            };
    return {
      ...(input.externalReference !== undefined ? { reference_id: input.externalReference } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      amount: { value: input.amount, currency: 'BRL' },
      payment_method: paymentMethod,
    };
  }

  #buildCard(input: ChargeInput): Record<string, unknown> {
    const token = input.card?.token ?? input.paymentMethodId;
    if (token === undefined) {
      throw new Error(
        "[payments] PagBank card charge needs a card. Pass `card: { token }` (the blob from PagBank's " +
          'card-encryption SDK) or `paymentMethodId` (a stored `CARD_…` id).',
      );
    }
    // PagBank takes either a saved card id or the encrypted blob its frontend SDK
    // produces. The `CARD_` prefix is the only thing that tells them apart.
    const card: Record<string, unknown> = token.startsWith('CARD_')
      ? { id: token }
      : { encrypted: token };
    const holderName = input.card?.holder?.name ?? input.customer?.name;
    if (holderName !== undefined) card.holder = { name: holderName };
    if (input.card?.holder === undefined && input.metadata?.store === true) card.store = true;
    return card;
  }

  #buildBoleto(input: ChargeInput): Record<string, unknown> {
    const holder = input.customer ?? {
      ...(input.card?.holder !== undefined
        ? {
            name: input.card.holder.name,
            email: input.card.holder.email,
            taxId: input.card.holder.cpfCnpj,
          }
        : {}),
    };
    const address = input.metadata?.address as Record<string, unknown> | undefined;
    if (!holder.name || !holder.taxId || !holder.email || address === undefined) {
      throw new Error(
        '[payments] PagBank boleto needs the payer on the charge: `customer: { name, email, taxId }` ' +
          'plus `metadata.address` (street, number, locality, city, region_code, country, postal_code) — ' +
          'PagBank prints them on the boleto and refuses the charge without them.',
      );
    }
    return {
      due_date:
        (input.metadata?.dueDate as string | undefined) ??
        new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      instruction_lines: (input.metadata?.instructionLines as
        | Record<string, string>
        | undefined) ?? {
        line_1: 'Pagamento processado para',
        line_2: input.description ?? 'DESC Sistema',
      },
      holder: {
        name: holder.name,
        tax_id: holder.taxId.replace(/\D/g, ''),
        email: holder.email,
        address,
      },
    };
  }

  /** PagBank requires the payer (with a CPF/CNPJ) on every order. */
  #requireCustomer(input: ChargeInput | CheckoutInput): Record<string, unknown> {
    const source =
      'customer' in input && input.customer !== undefined
        ? input.customer
        : 'card' in input && input.card?.holder !== undefined
          ? {
              name: input.card.holder.name,
              email: input.card.holder.email,
              taxId: input.card.holder.cpfCnpj,
            }
          : undefined;
    if (!source?.name || !source.email || !source.taxId) {
      throw new Error(
        '[payments] PagBank requires the payer on every order. Pass `customer: { name, email, taxId }` ' +
          '(CPF or CNPJ) on the charge — the Orders API has no stored customer to reference.',
      );
    }
    return {
      name: source.name,
      email: source.email,
      tax_id: source.taxId.replace(/\D/g, ''),
      ...(input.metadata?.phones !== undefined ? { phones: input.metadata.phones } : {}),
    };
  }

  #pixExpiration(input: ChargeInput): string {
    const explicit = input.metadata?.expirationDate as string | undefined;
    if (explicit !== undefined) return explicit;
    const minutes = Number(input.metadata?.expiresInMinutes ?? 60);
    return new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }

  /** The `CHAR_…` behind an id that may be an order id or a charge id. */
  async #resolveCharge(gatewayId: string): Promise<PagBankCharge> {
    if (gatewayId.startsWith('CHAR_')) {
      return this.#request<PagBankCharge>(`/charges/${gatewayId}`);
    }
    const order = await this.#request<PagBankOrder>(`/orders/${gatewayId}`);
    const charge = order.charges?.[0];
    if (charge === undefined) {
      throw new Error(
        `[payments] PagBank order ${gatewayId} has no charge to refund. A Pix order only becomes a charge once it is paid.`,
      );
    }
    return charge;
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown>; idempotencyKey?: string } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      bearerToken: this.#token,
      // PagBank deduplicates on this header for 48h — a retried charge with the same key
      // returns the original order instead of creating a second one.
      ...(options.idempotencyKey !== undefined
        ? { headers: { 'x-idempotency-key': options.idempotencyKey } }
        : {}),
    });
  }
}
