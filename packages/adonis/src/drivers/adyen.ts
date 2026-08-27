import { createHmac } from 'node:crypto';
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
import { httpRequest } from '../http.js';
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
import { safeCompare } from '../webhook_security.js';
import { requireCredential, requireCurrency } from './shared.js';

/** Config for `payments.adyen()`. Multi-currency and merchant-scoped, so both are required. */
export interface AdyenDriverConfig {
  /** Adyen API key, sent as `X-API-Key`. Defaults to `env.get('ADYEN_API_KEY')`. */
  apiKey?: string;
  /**
   * The merchant account every Checkout call is scoped to (Customer Area → the account
   * code, not the company account). Defaults to `env.get('ADYEN_MERCHANT_ACCOUNT')`.
   */
  merchantAccount?: string;
  /**
   * Currency for calls that don't name one (lowercase ISO 4217). **Required** — Adyen
   * charges whatever currency you send it, so a default would be a guess at the country
   * the app bills in, and the wrong guess still takes money.
   */
  currency: string;
  /**
   * The webhook HMAC key generated in the Customer Area — a **hex** string. Defaults to
   * `env.get('ADYEN_HMAC_KEY')`. When set, a webhook without a valid
   * `additionalData.hmacSignature` is rejected.
   */
  hmacKey?: string;
  /**
   * Live only: your account's URL prefix (Customer Area → Developers → API URLs), the
   * `{prefix}` in `https://{prefix}-checkout-live.adyenpayments.com`. Defaults to
   * `env.get('ADYEN_LIVE_URL_PREFIX')`.
   */
  liveUrlPrefix?: string;
  /** Which Adyen environment to talk to. Defaults to test unless `NODE_ENV=production`. */
  environment?: 'test' | 'live';
}

interface AdyenAmount {
  value: number;
  currency: string;
}

interface AdyenPaymentResponse {
  pspReference?: string;
  resultCode: string;
  merchantReference?: string;
  amount?: AdyenAmount;
  refusalReason?: string;
  additionalData?: Record<string, string>;
  action?: Record<string, unknown>;
}

interface AdyenRefundResponse {
  pspReference: string;
  paymentPspReference: string;
  reference?: string;
  amount: AdyenAmount;
  status: string;
  merchantAccount: string;
}

interface AdyenPaymentLinkResponse {
  id: string;
  url: string;
  status: string;
  amount: AdyenAmount;
  reference: string;
  expiresAt?: string;
  shopperReference?: string;
}

interface AdyenNotificationRequestItem {
  eventCode: string;
  success: string;
  eventDate?: string;
  pspReference?: string;
  originalReference?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  amount?: AdyenAmount;
  paymentMethod?: string;
  reason?: string;
  additionalData?: Record<string, string>;
}

interface AdyenNotification {
  live?: string;
  notificationItems?: Array<{ NotificationRequestItem: AdyenNotificationRequestItem }>;
}

/**
 * Adyen driver — Checkout API v71, `X-API-Key` auth, merchant-account scoped.
 *
 * Adyen is a processor, not a billing system, and this driver refuses rather than
 * pretends where the two disagree: there is no customer resource (a `shopperReference` is
 * a string you invent), no endpoint that reads a payment back by its `pspReference`, and
 * no subscription object at all — recurring billing at Adyen is you charging a stored
 * token on your own schedule. Money is already an integer in minor units
 * (`{ "value": 1990, "currency": "EUR" }`), so nothing here converts it.
 */
export class AdyenDriver implements PaymentsDriver {
  readonly provider = 'adyen';
  /**
   * `charge()` sends a stored card token (`paymentMethod.type: 'scheme'`), and
   * `createCheckout()` opens a Pay by Link page where the shopper picks. Adyen's other
   * ~100 local methods only reach a shopper through Drop-in/Components, which this driver
   * does not front, and the `PaymentMethodName` union has no name for them anyway.
   */
  readonly supportedMethods = ['credit_card', 'undefined'] as const;
  /** No invoice resource in the Checkout API, and no subscription resource anywhere. */
  readonly capabilities = { refunds: true, invoices: false, subscriptions: false };

  #baseUrl: string;
  #apiKey: string;
  #merchantAccount: string;
  #currency: string;
  #hmacKey: string | undefined;
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: AdyenDriverConfig) {
    this.#invoiceCtx = ctx;
    this.#apiKey = requireCredential({
      driver: 'adyen',
      option: 'apiKey',
      env: 'ADYEN_API_KEY',
      value: config.apiKey,
    });
    this.#merchantAccount = requireCredential({
      driver: 'adyen',
      option: 'merchantAccount',
      env: 'ADYEN_MERCHANT_ACCOUNT',
      value: config.merchantAccount,
    });
    this.#currency = requireCurrency('adyen', config.currency);
    this.#hmacKey = config.hmacKey ?? process.env.ADYEN_HMAC_KEY;

    const environment =
      config.environment ?? (process.env.NODE_ENV === 'production' ? 'live' : 'test');
    if (environment === 'live') {
      // Live traffic goes to a per-customer host; the generic live domain does not exist,
      // so this has to fail at boot rather than as a DNS error on the first charge.
      const prefix = requireCredential({
        driver: 'adyen',
        option: 'liveUrlPrefix',
        env: 'ADYEN_LIVE_URL_PREFIX',
        value: config.liveUrlPrefix,
      });
      this.#baseUrl = `https://${prefix}-checkout-live.adyenpayments.com/checkout/v71`;
    } else {
      this.#baseUrl = 'https://checkout-test.adyen.com/v71';
    }
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(_input: CreateCustomerInput): Promise<Customer> {
    throw new Error(
      '[payments] Adyen has no customer resource to create. Its `shopperReference` is a ' +
        'string you choose (your own user id) and it exists only on the payments that carry ' +
        'it — pass yours as `customerId` on `charge`/`createCheckout`.',
    );
  }

  async findCustomer(_customerId: string): Promise<Customer | null> {
    throw new Error(
      '[payments] Adyen has no customer resource to look up. Use ' +
        '`GET /v71/storedPaymentMethods?shopperReference=…` if you need the tokens saved ' +
        'for a shopper.',
    );
  }

  async updateCustomer(_customerId: string, _input: UpdateCustomerInput): Promise<Customer> {
    throw new Error(
      '[payments] Adyen has no customer resource to update — `shopperReference` is a plain ' +
        'string on each payment, and shopper details live in your own database.',
    );
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    if (input.split !== undefined && input.split.length > 0) {
      throw new Error(
        '[payments] Adyen splits with absolute amounts against balance accounts ' +
          '(`splits[].account`), which the percent-based `split` input cannot express. ' +
          'Build the `splits` array yourself against the Adyen Checkout API.',
      );
    }
    // Adyen's Checkout API has no server-side way to charge without a payment method: a
    // fresh card arrives through Drop-in/Components, and a saved one is a token.
    const token = input.card?.token ?? input.paymentMethodId;
    if (token === undefined) {
      throw new Error(
        '[payments] Adyen needs a payment method on every charge. Pass a stored token as ' +
          '`paymentMethodId` (or `card.token`), or send the shopper to ' +
          '`createCheckout()` (Pay by Link).',
      );
    }
    // `reference` is mandatory at Adyen and comes back as `merchantReference` on every
    // webhook — the only thing tying a notification to a local row.
    if (input.externalReference === undefined) {
      throw new Error(
        '[payments] Adyen requires `externalReference` on a charge: it becomes the ' +
          'payment `reference`, which the webhook echoes as `merchantReference`.',
      );
    }

    const extra = this.#passthrough(input.metadata);
    const data = await this.#request<AdyenPaymentResponse>('/payments', {
      method: 'POST',
      body: {
        merchantAccount: this.#merchantAccount,
        amount: this.#amount(input.amount, input.currency),
        reference: input.externalReference,
        paymentMethod: {
          type: extra.paymentMethodType ?? 'scheme',
          storedPaymentMethodId: token,
        },
        ...(input.customerId !== undefined ? { shopperReference: input.customerId } : {}),
        ...(input.customer?.email !== undefined ? { shopperEmail: input.customer.email } : {}),
        // Adyen decides scheme/mandate rules from these two, and the right values are a
        // business decision (is the shopper present? is this a subscription?), so the
        // driver forwards yours and never invents one.
        ...(extra.shopperInteraction !== undefined
          ? { shopperInteraction: extra.shopperInteraction }
          : {}),
        ...(extra.recurringProcessingModel !== undefined
          ? { recurringProcessingModel: extra.recurringProcessingModel }
          : {}),
        ...(extra.returnUrl !== undefined ? { returnUrl: extra.returnUrl } : {}),
        ...(Object.keys(extra.rest).length > 0 ? { metadata: extra.rest } : {}),
      },
      ...this.#idempotency(input.idempotencyKey),
    });

    const payment = this.#mapPayment(data, input.amount, input.currency, input.customerId);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(_gatewayId: string): Promise<Payment | null> {
    throw new Error(
      '[payments] Adyen Checkout v71 has no endpoint that reads a payment back by its ' +
        'pspReference — the payment state reaches you through webhooks (AUTHORISATION, ' +
        'CAPTURE, REFUND). Read your own `billing_payments` row, kept in sync by them.',
    );
  }

  async refund(paymentGatewayId: string, amount?: Money): Promise<Refund> {
    if (amount === undefined) {
      // Adyen requires the amount and gives the driver no way to read the payment's own,
      // so "full refund" cannot be inferred here without inventing a number.
      throw new Error(
        '[payments] Adyen requires the refund amount, and its Checkout API cannot read the ' +
          'payment back to infer a full refund. Pass the amount explicitly.',
      );
    }
    const data = await this.#request<AdyenRefundResponse>(`/payments/${paymentGatewayId}/refunds`, {
      method: 'POST',
      body: {
        merchantAccount: this.#merchantAccount,
        amount: this.#amount(amount, undefined),
      },
    });
    const status = data.status.toLowerCase();
    const refund: Refund = {
      id: data.pspReference,
      gatewayId: data.pspReference,
      provider: this.provider,
      amount: { amount: data.amount.value, currency: data.amount.currency.toLowerCase() },
      // Adyen answers a refund request, not the refund itself: the outcome arrives later in
      // a REFUND webhook, so anything short of `authorised` is still pending here.
      status: status === 'authorised' ? 'succeeded' : status === 'refused' ? 'failed' : 'pending',
      createdAt: new Date().toISOString(),
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (input.planId !== undefined || input.trialDays !== undefined) {
      throw new Error(
        '[payments] Adyen has no subscription checkout: it has no plan or subscription ' +
          'resource. Tokenize the card (`storePaymentMethod: true`) and charge it on your ' +
          'own schedule.',
      );
    }
    const extra = this.#passthrough(input.metadata);
    if (input.externalReference === undefined) {
      throw new Error(
        '[payments] Adyen requires `externalReference` on a payment link: it becomes the ' +
          'link `reference`, which the webhook echoes as `merchantReference`.',
      );
    }

    const data = await this.#request<AdyenPaymentLinkResponse>('/paymentLinks', {
      method: 'POST',
      body: {
        merchantAccount: this.#merchantAccount,
        amount: this.#amount(input.amount, input.currency),
        reference: input.externalReference,
        returnUrl: input.successUrl,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.customerId !== undefined ? { shopperReference: input.customerId } : {}),
        ...(Object.keys(extra.rest).length > 0 ? { metadata: extra.rest } : {}),
      },
      ...this.#idempotency(input.idempotencyKey),
    });

    const status = data.status.toLowerCase();
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      url: data.url,
      status:
        status === 'completed' || status === 'paid'
          ? 'complete'
          : status === 'expired'
            ? 'expired'
            : 'open',
      amount: { amount: data.amount.value, currency: data.amount.currency.toLowerCase() },
      ...(data.shopperReference !== undefined ? { customerId: data.shopperReference } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(_input: CreateSubscriptionInput): Promise<Subscription> {
    throw new Error(
      '[payments] Adyen has no subscription resource: recurring billing is you charging a ' +
        'stored token on your own schedule. Tokenize with `storePaymentMethod: true`, then ' +
        'call `charge({ paymentMethodId })` each cycle from your own scheduler.',
    );
  }

  async cancelSubscription(
    _subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    throw new Error(
      '[payments] Adyen has no subscription to cancel — nothing is scheduled at the ' +
        'gateway. Stop charging the token, and delete it with ' +
        '`DELETE /v71/storedPaymentMethods/{id}` if the shopper asked you to.',
    );
  }

  async updateSubscription(
    _subscriptionGatewayId: string,
    _input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    throw new Error(
      '[payments] Adyen has no subscription to update — the amount of the next charge is ' +
        'whatever your scheduler sends to `charge()`.',
    );
  }

  async findSubscription(_gatewayId: string): Promise<Subscription | null> {
    throw new Error(
      '[payments] Adyen has no subscription resource to look up. The recurring state you ' +
        'have is the stored token plus your own billing rows.',
    );
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    throw new Error(
      '[payments] Adyen Checkout has no invoice resource. Configure an `invoice` provider ' +
        'and pass `invoice: true` on the charge if you need a fiscal document.',
    );
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Verify Adyen's HMAC and normalize one notification.
   *
   * The signature covers eight fields of the notification item, colon-joined in a fixed
   * order with empty strings for the absent ones, HMAC-SHA256 under the **hex-decoded**
   * Customer Area key, base64-encoded, and delivered inside the item's `additionalData`.
   * Adyen's own Node, PHP, Java and Python libraries all join those fields *without*
   * escaping — the `\` → `\\`, `:` → `\:` rule belongs to the classic HPP/dictionary
   * signature, not to this one — so this does the same, and a merchant reference
   * containing a colon signs identically here and at Adyen.
   */
  parseWebhook(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const payload = JSON.parse(rawBody) as AdyenNotification;
    const items = payload.notificationItems ?? [];
    if (items.length === 0) {
      throw new Error('[payments] Adyen webhook carried no notificationItems.');
    }
    if (items.length > 1) {
      // Adyen batches; `parseWebhook` returns one event. Dropping the rest would lose
      // captures and refunds silently, so this refuses instead.
      throw new Error(
        `[payments] Adyen sent ${items.length} notification items in one request and the driver contract normalizes one event per request. Configure the webhook to send JSON/HTTP POST notifications (one item per request) rather than batched SOAP.`,
      );
    }
    const item = items[0]!.NotificationRequestItem;

    if (this.#hmacKey !== undefined) {
      this.#verifyHmac(item, this.#hmacKey);
    }

    // A modification (CAPTURE, REFUND, CANCELLATION) carries its own pspReference and
    // names the payment in `originalReference` — the payment is what the ledger routes on.
    const paymentReference = item.originalReference ?? item.pspReference ?? '';
    const success = item.success === 'true';
    return {
      id: `adyen:${item.eventCode}:${item.pspReference ?? paymentReference}`,
      provider: this.provider,
      type: this.#mapWebhookType(item.eventCode, success),
      ...(item.eventDate !== undefined ? { createdAt: item.eventDate } : {}),
      data: {
        gatewayId: paymentReference,
        ...(item.amount !== undefined
          ? { amount: item.amount.value, currency: item.amount.currency.toLowerCase() }
          : {}),
        ...(item.merchantReference !== undefined
          ? { externalReference: item.merchantReference }
          : {}),
        ...(item.reason !== undefined && item.reason !== '' ? { reason: item.reason } : {}),
      },
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapPayment(
    data: AdyenPaymentResponse,
    requested: Money,
    currency: string | undefined,
    customerId: string | undefined,
  ): Payment {
    const result: Payment = {
      id: data.pspReference ?? '',
      gatewayId: data.pspReference ?? '',
      provider: this.provider,
      amount: data.amount
        ? { amount: data.amount.value, currency: data.amount.currency.toLowerCase() }
        : { amount: requested, currency: (currency ?? this.#currency).toLowerCase() },
      status: this.#mapResultCode(data.resultCode),
      method: 'card',
      payload: data as unknown as Record<string, unknown>,
      // Adyen's payment response has no timestamp of its own.
      createdAt: new Date().toISOString(),
    };
    if (customerId !== undefined) result.customerId = customerId;
    return result;
  }

  /**
   * `Authorised` is read as paid because Adyen captures automatically by default. On an
   * account configured for **manual capture** it means the funds are only held, and the
   * money is not settled until the CAPTURE webhook — the API reference does not expose
   * which mode an account is in, so the driver cannot tell the difference.
   */
  #mapResultCode(resultCode: string): Payment['status'] {
    switch (resultCode) {
      case 'Authorised':
        return 'paid';
      case 'Refused':
      case 'Error':
        return 'failed';
      case 'Cancelled':
        return 'canceled';
      default:
        return 'pending';
    }
  }

  #mapWebhookType(eventCode: string, success: boolean): string {
    switch (eventCode) {
      case 'AUTHORISATION':
      case 'CAPTURE':
        return success ? 'payment.succeeded' : 'payment.failed';
      case 'AUTHORISATION_ADJUSTMENT':
      case 'CAPTURE_FAILED':
        return success ? 'payment.updated' : 'payment.failed';
      case 'REFUND':
        // A failed refund left the payment where it was; only a successful one refunds it.
        return success ? 'payment.refunded' : 'payment.updated';
      case 'REFUND_FAILED':
      case 'REFUNDED_REVERSED':
      case 'CANCELLATION':
      case 'CANCEL_OR_REFUND':
      case 'CHARGEBACK':
      case 'CHARGEBACK_REVERSED':
      case 'NOTIFICATION_OF_CHARGEBACK':
        // Real state changes with no canonical event in this package — the ledger records
        // them, and `event.raw` carries the eventCode for an app handler to act on.
        return 'payment.updated';
      default:
        return eventCode.toLowerCase();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  /**
   * Adyen's `amount.value` is already an integer in the currency's minor units — the same
   * unit this package uses — so it passes straight through. The neighbouring Mollie driver
   * converts to a decimal string; the difference is Adyen's, not an oversight here.
   */
  #amount(amount: Money, currency: string | undefined): AdyenAmount {
    return { value: amount, currency: (currency ?? this.#currency).toUpperCase() };
  }

  #verifyHmac(item: AdyenNotificationRequestItem, hmacKey: string): void {
    const received = item.additionalData?.hmacSignature;
    if (received === undefined || received === '') {
      throw new Error('[payments] Missing hmacSignature on Adyen webhook notification.');
    }
    const signedData = [
      item.pspReference,
      item.originalReference,
      item.merchantAccountCode,
      item.merchantReference,
      item.amount?.value,
      item.amount?.currency,
      item.eventCode,
      item.success,
    ]
      .map((value) => (value === undefined || value === null ? '' : String(value)))
      .join(':');
    // The Customer Area key is hex; signing with its characters instead of its bytes is
    // the classic way to get a signature that never matches.
    const expected = createHmac('sha256', Buffer.from(hmacKey, 'hex'))
      .update(signedData, 'utf8')
      .digest('base64');
    if (!safeCompare(received, expected)) {
      throw new Error('[payments] Invalid Adyen webhook HMAC signature.');
    }
  }

  /**
   * Adyen deduplicates on the `Idempotency-Key` request header and nowhere else; it never
   * echoes the key back on the response, so this header is the whole mechanism. Adyen's
   * reference recommends a UUID and caps it at 64 characters.
   */
  #idempotency(key: string | undefined): { headers?: Record<string, string> } {
    return key !== undefined ? { headers: { 'Idempotency-Key': key } } : {};
  }

  /** Split the Adyen-specific knobs out of `metadata`; the rest is echoed as metadata. */
  #passthrough(metadata: Record<string, unknown> | undefined): {
    paymentMethodType?: string;
    shopperInteraction?: string;
    recurringProcessingModel?: string;
    returnUrl?: string;
    rest: Record<string, unknown>;
  } {
    const { paymentMethodType, shopperInteraction, recurringProcessingModel, returnUrl, ...rest } =
      metadata ?? {};
    return {
      ...(typeof paymentMethodType === 'string' ? { paymentMethodType } : {}),
      ...(typeof shopperInteraction === 'string' ? { shopperInteraction } : {}),
      ...(typeof recurringProcessingModel === 'string' ? { recurringProcessingModel } : {}),
      ...(typeof returnUrl === 'string' ? { returnUrl } : {}),
      rest,
    };
  }

  async #request<T>(
    path: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    return httpRequest<T>(path, {
      baseUrl: this.#baseUrl,
      ...(options.method !== undefined ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      authHeader: { name: 'X-API-Key', value: this.#apiKey },
    });
  }
}
