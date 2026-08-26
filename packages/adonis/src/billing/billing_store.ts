import type {
  BillingPayment,
  BillingSubscription,
  BillingUsageEvent,
  BillingWebhookEvent,
} from './mixins/index.js';

/**
 * The persistence SPI for the billing layer. The Lucid implementation writes through the
 * configured models; an in-memory implementation exists in `src/testing` so the billing
 * layer is unit-testable without a database.
 *
 * Generic over the row types so the in-memory store can use plain objects while the
 * Lucid store returns model instances.
 */
export interface BillingStore<
  SubscriptionRow = BillingSubscription,
  PaymentRow = BillingPayment,
  WebhookEventRow = BillingWebhookEvent,
  UsageEventRow = BillingUsageEvent,
> {
  // ── Subscriptions ────────────────────────────────────────────────────────────────

  /** Upsert a subscription keyed by gateway id. Returns the stored row. */
  saveSubscription(sub: {
    gatewayId: string;
    provider: string;
    customerId: string;
    status: string;
    planId: string;
    trialEndsAt?: Date | null;
    endsAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<SubscriptionRow>;

  findSubscriptionByGatewayId(gatewayId: string): Promise<SubscriptionRow | null>;

  // ── Payments ─────────────────────────────────────────────────────────────────────

  /** Upsert a payment keyed by gateway id. Returns the stored row. */
  savePayment(payment: {
    gatewayId: string;
    provider: string;
    status: string;
    amount: number;
    currency: string;
    customerId?: string | null;
    subscriptionId?: string | null;
    paidAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<PaymentRow>;

  findPaymentByGatewayId(gatewayId: string): Promise<PaymentRow | null>;

  // ── Webhook idempotency ledger ───────────────────────────────────────────────────

  /** Record a webhook event for idempotency. Returns null when the event was already recorded. */
  recordWebhookEvent(event: {
    gatewayEventId: string;
    provider: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<WebhookEventRow | null>;

  markWebhookProcessed(id: string): Promise<void>;

  markWebhookFailed(id: string, error: string): Promise<void>;

  // ── Metered usage ────────────────────────────────────────────────────────────────

  /** Record one metered-usage event (a metered subscription's consumption). */
  recordUsage(event: {
    subscriptionId?: string | null;
    customerId?: string;
    meter: string;
    quantity: number;
    metadata?: Record<string, unknown>;
    recordedAt?: Date;
  }): Promise<UsageEventRow>;

  /** Aggregate metered usage by meter, filtered by subscription/customer/meter/window. */
  usageReport(query: {
    subscriptionId?: string;
    customerId?: string;
    meter?: string;
    from?: Date;
    to?: Date;
  }): Promise<Array<{ meter: string; quantity: number }>>;
}
