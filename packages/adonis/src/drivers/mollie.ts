import { createHmac } from 'node:crypto';
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
import { formatDecimal, fromDecimal } from '../money.js';
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

/** Config for `payments.mollie()`. Multi-currency, so `currency` is required. */
export interface MollieDriverConfig {
  /** Mollie API key (`test_...` or `live_...`). Defaults to `env.get('MOLLIE_API_KEY')`. */
  apiKey?: string;
  /**
   * Currency for charges that don't name one (lowercase ISO 4217). **Required** — Mollie
   * settles in whatever you hand it, so a default here would be a guess at the country
   * the app charges in, and a wrong guess succeeds.
   */
  currency: string;
  /**
   * Signing secret for Mollie's *next-gen* webhooks (the Webhooks API, which signs with
   * `X-Mollie-Signature`). Defaults to `env.get('MOLLIE_WEBHOOK_SECRET')`. When it is set
   * the driver rejects any webhook without a valid signature. Leave it unset for the
   * classic `webhookUrl` webhook, which Mollie does not sign at all — see
   * {@link MollieDriver.parseWebhook}.
   */
  webhookSecret?: string;
}

interface MollieAmount {
  currency: string;
  value: string;
}

interface MolliePaymentResponse {
  id: string;
  mode?: string;
  status: 'open' | 'pending' | 'authorized' | 'paid' | 'canceled' | 'expired' | 'failed';
  amount: MollieAmount;
  amountRefunded?: MollieAmount;
  /**
   * How much of this payment the payer's bank has pulled back. Mollie leaves `status` at
   * `paid` when a chargeback lands — this field is the only thing on the payment that says
   * the money went away, and it is what the classic webhook makes you fetch to find out.
   *
   * The classic webhook is called "when a chargeback is received on the payment" and the
   * reference lists no reversal among its triggers, so on that webhook the driver can only
   * ever report `payment.disputed`, never the close. Mollie's own description of this field
   * — "the total amount that was charged back for this payment. Only available when the
   * total charged back amount is not zero" — also does not say whether a reversal takes it
   * back to zero. Run the next-gen `chargeback.*` webhooks to hear about the reversal.
   */
  amountChargedBack?: MollieAmount;
  description?: string;
  method?: string | null;
  metadata?: Record<string, unknown> | null;
  customerId?: string;
  subscriptionId?: string;
  mandateId?: string;
  sequenceType?: string;
  createdAt: string;
  paidAt?: string;
  _links?: { checkout?: { href: string } };
}

interface MollieCustomerResponse {
  id: string;
  name?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface MollieSubscriptionResponse {
  id: string;
  customerId: string;
  status: 'pending' | 'active' | 'canceled' | 'suspended' | 'completed';
  amount: MollieAmount;
  interval: string;
  description?: string;
  metadata?: Record<string, unknown> | null;
  startDate?: string;
  nextPaymentDate?: string | null;
  canceledAt?: string | null;
  createdAt: string;
}

interface MollieRefundResponse {
  id: string;
  amount: MollieAmount;
  status: 'queued' | 'pending' | 'processing' | 'refunded' | 'failed' | 'canceled';
  createdAt: string;
  paymentId: string;
}

/** A chargeback, as `GET /payments/{id}/chargebacks/{id}` and the event snapshot return it. */
interface MollieChargeback {
  id: string;
  amount: MollieAmount;
  paymentId: string;
  createdAt?: string;
  reversedAt?: string | null;
  reason?: { code?: string; description?: string } | null;
}

/**
 * The next-gen (Webhooks API) event envelope, when the account is set up for it.
 *
 * `_embedded.entity` is present only on a **snapshot** webhook; a "simple payload" webhook
 * carries `entityId` and nothing else. That distinction matters for chargebacks: a
 * chargeback id cannot be read back on its own (`GET /payments/{paymentId}/chargebacks/{id}`
 * needs the payment id, and Mollie has no lookup by chargeback id), so a simple-payload
 * chargeback event is unresolvable — see {@link MollieDriver.parseWebhook}.
 */
interface MollieEventPayload {
  resource?: string;
  id?: string;
  type?: string;
  entityId?: string;
  createdAt?: string;
  _embedded?: { entity?: Record<string, unknown> };
}

/**
 * Canonical method **category** → the Mollie method ids in it.
 *
 * Mollie's `method` parameter takes a single id *or an array of ids*, and an array is
 * exactly what a category is: `bank_transfer` is not one brand, it is iDEAL in the
 * Netherlands, Bancontact in Belgium, Multibanco in Portugal and eleven others. Sending
 * the whole set restricts the hosted page to that category and lets Mollie show the
 * buyer the ones their country and your profile actually enable.
 *
 * To pin one brand — "iDEAL, nothing else" — pass `metadata.mollieMethod` with the exact
 * Mollie id; that is the gateway's own field, which is where a brand belongs.
 */
const MOLLIE_METHOD_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  credit_card: ['creditcard'],
  // Push-from-your-bank. Mollie's own docs group these as its "bank-based" methods.
  bank_transfer: [
    'ideal',
    'bancontact',
    'banktransfer',
    'belfius',
    'bizum',
    'blik',
    'eps',
    'kbc',
    'mbway',
    'mobilepay',
    'multibanco',
    'mybank',
    'paybybank',
    'przelewy24',
    'satispay',
    'swish',
    'trustly',
    'twint',
    'vipps',
    'bancomatpay',
  ],
  // Pull-from-your-account mandates: SEPA Direct Debit and its UK equivalent, Bacs.
  bank_debit: ['directdebit', 'bacs'],
  wallet: ['paypal', 'applepay', 'googlepay'],
  bnpl: ['klarna', 'in3', 'riverty', 'billie', 'billink', 'alma'],
  // Stored-value paper and plastic: meal/eco vouchers, gift cards, paysafecard.
  voucher: ['voucher', 'giftcard', 'paysafecard'],
};

/**
 * Mollie driver — European gateway (api.mollie.com/v2), Bearer API key, multi-currency.
 *
 * Two things about Mollie shape this driver more than anything else:
 *
 * 1. **Money is a decimal string** (`{ "currency": "EUR", "value": "10.00" }`). The whole
 *    package works in the currency's smallest unit, so the conversion happens once on the
 *    way out (`#toMollieAmount`) and once on the way in (`#fromMollieAmount`).
 * 2. **The classic webhook is a bare id** — `id=tr_xxx`, form-encoded, unsigned. Mollie
 *    deliberately leaves the status out so a forged call cannot tell you a payment was
 *    paid; you learn what happened, and that the call is genuine, by fetching the payment
 *    with your API key. `parseWebhook` is async here for exactly that reason.
 */
export class MollieDriver implements PaymentsDriver {
  readonly provider = 'mollie';
  /**
   * What `charge()` can genuinely ask Mollie for, now that the contract names **categories**
   * instead of brands. Mollie's catalogue is almost entirely local European methods and
   * none of them had a name here, so every one of iDEAL, Bancontact, SEPA Direct Debit,
   * Klarna, PayPal, Apple Pay, EPS, Przelewy24, BLIK, TWINT, MB WAY, Multibanco, Trustly,
   * paysafecard and the vouchers was unroutable. Each now falls into a category, and the
   * category goes out as Mollie's own `method` array (see {@link MollieDriver.#mapMethod}).
   *
   * `debit_card` is still absent, and re-checking did not change that: Mollie folds debit
   * cards (Maestro, V PAY) into the single `creditcard` method id and exposes no separate
   * debit id, so a `debit_card` route could only be a `creditcard` charge wearing another
   * name. `pix` and `boleto` are not European methods and Mollie has neither.
   */
  readonly supportedMethods = [
    'credit_card',
    'bank_transfer',
    'bank_debit',
    'wallet',
    'bnpl',
    'voucher',
    'undefined',
  ] as const;
  /** No invoices: Mollie's Invoices API returns Mollie's own invoices to *you*, not yours. */
  readonly capabilities = { refunds: true, invoices: false, subscriptions: true };

  #baseUrl = 'https://api.mollie.com/v2';
  #apiKey: string;
  #currency: string;
  #webhookSecret: string | undefined;
  #invoiceCtx: EmitInvoiceContext;
  /**
   * Subscription id → customer id. Every Mollie subscription endpoint is nested under a
   * customer, but the driver contract passes only the subscription id; this remembers the
   * pairing for subscriptions this process created, so the common path costs no lookup.
   */
  #subscriptionCustomers = new Map<string, string>();

  constructor(ctx: EmitInvoiceContext, config: MollieDriverConfig) {
    this.#invoiceCtx = ctx;
    this.#apiKey = requireCredential({
      driver: 'mollie',
      option: 'apiKey',
      env: 'MOLLIE_API_KEY',
      value: config.apiKey,
    });
    this.#currency = requireCurrency('mollie', config.currency);
    this.#webhookSecret = config.webhookSecret ?? process.env.MOLLIE_WEBHOOK_SECRET;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const data = await this.#request<MollieCustomerResponse>('/customers', {
      method: 'POST',
      body: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...this.#customerMetadata(input),
      },
      ...this.#idempotency(input.idempotencyKey),
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      return this.#mapCustomer(
        await this.#request<MollieCustomerResponse>(`/customers/${customerId}`),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const data = await this.#request<MollieCustomerResponse>(`/customers/${customerId}`, {
      method: 'PATCH',
      body: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...this.#customerMetadata(input),
      },
    });
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    if (input.split !== undefined && input.split.length > 0) {
      throw new Error(
        '[payments] Mollie does not take a percent/fixed wallet split on a payment. ' +
          'Its equivalent (Mollie Connect routes) splits to organization ids with absolute ' +
          'amounts only, which `split` cannot express — create the routes through the Mollie API.',
      );
    }

    // A stored card at Mollie is a *mandate*, and charging one is `sequenceType: recurring`.
    const mandateId = input.card?.token ?? input.paymentMethodId;
    const recurring = mandateId !== undefined;
    const transport = this.#transportOptions(input.metadata);

    // Mollie requires `redirectUrl` on every payment the shopper completes themselves; a
    // recurring charge against a mandate is the one case with nobody to redirect.
    if (!recurring && transport.redirectUrl === undefined) {
      throw new Error(
        '[payments] Mollie requires a redirect URL on a customer-facing payment. ' +
          'Pass `metadata.redirectUrl` on the charge, or use `createCheckout({ successUrl })`.',
      );
    }
    if (recurring && input.customerId === undefined) {
      throw new Error(
        '[payments] Mollie needs the customer that owns the mandate. Pass `customerId` ' +
          'alongside the mandate id when charging a stored card.',
      );
    }

    const method = this.#mapMethod(input.method, input.metadata);
    const body: Record<string, unknown> = {
      amount: this.#toMollieAmount(input.amount, input.currency),
      // Mollie makes `description` mandatory — it is what the payer sees on their statement.
      description: input.description ?? 'Payment',
      ...(transport.redirectUrl !== undefined ? { redirectUrl: transport.redirectUrl } : {}),
      ...(transport.cancelUrl !== undefined ? { cancelUrl: transport.cancelUrl } : {}),
      ...(transport.webhookUrl !== undefined ? { webhookUrl: transport.webhookUrl } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(mandateId !== undefined ? { mandateId, sequenceType: 'recurring' } : {}),
      ...this.#metadataBody(transport.rest, input.externalReference),
    };

    const data = await this.#request<MolliePaymentResponse>('/payments', {
      method: 'POST',
      body,
      ...this.#idempotency(input.idempotencyKey),
    });
    const payment = this.#mapPayment(data);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      return this.#mapPayment(await this.#request<MolliePaymentResponse>(`/payments/${gatewayId}`));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * `options.idempotencyKey` goes out as Mollie's `Idempotency-Key` header — the only
   * thing Mollie deduplicates on, and the difference between a retried refund and a second
   * one. Mollie keeps a key for one hour; after that the same key refunds again.
   */
  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    // Mollie makes `amount` mandatory on a refund and the amount must carry the *payment's*
    // currency, which a charge may have overridden — so read it off the payment rather than
    // assuming the driver's configured one.
    const payment = await this.#request<MolliePaymentResponse>(`/payments/${paymentGatewayId}`);
    const value =
      amount !== undefined
        ? {
            currency: payment.amount.currency,
            value: formatDecimal(amount, payment.amount.currency),
          }
        : payment.amount;

    const data = await this.#request<MollieRefundResponse>(
      `/payments/${paymentGatewayId}/refunds`,
      { method: 'POST', body: { amount: value }, ...this.#idempotency(options?.idempotencyKey) },
    );
    const refund: Refund = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount: this.#fromMollieAmount(data.amount),
      status:
        data.status === 'refunded'
          ? 'succeeded'
          : data.status === 'failed' || data.status === 'canceled'
            ? 'failed'
            : 'pending',
      createdAt: data.createdAt,
    };
    publishRefundDiagnostics(refund);
    return refund;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (input.planId !== undefined || input.trialDays !== undefined) {
      throw new Error(
        '[payments] Mollie has no subscription checkout: a subscription needs a mandate, ' +
          'which the shopper grants by completing a first payment. Check out the first ' +
          'payment, then call `createSubscription` once the mandate is valid.',
      );
    }
    const transport = this.#transportOptions(input.metadata);
    const data = await this.#request<MolliePaymentResponse>('/payments', {
      method: 'POST',
      body: {
        amount: this.#toMollieAmount(input.amount, input.currency),
        description: input.description ?? 'Checkout',
        redirectUrl: input.successUrl,
        ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
        ...(transport.webhookUrl !== undefined ? { webhookUrl: transport.webhookUrl } : {}),
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        ...this.#metadataBody(transport.rest, input.externalReference),
      },
      ...this.#idempotency(input.idempotencyKey),
    });

    const url = data._links?.checkout?.href;
    if (url === undefined) {
      // An empty redirect URL fails at the browser, long after the caller could react.
      throw new Error(
        `[payments] Mollie returned payment ${data.id} without a checkout link. That happens when the payment cannot be paid by the shopper (e.g. a recurring sequence) — use \`charge()\` for those.`,
      );
    }
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      url,
      status: data.status === 'paid' ? 'complete' : data.status === 'expired' ? 'expired' : 'open',
      amount: this.#fromMollieAmount(data.amount),
      ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    if (input.amount === undefined) {
      throw new Error('[payments] Mollie requires an `amount` on every subscription.');
    }
    if (input.trialDays !== undefined) {
      throw new Error(
        '[payments] Mollie has no trial period on a subscription — it would have to be ' +
          'faked as a later first charge, and nothing at the gateway would call it a trial. ' +
          'Pass `startDate` for the first charge date instead.',
      );
    }
    const transport = this.#transportOptions(input.metadata);
    const body: Record<string, unknown> = {
      amount: this.#toMollieAmount(input.amount, undefined),
      interval: this.#mapCycle(input.cycle),
      // Mollie requires a description and shows it on the payer's statement; it must be
      // unique among a customer's active subscriptions, so the plan id is a good default.
      description: input.description ?? input.planId,
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.card?.token !== undefined ? { mandateId: input.card.token } : {}),
      ...(transport.webhookUrl !== undefined ? { webhookUrl: transport.webhookUrl } : {}),
      // Mollie has no plan resource, so the plan id survives only as metadata — and
      // `#mapSubscription` reads it back out of there.
      ...this.#metadataBody({ ...transport.rest, planId: input.planId }, input.externalReference),
    };

    const data = await this.#request<MollieSubscriptionResponse>(
      `/customers/${input.customerId}/subscriptions`,
      { method: 'POST', body, ...this.#idempotency(input.idempotencyKey) },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    // Mollie cancels the schedule outright; there is no period-end flag to honor.
    const { customerId, subscriptionId } = await this.#resolveSubscription(subscriptionGatewayId);
    const data = await this.#request<MollieSubscriptionResponse>(
      `/customers/${customerId}/subscriptions/${subscriptionId}`,
      { method: 'DELETE' },
    );
    const subscription = this.#mapSubscription(data);
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  /**
   * `input.idempotencyKey` is REFUSED, not ignored. Mollie's own words: "All `POST`
   * endpoints accept idempotency keys. Sending idempotency keys for `GET`, `PATCH`, or
   * `DELETE` requests is not necessary since these API requests are repeatable by nature."
   * Updating a subscription is a `PATCH`, so there is no key to send and accepting one
   * would promise a deduplication Mollie never performs.
   */
  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    if (input.idempotencyKey !== undefined) {
      throw new Error(
        '[payments] Mollie accepts `Idempotency-Key` on POST requests only, and updating a ' +
          'subscription is a PATCH — so `idempotencyKey` cannot be honoured on ' +
          'updateSubscription(). The PATCH is repeatable by nature (it sets fields to the ' +
          'values you pass), so drop the key rather than relying on one Mollie ignores.',
      );
    }
    const { customerId, subscriptionId } = await this.#resolveSubscription(subscriptionGatewayId);
    const data = await this.#request<MollieSubscriptionResponse>(
      `/customers/${customerId}/subscriptions/${subscriptionId}`,
      {
        method: 'PATCH',
        body: {
          ...(input.amount !== undefined
            ? { amount: this.#toMollieAmount(input.amount, undefined) }
            : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      },
    );
    return this.#mapSubscription(data);
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const { customerId, subscriptionId } = await this.#resolveSubscription(gatewayId);
      return this.#mapSubscription(
        await this.#request<MollieSubscriptionResponse>(
          `/customers/${customerId}/subscriptions/${subscriptionId}`,
        ),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    throw new Error(
      '[payments] Mollie has no customer invoices to list: its Invoices API returns the ' +
        'monthly invoices Mollie issues to *you* for its fees, not documents you issue to ' +
        'your customers. Configure an `invoice` provider and pass `invoice: true` on the charge.',
    );
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Mollie's classic webhook carries one thing: `id=tr_xxx`, form-encoded and unsigned.
   * That is deliberate — because the body never says "paid", a forged call cannot make you
   * think a payment succeeded. **Authenticity comes from the fetch, not from the request**:
   * the driver reads the payment back with your API key, and what that authenticated call
   * returns is the event. Nothing here trusts a word of the request body beyond the id.
   *
   * Which is why this is async. A synchronous parse could only report "payment tr_x
   * changed", so the mounted route ledgered a row and never marked the payment paid — the
   * money arriving and the app never finding out.
   *
   * A fetch failure propagates on purpose: the route answers 400 and Mollie retries, which
   * is the right outcome for a payment nobody could confirm.
   *
   * When `webhookSecret` is configured the driver is talking to Mollie's *next-gen*
   * webhooks instead, which send a JSON event and sign it with `X-Mollie-Signature`
   * (`sha256=<hex hmac of the raw body>`) — then verification is mandatory, fail-closed.
   * Those still get fetched: a signature proves who sent the event, not what the payment
   * is worth, and the built-in billing sync needs the amount.
   */
  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * Next-gen webhooks are signed, so a configured secret is `'configured'`. Without one the
   * driver is on the CLASSIC flow, and that flow is `'unsupported'` rather than
   * `'unconfigured'` — the distinction matters, because `'unconfigured'` refuses to boot.
   *
   * There is no credential to configure on the classic flow and nothing insecure about not
   * having one: the request carries only `id=tr_xxx`, and the driver authenticates by
   * reading that payment back with your API key (see `parseWebhook` below). Reporting it as
   * a missing credential would make the supported, safe configuration fail at boot and push
   * apps into `allowUnverifiedWebhooks`, which would then also silence a genuinely missing
   * next-gen secret.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookSecret !== undefined ? 'configured' : 'unsupported';
  }

  async parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookEvent> {
    if (this.#webhookSecret !== undefined) {
      this.#verifySignature(rawBody, headerValue(headers, 'x-mollie-signature'));
    }

    const envelope = this.#parseEventPayload(rawBody);
    const entityId = envelope !== null ? envelope.entityId : this.#classicId(rawBody);
    if (entityId === undefined || entityId === '') {
      throw new Error('[payments] Mollie webhook body carried no resource id.');
    }

    if (entityId.startsWith('chb_')) {
      return this.#chargebackEvent(envelope, entityId);
    }

    if (!entityId.startsWith('tr_')) {
      // A next-gen event about something that is not a payment (a payment link, a sales
      // invoice). There is nothing to map onto the payment shape, so report what the
      // signed envelope said and leave it to an app handler.
      return {
        id: envelope?.id ?? `mollie:${entityId}`,
        provider: this.provider,
        type: this.#mapEventType(envelope?.type),
        ...(envelope?.createdAt !== undefined ? { createdAt: envelope.createdAt } : {}),
        data: { gatewayId: entityId },
        raw: (envelope ?? { id: entityId }) as unknown as Record<string, unknown>,
      };
    }

    const data = await this.#request<MolliePaymentResponse>(`/payments/${entityId}`);
    const payment = this.#mapPayment(data);
    return {
      // Stable per *transition*, so a redelivery of the same status dedupes in the ledger
      // while the next status still gets through. A next-gen event has a real id of its own.
      //
      // Mollie's own `status` stays `paid` through a refund AND through a chargeback, so
      // the derived id needs the mapped outcome too — without it the chargeback's event id
      // is byte-identical to the earlier `payment.succeeded` one and the ledger discards
      // the webhook that takes the money away as a replay.
      id: envelope?.id ?? `mollie:${data.id}:${this.#transition(data.status, payment.status)}`,
      provider: this.provider,
      type:
        payment.status === 'disputed'
          ? 'payment.disputed'
          : payment.status === 'paid'
            ? 'payment.succeeded'
            : payment.status === 'refunded'
              ? 'payment.refunded'
              : payment.status === 'failed' || payment.status === 'canceled'
                ? 'payment.failed'
                : 'payment.updated',
      createdAt: data.createdAt,
      data: {
        gatewayId: payment.gatewayId,
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
        ...(payment.subscriptionId !== undefined ? { subscriptionId: payment.subscriptionId } : {}),
        ...(typeof data.metadata?.externalReference === 'string'
          ? { externalReference: data.metadata.externalReference }
          : {}),
        ...(data.metadata != null ? { metadata: data.metadata } : {}),
      },
      // The request body carried only an id; the fetched payment is the gateway payload
      // this event was actually normalized from.
      raw: data as unknown as Record<string, unknown>,
    };
  }

  /**
   * A next-gen `chargeback.*` event: the one webhook that takes revenue away, and the one
   * that gives it back.
   *
   * Mollie has exactly two of them — `chargeback.received` ("a chargeback has been received
   * for a payment") and `chargeback.reversed` ("a previously received chargeback has been
   * reversed") — and **no pre-dispute vocabulary at all**: no fraud alert, no retrieval
   * request, no inquiry, and no `payment.dispute_warning` for this driver to emit. Mollie's
   * own words are that the money "will be reclaimed and deducted from your Mollie balance",
   * so the first event already is the withdrawal.
   *
   * The chargeback object carries no response deadline either — its whole field list is
   * `id`, `amount`, `settlementAmount`, `reason`, `paymentId`, `settlementId`, `createdAt`,
   * `reversedAt` — so no `actionableUntil` is emitted rather than one being invented.
   *
   * The reversal is read from `reversedAt` as well as from the event name: the payload is a
   * snapshot of the entity, so a `chargeback.received` redelivered after the reversal
   * carries the timestamp too, and taking the money back off the row twice would be worse
   * than reading it from either place.
   *
   * The chargeback entity has to come from the event body. Mollie's only read endpoint is
   * `GET /payments/{paymentId}/chargebacks/{id}` — there is no lookup by chargeback id —
   * so a webhook configured with the "simple payload" (an `entityId` and nothing else)
   * carries a chargeback that literally cannot be resolved. That throws rather than
   * degrading to an inert event: the route answers 400, Mollie retries, and the message
   * says which setting to change. A silent pass-through here is exactly the shape of bug
   * `payment.disputed` exists to remove.
   *
   * Note this is the *next-gen* path only. On the classic webhook a chargeback arrives as
   * an ordinary `tr_…` notification and is caught by `amountChargedBack` on the fetched
   * payment — see {@link MollieDriver.#mapPayment}.
   */
  #chargebackEvent(envelope: MollieEventPayload | null, entityId: string): WebhookEvent {
    const entity = envelope?._embedded?.entity as unknown as MollieChargeback | undefined;
    if (entity?.paymentId === undefined || entity.amount === undefined) {
      throw new Error(
        `[payments] Mollie sent chargeback ${entityId} with no embedded entity, and a chargeback cannot be read back on its own — \`GET /payments/{paymentId}/chargebacks/{id}\` needs the payment id Mollie did not send. Configure this webhook to deliver the full snapshot payload instead of the id-only one.`,
      );
    }
    const amount = this.#fromMollieAmount(entity.amount);
    const reversed =
      envelope?.type === 'chargeback.reversed' || typeof entity.reversedAt === 'string';
    return {
      id: envelope?.id ?? `mollie:${entityId}:${envelope?.type ?? 'chargeback'}`,
      provider: this.provider,
      // A reversal is the dispute resolved in your favour and the money back on the
      // balance, so it closes the dispute as `won` — the processor is what moves the row
      // off `disputed`, and reporting the reversal as a plain update left it stuck there
      // with the revenue written off.
      type: reversed ? 'payment.dispute_closed' : 'payment.disputed',
      ...(envelope?.createdAt !== undefined ? { createdAt: envelope.createdAt } : {}),
      // Keyed by the PAYMENT, not the chargeback: the payment is the row whose status has
      // to move to `disputed`.
      data: {
        gatewayId: entity.paymentId,
        amount: amount.amount,
        currency: amount.currency,
        disputeId: entity.id ?? entityId,
        ...(reversed ? { outcome: 'won' } : {}),
        // Only ever set on a SEPA Direct Debit chargeback — Mollie's reference says the
        // card schemes send it no reason at all.
        ...(entity.reason?.code !== undefined ? { reason: entity.reason.code } : {}),
      },
      raw: (envelope ?? { id: entityId }) as unknown as Record<string, unknown>,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: MollieCustomerResponse): Customer {
    const taxId = data.metadata?.taxId;
    return {
      id: data.id,
      ...(data.name != null ? { name: data.name } : {}),
      ...(data.email != null ? { email: data.email } : {}),
      ...(typeof taxId === 'string' ? { taxId } : {}),
      ...(data.metadata != null ? { metadata: data.metadata } : {}),
    };
  }

  #mapPayment(data: MolliePaymentResponse): Payment {
    const amount = this.#fromMollieAmount(data.amount);
    const refunded =
      data.amountRefunded !== undefined &&
      this.#fromMollieAmount(data.amountRefunded).amount >= amount.amount;
    // A chargeback leaves Mollie's own `status` at `paid` — `amountChargedBack` is the only
    // field that says the bank pulled the money back, and it outranks everything below it.
    const chargedBack =
      data.amountChargedBack !== undefined &&
      this.#fromMollieAmount(data.amountChargedBack).amount > 0;
    const statusMap: Record<MolliePaymentResponse['status'], Payment['status']> = {
      open: 'pending',
      pending: 'pending',
      // Funds held, nothing captured — a real Mollie state for pay-later methods and for
      // manual-capture cards. It used to collapse into `pending`, which understated it.
      authorized: 'authorized',
      paid: 'paid',
      canceled: 'canceled',
      // The payer never completed it and now cannot — the same outcome as `failed`, and
      // `canceled` would wrongly suggest somebody canceled it.
      expired: 'failed',
      failed: 'failed',
    };
    const result: Payment = {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      amount,
      status: chargedBack
        ? 'disputed'
        : refunded
          ? 'refunded'
          : (statusMap[data.status] ?? 'pending'),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.createdAt,
    };
    if (data.customerId !== undefined) result.customerId = data.customerId;
    if (data.subscriptionId !== undefined) result.subscriptionId = data.subscriptionId;
    if (data.paidAt !== undefined) result.paidAt = data.paidAt;
    const method = this.#mapPaymentMethodType(data.method);
    if (method !== undefined) result.method = method;
    const checkout = data._links?.checkout?.href;
    if (checkout !== undefined) result.hostedUrl = checkout;
    return result;
  }

  #mapSubscription(data: MollieSubscriptionResponse): Subscription {
    this.#subscriptionCustomers.set(data.id, data.customerId);
    const statusMap: Record<MollieSubscriptionResponse['status'], Subscription['status']> = {
      pending: 'incomplete',
      active: 'active',
      canceled: 'canceled',
      suspended: 'past_due',
      completed: 'ended',
    };
    const planId = data.metadata?.planId;
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      customerId: data.customerId,
      status: statusMap[data.status] ?? 'active',
      planId: typeof planId === 'string' ? planId : (data.description ?? data.interval),
      amount: this.#fromMollieAmount(data.amount),
      ...(data.canceledAt != null ? { endsAt: data.canceledAt } : {}),
      ...(data.nextPaymentDate != null ? { currentPeriodEnd: data.nextPaymentDate } : {}),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.createdAt,
    };
  }

  /**
   * Canonical method name → what goes in Mollie's `method` field. Anything else is a
   * routing mistake and fails here rather than at the gateway.
   */
  #mapMethod(method: string | undefined, metadata: Record<string, unknown> | undefined): unknown {
    const brand = metadata?.mollieMethod;
    const category = method === undefined || method === 'undefined' ? undefined : method;

    if (typeof brand === 'string') {
      if (category !== undefined) {
        const allowed = MOLLIE_METHOD_CATEGORIES[category];
        if (allowed === undefined) throw this.#unknownMethod(category);
        if (!allowed.includes(brand)) {
          throw new Error(
            `[payments] Mollie method "${brand}" is not a \`${category}\` method. \`metadata.mollieMethod\` names the exact Mollie id and must belong to the category being routed — ${category} covers: ${allowed.join(', ')}.`,
          );
        }
      }
      return brand;
    }

    if (category === undefined) return undefined;
    const ids = MOLLIE_METHOD_CATEGORIES[category];
    if (ids === undefined) throw this.#unknownMethod(category);
    // A single-member category goes out as the bare id Mollie documents, not a 1-element
    // array, so the request body reads the way Mollie's own examples do.
    return ids.length === 1 ? ids[0] : [...ids];
  }

  #unknownMethod(method: string): Error {
    return new Error(
      `[payments] Mollie has no "${method}" method. This driver routes the categories ${Object.keys(
        MOLLIE_METHOD_CATEGORIES,
      ).join(
        ', ',
      )}, or lets the shopper pick on the hosted page when no method is given. Mollie has no separate debit-card method (debit cards are \`creditcard\`), and no Pix or boleto.`,
    );
  }

  /**
   * A Mollie method id, as reported back on a payment, onto the contract's categories.
   * Only `creditcard` had a name before, so an iDEAL or Klarna payment came back with no
   * `method` at all.
   */
  #mapPaymentMethodType(method: string | null | undefined): Payment['method'] | undefined {
    if (method === null || method === undefined) return undefined;
    if (method === 'creditcard' || method === 'pointofsale') return 'card';
    for (const [category, ids] of Object.entries(MOLLIE_METHOD_CATEGORIES)) {
      if (!ids.includes(method)) continue;
      if (category === 'credit_card') return 'card';
      return category as Payment['method'];
    }
    // A method Mollie added since this table was written: it was paid, and saying so with
    // `unknown` is honest, where leaving it unset would read as "Mollie did not tell us".
    return 'unknown';
  }

  #mapCycle(cycle: CreateSubscriptionInput['cycle']): string {
    switch (cycle) {
      case 'WEEKLY':
        return '1 week';
      case 'BIWEEKLY':
        return '2 weeks';
      case 'QUARTERLY':
        return '3 months';
      case 'SEMIANNUALLY':
        return '6 months';
      case 'YEARLY':
        return '12 months';
      default:
        return '1 month';
    }
  }

  #mapEventType(type: string | undefined): string {
    switch (type) {
      case 'payment.paid':
        return 'payment.succeeded';
      case 'payment.failed':
      case 'payment.expired':
      case 'payment.canceled':
        return 'payment.failed';
      case 'payment.refunded':
      case 'refund.successful':
        return 'payment.refunded';
      case 'chargeback.received':
        return 'payment.disputed';
      default:
        return type ?? 'payment.updated';
    }
  }

  /**
   * The event-id suffix for a payment webhook. Mollie's own `status` is the transition in
   * every ordinary case, but it stays `paid` through both a refund and a chargeback — so
   * those two get their own suffix, or their event id collides with the earlier
   * `payment.succeeded` one and the idempotency ledger drops them as replays.
   */
  #transition(gatewayStatus: string, mapped: Payment['status']): string {
    if (mapped === 'disputed') return `${gatewayStatus}:chargeback`;
    if (mapped === 'refunded') return `${gatewayStatus}:refunded`;
    return gatewayStatus;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  /**
   * Mollie takes money as a decimal string carrying the currency's own number of decimals
   * — `"19.90"` for EUR, `"1990"` for JPY, `"1.990"` for KWD. `formatDecimal` shifts the
   * digits of the integer instead of dividing, so nothing is lost to a binary float and a
   * zero-decimal currency is not billed at a hundredth of its amount.
   */
  #toMollieAmount(amount: Money, currency?: string): MollieAmount {
    const resolved = currency ?? this.#currency;
    return { currency: resolved.toUpperCase(), value: formatDecimal(amount, resolved) };
  }

  #fromMollieAmount(amount: MollieAmount): { amount: Money; currency: string } {
    return {
      amount: fromDecimal(Number(amount.value), amount.currency),
      currency: amount.currency.toLowerCase(),
    };
  }

  /**
   * Pull the per-request URLs out of `metadata`: `ChargeInput` has no room for the redirect
   * and webhook URLs Mollie needs, and echoing them back as gateway metadata would be noise.
   */
  #transportOptions(metadata: Record<string, unknown> | undefined): {
    redirectUrl?: string;
    cancelUrl?: string;
    webhookUrl?: string;
    rest: Record<string, unknown>;
  } {
    // `mollieMethod` is read as an argument (the exact Mollie method id to pin), so it is
    // consumed here rather than echoed back as gateway metadata.
    const {
      redirectUrl,
      cancelUrl,
      webhookUrl,
      mollieMethod: _mollieMethod,
      ...rest
    } = metadata ?? {};
    return {
      ...(typeof redirectUrl === 'string' ? { redirectUrl } : {}),
      ...(typeof cancelUrl === 'string' ? { cancelUrl } : {}),
      ...(typeof webhookUrl === 'string' ? { webhookUrl } : {}),
      rest,
    };
  }

  #metadataBody(
    rest: Record<string, unknown>,
    externalReference: string | undefined,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      ...rest,
      ...(externalReference !== undefined ? { externalReference } : {}),
    };
    return Object.keys(metadata).length > 0 ? { metadata } : {};
  }

  #customerMetadata(input: CreateCustomerInput | UpdateCustomerInput): Record<string, unknown> {
    // Mollie's customer has no tax-id field, so it rides along in metadata — the one place
    // it survives a round-trip, and where `#mapCustomer` reads it back from.
    const metadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
    };
    return Object.keys(metadata).length > 0 ? { metadata } : {};
  }

  /**
   * Mollie deduplicates on the `Idempotency-Key` request header and on nothing else — a key
   * written into `metadata` would be echoed back and protect nothing. Mollie keeps a key for
   * one hour; after that the same key creates a second payment.
   *
   * Applied to every POST the driver makes: `charge`, `createCheckout`, `refund`,
   * `createCustomer` and `createSubscription`. `updateSubscription` is a PATCH, which
   * Mollie does not accept keys for at all, so it refuses instead.
   */
  #idempotency(key: string | undefined): { headers?: Record<string, string> } {
    return key !== undefined ? { headers: { 'Idempotency-Key': key } } : {};
  }

  /**
   * Every Mollie subscription endpoint is nested under a customer, but the driver contract
   * passes only the subscription id. Resolved from the pairing this process already saw,
   * or from an explicit `customerId/subscriptionId` — never guessed.
   */
  async #resolveSubscription(
    gatewayId: string,
  ): Promise<{ customerId: string; subscriptionId: string }> {
    const slash = gatewayId.indexOf('/');
    if (slash !== -1) {
      return {
        customerId: gatewayId.slice(0, slash),
        subscriptionId: gatewayId.slice(slash + 1),
      };
    }
    const known = this.#subscriptionCustomers.get(gatewayId);
    if (known !== undefined) return { customerId: known, subscriptionId: gatewayId };

    // Last resort: Mollie's account-wide subscription list, which does carry `customerId`.
    const page = await this.#request<{
      _embedded?: { subscriptions?: MollieSubscriptionResponse[] };
    }>('/subscriptions?limit=250');
    const found = page._embedded?.subscriptions?.find((item) => item.id === gatewayId);
    if (found !== undefined) {
      this.#subscriptionCustomers.set(found.id, found.customerId);
      return { customerId: found.customerId, subscriptionId: found.id };
    }
    throw new Error(
      `[payments] Mollie subscription ${gatewayId} needs its customer: every subscription endpoint is nested under one, and it was not in the first page of the account-wide list. Pass it as \`"cst_xxx/sub_xxx"\`.`,
    );
  }

  /** Next-gen webhook envelope, or `null` when this is the classic form-encoded id POST. */
  #parseEventPayload(rawBody: string): MollieEventPayload | null {
    if (!rawBody.trimStart().startsWith('{')) return null;
    const parsed = JSON.parse(rawBody) as MollieEventPayload;
    return parsed.resource === 'event' ? parsed : null;
  }

  #verifySignature(rawBody: string, signature: string | undefined): void {
    if (signature === undefined || signature === '') {
      throw new Error('[payments] Missing X-Mollie-Signature on Mollie webhook request.');
    }
    // Mollie sends `sha256=<hex>`; the digest is over the raw, undeserialized body.
    const received = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const secret = this.#webhookSecret ?? '';
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (!safeCompare(received, expected)) {
      throw new Error('[payments] Invalid Mollie webhook signature.');
    }
  }

  /** The classic webhook's only field: `id=tr_xxx`, form-encoded. */
  #classicId(rawBody: string): string | undefined {
    return new URLSearchParams(rawBody).get('id') ?? undefined;
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
      bearerToken: this.#apiKey,
    });
  }
}
