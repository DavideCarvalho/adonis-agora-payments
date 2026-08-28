import { randomUUID } from 'node:crypto';
import type { InfinitePayDriverConfig } from '../define_config.js';
import { publishPaymentDiagnostics } from '../diagnostics.js';
import type {
  ChargeInput,
  CheckoutInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  PaymentsDriver,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
} from '../driver.js';
import { httpRequest } from '../http.js';
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
import { requireCredential } from './shared.js';

/** One line of an InfinitePay checkout cart. `price` is in centavos, like {@link Money}. */
export interface InfinitePayItem {
  quantity: number;
  price: number;
  description: string;
}

/** The buyer data a checkout link can be pre-filled with (write-only — nothing reads it back). */
export interface InfinitePayCustomerInput {
  name?: string;
  email?: string;
  phone_number?: string;
}

/** The delivery address a checkout link can be pre-filled with. */
export interface InfinitePayAddressInput {
  cep?: string;
  street?: string;
  neighborhood?: string;
  number?: string;
  complement?: string;
}

/** The three ids `payment_check` needs; all three only exist once a payment happened. */
export interface InfinitePayCheckInput {
  /** Your own order id, the one sent as `order_nsu` when the link was created. */
  orderNsu: string;
  /** The gateway transaction id, from the webhook or the redirect query string. */
  transactionNsu: string;
  /** The invoice slug, from the webhook (`invoice_slug`) or the redirect query string. */
  slug: string;
}

interface InfinitePayLinkResponse {
  url: string;
}

interface InfinitePayCheckResponse {
  success?: boolean;
  paid?: boolean;
  amount?: number;
  paid_amount?: number;
  installments?: number;
  capture_method?: string;
  message?: string;
}

/** The body InfinitePay POSTs to a link's `webhook_url` once a payment is approved. */
interface InfinitePayWebhookPayload {
  invoice_slug?: string;
  amount?: number;
  paid_amount?: number;
  installments?: number;
  capture_method?: string;
  transaction_nsu?: string;
  order_nsu?: string;
  receipt_url?: string;
  items?: InfinitePayItem[];
}

/**
 * InfinitePay driver — CloudWalk's Brazilian payments product (infinitepay.io).
 *
 * **This is a redirect-checkout driver, and nothing more.** InfinitePay's only currently
 * documented developer API is the Checkout / Payment Link API: you create a link, send the
 * payer to it, and InfinitePay calls a per-link webhook once the payment is approved. There
 * is no documented server-side charge API, no refund endpoint, no customer resource, no
 * subscription API and no way to list anything — so every method outside
 * {@link InfinitePayDriver.createCheckout}, {@link InfinitePayDriver.parseWebhook} and
 * {@link InfinitePayDriver.checkPayment} throws rather than calling an endpoint that does
 * not exist. (A v2 transactions API did exist and is still referenced by CloudWalk's
 * abandoned WooCommerce and Magento plugins, but its documentation host is gone and its
 * credentials were handed out by email; building on it would be building on an archive.)
 *
 * Three consequences worth knowing before you configure it:
 *
 * - **The credential is a `handle`, not a secret.** The link endpoint is public and
 *   unauthenticated; the `handle` (your InfiniteTag) is what identifies the merchant. Enable
 *   *Vendas → Checkout → Configurações → Habilitar Checkout Integrado* in the app first, or
 *   link creation is refused.
 * - **The webhook is unauthenticated.** No signature, no HMAC, no shared token — InfinitePay
 *   documents none. `parseWebhook` therefore cannot verify anything; treat the payload as a
 *   hint that something happened and confirm it with {@link InfinitePayDriver.checkPayment}
 *   before you credit an order.
 * - **`webhook_url` is per link.** There is no global endpoint to register, so the driver
 *   sends one on every link it creates — configure `webhookUrl` (or `INFINITEPAY_WEBHOOK_URL`)
 *   or no webhook will ever arrive.
 */
export class InfinitePayDriver implements PaymentsDriver {
  readonly provider = 'infinitepay';
  /**
   * What the hosted checkout page settles with (`capture_method` comes back as
   * `credit_card` or `pix`). Boleto is not offered. These are the methods a *link* accepts —
   * routing a charge here still fails, because there is no charge API.
   */
  readonly supportedMethods = ['pix', 'credit_card'] as const;
  /** Nothing beyond checkout: no refunds, no invoices, no subscriptions. */
  readonly capabilities = { refunds: false, invoices: false, subscriptions: false };

  #baseUrl: string;
  #handle: string;
  #webhookUrl: string | undefined;

  constructor(_ctx: EmitInvoiceContext, config: InfinitePayDriverConfig = {}) {
    this.#handle = requireCredential({
      driver: 'infinitepay',
      option: 'handle',
      env: 'INFINITEPAY_HANDLE',
      value: config.handle,
    });
    this.#baseUrl = config.baseUrl ?? 'https://api.checkout.infinitepay.io';
    this.#webhookUrl = config.webhookUrl ?? process.env.INFINITEPAY_WEBHOOK_URL;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a checkout link (`POST /links`) and returns the URL to send the payer to.
   *
   * The gateway answers with `{ "url": … }` and nothing else — no link id, no session id —
   * so the session's `id`/`gatewayId` is the `order_nsu` this call sent. That is also the
   * only id the webhook and {@link InfinitePayDriver.checkPayment} speak in, which makes it
   * the right thing to store against your local order.
   *
   * `cancelUrl` is ignored: a link has one `redirect_url`, used on success, and the API has
   * no cancel destination to map onto.
   */
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (input.planId !== undefined || input.trialDays !== undefined) {
      throw new Error(
        '[payments] InfinitePay has no documented subscription API — a checkout link cannot ' +
          'create a recurring plan. Drop `planId`/`trialDays`, or route subscriptions to another provider.',
      );
    }

    const items = this.#items(input);
    const orderNsu = this.#orderNsu(input);
    const webhookUrl = (input.metadata?.webhookUrl as string | undefined) ?? this.#webhookUrl;
    const body: Record<string, unknown> = {
      handle: this.#handle,
      order_nsu: orderNsu,
      items,
      redirect_url: input.successUrl,
      ...(webhookUrl !== undefined ? { webhook_url: webhookUrl } : {}),
      ...(input.metadata?.customer !== undefined ? { customer: input.metadata.customer } : {}),
      ...(input.metadata?.address !== undefined ? { address: input.metadata.address } : {}),
    };

    const data = await this.#request<InfinitePayLinkResponse>('/links', {
      method: 'POST',
      body,
    });
    if (typeof data.url !== 'string' || data.url === '') {
      throw new Error(
        `[payments] InfinitePay returned no checkout URL for handle "${this.#handle}". Check the handle and that "Checkout Integrado" is enabled in the InfinitePay app.`,
      );
    }
    return {
      id: orderNsu,
      gatewayId: orderNsu,
      provider: this.provider,
      url: data.url,
      status: 'open',
      amount: {
        amount: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
        currency: 'brl',
      },
    };
  }

  // ── Payment status ───────────────────────────────────────────────────────────────────

  /**
   * Confirms a payment with `POST /payment_check` — the only status lookup InfinitePay
   * documents, and the one its own docs tell you to run before crediting an order.
   *
   * It needs all three of `orderNsu`, `transactionNsu` and `slug`, and the last two only
   * come into existence when the payment does (they arrive on the webhook and on the
   * redirect query string). There is consequently **no way to poll a link that has not been
   * paid** — a pending link is invisible to the API, which is why
   * {@link InfinitePayDriver.findPayment} cannot be implemented and this method exists in
   * its place.
   */
  async checkPayment(input: InfinitePayCheckInput): Promise<Payment | null> {
    const data = await this.#request<InfinitePayCheckResponse>('/payment_check', {
      method: 'POST',
      body: {
        handle: this.#handle,
        order_nsu: input.orderNsu,
        transaction_nsu: input.transactionNsu,
        slug: input.slug,
      },
    });
    if (data.success === false) return null;
    const payment = this.#mapPayment({
      order_nsu: input.orderNsu,
      transaction_nsu: input.transactionNsu,
      invoice_slug: input.slug,
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.paid_amount !== undefined ? { paid_amount: data.paid_amount } : {}),
      ...(data.installments !== undefined ? { installments: data.installments } : {}),
      ...(data.capture_method !== undefined ? { capture_method: data.capture_method } : {}),
    });
    if (data.paid !== true) payment.status = 'pending';
    publishPaymentDiagnostics(payment);
    return payment;
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Normalizes the per-link webhook InfinitePay POSTs when a payment is approved.
   *
   * **It verifies nothing, because there is nothing to verify.** InfinitePay documents no
   * signature, no HMAC and no shared token for the checkout webhook — the security advice in
   * its own docs is to re-check the payment instead. So an event out of this method means
   * "somebody claimed a payment happened", not "a payment happened": confirm it with
   * {@link InfinitePayDriver.checkPayment} (`event.raw` carries the three ids it needs)
   * before you credit anything, and put an unguessable segment in the `webhookUrl` you
   * configure so the endpoint is at least not trivially discoverable.
   */
  parseWebhook(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const payload = JSON.parse(rawBody) as InfinitePayWebhookPayload;
    const payment = this.#mapPayment(payload);
    return {
      // The webhook has no event id of its own; the transaction is the stable, idempotent key.
      id: payload.transaction_nsu ?? payload.invoice_slug ?? `infinitepay-${randomUUID()}`,
      provider: this.provider,
      // The webhook fires on approved payments only. InfinitePay's checkout reference
      // documents exactly one notification — "quando o pagamento for aprovado" — and two
      // endpoints (`POST /links`, `POST /payment_check`). There is no failure event, no
      // refund event and **no dispute vocabulary at all**: no chargeback webhook, no
      // pre-dispute alert, no dispute resource. A contested sale is handled inside the
      // InfinitePay app, which is also the only place defense documents can be uploaded,
      // and the first the integration hears of one is the debit on the statement. So this
      // is unconditionally `payment.succeeded` — there is nothing else it could be.
      type: 'payment.succeeded',
      createdAt: new Date().toISOString(),
      data: {
        gatewayId: payment.gatewayId,
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        ...(payload.order_nsu !== undefined ? { externalReference: payload.order_nsu } : {}),
      },
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Not exposed by the gateway ───────────────────────────────────────────────────────

  /**
   * Not supported. InfinitePay documents no server-side charge API — the only way to take
   * money is to send the payer to a checkout link.
   */
  async charge(_input: ChargeInput): Promise<Payment> {
    throw new Error(
      '[payments] InfinitePay has no documented server-side charge API. ' +
        'Use `createCheckout()` and redirect the payer to the returned URL.',
    );
  }

  /**
   * Not supported. `payment_check` needs the transaction id and the invoice slug alongside
   * your order id, and both only exist after payment — see
   * {@link InfinitePayDriver.checkPayment}.
   */
  async findPayment(gatewayId: string): Promise<Payment | null> {
    throw new Error(
      `[payments] InfinitePay cannot look payment "${gatewayId}" up by id alone: \`payment_check\` needs order_nsu + transaction_nsu + slug, and the last two only exist once the payment does. ` +
        `Call \`checkPayment({ orderNsu: '${gatewayId}', transactionNsu, slug })\` with the ids from the webhook or the redirect URL.`,
    );
  }

  /** Not supported. InfinitePay documents no refund endpoint; refunds go through the app. */
  async refund(_paymentGatewayId: string, _amount?: Money): Promise<Refund> {
    throw new Error(
      '[payments] InfinitePay has no documented refund API. Refund from the InfinitePay app.',
    );
  }

  /**
   * Not supported. A checkout link takes buyer data as a write-only field; InfinitePay has
   * no customer resource to create, read or update.
   */
  async createCustomer(_input: CreateCustomerInput): Promise<Customer> {
    throw new Error(
      '[payments] InfinitePay has no customer API. Pass buyer data per checkout instead ' +
        '(`metadata.customer` on `createCheckout`).',
    );
  }

  /** Not supported — see {@link InfinitePayDriver.createCustomer}. */
  async findCustomer(_customerId: string): Promise<Customer | null> {
    throw new Error('[payments] InfinitePay has no customer API to look a customer up in.');
  }

  /** Not supported — see {@link InfinitePayDriver.createCustomer}. */
  async updateCustomer(_customerId: string, _input: UpdateCustomerInput): Promise<Customer> {
    throw new Error('[payments] InfinitePay has no customer API to update.');
  }

  /** Not supported. InfinitePay sells recurring billing as an app feature, with no public API. */
  async createSubscription(_input: CreateSubscriptionInput): Promise<Subscription> {
    throw new Error(
      '[payments] InfinitePay has no documented subscription API. Route subscriptions to another provider.',
    );
  }

  /** Not supported — see {@link InfinitePayDriver.createSubscription}. */
  async cancelSubscription(
    _subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    throw new Error('[payments] InfinitePay has no documented subscription API to cancel.');
  }

  /** Not supported — see {@link InfinitePayDriver.createSubscription}. */
  async updateSubscription(
    _subscriptionGatewayId: string,
    _input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    throw new Error('[payments] InfinitePay has no documented subscription API to update.');
  }

  /** Not supported — see {@link InfinitePayDriver.createSubscription}. */
  async findSubscription(_gatewayId: string): Promise<Subscription | null> {
    throw new Error('[payments] InfinitePay has no documented subscription API to read.');
  }

  /** Not supported. InfinitePay exposes no list or search endpoint of any kind. */
  async listInvoices(_customerId: string): Promise<Invoice[]> {
    throw new Error(
      '[payments] InfinitePay has no invoice or listing API. Read your own billing tables instead.',
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────

  /**
   * The cart the link is built from. One line by default; `metadata.items` passes a real
   * cart, which must add up to `amount` — a mismatch would charge one number while the
   * caller booked another.
   */
  #items(input: CheckoutInput): InfinitePayItem[] {
    const provided = input.metadata?.items as InfinitePayItem[] | undefined;
    if (Array.isArray(provided) && provided.length > 0) {
      const total = provided.reduce((sum, item) => sum + item.price * item.quantity, 0);
      if (total !== input.amount) {
        throw new Error(
          `[payments] InfinitePay checkout items add up to ${total} but the checkout amount ` +
            `is ${input.amount}. Both are in centavos — make them agree.`,
        );
      }
      return provided;
    }
    return [{ quantity: 1, price: input.amount, description: input.description ?? 'Checkout' }];
  }

  /**
   * The `order_nsu` — the one field InfinitePay echoes back, on the webhook and on the
   * redirect. It is therefore where {@link CheckoutInput.externalReference} goes: without
   * it a confirmation cannot be routed to an order. Falls back to `metadata.orderNsu`,
   * then the idempotency key (routing, not deduplication: InfinitePay documents no
   * idempotency, so a repeated call makes a second link), then a generated id.
   */
  #orderNsu(input: CheckoutInput): string {
    return (
      input.externalReference ??
      (input.metadata?.orderNsu as string | undefined) ??
      input.idempotencyKey ??
      randomUUID()
    );
  }

  #mapPayment(payload: InfinitePayWebhookPayload): Payment {
    const amount = payload.paid_amount ?? payload.amount ?? 0;
    const payment: Payment = {
      // The transaction is the gateway's own id for the money; `order_nsu` is ours.
      id: payload.transaction_nsu ?? payload.order_nsu ?? payload.invoice_slug ?? '',
      gatewayId: payload.transaction_nsu ?? payload.order_nsu ?? payload.invoice_slug ?? '',
      provider: this.provider,
      // Amounts are integer centavos on both sides — no conversion, unlike the decimal-reais
      // Brazilian gateways.
      amount: { amount, currency: 'brl' },
      // The webhook only fires on approval, and `payment_check` answers `paid`.
      status: 'paid',
      payload: payload as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
    };
    const method = this.#mapMethod(payload.capture_method);
    if (method !== 'unknown') payment.method = method;
    if (payload.receipt_url !== undefined) payment.hostedUrl = payload.receipt_url;
    return payment;
  }

  #mapMethod(captureMethod: string | undefined): PaymentMethodType {
    switch (captureMethod) {
      case 'pix':
        return 'pix';
      case 'credit_card':
      case 'credit':
        return 'card';
      default:
        return 'unknown';
    }
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    // No auth header: the checkout endpoints are public and identify the merchant by `handle`.
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
  }
}
