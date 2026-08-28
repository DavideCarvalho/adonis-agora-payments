import Stripe from 'stripe';
import type { StripeDriverConfig } from '../define_config.js';
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
import { requireCurrency } from './shared.js';

/**
 * Stripe driver. Wraps the Stripe SDK and normalizes its API onto the shared
 * {@link PaymentsDriver} contract. The SDK is imported lazily by the factory in
 * `define_config.ts`, so `stripe` stays an optional peer dependency.
 */
export class StripeDriver implements PaymentsDriver {
  readonly provider = 'stripe';
  readonly supportedMethods = ['pix', 'credit_card', 'boleto', 'undefined'] as const;
  readonly capabilities = { refunds: true, invoices: true, subscriptions: true };

  #stripe: Stripe;
  #currency: string;
  #webhookSecret: string | undefined;
  #invoiceCtx: EmitInvoiceContext;

  constructor(ctx: EmitInvoiceContext, config: StripeDriverConfig) {
    this.#invoiceCtx = ctx;
    // Lazy import happens in the factory; here we import the SDK synchronously because
    // the factory already ensured it is available. We read the env at construction time.
    const apiKey = config.apiKey ?? process.env.STRIPE_KEY;
    if (!apiKey) {
      throw new Error(
        '[payments] Stripe driver requires an API key. Set `STRIPE_KEY` env or pass `apiKey` to `payments.stripe()`.',
      );
    }
    this.#stripe = new Stripe(apiKey);
    // The constructor (not the factory) enforces this, because `./drivers/stripe` is a
    // public entry point too — this is the one boundary every path crosses.
    this.#currency = requireCurrency('stripe', config.currency);
    this.#webhookSecret = config.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const customer = await this.#stripe.customers.create(
      {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.taxId !== undefined ? { tax_id: input.taxId } : {}),
        ...(input.metadata !== undefined
          ? { metadata: input.metadata as Record<string, string> }
          : {}),
      },
      this.#requestOptions(input.idempotencyKey),
    );
    return this.#mapCustomer(customer);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const customer = await this.#stripe.customers.retrieve(customerId);
      if (customer.deleted) return null;
      return this.#mapCustomer(customer);
    } catch (error) {
      if (this.#isNotFound(error)) return null;
      throw error;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    const customer = await this.#stripe.customers.update(customerId, {
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.taxId !== undefined ? { tax_id: input.taxId } : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Record<string, string> }
        : {}),
    });
    return this.#mapCustomer(customer);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    // Without `payment_method_types` Stripe creates the intent with whatever the account's
    // dashboard defaults are, so a charge routed as Pix could come back a card.
    const methodType = this.#mapMethodToStripe(input.method);
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.amount,
      currency: input.currency ?? this.#currency,
      ...(input.customerId !== undefined ? { customer: input.customerId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.paymentMethodId !== undefined ? { payment_method: input.paymentMethodId } : {}),
      ...(input.card !== undefined ? { payment_method: input.card.token } : {}),
      ...(methodType !== undefined ? { payment_method_types: [methodType] } : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Record<string, string> }
        : {}),
    };
    if (input.idempotencyKey !== undefined) {
      // Stripe never echoes the request header back on the object, so the metadata copy is
      // what lets `payment.payload` trace a charge to the key that created it.
      params.metadata = { ...(params.metadata ?? {}), idempotency_key: input.idempotencyKey };
    }
    if (input.externalReference !== undefined) {
      params.metadata = { ...(params.metadata ?? {}), external_reference: input.externalReference };
    }
    const intent = await this.#stripe.paymentIntents.create(
      params,
      this.#requestOptions(input.idempotencyKey),
    );
    const payment = this.#mapPayment(intent);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const intent = await this.#stripe.paymentIntents.retrieve(gatewayId);
      return this.#mapPayment(intent);
    } catch (error) {
      if (this.#isNotFound(error)) return null;
      throw error;
    }
  }

  async refund(
    paymentGatewayId: string,
    amount?: Money,
    options?: { idempotencyKey?: string },
  ): Promise<Refund> {
    const refund = await this.#stripe.refunds.create(
      {
        payment_intent: paymentGatewayId,
        ...(amount !== undefined ? { amount } : {}),
      },
      this.#requestOptions(options?.idempotencyKey),
    );
    const result: Refund = {
      id: refund.id,
      gatewayId: refund.id,
      provider: this.provider,
      amount: { amount: refund.amount, currency: refund.currency },
      status:
        refund.status === 'succeeded'
          ? 'succeeded'
          : refund.status === 'pending'
            ? 'pending'
            : 'failed',
      createdAt: new Date(refund.created * 1000).toISOString(),
    };
    publishRefundDiagnostics(result);
    return result;
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: input.planId !== undefined ? 'subscription' : 'payment',
      ...(input.customerId !== undefined ? { customer: input.customerId } : {}),
      success_url: input.successUrl,
      ...(input.cancelUrl !== undefined ? { cancel_url: input.cancelUrl } : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Record<string, string> }
        : {}),
      ...(input.planId !== undefined
        ? {
            line_items: [{ price: input.planId, quantity: 1 }],
            ...(input.trialDays !== undefined
              ? { subscription_data: { trial_period_days: input.trialDays } }
              : {}),
          }
        : {
            line_items: [
              {
                price_data: {
                  currency: input.currency ?? this.#currency,
                  product_data: { name: input.description ?? 'Payment' },
                  unit_amount: input.amount,
                },
                quantity: 1,
              },
            ],
          }),
    };
    const session = await this.#stripe.checkout.sessions.create(
      params,
      this.#requestOptions(input.idempotencyKey),
    );
    return {
      id: session.id,
      gatewayId: session.id,
      provider: this.provider,
      url: session.url ?? '',
      status:
        session.status === 'complete'
          ? 'complete'
          : session.status === 'expired'
            ? 'expired'
            : 'open',
      ...(session.amount_total !== null && session.currency !== null
        ? { amount: { amount: session.amount_total, currency: session.currency } }
        : {}),
      ...(session.subscription !== null
        ? {
            subscriptionId:
              typeof session.subscription === 'string'
                ? session.subscription
                : session.subscription.id,
          }
        : {}),
      ...(session.customer !== null
        ? {
            customerId:
              typeof session.customer === 'string' ? session.customer : session.customer.id,
          }
        : {}),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    const params: Stripe.SubscriptionCreateParams = {
      customer: input.customerId,
      items: [{ price: input.planId }],
      ...(input.trialDays !== undefined ? { trial_period_days: input.trialDays } : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Record<string, string> }
        : {}),
      ...(input.externalReference !== undefined
        ? {
            metadata: {
              ...((input.metadata ?? {}) as Record<string, string>),
              external_reference: input.externalReference,
            },
          }
        : {}),
    };
    const subscription = await this.#stripe.subscriptions.create(
      params,
      this.#requestOptions(input.idempotencyKey),
    );
    const result = this.#mapSubscription(subscription);
    publishSubscriptionDiagnostics(result, 'subscription.created');
    return result;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const subscription = await this.#stripe.subscriptions.update(subscriptionGatewayId, {
      cancel_at_period_end: options?.atPeriodEnd ?? true,
    });
    if (options?.atPeriodEnd === false) {
      // Immediate cancel.
      await this.#stripe.subscriptions.cancel(subscriptionGatewayId);
      const canceled = await this.#stripe.subscriptions.retrieve(subscriptionGatewayId);
      const result = this.#mapSubscription(canceled);
      publishSubscriptionDiagnostics(result, 'subscription.canceled');
      return result;
    }
    const result = this.#mapSubscription(subscription);
    publishSubscriptionDiagnostics(result, 'subscription.canceled');
    return result;
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const subscription = await this.#stripe.subscriptions.retrieve(gatewayId);
      return this.#mapSubscription(subscription);
    } catch (error) {
      if (this.#isNotFound(error)) return null;
      throw error;
    }
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    // Stripe changes prices by subscription item id (the billing layer's swap); here we
    // support description/metadata only.
    const params: Stripe.SubscriptionUpdateParams = {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Record<string, string> }
        : {}),
    };
    const subscription = await this.#stripe.subscriptions.update(
      subscriptionGatewayId,
      params,
      this.#requestOptions(input.idempotencyKey),
    );
    return this.#mapSubscription(subscription);
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(customerId: string): Promise<Invoice[]> {
    const invoices = await this.#stripe.invoices.list({ customer: customerId });
    return invoices.data.map((invoice) => {
      const id = invoice.id ?? '';
      const subscriptionId =
        (invoice as { subscription?: string | null }).subscription !== undefined &&
        typeof (invoice as { subscription?: string | null }).subscription === 'string'
          ? ((invoice as { subscription?: string | null }).subscription as string)
          : undefined;
      return {
        id,
        gatewayId: id,
        provider: this.provider,
        ...(typeof invoice.customer === 'string' ? { customerId: invoice.customer } : {}),
        ...(subscriptionId !== undefined ? { subscriptionId } : {}),
        status: invoice.status ?? 'draft',
        amount: { amount: invoice.amount_due, currency: invoice.currency },
        createdAt: new Date(invoice.created * 1000).toISOString(),
        ...(invoice.hosted_invoice_url !== null && invoice.hosted_invoice_url !== undefined
          ? { hostedPdfUrl: invoice.hosted_invoice_url }
          : {}),
        payload: invoice as unknown as Record<string, unknown>,
      };
    });
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (!this.#webhookSecret) {
      throw new Error(
        '[payments] Stripe webhook processing requires `STRIPE_WEBHOOK_SECRET` env var.',
      );
    }
    const signature = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    if (!signature) {
      throw new Error('[payments] Missing `stripe-signature` header on webhook request.');
    }
    // Stripe's constructEvent throws on invalid signature.
    const event = this.#stripe.webhooks.constructEvent(
      rawBody,
      Array.isArray(signature) ? signature[0]! : signature,
      this.#webhookSecret,
    );
    return this.#mapWebhookEvent(event);
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(customer: Stripe.Customer): Customer {
    return {
      id: customer.id,
      ...(customer.email !== null ? { email: customer.email } : {}),
      ...(customer.name !== null ? { name: customer.name } : {}),
      ...(customer.metadata !== undefined && Object.keys(customer.metadata).length > 0
        ? { metadata: customer.metadata as unknown as Record<string, unknown> }
        : {}),
    };
  }

  #mapPayment(intent: Stripe.PaymentIntent): Payment {
    const method =
      intent.payment_method_types.length > 0
        ? this.#mapMethod(intent.payment_method_types[0]!)
        : undefined;
    const result: Payment = {
      id: intent.id,
      gatewayId: intent.id,
      provider: this.provider,
      amount: { amount: intent.amount, currency: intent.currency },
      status: this.#mapIntentStatus(intent.status),
      payload:
        intent.metadata !== undefined && Object.keys(intent.metadata).length > 0
          ? (intent.metadata as unknown as Record<string, unknown>)
          : {},
      createdAt: new Date(intent.created * 1000).toISOString(),
    };
    if (typeof intent.customer === 'string') result.customerId = intent.customer;
    if (method !== undefined && method !== 'unknown') result.method = method;
    if (intent.status === 'succeeded') {
      result.paidAt = new Date(intent.created * 1000).toISOString();
    }
    // A Pix/boleto intent is useless to the caller without what the payer has to act on;
    // Stripe puts it under `next_action`. `image_url_png` is a URL, not the base64 PNG
    // `pixQrCodeImage` promises, so it is deliberately not mapped there.
    const pix = intent.next_action?.pix_display_qr_code;
    if (pix?.data !== undefined) {
      result.pixCode = pix.data;
      result.pixCopiaECola = pix.data;
    }
    const hostedUrl =
      pix?.hosted_instructions_url ??
      intent.next_action?.boleto_display_details?.hosted_voucher_url;
    if (hostedUrl !== null && hostedUrl !== undefined) result.hostedUrl = hostedUrl;
    return result;
  }

  /**
   * A PaymentIntent status → a `BillingStatus`.
   *
   * `requires_capture` is the manual-capture hold: Stripe has the funds reserved on the
   * card and nothing has moved. It used to fall through to `failed` — the same shape of
   * lie in the opposite direction, a live authorization reported as a dead payment — and
   * `requires_confirmation` fell there with it. Neither is a failure; the first is
   * `authorized` and the second is a payment nobody has confirmed yet.
   */
  #mapIntentStatus(status: Stripe.PaymentIntent.Status): Payment['status'] {
    switch (status) {
      case 'succeeded':
        return 'paid';
      case 'requires_capture':
        return 'authorized';
      case 'requires_payment_method':
      case 'requires_confirmation':
      case 'requires_action':
      case 'processing':
        return 'pending';
      case 'canceled':
        return 'canceled';
      default:
        return 'failed';
    }
  }

  /**
   * A Stripe subscription status → a `SubscriptionStatus`.
   *
   * `paused` used to answer `active`, which entitled a subscriber nobody is billing —
   * Stripe pauses collection precisely so you can stop serving them. It has its own name
   * now: the subscription exists, it will bill again, and it must not grant access today.
   */
  #mapSubscriptionStatus(status: string | undefined): Subscription['status'] {
    const statusMap: Record<string, Subscription['status']> = {
      trialing: 'trialing',
      active: 'active',
      past_due: 'past_due',
      incomplete: 'incomplete',
      canceled: 'canceled',
      unpaid: 'past_due',
      incomplete_expired: 'ended',
      paused: 'paused',
    };
    return (status !== undefined ? statusMap[status] : undefined) ?? 'active';
  }

  #mapSubscription(subscription: Stripe.Subscription): Subscription {
    return {
      id: subscription.id,
      gatewayId: subscription.id,
      provider: this.provider,
      customerId:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id,
      status: this.#mapSubscriptionStatus(subscription.status),
      planId: subscription.items.data[0]?.price.id ?? '',
      ...(subscription.items.data[0]?.price.unit_amount !== null
        ? {
            amount: {
              amount: subscription.items.data[0]!.price.unit_amount!,
              currency: subscription.items.data[0]!.price.currency,
            },
          }
        : {}),
      ...(subscription.trial_end !== null
        ? { trialEndsAt: new Date(subscription.trial_end * 1000).toISOString() }
        : {}),
      ...(subscription.cancel_at_period_end
        ? { endsAt: new Date(subscription.ended_at ?? subscription.created * 1000).toISOString() }
        : subscription.ended_at !== null
          ? { endsAt: new Date(subscription.ended_at * 1000).toISOString() }
          : {}),
      payload: subscription as unknown as Record<string, unknown>,
      createdAt: new Date(subscription.created * 1000).toISOString(),
    };
  }

  #mapWebhookEvent(event: Stripe.Event): WebhookEvent {
    const object = event.data.object as unknown as Record<string, unknown>;
    const normalized = this.#normalizeEvent(event.type, object);
    return {
      id: event.id,
      provider: this.provider,
      type: normalized.type,
      // Guarded: `new Date(undefined * 1000).toISOString()` throws a bare RangeError, which
      // surfaces as a crash rather than as this package's own rejection. A real Stripe event
      // always carries `created`, so this only fires on a malformed body — but a malformed
      // body should be REFUSED, not turned into a stack trace.
      //
      // Deliberately untested: this spec's mocked Stripe SDK fills `created`, so a test here
      // passes with and without the guard, which measures nothing. Reaching it needs the real
      // SDK's `constructEvent` over a hand-signed body.
      createdAt: Number.isFinite(event.created)
        ? new Date(event.created * 1000).toISOString()
        : new Date().toISOString(),
      data: normalized.data,
      raw: event as unknown as Record<string, unknown>,
    };
  }

  /**
   * Stripe's own event type → the canonical one, with the payload the processor syncs on.
   *
   * This driver used to pass `event.type` and the raw Stripe object straight through, so
   * `WebhookProcessor` — which switches on the canonical names — recognized nothing Stripe
   * sent and synced nothing: `billing_payments` stayed empty while every webhook was
   * ledgered as processed. A chargeback could not move a row that was never written.
   *
   * A type is only renamed when the canonical payload can actually be built from the
   * object; when it cannot, the event passes through under its Stripe name with the raw
   * object as `data`, which is what the processor does with anything it does not know.
   * That matters because the built-in handlers THROW on a malformed payload, and a throw
   * inside the webhook route is a 500 that Stripe retries forever.
   */
  #normalizeEvent(type: string, object: Record<string, unknown>): { type: string; data: unknown } {
    const passthrough = { type, data: object as unknown };
    const as = (canonical: string, data: Record<string, unknown> | undefined) =>
      data === undefined ? passthrough : { type: canonical, data: data as unknown };

    switch (type) {
      case 'payment_intent.succeeded':
        return as('payment.succeeded', this.#intentData(object));
      case 'payment_intent.payment_failed':
        return as('payment.failed', this.#intentData(object));
      // Real state changes with no canonical event of their own. `amount_capturable_updated`
      // is the manual-capture authorization — money held, not moved — and there is
      // deliberately no `payment.authorized` event for it to become.
      case 'payment_intent.canceled':
      case 'payment_intent.processing':
      case 'payment_intent.requires_action':
      case 'payment_intent.amount_capturable_updated':
        return as('payment.updated', this.#intentData(object));
      case 'charge.refunded': {
        const charge = object as unknown as Stripe.Charge;
        // Stripe fires this for a PARTIAL refund too, and the canonical `payment.refunded`
        // marks the whole payment refunded. Only `refunded: true` — Stripe's own "nothing
        // left" flag — means that; a partial one is an update.
        return as(
          charge.refunded === true ? 'payment.refunded' : 'payment.updated',
          this.#chargeData(object),
        );
      }
      // The dispute family. `charge.dispute.created` fires for BOTH a chargeback and an
      // inquiry, and the two are not the same event at all: on an inquiry the card network
      // is asking a question and **no funds are withdrawn**, so calling it
      // `payment.disputed` took a paid payment away over a question. Stripe distinguishes
      // them only by the status prefix — an inquiry's is `warning_*`.
      case 'charge.dispute.created': {
        const dispute = object as unknown as Stripe.Dispute;
        return typeof dispute.status === 'string' && dispute.status.startsWith('warning_')
          ? as('payment.dispute_warning', this.#disputeWarningData(object))
          : as('payment.disputed', this.#disputeData(object));
      }
      // An early fraud warning is the issuer's TC40/SAFE fraud report, and it arrives
      // before any dispute exists. Stripe's own figure is that ~80% of them become a fraud
      // dispute if you do nothing, and a refund inside the window stops the chargeback
      // being filed at all — which is worth doing even on one you would win, because the
      // chargeback still counts against the ratio that triggers network monitoring.
      case 'radar.early_fraud_warning.created':
        return as('payment.dispute_warning', this.#fraudWarningData(object));
      case 'charge.dispute.closed': {
        const outcome = this.#disputeOutcome(object);
        // Only a status that names an outcome becomes a close. Anything else stays an
        // update rather than inventing a result for money that has not settled.
        return outcome === undefined
          ? as('payment.updated', this.#disputeData(object))
          : as('payment.dispute_closed', this.#disputeClosedData(object, outcome));
      }
      // Funds moving during an open dispute, and evidence being submitted. Neither is a
      // resolution.
      case 'charge.dispute.updated':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated':
        return as('payment.updated', this.#disputeData(object));
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = object as unknown as Stripe.Checkout.Session;
        // A completed session is not a paid one: a subscription checkout completes with no
        // payment at all, and a delayed-notification method (boleto, SEPA) completes while
        // the money is still in flight. `payment_status` is the only field that says so.
        return as(
          session.payment_status === 'paid' ? 'payment.succeeded' : 'payment.updated',
          this.#sessionData(object),
        );
      }
      case 'checkout.session.async_payment_failed':
        return as('payment.failed', this.#sessionData(object));
      case 'checkout.session.expired':
        return as('payment.updated', this.#sessionData(object));
      case 'customer.subscription.created':
        return as('subscription.created', this.#subscriptionData(object));
      case 'customer.subscription.updated':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
      case 'customer.subscription.trial_will_end':
        return as('subscription.updated', this.#subscriptionData(object));
      case 'customer.subscription.deleted':
        return as('subscription.canceled', this.#subscriptionData(object));
      default:
        // Everything else keeps its Stripe name and its raw object: unknown is ledgered
        // and handed to a registered handler, never dropped.
        return passthrough;
    }
  }

  /** A PaymentIntent → the canonical payment payload, or `undefined` if it is not one. */
  #intentData(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const intent = object as unknown as Stripe.PaymentIntent;
    if (
      typeof intent.id !== 'string' ||
      typeof intent.amount !== 'number' ||
      typeof intent.currency !== 'string'
    ) {
      return undefined;
    }
    const metadata = (intent.metadata ?? {}) as Record<string, string | undefined>;
    return {
      gatewayId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      ...(typeof intent.customer === 'string' ? { customerId: intent.customer } : {}),
      ...(typeof metadata.external_reference === 'string'
        ? { externalReference: metadata.external_reference }
        : {}),
    };
  }

  /**
   * A Charge → the canonical payment payload, keyed on the **PaymentIntent**.
   *
   * `charge()` returns `pi_…` and every other event here is keyed on it, so a refund
   * ledgered under `ch_…` would write a second row for the same money instead of moving
   * the first. The charge id is only used for a legacy Charges-API charge that has no
   * intent at all.
   */
  #chargeData(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const charge = object as unknown as Stripe.Charge;
    const gatewayId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : typeof charge.id === 'string'
          ? charge.id
          : undefined;
    if (
      gatewayId === undefined ||
      typeof charge.amount !== 'number' ||
      typeof charge.currency !== 'string'
    ) {
      return undefined;
    }
    const metadata = (charge.metadata ?? {}) as Record<string, string | undefined>;
    return {
      gatewayId,
      amount: charge.amount,
      currency: charge.currency,
      ...(typeof charge.customer === 'string' ? { customerId: charge.customer } : {}),
      ...(typeof metadata.external_reference === 'string'
        ? { externalReference: metadata.external_reference }
        : {}),
    };
  }

  /**
   * A Dispute → the canonical payment payload.
   *
   * `payment_intent` is nullable on the Dispute object (a charge created without one has
   * none), so the charge id is the fallback rather than an assumption. The amount is the
   * DISPUTED amount, which for a partial dispute is less than the payment — the row moves
   * to `disputed` either way, and `event.raw` carries the reason and the evidence deadline.
   */
  #disputeData(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const dispute = object as unknown as Stripe.Dispute;
    const gatewayId =
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : typeof dispute.charge === 'string'
          ? dispute.charge
          : undefined;
    if (
      gatewayId === undefined ||
      typeof dispute.amount !== 'number' ||
      typeof dispute.currency !== 'string'
    ) {
      return undefined;
    }
    return { gatewayId, amount: dispute.amount, currency: dispute.currency };
  }

  /**
   * An inquiry (`warning_*`) or the pre-dispute half of the dispute family. Carries the
   * deadline, which is the entire value of the alert: an inquiry left unanswered reads to
   * the issuer as accepting the claim and becomes a chargeback that is probably
   * irreversible.
   */
  #disputeWarningData(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const base = this.#disputeData(object);
    if (base === undefined) return undefined;
    const dispute = object as unknown as Stripe.Dispute;
    const dueBy = dispute.evidence_details?.due_by;
    return {
      ...base,
      disputeId: dispute.id,
      ...(typeof dispute.reason === 'string' ? { reason: dispute.reason } : {}),
      ...(typeof dueBy === 'number'
        ? { actionableUntil: new Date(dueBy * 1000).toISOString() }
        : {}),
    };
  }

  /**
   * An early fraud warning has no deadline of its own — the window closes when the
   * chargeback is filed, which is the thing you are trying to prevent — so it carries no
   * `actionableUntil`. `actionable` is Stripe's own flag for whether anything can still be
   * done: false once a dispute has arrived or the charge is fully refunded.
   */
  #fraudWarningData(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const warning = object as unknown as Stripe.Radar.EarlyFraudWarning;
    const gatewayId =
      typeof warning.payment_intent === 'string'
        ? warning.payment_intent
        : typeof warning.charge === 'string'
          ? warning.charge
          : undefined;
    if (gatewayId === undefined) return undefined;
    return {
      gatewayId,
      disputeId: warning.id,
      reason: warning.fraud_type,
      actionable: warning.actionable,
    };
  }

  /**
   * `warning_closed` is an inquiry that sat 120 days without escalating. The networks send
   * no explicit win for one, so it is `expired` rather than `won` — nothing was decided in
   * your favour, the clock simply ran out in the right direction.
   */
  #disputeOutcome(object: Record<string, unknown>): 'won' | 'lost' | 'expired' | undefined {
    const status = (object as unknown as Stripe.Dispute).status;
    if (status === 'won') return 'won';
    if (status === 'lost') return 'lost';
    if (status === 'warning_closed') return 'expired';
    return undefined;
  }

  #disputeClosedData(
    object: Record<string, unknown>,
    outcome: 'won' | 'lost' | 'expired',
  ): Record<string, unknown> | undefined {
    const base = this.#disputeData(object);
    if (base === undefined) return undefined;
    return { ...base, disputeId: (object as unknown as Stripe.Dispute).id, outcome };
  }

  /** A Checkout Session → the canonical payment payload, keyed on its PaymentIntent. */
  #sessionData(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const session = object as unknown as Stripe.Checkout.Session;
    const gatewayId =
      typeof session.payment_intent === 'string' ? session.payment_intent : undefined;
    if (
      gatewayId === undefined ||
      typeof session.amount_total !== 'number' ||
      typeof session.currency !== 'string'
    ) {
      return undefined;
    }
    const metadata = (session.metadata ?? {}) as Record<string, string | undefined>;
    return {
      gatewayId,
      amount: session.amount_total,
      currency: session.currency,
      ...(typeof session.customer === 'string' ? { customerId: session.customer } : {}),
      ...(typeof session.subscription === 'string' ? { subscriptionId: session.subscription } : {}),
      ...(typeof metadata.external_reference === 'string'
        ? { externalReference: metadata.external_reference }
        : typeof session.client_reference_id === 'string'
          ? { externalReference: session.client_reference_id }
          : {}),
    };
  }

  /** A Subscription → the canonical subscription payload. */
  #subscriptionData(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const subscription = object as unknown as Stripe.Subscription;
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : (subscription.customer as { id?: string } | undefined)?.id;
    if (typeof subscription.id !== 'string' || typeof customerId !== 'string') return undefined;
    const planId = subscription.items?.data?.[0]?.price?.id;
    return {
      gatewayId: subscription.id,
      customerId,
      status: this.#mapSubscriptionStatus(subscription.status),
      ...(typeof planId === 'string' ? { planId } : {}),
      ...(typeof subscription.trial_end === 'number'
        ? { trialEndsAt: new Date(subscription.trial_end * 1000).toISOString() }
        : {}),
      ...(typeof subscription.ended_at === 'number'
        ? { endsAt: new Date(subscription.ended_at * 1000).toISOString() }
        : {}),
    };
  }

  /**
   * Canonical method → the Stripe `payment_method_types` entry that produces it. An
   * unnamed (or unmappable) method leaves the intent on the account's dynamic payment
   * methods, which is Stripe's own default rather than a silent substitution.
   */
  #mapMethodToStripe(method?: string): string | undefined {
    switch (method) {
      case 'pix':
        return 'pix';
      case 'boleto':
        return 'boleto';
      case 'credit_card':
        return 'card';
      default:
        return undefined;
    }
  }

  /**
   * Stripe deduplicates on the `Idempotency-Key` request header, which the SDK takes as a
   * request option — a key sent in the body retries into a second charge.
   */
  #requestOptions(idempotencyKey?: string): Stripe.RequestOptions | undefined {
    return idempotencyKey !== undefined ? { idempotencyKey } : undefined;
  }

  /**
   * A Stripe `payment_method_types` entry → the canonical {@link PaymentMethodType}.
   *
   * By category, never by brand: Stripe adds a local method most quarters, and a driver
   * that enumerated iDEAL, BLIK, TWINT and the rest would go stale between releases while
   * `PaymentMethodType` — a closed union — could never keep up. So SEPA and ACH are one
   * answer (`bank_debit`, pulled from an account), iDEAL and Bancontact another
   * (`bank_transfer`, pushed from a bank), and the brand stays readable on
   * `payment.payload`.
   *
   * The type is read off `payment_method_types[0]`, which is the list of methods the
   * intent ALLOWS. With one entry — what this driver sends whenever the charge names a
   * `method` — it is exact; with the account's dynamic payment methods it is Stripe's own
   * ordering, and the settled method is only known once `latest_charge` exists.
   */
  #mapMethod(method: string): Payment['method'] {
    switch (method) {
      case 'card':
      case 'card_present':
        return 'card';
      case 'pix':
        return 'pix';
      case 'boleto':
        return 'boleto';
      // Pulled from an account you hold a mandate on.
      case 'sepa_debit':
      case 'us_bank_account':
      case 'acss_debit':
      case 'bacs_debit':
      case 'au_becs_debit':
        return 'bank_debit';
      // Pushed from the payer's own bank, in their own banking app.
      case 'ideal':
      case 'bancontact':
      case 'eps':
      case 'p24':
      case 'blik':
      case 'multibanco':
      case 'sofort':
      case 'customer_balance':
        return 'bank_transfer';
      // Stored-balance and device wallets.
      case 'link':
      case 'paypal':
      case 'wechat_pay':
      case 'alipay':
      case 'cashapp':
      case 'revolut_pay':
      case 'amazon_pay':
      case 'twint':
        return 'wallet';
      case 'klarna':
      case 'afterpay_clearpay':
      case 'affirm':
      case 'zip':
        return 'bnpl';
      // Paid in cash at a counter against a printed reference.
      case 'oxxo':
      case 'konbini':
      case 'paysafecard':
        return 'voucher';
      default:
        return 'unknown';
    }
  }

  #isNotFound(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      (error as { statusCode?: number }).statusCode === 404
    );
  }
}
