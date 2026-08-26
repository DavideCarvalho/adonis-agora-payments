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
    this.#currency = config.currency ?? 'brl';
    this.#webhookSecret = config.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const customer = await this.#stripe.customers.create({
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.taxId !== undefined ? { tax_id: input.taxId } : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Record<string, string> }
        : {}),
    });
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
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.amount,
      currency: input.currency ?? this.#currency,
      ...(input.customerId !== undefined ? { customer: input.customerId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.paymentMethodId !== undefined ? { payment_method: input.paymentMethodId } : {}),
      ...(input.card !== undefined ? { payment_method: input.card.token } : {}),
      ...(input.metadata !== undefined
        ? { metadata: input.metadata as Record<string, string> }
        : {}),
      ...(input.idempotencyKey !== undefined ? {} : {}),
    };
    if (input.idempotencyKey !== undefined) {
      params.metadata = { ...(params.metadata ?? {}), idempotency_key: input.idempotencyKey };
    }
    const intent = await this.#stripe.paymentIntents.create(params);
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

  async refund(paymentGatewayId: string, amount?: Money): Promise<Refund> {
    const refund = await this.#stripe.refunds.create({
      payment_intent: paymentGatewayId,
      ...(amount !== undefined ? { amount } : {}),
    });
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
    const session = await this.#stripe.checkout.sessions.create(params);
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
    };
    const subscription = await this.#stripe.subscriptions.create(params);
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
    const subscription = await this.#stripe.subscriptions.update(subscriptionGatewayId, params);
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
      status:
        intent.status === 'succeeded'
          ? 'paid'
          : intent.status === 'requires_payment_method' ||
              intent.status === 'requires_action' ||
              intent.status === 'processing'
            ? 'pending'
            : intent.status === 'canceled'
              ? 'canceled'
              : 'failed',
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
    return result;
  }

  #mapSubscription(subscription: Stripe.Subscription): Subscription {
    const statusMap: Record<string, Subscription['status']> = {
      trialing: 'trialing',
      active: 'active',
      past_due: 'past_due',
      incomplete: 'incomplete',
      canceled: 'canceled',
      unpaid: 'past_due',
      incomplete_expired: 'ended',
      paused: 'active',
    };
    return {
      id: subscription.id,
      gatewayId: subscription.id,
      provider: this.provider,
      customerId:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id,
      status: statusMap[subscription.status] ?? 'active',
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
    return {
      id: event.id,
      provider: this.provider,
      type: event.type,
      createdAt: new Date(event.created * 1000).toISOString(),
      data: event.data.object as unknown,
      raw: event as unknown as Record<string, unknown>,
    };
  }

  #mapMethod(method: string): Payment['method'] {
    switch (method) {
      case 'card':
        return 'card';
      case 'pix':
        return 'pix';
      case 'boleto':
        return 'boleto';
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
