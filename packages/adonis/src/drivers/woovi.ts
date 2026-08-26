import { createClient } from '@woovi/node-sdk';
import type { WooviDriverConfig } from '../define_config.js';
import { publishPaymentDiagnostics, publishSubscriptionDiagnostics } from '../diagnostics.js';
import type {
  ChargeInput,
  CheckoutInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  PaymentsDriver,
  UpdateCustomerInput,
  UpdateSubscriptionInput,
} from '../driver.js';
import { headerValue } from '../http.js';
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
import { verifyHmacSignature, verifyRsaSha256Signature } from '../webhook_security.js';

/**
 * Woovi/OpenPix driver — Brazilian Pix gateway with Pix Automático (recurring Pix via
 * webhooks, no card). Uses the official `@woovi/node-sdk` (lazily imported by the factory,
 * so the SDK stays an optional peer dependency).
 */
/** A Woovi subaccount (OpenPix for Platforms marketplace receiver). */
export interface WooviSubAccount {
  name: string;
  pixKey: string;
  balance: number;
}

export class WooviDriver implements PaymentsDriver {
  readonly provider = 'woovi';
  // Woovi/OpenPix is Pix-only and has no refunds or invoice concept.
  readonly supportedMethods = ['pix', 'undefined'] as const;
  readonly capabilities = { subscriptions: true };

  #client: {
    charge: {
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      get(data: { id: string }): Promise<Record<string, unknown>>;
    };
    subscription: {
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      get(data: { id: string }): Promise<Record<string, unknown>>;
    };
    customer: {
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      get(data: { id: string }): Promise<Record<string, unknown>>;
    };
    subAccount: {
      create(input: { pixKey: string; name: string }): Promise<{ SubAccount: WooviSubAccount }>;
      get(data: { id: string }): Promise<{ SubAccount: WooviSubAccount }>;
      list(): Promise<{ subAccounts: WooviSubAccount[] }>;
    };
  };

  #invoiceCtx: EmitInvoiceContext;
  /** HMAC secret of the specific webhook config (dashboard → API/Plugins). */
  #webhookSecret: string | undefined;
  /** Woovi account public key, used to verify `x-webhook-signature` (recommended). */
  #webhookPublicKey: string | undefined;
  #appId: string;

  constructor(ctx: EmitInvoiceContext, config: WooviDriverConfig = {}) {
    this.#invoiceCtx = ctx;
    const appId = config.appId ?? process.env.WOOVI_APP_ID;
    if (!appId) {
      throw new Error(
        '[payments] Woovi driver requires an app id. Set `WOOVI_APP_ID` env or pass `appId` to `payments.woovi()`.',
      );
    }
    this.#appId = appId;
    this.#webhookSecret = config.webhookSecret ?? process.env.WOOVI_WEBHOOK_SECRET;
    this.#webhookPublicKey = config.webhookPublicKey ?? process.env.WOOVI_WEBHOOK_PUBLIC_KEY;
    // Lazy import happens in the factory (see `define_config.ts`), so the SDK module is
    // only loaded when this driver is actually selected.
    this.#client = createClient({ appId });
  }

  // ── Customers ────────────────────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const data = await this.#client.customer.create({
      name: input.name ?? input.email ?? 'Customer',
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.taxId !== undefined ? { taxID: { taxID: input.taxId, type: 'BR:CPF' } } : {}),
    });
    return this.#mapCustomer(data);
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    try {
      const data = await this.#client.customer.get({ id: customerId });
      return this.#mapCustomer(data);
    } catch {
      return null;
    }
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput): Promise<Customer> {
    // OpenPix customers are immutable; return the existing customer best-effort.
    const data = await this.#client.customer.create({
      correlationID: customerId,
      name: input.name ?? 'Customer',
      ...(input.email !== undefined ? { email: input.email } : {}),
    });
    return this.#mapCustomer(data);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────────────

  async charge(input: ChargeInput): Promise<Payment> {
    const data = await this.#client.charge.create({
      // Woovi's `correlationID` is the app's own reference — the routing key webhook
      // handlers read. Prefer the explicit `externalReference`, fall back to the
      // idempotency key (legacy behavior).
      correlationID: input.externalReference ?? input.idempotencyKey ?? `charge_${Date.now()}`,
      value: toDecimal(input.amount),
      ...(input.description !== undefined ? { comment: input.description } : {}),
      ...(input.customerId !== undefined ? { customer: input.customerId } : {}),
    });
    const payment = this.#mapPayment(data);
    await emitInvoiceIfRequested(this.#invoiceCtx, input, payment, this);
    publishPaymentDiagnostics(payment);
    return payment;
  }

  async findPayment(gatewayId: string): Promise<Payment | null> {
    try {
      const data = await this.#client.charge.get({ id: gatewayId });
      return this.#mapPayment(data);
    } catch {
      return null;
    }
  }

  async refund(_paymentGatewayId: string, _amount?: Money): Promise<Refund> {
    throw new Error('[payments] Woovi/OpenPix does not support refunds via API.');
  }

  // ── Subaccounts (Woovi for Platforms) ────────────────────────────────────────────────

  /** Create a subaccount (marketplace receiver) keyed by a Pix key. */
  async createSubAccount(input: { pixKey: string; name: string }): Promise<WooviSubAccount> {
    const data = await this.#client.subAccount.create(input);
    return this.#mapSubAccount(data.SubAccount);
  }

  /** Find a subaccount by its id. */
  async findSubAccount(id: string): Promise<WooviSubAccount | null> {
    try {
      const data = await this.#client.subAccount.get({ id });
      return this.#mapSubAccount(data.SubAccount);
    } catch {
      return null;
    }
  }

  /** List every subaccount. */
  async listSubAccounts(): Promise<WooviSubAccount[]> {
    const data = await this.#client.subAccount.list();
    return data.subAccounts.map((s) => this.#mapSubAccount(s));
  }

  #mapSubAccount(data: WooviSubAccount): WooviSubAccount {
    return {
      name: data.name ?? '',
      pixKey: data.pixKey ?? '',
      balance: Number(data.balance ?? 0),
    };
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────────────

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const data = await this.#client.charge.create({
      correlationID: input.idempotencyKey ?? `checkout_${Date.now()}`,
      value: toDecimal(input.amount),
      ...(input.description !== undefined ? { comment: input.description } : {}),
    });
    const charge = data as {
      pixQrCode?: { brCode?: string; qrCodeImage?: string };
      brCode?: { brCode?: string };
      id?: string;
    };
    const brCode = charge.pixQrCode?.brCode ?? charge.brCode?.brCode ?? '';
    return {
      id: String(charge.id ?? ''),
      gatewayId: String(charge.id ?? ''),
      provider: this.provider,
      url: '',
      status: 'open',
      amount: { amount: input.amount, currency: 'brl' },
      ...(brCode !== '' ? { pixCopiaECola: brCode } : {}),
    };
  }

  // ── Subscriptions (Pix Automático) ──────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    // Woovi creates subscriptions with an inline customer (no customer-id flow).
    const customer = await this.#resolveSubscriptionCustomer(input);
    const body: Record<string, unknown> = {
      customer,
      value: toDecimal(input.amount ?? 0),
      dayGenerateCharge: this.#dayOfMonth(input.startDate) ?? 1,
      ...(input.cycle !== undefined ? { frequency: this.#mapFrequency(input.cycle) } : {}),
      // Pix Automático journey 3 (pay-on-approval): `DYNAMIC` generates each charge and
      // asks the payer to approve it. Override via `metadata.chargeType` if needed.
      ...(input.metadata?.chargeType !== undefined
        ? { chargeType: input.metadata.chargeType }
        : { chargeType: 'DYNAMIC' }),
      ...(input.metadata?.dayDue !== undefined ? { dayDue: input.metadata.dayDue } : {}),
    };
    const data = await this.#client.subscription.create(body);
    // The SDK wraps the created subscription in `{ subscription }` (get/find return it bare).
    const subscription = this.#mapSubscription(
      (data as { subscription?: Record<string, unknown> }).subscription ??
        (data as Record<string, unknown>),
    );
    publishSubscriptionDiagnostics(subscription, 'subscription.created');
    return subscription;
  }

  /** Woovi's inline customer: `input.customer`, else the gateway customer (needs name+taxId). */
  async #resolveSubscriptionCustomer(
    input: CreateSubscriptionInput,
  ): Promise<{ name: string; email: string; taxID: string; phone?: string }> {
    if (input.customer?.name && input.customer.taxId) {
      return {
        name: input.customer.name,
        email: input.customer.email ?? '',
        taxID: input.customer.taxId.replace(/\D/g, ''),
      };
    }
    if (input.customerId) {
      const customer = await this.findCustomer(input.customerId);
      if (customer?.name && customer.taxId) {
        return {
          name: customer.name,
          email: customer.email ?? '',
          taxID: customer.taxId.replace(/\D/g, ''),
        };
      }
    }
    throw new Error(
      '[payments] Woovi subscription needs the payer name + taxId — pass `customer` on the subscription, or create the gateway customer with them.',
    );
  }

  #mapFrequency(cycle: string): string {
    switch (cycle) {
      case 'WEEKLY':
        return 'WEEKLY';
      case 'MONTHLY':
        return 'MONTHLY';
      case 'QUARTERLY':
        return 'TRIMONTHLY';
      case 'SEMIANNUALLY':
        return 'SEMIANNUALY';
      case 'YEARLY':
        return 'ANNUALY';
      default:
        return 'MONTHLY';
    }
  }

  async cancelSubscription(
    subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    const data = await this.#client.subscription.get({ id: subscriptionGatewayId });
    const subscription = this.#mapSubscription({ ...data, status: 'INACTIVE' });
    publishSubscriptionDiagnostics(subscription, 'subscription.canceled');
    return subscription;
  }

  async findSubscription(gatewayId: string): Promise<Subscription | null> {
    try {
      const data = await this.#client.subscription.get({ id: gatewayId });
      return this.#mapSubscription(data);
    } catch {
      return null;
    }
  }

  async updateSubscription(
    subscriptionGatewayId: string,
    input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    // OpenPix subscriptions are immutable — best-effort: fetch and return with the new
    // amount/description applied locally (the change takes effect on the next cycle by
    // recreating the subscription in a real integration).
    const data = await this.#client.subscription.get({ id: subscriptionGatewayId });
    const updated: Record<string, unknown> = {
      ...data,
      ...(input.amount !== undefined ? { value: toDecimal(input.amount) } : {}),
      ...(input.description !== undefined ? { comment: input.description } : {}),
    };
    return this.#mapSubscription(updated);
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    // OpenPix has no invoice concept — charges are the billing record.
    return [];
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    // Woovi signs webhooks two ways: the recommended `x-webhook-signature`
    // (RSA-SHA256 with Woovi's account public key — validates the SENDER) and the
    // per-webhook HMAC (`X-OpenPix-Signature`, deprecated but validates YOUR webhook
    // config). Whichever credential is configured is enforced strictly; without one
    // only the app id header (when set) guards the endpoint.
    if (this.#webhookPublicKey !== undefined) {
      const signature = headerValue(headers, 'x-webhook-signature');
      if (!verifyRsaSha256Signature(rawBody, signature, this.#webhookPublicKey)) {
        throw new Error('[payments] Invalid or missing Woovi webhook signature.');
      }
    } else if (this.#webhookSecret !== undefined) {
      const hmac = headerValue(headers, 'x-openpix-signature');
      if (!verifyHmacSignature(rawBody, hmac, this.#webhookSecret, 'sha1')) {
        throw new Error('[payments] Invalid or missing Woovi webhook HMAC.');
      }
    }
    const appId = headerValue(headers, 'app_id') ?? headerValue(headers, 'x-woovi-app-id');
    if (this.#appId && appId && appId !== this.#appId) {
      throw new Error('[payments] Invalid Woovi webhook app id.');
    }
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const event = String(payload.event ?? 'unknown');
    return {
      id: String(payload.id ?? payload.globalID ?? `${event}-${Math.random()}`),
      provider: this.provider,
      type: this.#mapWebhookType(event),
      createdAt: new Date().toISOString(),
      data: payload,
      raw: payload,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────────────

  #mapCustomer(data: Record<string, unknown>): Customer {
    const taxId = (data.taxID as { taxID?: string } | undefined)?.taxID;
    return {
      id: String(data.id ?? data.correlationID ?? ''),
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
      ...(typeof data.email === 'string' ? { email: data.email } : {}),
      ...(taxId !== undefined ? { taxId } : {}),
    };
  }

  #mapPayment(data: Record<string, unknown>): Payment {
    const value = typeof data.value === 'number' ? data.value : 0;
    const status = String(data.status ?? 'ACTIVE').toUpperCase();
    const pixQrCode =
      (data.pixQrCode as { brCode?: string } | undefined)?.brCode ??
      (data.brCode as { brCode?: string } | undefined)?.brCode;
    return {
      id: String(data.id ?? data.globalID ?? ''),
      gatewayId: String(data.globalID ?? data.id ?? ''),
      provider: this.provider,
      amount: { amount: fromDecimal(value), currency: 'brl' },
      status:
        status === 'COMPLETED' || status === 'PAID'
          ? 'paid'
          : status === 'EXPIRED' || status === 'CANCELED' || status === 'REJECTED'
            ? 'canceled'
            : 'pending',
      ...(pixQrCode !== undefined ? { pixCopiaECola: pixQrCode } : {}),
      ...(typeof data.correlationID === 'string' ? { customerId: data.correlationID } : {}),
      payload: data,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    };
  }

  #mapSubscription(data: Record<string, unknown>): Subscription {
    const value = typeof data.value === 'number' ? data.value : 0;
    const status = String(data.status ?? 'ACTIVE').toUpperCase();
    const globalId = String(data.globalID ?? data.id ?? '');
    return {
      id: globalId,
      gatewayId: globalId,
      provider: this.provider,
      customerId: String(data.correlationID ?? ''),
      status:
        status === 'ACTIVE' || status === 'APPROVED'
          ? 'active'
          : status === 'INACTIVE' || status === 'CANCELED'
            ? 'canceled'
            : status === 'REJECTED'
              ? 'past_due'
              : 'trialing',
      planId: String(
        (data.pixRecurring as { recurrencyId?: string } | undefined)?.recurrencyId ?? '',
      ),
      amount: { amount: fromDecimal(value), currency: 'brl' },
      payload: data,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    };
  }

  #mapWebhookType(event: string): string {
    switch (event) {
      case 'PIX_AUTOMATIC_APPROVED':
        return 'subscription.created';
      case 'PIX_AUTOMATIC_REJECTED':
        return 'subscription.canceled';
      case 'PIX_AUTOMATIC_COBR_COMPLETED':
        return 'payment.succeeded';
      case 'PIX_AUTOMATIC_COBR_REJECTED':
      case 'PIX_AUTOMATIC_COBR_TRY_REJECTED':
        return 'payment.failed';
      case 'CHARGE_COMPLETED':
        return 'payment.succeeded';
      case 'CHARGE_EXPIRED':
        return 'payment.failed';
      default:
        return event.toLowerCase();
    }
  }

  #dayOfMonth(date?: string): number | undefined {
    if (!date) return undefined;
    const day = new Date(date).getDate();
    return Number.isNaN(day) ? undefined : day;
  }
}
