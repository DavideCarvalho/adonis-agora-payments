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

/** The next-gen (Webhooks API) event envelope, when the account is set up for it. */
interface MollieEventPayload {
  resource?: string;
  id?: string;
  type?: string;
  entityId?: string;
  createdAt?: string;
}

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
   * Only what `charge()` can genuinely ask Mollie for. Mollie's catalogue is mostly local
   * European methods (iDEAL, Bancontact, SEPA direct debit, Klarna, PayPal, …) and the
   * package's `PaymentMethodName` union has no name for any of them, so they cannot be
   * declared here — see the driver's docs page.
   */
  readonly supportedMethods = ['credit_card', 'undefined'] as const;
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

    const method = this.#mapMethod(input.method);
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

  async refund(paymentGatewayId: string, amount?: Money): Promise<Refund> {
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
      { method: 'POST', body: { amount: value } },
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
      { method: 'POST', body },
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

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
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
      id: envelope?.id ?? `mollie:${data.id}:${data.status}`,
      provider: this.provider,
      type:
        payment.status === 'paid'
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
    const statusMap: Record<MolliePaymentResponse['status'], Payment['status']> = {
      open: 'pending',
      pending: 'pending',
      authorized: 'pending',
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
      status: refunded ? 'refunded' : (statusMap[data.status] ?? 'pending'),
      payload: data as unknown as Record<string, unknown>,
      createdAt: data.createdAt,
    };
    if (data.customerId !== undefined) result.customerId = data.customerId;
    if (data.subscriptionId !== undefined) result.subscriptionId = data.subscriptionId;
    if (data.paidAt !== undefined) result.paidAt = data.paidAt;
    if (data.method === 'creditcard') result.method = 'card';
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

  /** Canonical method name → Mollie method id. Anything else is a routing mistake. */
  #mapMethod(method?: string): string | undefined {
    if (method === undefined || method === 'undefined') return undefined;
    if (method === 'credit_card') return 'creditcard';
    throw new Error(
      `[payments] Mollie has no "${method}" method. This driver asks Mollie for \`creditcard\`, or lets the shopper pick on the hosted page when no method is given.`,
    );
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
      default:
        return type ?? 'payment.updated';
    }
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
    const { redirectUrl, cancelUrl, webhookUrl, ...rest } = metadata ?? {};
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
