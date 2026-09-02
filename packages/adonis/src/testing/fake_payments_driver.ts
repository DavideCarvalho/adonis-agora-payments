import type { PaymentsDriver, UpdateSubscriptionInput } from '../driver.js';
import type {
  CheckoutSession,
  Customer,
  Invoice,
  Payment,
  Refund,
  Subscription,
  WebhookEvent,
} from '../types.js';

export interface FakePaymentsDriverOptions {
  provider?: string;
  /** Queue of webhook events `parseWebhook` returns (in order). */
  webhookEvents?: WebhookEvent[];
  /**
   * Override what this fake claims to support, for a test ABOUT a gateway limitation.
   *
   * Merged over the defaults, so `{ disputes: false }` says exactly that and leaves the rest
   * alone. Spell it out rather than relying on absence: a capability the fake happens not to
   * declare is a limitation nobody chose, and it fails tests about the application for a
   * reason that lives in the double.
   */
  capabilities?: Partial<NonNullable<PaymentsDriver['capabilities']>>;
}

/**
 * In-memory {@link PaymentsDriver} for tests and local development. Records every call and
 * returns canned responses, so billing flows can be exercised without a gateway.
 */
export class FakePaymentsDriver implements PaymentsDriver {
  readonly provider: string;
  readonly supportedMethods = ['pix', 'credit_card', 'boleto', 'debit_card', 'undefined'] as const;

  /**
   * Everything, because this driver implements everything.
   *
   * It declared NOTHING, which was invisible until the manager started checking: capability
   * guards read `capabilities?.x === true`, so an absent block means "cannot". The moment
   * `subscriptions().cancel()` began asserting the gateway can cancel, every consumer's test
   * that cancelled through a `FakePaymentsDriver` started failing on a limitation the fake
   * does not have — it records the call and returns a subscription like it always did.
   *
   * A test double that refuses what it implements is worse than no double: it fails tests
   * about the application for a reason that lives in the double.
   */
  readonly capabilities: NonNullable<PaymentsDriver['capabilities']>;

  /** Canned webhook events returned by `parseWebhook`, in order. */
  webhookEvents: WebhookEvent[];

  // Call records for assertions.
  createCustomerCalls: { input: Parameters<PaymentsDriver['createCustomer']>[0] }[] = [];
  chargeCalls: { input: Parameters<PaymentsDriver['charge']>[0] }[] = [];
  refundCalls: { paymentGatewayId: string; amount?: number }[] = [];
  createCheckoutCalls: { input: Parameters<PaymentsDriver['createCheckout']>[0] }[] = [];
  createSubscriptionCalls: { input: Parameters<PaymentsDriver['createSubscription']>[0] }[] = [];
  cancelSubscriptionCalls: { id: string; options?: { atPeriodEnd?: boolean } }[] = [];
  updateSubscriptionCalls: { id: string; input: UpdateSubscriptionInput }[] = [];

  // Canned results.
  customers: Map<string, Customer> = new Map();
  payments: Map<string, Payment> = new Map();
  subscriptions: Map<string, Subscription> = new Map();
  invoices: Invoice[] = [];

  constructor(options: FakePaymentsDriverOptions = {}) {
    this.provider = options.provider ?? 'fake';
    this.webhookEvents = options.webhookEvents ?? [];
    // Everything on by default, because this driver implements everything. It used to
    // declare NOTHING, which was invisible until the manager began checking: the guards read
    // `capabilities?.x === true`, so an absent block means "cannot". The moment
    // `subscriptions().cancel()` started asserting the gateway can cancel, every test that
    // cancelled through this fake failed on a limitation the fake does not have.
    this.capabilities = {
      disputes: true,
      refunds: true,
      invoices: true,
      subscriptions: true,
      cardTokenization: false,
      subscriptionLifecycle: { create: true, update: true, cancel: true },
      ...options.capabilities,
    };
  }

  async createCustomer(input: Parameters<PaymentsDriver['createCustomer']>[0]): Promise<Customer> {
    this.createCustomerCalls.push({ input });
    const customer: Customer = {
      id: `cus_${this.customers.size + 1}`,
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    return this.customers.get(customerId) ?? null;
  }

  async updateCustomer(
    customerId: string,
    input: Parameters<PaymentsDriver['updateCustomer']>[1],
  ): Promise<Customer> {
    const existing = this.customers.get(customerId) ?? { id: customerId };
    const updated: Customer = {
      id: customerId,
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
    };
    void existing;
    this.customers.set(customerId, updated);
    return updated;
  }

  async charge(input: Parameters<PaymentsDriver['charge']>[0]): Promise<Payment> {
    this.chargeCalls.push({ input });
    const payment: Payment = {
      id: `pi_${this.payments.size + 1}`,
      gatewayId: `pi_${this.payments.size + 1}`,
      provider: this.provider,
      amount: { amount: input.amount, currency: input.currency ?? 'brl' },
      status: 'paid',
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      payload: {},
      createdAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
    };
    this.payments.set(payment.gatewayId, payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    return this.payments.get(gatewayId) ?? null;
  }

  async refund(paymentGatewayId: string, amount?: number): Promise<Refund> {
    this.refundCalls.push(
      amount !== undefined ? { paymentGatewayId, amount } : { paymentGatewayId },
    );
    const payment = this.payments.get(paymentGatewayId);
    return {
      id: `re_${this.refundCalls.length}`,
      gatewayId: `re_${this.refundCalls.length}`,
      provider: this.provider,
      amount: {
        amount: amount ?? payment?.amount.amount ?? 0,
        currency: payment?.amount.currency ?? 'brl',
      },
      status: 'succeeded',
      createdAt: new Date().toISOString(),
    };
  }

  async createCheckout(
    input: Parameters<PaymentsDriver['createCheckout']>[0],
  ): Promise<CheckoutSession> {
    this.createCheckoutCalls.push({ input });
    return {
      id: `cs_${this.createCheckoutCalls.length}`,
      gatewayId: `cs_${this.createCheckoutCalls.length}`,
      provider: this.provider,
      url: 'https://checkout.example.test/session',
      status: 'open',
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.planId !== undefined
        ? { subscriptionId: `sub_${this.createCheckoutCalls.length}` }
        : {}),
    };
  }

  async createSubscription(
    input: Parameters<PaymentsDriver['createSubscription']>[0],
  ): Promise<Subscription> {
    this.createSubscriptionCalls.push({ input });
    const subscription: Subscription = {
      id: `sub_${this.subscriptions.size + 1}`,
      gatewayId: `sub_${this.subscriptions.size + 1}`,
      provider: this.provider,
      customerId: input.customerId,
      status: 'active',
      planId: input.planId,
      payload: {},
      createdAt: new Date().toISOString(),
    };
    this.subscriptions.set(subscription.gatewayId, subscription);
    return subscription;
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    this.cancelSubscriptionCalls.push(
      options !== undefined
        ? { id: subscriptionGatewayId, options }
        : { id: subscriptionGatewayId },
    );
    const existing = this.subscriptions.get(subscriptionGatewayId);
    const canceled: Subscription = {
      ...(existing ?? {
        id: subscriptionGatewayId,
        gatewayId: subscriptionGatewayId,
        provider: this.provider,
        customerId: '',
        status: 'canceled',
        planId: '',
        payload: {},
        createdAt: new Date().toISOString(),
      }),
      status: 'canceled',
      ...(options?.atPeriodEnd === false ? { endsAt: new Date().toISOString() } : {}),
    };
    this.subscriptions.set(subscriptionGatewayId, canceled);
    return canceled;
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    return this.subscriptions.get(gatewayId) ?? null;
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    this.updateSubscriptionCalls.push({ id: subscriptionGatewayId, input });
    const existing = this.subscriptions.get(subscriptionGatewayId);
    const updated: Subscription = {
      ...(existing ?? {
        id: subscriptionGatewayId,
        gatewayId: subscriptionGatewayId,
        provider: this.provider,
        customerId: '',
        status: 'active',
        planId: '',
        payload: {},
        createdAt: new Date().toISOString(),
      }),
      ...(input.amount !== undefined ? { amount: { amount: input.amount, currency: 'brl' } } : {}),
    };
    this.subscriptions.set(subscriptionGatewayId, updated);
    return updated;
  }

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    return this.invoices;
  }

  parseWebhook(
    _rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const event = this.webhookEvents.shift();
    if (!event) {
      throw new Error('[payments] FakePaymentsDriver.parseWebhook: no webhookEvents queued.');
    }
    return event;
  }
}
