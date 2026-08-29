import { publishPayments } from '../diagnostics.js';
import type { PaymentsDriver } from '../driver.js';
import type { WebhookEvent } from '../types.js';
import type { BillingStore } from './billing_store.js';
import {
  type DisputeWebhookData,
  isDisputeWebhookData,
  isPaymentWebhookData,
  isSubscriptionWebhookData,
} from './webhook_events.js';

/**
 * A handler for a gateway webhook event type (e.g. `'invoice.payment_succeeded'`).
 * Receives the normalized event plus the raw gateway payload. Return normally to mark the
 * event processed; throw to mark it failed (and trigger the dispatcher's retry).
 */
export type WebhookHandler = (event: WebhookEvent) => void | Promise<void>;

export interface WebhookProcessorOptions {
  store: BillingStore;
  /**
   * The driver that received the webhook — used for lookups and sync. Optional: the
   * built-in handlers persist through the store and don't call the gateway.
   */
  driver?: PaymentsDriver;
  /** Map of gateway event type → handler. Apps register their business logic here. */
  handlers?: Record<string, WebhookHandler>;
}

/**
 * A gateway-sent instant (`actionableUntil`, `paidAt`) as a `Date`, or `null` when there is
 * nothing usable to store.
 *
 * An unparseable value is dropped rather than written: `new Date('soon')` is an Invalid Date,
 * which Postgres rejects — so a driver with one bad field would fail the whole webhook and,
 * through the ledger, every redelivery of it. Dropping one field loses a deadline's urgency;
 * throwing here loses the chargeback itself.
 */
function parseInstant(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Routes normalized webhook events to handlers, enforcing idempotency through the
 * `billing_webhook_events` ledger (keyed by gateway event id), and keeps the local
 * billing tables in sync (payments, subscriptions).
 *
 * Built-in handlers keep the store in sync and publish the normalized business events on
 * the `@adonis-agora/diagnostics` channel (`agora:payments:payment.succeeded`, ...) —
 * apps react with `onDiagnostic('payments', ...)` (or the `handlers` below). App
 * handlers (via `handlers`) run after the built-in sync and can dispatch work.
 */
export class WebhookProcessor {
  #store: BillingStore;
  #driver: PaymentsDriver | undefined;
  #handlers: Record<string, WebhookHandler>;

  constructor(options: WebhookProcessorOptions) {
    this.#store = options.store;
    this.#driver = options.driver;
    this.#handlers = options.handlers ?? {};
  }

  /**
   * Process a webhook event. Returns `false` when the event was already processed
   * (idempotent replay). Throws when the event handler throws.
   */
  async process(event: WebhookEvent): Promise<boolean> {
    const ledger = await this.#store.recordWebhookEvent({
      gatewayEventId: event.id,
      provider: event.provider,
      type: event.type,
      payload: event.raw,
      // The NORMALIZED event, stored beside the raw payload so the dashboard's retry can
      // replay this delivery without calling `parseWebhook` again — which would re-verify a
      // signature computed from headers the ledger never kept.
      normalized: event.data,
    });

    // Already seen → idempotent replay, skip.
    if (ledger === null) return false;

    publishPayments('webhook.received', {
      id: event.id,
      provider: event.provider,
      type: event.type,
    });

    try {
      await this.#runBuiltIn(event);
      const handler = this.#handlers[event.type];
      if (handler) await handler(event);
      await this.#store.markWebhookProcessed(ledger.id);
      publishPayments('webhook.processed', {
        id: event.id,
        provider: event.provider,
        type: event.type,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.markWebhookFailed(ledger.id, message);
      publishPayments('webhook.failed', {
        id: event.id,
        provider: event.provider,
        type: event.type,
        error: message,
      });
      throw error;
    }
  }

  /** Built-in sync handlers, keyed by the normalized event type (shared constants). */
  #runBuiltIn(event: WebhookEvent): Promise<void> {
    switch (event.type) {
      case 'payment.succeeded':
        return this.#onPaymentSucceeded(event);
      case 'payment.failed':
        return this.#onPaymentFailed(event);
      case 'payment.refunded':
        return this.#onPaymentRefunded(event);
      case 'payment.disputed':
        return this.#onPaymentDisputed(event);
      case 'payment.dispute_warning':
        return this.#onDisputeWarning(event);
      case 'payment.dispute_closed':
        return this.#onDisputeClosed(event);
      case 'payment.updated':
        return this.#onPaymentUpdated(event);

      case 'subscription.created':
      case 'subscription.updated':
        return this.#onSubscriptionChanged(event);
      case 'subscription.canceled':
        return this.#onSubscriptionCanceled(event);
      default:
        return Promise.resolve();
    }
  }

  async #onPaymentSucceeded(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.succeeded payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, customerId, subscriptionId, externalReference } =
      event.data;
    await this.#store.savePayment({
      gatewayId,
      provider: event.provider,
      status: 'paid',
      amount,
      currency,
      ...(customerId !== undefined ? { customerId } : {}),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      // Spread away when absent, never passed as `null`: the store keeps what it already has
      // for an `undefined` reference, and a later event that does not echo one must not blank
      // the key the app routes on.
      ...(externalReference !== undefined ? { externalReference } : {}),
      // The GATEWAY's settlement date when it sent one, and the arrival time only as a last
      // resort. `revenue()` windows on `paid_at`, so stamping "now" over a confirmation that
      // is being redelivered — or replayed from the ledger a month later — files the money in
      // the wrong month.
      paidAt: parseInstant(event.data.paidAt) ?? new Date(),
      payload: event.raw,
    });
    publishPayments('payment.succeeded', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
      ...(event.data.externalReference !== undefined
        ? { externalReference: event.data.externalReference }
        : {}),
    });
  }

  async #onPaymentFailed(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.failed payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, customerId, subscriptionId, externalReference } =
      event.data;
    await this.#store.savePayment({
      gatewayId,
      provider: event.provider,
      status: 'failed',
      amount,
      currency,
      ...(customerId !== undefined ? { customerId } : {}),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      ...(externalReference !== undefined ? { externalReference } : {}),
      payload: event.raw,
    });
    publishPayments('payment.failed', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
      // `reason` is on the payload type and was never published, so a subscriber could not
      // see it even on the gateways that normalize one. It is the field that answers "why",
      // which is the only question anyone asks of a failed payment.
      ...(event.data.reason !== undefined ? { reason: event.data.reason } : {}),
      ...(event.data.externalReference !== undefined
        ? { externalReference: event.data.externalReference }
        : {}),
    });
  }

  async #onPaymentRefunded(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.refunded payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, externalReference } = event.data;
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);
    if (existing) {
      await this.#store.savePayment({
        gatewayId,
        provider: event.provider,
        status: 'refunded',
        amount,
        currency,
        // A FULL refund, by definition — a partial one arrives as `payment.updated`, because
        // this handler writes the whole charge off. Recorded so `amount - refundedAmount` is
        // the net figure on every refunded row, not just the partial ones.
        refundedAmount: amount,
        ...(externalReference !== undefined ? { externalReference } : {}),
        ...(existing.customerId !== undefined ? { customerId: existing.customerId } : {}),
        ...(existing.subscriptionId !== undefined
          ? { subscriptionId: existing.subscriptionId }
          : {}),
        payload: event.raw,
      });
    }
    publishPayments('payment.refunded', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
    });
  }

  /**
   * "This payment changed" — the catch-all every driver falls back to, and until now the one
   * case `#runBuiltIn` answered with `Promise.resolve()`.
   *
   * The cost of that no-op was not theoretical. A **partial refund** arrives as exactly this
   * type on Asaas (`PAYMENT_PARTIALLY_REFUNDED`), deliberately: routing it to
   * `payment.refunded` would overwrite the row's status with `refunded` and write off the
   * whole charge. So the money came back, the ledger row went to `processed`, and nothing
   * else happened — revenue stayed overstated by the refunded part, permanently. Same for a
   * deleted charge, a restored one, a denied refund, and a cash receipt taken back.
   *
   * What it does now: keeps the row CURRENT — status, amount, refunded amount, settlement
   * date — and nothing more. It never creates a row (an update about a charge this install
   * never recorded is not a charge; a `payment.succeeded` or a reconcile creates those), and
   * it moves nothing when the driver sends no `status`.
   */
  async #onPaymentUpdated(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.updated payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, status, refundedAmount, externalReference } = event.data;
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);
    if (existing === null) return;

    const settledAt = parseInstant(event.data.paidAt);
    const target = this.#updatedStatus(existing.status, status);
    await this.#store.savePayment({
      gatewayId,
      provider: event.provider,
      status: target,
      // The charge's own amount, which an update CAN legitimately change — editing the value
      // of a pending boleto is what `PAYMENT_UPDATED` means on Asaas. A partial refund does
      // not change it: the refunded part travels as `refundedAmount`, so `amount` stays the
      // charge and `amount - refundedAmount` stays the net. Never divide either.
      amount,
      currency,
      ...(existing.customerId !== null ? { customerId: existing.customerId } : {}),
      ...(existing.subscriptionId !== null ? { subscriptionId: existing.subscriptionId } : {}),
      ...(externalReference !== undefined ? { externalReference } : {}),
      ...(refundedAmount !== undefined ? { refundedAmount } : {}),
      // Absent leaves the stored one alone — see `savePayment`. An update is exactly the
      // event that carries no settlement date, and blanking `paid_at` here would drop the row
      // out of every windowed revenue figure.
      ...(settledAt !== null ? { paidAt: settledAt } : {}),
      payload: event.raw,
    });

    publishPayments('payment.updated', {
      gatewayId,
      provider: event.provider,
      status: target,
    });
  }

  /**
   * The status an update is allowed to write, given what the row already says.
   *
   * Two rules, both about not losing money:
   *
   * 1. **No status, no move.** Most drivers normalize no status onto `payment.updated` — the
   *    event says only "something changed" — and inventing one from an event that named none
   *    is how a paid row becomes pending.
   * 2. **An update never moves a row OUT of `disputed`.** A chargeback is the one webhook that
   *    takes revenue away, and the gateway's own payment resource often goes on reporting the
   *    charge as received while the bank holds the money. Only `payment.dispute_closed`, which
   *    carries an outcome, resolves a dispute — the same rule `payments:sync` follows, for the
   *    same reason.
   */
  #updatedStatus(current: string, incoming: string | undefined): string {
    if (incoming === undefined) return current;
    if (current === 'disputed' && incoming !== 'disputed') return current;
    return incoming;
  }

  /**
   * A chargeback: the customer's bank has pulled the money back.
   *
   * The one webhook that takes revenue AWAY, and until now the library had no name for it —
   * `BillingStatus` carried `'disputed'` while nothing could ever set it, so a dispute
   * arrived as an unknown type, passed through unprocessed, and the payment row went on
   * saying `paid`. The app found out from its bank statement.
   *
   * Deliberately does NOT invent the resolution event. A dispute that is later won or lost
   * is reported differently by every gateway, and a canonical type no driver emits is worse
   * than none — those arrive as `payment.updated`.
   */
  async #onPaymentDisputed(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.disputed payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, externalReference } = event.data;
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);
    if (existing) {
      await this.#store.savePayment({
        gatewayId,
        provider: event.provider,
        status: 'disputed',
        amount,
        currency,
        ...(externalReference !== undefined ? { externalReference } : {}),
        ...(existing.customerId !== undefined ? { customerId: existing.customerId } : {}),
        ...(existing.subscriptionId !== undefined
          ? { subscriptionId: existing.subscriptionId }
          : {}),
        payload: event.raw,
      });
    }
    // The dispute row is written whether or not the payment is one we recorded: a chargeback
    // against a charge this install never saw is exactly the one somebody has to be told
    // about, and its deadline is the only thing that makes it actionable.
    if (isDisputeWebhookData(event.data)) {
      await this.#persistDispute(event, event.data, { status: 'open' });
    }
    publishPayments('payment.disputed', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
    });
  }

  /**
   * A pre-dispute alert: a Stripe inquiry or early fraud warning, an Adyen notification of
   * chargeback or fraud. **The PAYMENT row is not touched** — a dispute row is written, so the
   * deadline is somewhere, but no money has moved and a payment that says `paid` is telling
   * the truth, and the one useful thing to do with the alert is put it in
   * front of somebody while a refund still prevents the chargeback.
   *
   * That is what the diagnostics publish is for — and until this method existed, the event
   * was declared on the bus with a payload type and published by nothing at all.
   */
  async #onDisputeWarning(event: WebhookEvent): Promise<void> {
    if (!isDisputeWebhookData(event.data)) {
      throw new Error(
        `[payments] Malformed payment.dispute_warning payload for event ${event.id}.`,
      );
    }
    const { gatewayId, reason, actionableUntil } = event.data;
    // Still NOTHING is written to the payment — no money has moved, and a row that says
    // `paid` is telling the truth. The DISPUTE row is new, and is the point: this is the
    // moment the clock starts, and the alert is only actionable while it has somewhere to
    // live. `warning` is a dispute status of its own, so nothing here can be mistaken for a
    // chargeback that took money.
    await this.#persistDispute(event, event.data, { status: 'warning' });
    publishPayments('payment.dispute_warning', {
      gatewayId,
      provider: event.provider,
      ...(reason !== undefined ? { reason } : {}),
      ...(actionableUntil !== undefined ? { actionableUntil } : {}),
    });
  }

  /**
   * A dispute reaching its outcome. A WON dispute returns the money, and the row has been
   * sitting at `disputed` since the chargeback arrived — `revenue()` sums rows that are
   * `paid`, so leaving it there writes off money that came back.
   *
   * Only `won` moves it. `lost` and `expired` are money that is gone, and `canceled` — the
   * cardholder withdrawing — is deliberately NOT treated as a win: on Stripe a withdrawn
   * dispute still has to be closed in your favour with evidence, so calling it settled would
   * count revenue the acquirer has not returned. Understating is the safe direction here.
   */
  async #onDisputeClosed(event: WebhookEvent): Promise<void> {
    if (!isDisputeWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.dispute_closed payload for event ${event.id}.`);
    }
    const { gatewayId, disputeId, outcome, amount, currency } = event.data;
    // A close with no outcome is not a close. Defaulting it — to `lost`, to anything —
    // would report a result the gateway never sent, which is the failure this whole event
    // exists to avoid: a driver that cannot read the outcome is supposed to emit
    // `payment.updated` instead.
    if (outcome === undefined) {
      throw new Error(
        `[payments] payment.dispute_closed for event ${event.id} carries no outcome. A driver that cannot read one must emit payment.updated instead.`,
      );
    }
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);

    // A close moves the payment row in BOTH directions, and the second one is easy to miss.
    //
    // `won` returns money that a chargeback took, so a row sitting at `disputed` goes back
    // to `paid` — `revenue()` sums `paid`, and leaving it writes off money that came back.
    //
    // `lost` is the mirror, and it does not assume a `payment.disputed` ever arrived. Plenty
    // of gateways never send one: Razorpay documents that it does not debit provisionally at
    // all, PayPal opens at an inquiry that takes nothing, and Woovi only blocks the balance.
    // On those the sequence is warning → closed(lost), with nothing in between to move the
    // row — so a payment whose money is definitively gone would still read `paid`.
    //
    // `expired` and `canceled` deliberately move nothing. Expired means the window closed
    // with no verdict published, and canceled means the cardholder withdrew — on Stripe a
    // withdrawn dispute still has to be closed in your favour with evidence. Neither is a
    // statement about where the money ended up.
    const target =
      outcome === 'won' && existing?.status === 'disputed'
        ? 'paid'
        : outcome === 'lost' && existing !== null && existing.status !== 'disputed'
          ? 'disputed'
          : undefined;

    if (target !== undefined && existing !== null) {
      await this.#store.savePayment({
        gatewayId,
        provider: event.provider,
        status: target,
        // The dispute's amount can differ from the charge's — a partial dispute, or a
        // currency conversion between the charge and the chargeback. The ROW keeps the
        // amount it was charged for; the dispute's own figure stays on the payload.
        amount: existing.amount,
        currency: existing.currency,
        ...(existing.customerId !== null ? { customerId: existing.customerId } : {}),
        ...(existing.subscriptionId !== null ? { subscriptionId: existing.subscriptionId } : {}),
        payload: event.raw,
      });
    }

    // The outcome IS the status: `won`/`lost`/`canceled`/`expired` are all `DisputeStatus`
    // members, so a closed dispute stops matching the open-window read the moment it closes —
    // which is what stops the deadline check alerting on a window nobody has to answer.
    await this.#persistDispute(event, event.data, { status: outcome, closedAt: new Date() });

    publishPayments('payment.dispute_closed', {
      gatewayId,
      provider: event.provider,
      disputeId: disputeId ?? gatewayId,
      outcome,
      ...(amount !== undefined ? { amount } : {}),
      ...(currency !== undefined ? { currency } : {}),
    });
  }

  /**
   * The key a dispute row is upserted on — the DISPUTE's own gateway id where the event
   * carries one, and a reconcilable stand-in where it does not.
   *
   * Several gateways send no dispute id at all, and several more send one when the dispute
   * opens and omit it when it closes. Both have to land on the SAME row, or the close opens a
   * second dispute and the deadline check keeps alerting on a window that was already
   * answered. So, in order:
   *
   * 1. `disputeId`, when the event carries one. That is the gateway's own identity.
   * 2. Otherwise the payment's newest UNRESOLVED dispute, if there is one — this is the close
   *    (or the chargeback after a warning) rejoining the row its own opening event created.
   * 3. Otherwise `dispute:<provider>:<payment gateway id>`, synthesized.
   *
   * The `dispute:` prefix is what makes step 3 safe to store in the same unique column as a
   * real gateway id: no gateway issues an id in that shape, so a synthesized key can never
   * collide with a real one, and it stays reconcilable by hand because the payment it names
   * is right there in it. What it costs: a payment disputed TWICE by a gateway that sends no
   * dispute id collapses into one row, because such a gateway gives us nothing to tell the
   * two apart. Overwriting one row is the lesser error — a second row keyed on nothing could
   * never be closed, and would alert on its deadline forever.
   */
  async #disputeKey(provider: string, data: DisputeWebhookData): Promise<string> {
    if (data.disputeId !== undefined && data.disputeId !== '') return data.disputeId;
    const open = await this.#store.findOpenDisputeByPayment(data.gatewayId);
    if (open !== null) return open.gatewayId;
    return `dispute:${provider}:${data.gatewayId}`;
  }

  /**
   * Write the dispute row that goes with a dispute event.
   *
   * ADDITIONAL to what each handler already does, never a replacement: the warning still
   * moves no money, the chargeback still moves the payment to `disputed`, and a won close
   * still puts it back to `paid`. What this adds is the one thing none of them kept — the
   * response deadline, which arrived on the event, was published once, and was then gone.
   */
  async #persistDispute(
    event: WebhookEvent,
    data: DisputeWebhookData,
    fields: { status: string; closedAt?: Date },
  ): Promise<void> {
    const deadline = parseInstant(data.actionableUntil);
    await this.#store.saveDispute({
      gatewayId: await this.#disputeKey(event.provider, data),
      paymentGatewayId: data.gatewayId,
      provider: event.provider,
      status: fields.status,
      // Spread away when absent, never passed as `null`: the store keeps what it already has
      // for an `undefined` field, and the closing event — which carries no reason, no amount
      // and no deadline — must not blank what the opening event recorded.
      ...(data.reason !== undefined ? { reason: data.reason } : {}),
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.currency !== undefined ? { currency: data.currency } : {}),
      ...(deadline !== null ? { evidenceDueBy: deadline } : {}),
      ...(data.outcome !== undefined ? { outcome: data.outcome } : {}),
      ...(fields.closedAt !== undefined ? { closedAt: fields.closedAt } : {}),
      payload: event.raw,
    });
  }

  async #onSubscriptionChanged(event: WebhookEvent): Promise<void> {
    if (!isSubscriptionWebhookData(event.data)) {
      throw new Error(`[payments] Malformed subscription payload for event ${event.id}.`);
    }
    const data = event.data;
    await this.#store.saveSubscription({
      gatewayId: data.gatewayId,
      provider: event.provider,
      customerId: data.customerId,
      status: data.status,
      planId: data.planId ?? '',
      ...(data.trialEndsAt !== undefined ? { trialEndsAt: new Date(data.trialEndsAt) } : {}),
      ...(data.endsAt !== undefined ? { endsAt: new Date(data.endsAt) } : {}),
      payload: event.raw,
    });
    const type =
      event.type === 'subscription.created' ? 'subscription.created' : 'subscription.updated';
    publishPayments(type, {
      gatewayId: data.gatewayId,
      provider: event.provider,
      customerId: data.customerId,
      status: data.status,
    });
  }

  async #onSubscriptionCanceled(event: WebhookEvent): Promise<void> {
    if (!isSubscriptionWebhookData(event.data)) {
      throw new Error(`[payments] Malformed subscription.canceled payload for event ${event.id}.`);
    }
    const data = event.data;
    const existing = await this.#store.findSubscriptionByGatewayId(data.gatewayId);
    if (existing) {
      await this.#store.saveSubscription({
        gatewayId: data.gatewayId,
        provider: event.provider,
        customerId: data.customerId,
        status: 'canceled',
        planId: existing.planId,
        ...(data.trialEndsAt !== undefined ? { trialEndsAt: new Date(data.trialEndsAt) } : {}),
        ...(data.endsAt !== undefined ? { endsAt: new Date(data.endsAt) } : {}),
        payload: event.raw,
      });
    }
    publishPayments('subscription.canceled', {
      gatewayId: data.gatewayId,
      provider: event.provider,
    });
  }
}
