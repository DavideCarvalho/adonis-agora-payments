import { createHash } from 'node:crypto';
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
  WebhookVerificationState,
} from '../driver.js';
import { headerValue } from '../http.js';
import type { EmitInvoiceContext } from '../invoice/emit_invoice.js';
import { emitInvoiceIfRequested } from '../invoice/emit_invoice.js';
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
/**
 * Journey 3. Woovi's own recommendation, and the only one where the payer both authorizes
 * and pays by scanning a single QR code — the closest thing to a card checkout.
 */
const DEFAULT_JOURNEY = 'PAYMENT_ON_APPROVAL';

/**
 * No automatic retry. The conservative default on purpose: `THREE_RETRIES_7_DAYS` re-debits
 * a payer's bank account without the app asking, which is not something to opt someone into.
 */
const DEFAULT_RETRY_POLICY = 'NON_PERMITED';

/** Days a generated charge stays payable before expiring. */
const DEFAULT_DAY_DUE = 3;

/** `comment` is the adoption-contract text in the payer's bank app; Woovi caps it at 30. */
const COMMENT_MAX_LENGTH = 30;

/** A non-empty string, or `undefined`. Woovi returns `brCode` as a string at two levels. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

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
  /**
   * Creates subscriptions; cannot cancel or update one. The OpenPix subscription API is
   * `create` and `get`, and that asymmetry is a fact callers need BEFORE they offer a cancel
   * button — not an exception they discover when a customer clicks it.
   */
  readonly capabilities = {
    subscriptions: true,
    subscriptionLifecycle: { create: true, update: false, cancel: false },
  };

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
      // Centavos, straight through. OpenPix documents `value` as "o valor em centavos da
      // cobrança Pix" — the same integer minor unit this package uses — so there is no
      // conversion to do. This driver used to send `toDecimal(amount)`, which turned a
      // R$19,90 charge into `value: 19.9` and created a **20 centavo** charge at the
      // gateway. The neighbouring Asaas and AbacatePay drivers DO work in decimal reais;
      // the difference is Woovi's, not an oversight here.
      value: input.amount,
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
      value: input.amount,
      ...(input.description !== undefined ? { comment: input.description } : {}),
    });
    // Same envelope as `charge()` — unwrap before reading, or every field is undefined.
    const envelope = data as Record<string, unknown>;
    const charge =
      typeof envelope.charge === 'object' && envelope.charge !== null
        ? (envelope.charge as Record<string, unknown>)
        : envelope;
    const brCode =
      asString(charge.brCode) ??
      asString(envelope.brCode) ??
      (charge.pixQrCode as { brCode?: string } | undefined)?.brCode ??
      '';
    const id = String(charge.globalID ?? charge.id ?? '');
    return {
      id,
      gatewayId: id,
      provider: this.provider,
      url: asString(charge.paymentLinkUrl) ?? '',
      status: 'open',
      amount: { amount: input.amount, currency: 'brl' },
      ...(brCode !== '' ? { pixCode: brCode, pixCopiaECola: brCode } : {}),
    };
  }

  // ── Subscriptions (Pix Automático) ──────────────────────────────────────────────────

  /**
   * Create a subscription. Pix Automático (`type: 'PIX_RECURRING'`) unless opted out.
   *
   * ## Why this is not the old body
   *
   * `POST /api/v1/subscriptions` serves TWO products. Send `type: 'PIX_RECURRING'` plus
   * `pixRecurringOptions` and you get Pix Automático: the payer authorizes a recurring debit
   * at their bank once, and every cycle is collected without them doing anything. Omit them
   * and the same endpoint creates an ordinary subscription that emails a payment link each
   * cycle — a different product, which the payer has to act on every month.
   *
   * This driver documents itself as Pix Automático and maps the `PIX_AUTOMATIC_*` webhooks,
   * but the body it sent had neither field, so it created the ordinary kind. Those webhooks
   * only fire for `PIX_RECURRING`: every event the driver knew how to translate was an event
   * the gateway had no reason to send. Nothing failed loudly — the subscription existed, the
   * dashboard showed it, and the recurring debit simply never happened.
   *
   * `correlationID` is the other half. The API accepts it and echoes it on the root of every
   * `PIX_AUTOMATIC_COBR_*` webhook; the SDK's `CreatePayload` type just does not declare it,
   * so it was dropped. Without it Woovi assigns its own, and an app routing webhooks by its
   * own reference cannot recognise its own renewals.
   *
   * ## Required by the gateway, not by us
   *
   * `name`, `comment`, `frequency`, `dayGenerateCharge`, `dayDue`, both `pixRecurringOptions`
   * and a customer WITH `address` are all mandatory for `PIX_RECURRING`. `comment` is the
   * adoption-contract text shown in the payer's bank app and is capped at 30 characters —
   * longer text is rejected, so it is truncated here rather than sent to fail.
   *
   * Pass `metadata.pixAutomatic: false` for the ordinary link-per-cycle subscription.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    // Woovi creates subscriptions with an inline customer (no customer-id flow).
    const customer = await this.#resolveSubscriptionCustomer(input);
    const reference =
      input.externalReference !== undefined ? { correlationID: input.externalReference } : {};

    const body: Record<string, unknown> = {
      customer,
      value: input.amount ?? 0,
      ...reference,
      ...(input.metadata?.pixAutomatic === false
        ? this.#plainSubscriptionFields(input)
        : this.#pixAutomaticFields(input)),
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

  /**
   * The `PIX_RECURRING` half of the body — what turns a subscription into a real recurring
   * bank authorization.
   */
  #pixAutomaticFields(input: CreateSubscriptionInput): Record<string, unknown> {
    const journey = (input.metadata?.journey as string | undefined) ?? DEFAULT_JOURNEY;
    const label = input.description ?? input.planId;

    return {
      type: 'PIX_RECURRING',
      name: label,
      // Truncated, not rejected: 31 characters of description is a caller's honest mistake,
      // and failing the whole subscription over the contract label helps nobody.
      comment: ((input.metadata?.comment as string | undefined) ?? label).slice(
        0,
        COMMENT_MAX_LENGTH,
      ),
      frequency: this.#mapRecurringFrequency(input.cycle),
      // `PAYMENT_ON_APPROVAL` collects on approval, so the gateway requires the generation
      // day to be TODAY. Deriving it from a `startDate` in another month is rejected — when
      // the caller named no date, today is also the only answer that can be right.
      dayGenerateCharge:
        this.#dayOfMonth(input.startDate) ??
        (journey === DEFAULT_JOURNEY ? new Date().getDate() : 1),
      dayDue: input.metadata?.dayDue ?? DEFAULT_DAY_DUE,
      pixRecurringOptions: {
        journey,
        retryPolicy: (input.metadata?.retryPolicy as string | undefined) ?? DEFAULT_RETRY_POLICY,
        ...(input.metadata?.minimumValue !== undefined
          ? { minimumValue: input.metadata.minimumValue }
          : {}),
      },
    };
  }

  /** The ordinary subscription (a payment link per cycle) — `metadata.pixAutomatic: false`. */
  #plainSubscriptionFields(input: CreateSubscriptionInput): Record<string, unknown> {
    return {
      dayGenerateCharge: this.#dayOfMonth(input.startDate) ?? 1,
      ...(input.cycle !== undefined ? { frequency: this.#mapFrequency(input.cycle) } : {}),
      ...(input.metadata?.chargeType !== undefined
        ? { chargeType: input.metadata.chargeType }
        : { chargeType: 'DYNAMIC' }),
      ...(input.metadata?.dayDue !== undefined ? { dayDue: input.metadata.dayDue } : {}),
    };
  }

  /**
   * Cycle → `frequency` for `PIX_RECURRING`, which spells them the ordinary way.
   *
   * Deliberately NOT `#mapFrequency`: the plain subscription product uses its own spellings
   * (`TRIMONTHLY`, `SEMIANUALY`, `ANNUALY` — the last two missing a letter each, and that is
   * the gateway's spelling, not a typo here). Sending those under `PIX_RECURRING` is a
   * rejected enum. Same field name, two vocabularies, chosen by `type`.
   *
   * Woovi does not offer bimonthly on Pix Automático at all; it falls back to monthly rather
   * than sending a value the gateway refuses.
   */
  #mapRecurringFrequency(cycle: string | undefined): string {
    switch (cycle) {
      case 'WEEKLY':
        return 'WEEKLY';
      case 'QUARTERLY':
        return 'QUARTERLY';
      case 'SEMIANNUALLY':
        return 'SEMIANNUALLY';
      case 'YEARLY':
        return 'ANNUALLY';
      default:
        return 'MONTHLY';
    }
  }

  /** Woovi's inline customer: `input.customer`, else the gateway customer (needs name+taxId). */
  async #resolveSubscriptionCustomer(
    input: CreateSubscriptionInput,
  ): Promise<Record<string, unknown>> {
    // The address rides along because `PIX_RECURRING` requires it. It is NOT defaulted or
    // faked when absent: an address the payer never gave is wrong data on a bank mandate,
    // and the gateway's own rejection names the missing field better than a guess would.
    const address = input.customer?.address;
    const withAddress = address !== undefined ? { address } : {};

    if (input.customer?.name && input.customer.taxId) {
      return {
        name: input.customer.name,
        email: input.customer.email ?? '',
        taxID: input.customer.taxId.replace(/\D/g, ''),
        ...(input.customer.phone !== undefined ? { phone: input.customer.phone } : {}),
        ...withAddress,
      };
    }
    if (input.customerId) {
      const customer = await this.findCustomer(input.customerId);
      if (customer?.name && customer.taxId) {
        return {
          name: customer.name,
          email: customer.email ?? '',
          taxID: customer.taxId.replace(/\D/g, ''),
          ...withAddress,
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
    _subscriptionGatewayId: string,
    _options?: { atPeriodEnd?: boolean },
  ): Promise<Subscription> {
    // The SDK's subscription client exposes only `create` and `get` — there is no cancel,
    // and there is no delete. This used to fetch the subscription, flip `status` to
    // INACTIVE on the local copy, PUBLISH `subscription.canceled`, and return it: the
    // billing row went to canceled, the app stopped entitling the customer, and Woovi
    // carried on charging them. Both halves wrong, from one call that reported success.
    throw new Error(
      '[payments] Woovi/OpenPix does not support canceling a subscription via API. ' +
        'Cancel it in the Woovi dashboard, then reconcile your own record — a Pix Automático ' +
        'authorization can also be revoked by the payer at their bank.',
    );
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
    _subscriptionGatewayId: string,
    _input: UpdateSubscriptionInput,
  ): Promise<Subscription> {
    // OpenPix subscriptions are immutable: the API (and the SDK's subscription client)
    // exposes only create and get. Returning a locally patched object would report
    // success on a change the gateway never saw, while it keeps charging the old value.
    throw new Error(
      '[payments] Woovi/OpenPix does not support updating a subscription via API. ' +
        'Cancel it and create a new one with the new amount, or keep the change on your own record.',
    );
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────────────

  async listInvoices(_customerId: string): Promise<Invoice[]> {
    // OpenPix has no invoice concept — charges are the billing record.
    return [];
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────────────

  /**
   * Whether a delivery to `POST /payments/webhook/:provider` can be authenticated.
   *
   * Woovi accepts either the RSA public key (recommended) or the shared secret; with neither,
   * `parseWebhook` verifies nothing.
   */
  get webhookVerification(): WebhookVerificationState {
    return this.#webhookPublicKey !== undefined || this.#webhookSecret !== undefined
      ? 'configured'
      : 'unconfigured';
  }

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
    // The dispute family is normalized from `payload.dispute`, and ONLY when that object
    // names the Pix it is about: a dispute the driver cannot key keeps its Woovi name
    // rather than reaching a built-in handler that throws on a payload with no id — a throw
    // in the webhook route is a 500 Woovi retries.
    const dispute = this.#disputeEvent(event, payload);
    const type = dispute?.type ?? this.#mapWebhookType(event);
    return {
      // A CONTENT hash, never a random id. A payload with no id used to get a fresh
      // `Math.random()` on every delivery, so the ledger saw each redelivery as a new
      // event and processed it again — the exact double-grant the ledger exists to stop.
      id: String(
        payload.id ??
          payload.globalID ??
          `${event}-${createHash('sha256').update(rawBody, 'utf8').digest('hex').slice(0, 32)}`,
      ),
      provider: this.provider,
      type,
      createdAt: new Date().toISOString(),
      data: dispute?.data ?? this.#mapWebhookData(payload, type),
      raw: payload,
    };
  }

  /**
   * The normalized shape the built-in sync needs (`gatewayId`, `amount`, `currency`).
   *
   * This used to hand the processor Woovi's raw body, which its shape guard rejected — so
   * every Woovi webhook was ledgered, threw `Malformed`, and was retried forever while the
   * billing tables never learned the payment was paid. `raw` still carries the original.
   */
  #mapWebhookData(payload: Record<string, unknown>, type: string): Record<string, unknown> {
    // Woovi nests the subject under `charge`/`pix` on charge events and inlines it on
    // subscription ones.
    const subject = (payload.charge ?? payload.pix ?? payload) as Record<string, unknown>;
    const gatewayId = String(subject.globalID ?? subject.id ?? payload.globalID ?? '');
    if (gatewayId === '') return payload;

    if (type.startsWith('subscription.')) {
      const subscription = this.#mapSubscription(subject);
      return {
        gatewayId: subscription.gatewayId,
        status: subscription.status,
        planId: subscription.planId,
        ...(subscription.customerId !== undefined ? { customerId: subscription.customerId } : {}),
        ...(typeof subject.correlationID === 'string'
          ? { externalReference: subject.correlationID }
          : {}),
      };
    }

    const payment = this.#mapPayment(subject);
    // The Pix's `endToEndId`, carried through as metadata because it is the ONLY key a
    // dispute arrives under: Woovi's MED payload names the Pix and never the charge, so an
    // app that did not persist this cannot join the two. See `#disputeEvent`.
    const endToEndId =
      (payload.pix as { endToEndId?: unknown } | undefined)?.endToEndId ?? subject.endToEndId;
    return {
      gatewayId: payment.gatewayId,
      amount: payment.amount.amount,
      currency: payment.amount.currency,
      ...(payment.customerId !== undefined ? { customerId: payment.customerId } : {}),
      // `correlationID` is what an app sets as its own reference on a Woovi charge.
      ...(typeof subject.correlationID === 'string'
        ? { externalReference: subject.correlationID }
        : {}),
      ...(typeof endToEndId === 'string' ? { metadata: { endToEndId } } : {}),
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
    // OpenPix WRAPS a charge: `POST /api/v1/charge` answers
    // `{ charge: { globalID, brCode, paymentLinkUrl, ... }, correlationID, brCode }`, and
    // `charge.get` returns the same envelope. This read the envelope as if it were the
    // charge, so `globalID` was missing (every payment came back with `gatewayId: ''`) and
    // `brCode` — a STRING at both levels — was read as `data.brCode.brCode`, an object
    // access on a string, which is `undefined`. The result was a Pix charge the caller
    // could neither identify nor show to anyone: no id, no code, no link.
    const charge =
      typeof data.charge === 'object' && data.charge !== null
        ? (data.charge as Record<string, unknown>)
        : data;
    const value = typeof charge.value === 'number' ? charge.value : 0;
    const status = String(charge.status ?? 'ACTIVE').toUpperCase();
    const brCode =
      asString(charge.brCode) ??
      asString(data.brCode) ??
      (charge.pixQrCode as { brCode?: string } | undefined)?.brCode;
    const paymentLinkUrl = asString(charge.paymentLinkUrl);
    return {
      id: String(charge.id ?? charge.globalID ?? ''),
      gatewayId: String(charge.globalID ?? charge.id ?? ''),
      provider: this.provider,
      amount: { amount: Math.round(value), currency: 'brl' },
      status:
        status === 'COMPLETED' || status === 'PAID'
          ? 'paid'
          : status === 'EXPIRED' || status === 'CANCELED' || status === 'REJECTED'
            ? 'canceled'
            : 'pending',
      ...(brCode !== undefined ? { pixCode: brCode, pixCopiaECola: brCode } : {}),
      // Woovi's `qrCodeImage` is a URL, and `pixQrCodeImage` is documented as base64 PNG
      // ("render it directly as `data:image/png;base64,...`"). Putting a URL there would
      // produce a broken <img> in every consumer that followed the docs, so it is left
      // unset: `pixCode` is the BR Code and a QR renders from it client-side.
      ...(paymentLinkUrl !== undefined ? { hostedUrl: paymentLinkUrl } : {}),
      ...(typeof charge.correlationID === 'string' ? { customerId: charge.correlationID } : {}),
      payload: data,
      createdAt: typeof charge.createdAt === 'string' ? charge.createdAt : new Date().toISOString(),
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
      amount: { amount: Math.round(value), currency: 'brl' },
      payload: data,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    };
  }

  /**
   * Woovi's dispute family → the canonical dispute events, or `undefined` when this is not
   * one (or is one the driver cannot key).
   *
   * **What a Woovi dispute is.** Not a card chargeback: a Pix cannot be charged back. It is
   * the Banco Central's MED — a payer who reports fraud or a scam opens a claim, and
   * Woovi's own `GET` dispute payload types it as `"MED" | "CHARGEBACK"`. While it is under
   * analysis Woovi documents that "o saldo relacionado a transacao será bloqueado no saldo
   * da empresa": the money is **blocked, not taken**, which is why `DISPUTE_CREATED` is a
   * warning and not a `payment.disputed`. Woovi's own MED page: it notifies immediately,
   * you have three days to send evidence, the bank has up to seven to decide.
   *
   * **The outcomes.** Woovi's developer reference documents the four events and nothing
   * about who wins; its help centre ("Quais são os status do MED e Disputas na
   * plataforma?") is where the meaning is written down — a dispute *aceita* refunds the end
   * customer and closes the case (the merchant LOST), a *rejeitada* one means the company
   * proved the transaction legitimate and keeps the money (WON), and a *cancelada* one was
   * withdrawn by the customer or by the bank that opened it. The provenance is worth
   * knowing before you act on `outcome`, so it is on the docs page too.
   *
   * **`gatewayId` is the Pix `endToEndId`, not the charge id** — the dispute payload
   * carries nothing else: no `charge`, no `correlationID`. Woovi charges are stored under
   * `charge.globalID`, so this event does NOT find the row by itself, and that is why
   * nothing here writes one. Persist `event.data.metadata.endToEndId` from the paid webhook
   * and the two join.
   */
  #disputeEvent(
    event: string,
    payload: Record<string, unknown>,
  ): { type: string; data: Record<string, unknown> } | undefined {
    const name = event.startsWith('OPENPIX:') ? event.slice('OPENPIX:'.length) : event;
    if (!name.startsWith('DISPUTE_')) return undefined;
    const outcome = {
      DISPUTE_ACCEPTED: 'lost',
      DISPUTE_REJECTED: 'won',
      DISPUTE_CANCELED: 'canceled',
    }[name];
    if (name !== 'DISPUTE_CREATED' && outcome === undefined) return undefined;

    const dispute = payload.dispute as Record<string, unknown> | undefined;
    const endToEndId = dispute?.endToEndId;
    if (typeof endToEndId !== 'string' || endToEndId === '') return undefined;

    return {
      type: outcome === undefined ? 'payment.dispute_warning' : 'payment.dispute_closed',
      data: {
        gatewayId: endToEndId,
        ...(outcome !== undefined ? { outcome } : {}),
        ...(typeof dispute?.id === 'string' ? { disputeId: dispute.id } : {}),
        ...(typeof dispute?.disputeReason === 'string' ? { reason: dispute.disputeReason } : {}),
        // No `actionableUntil`: the payload carries no date at all. The three days to
        // answer are Woovi's published policy, not a field, and a deadline this driver
        // computed itself would be a deadline it invented.
        //
        // No `amount` either, and that is deliberate: Woovi documents `dispute.value` in
        // centavos while every other amount in this driver is read as reais (see
        // `#mapPayment`), and a dispute event is the wrong place to settle that
        // disagreement. `event.raw.dispute.value` has the untouched figure.
      },
    };
  }

  #mapWebhookType(event: string): string {
    // Woovi sends every event prefixed — `OPENPIX:CHARGE_COMPLETED`, not
    // `CHARGE_COMPLETED` — and the map below was written against the bare names, so a real
    // payload matched nothing and fell through to the passthrough branch. Both forms are
    // accepted; an unknown event still keeps its original name.
    switch (event.startsWith('OPENPIX:') ? event.slice('OPENPIX:'.length) : event) {
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
