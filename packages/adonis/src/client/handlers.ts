import type { HttpContext } from '@adonisjs/core/http';
import type { BillingStore } from '../billing/billing_store.js';
import type { ClientPayment, ResolvedPaymentsClientConfig } from './define_config.js';

/**
 * The one framework-light handler behind `GET <path>/status`.
 *
 * It answers exactly one question — "where does the payment behind this reference stand" —
 * for a caller that has been proven to own it, and it is built so the unsafe shape of that
 * answer is not expressible:
 *
 * 1. the caller is resolved BEFORE the reference is looked at (`authorize`, then `owner`);
 * 2. the payment is loaded, but the response is only ever constructed AFTER the ownership
 *    guard has returned `allowed`, inside this function — there is no branch that reaches
 *    a body without passing it;
 * 3. the body is assembled from four NAMED fields. Nothing spreads the row, so a column
 *    added to `billing_payments` later (a payload, a customer, a gateway id) cannot start
 *    appearing in a browser because somebody forgot to exclude it.
 *
 * Reads one indexed row (`billing_payments_external_reference_idx`, then the unique
 * `billing_payments.gateway_id` when nothing carries that reference) plus, for the default
 * guard, one more (`billing_customers_owner_idx`). It never calls a gateway: this endpoint
 * is polled, and a gateway call per poll is a rate-limit incident waiting for its first
 * busy afternoon.
 */

/** What the handler needs to answer a request. */
export interface PaymentStatusDeps {
  store: BillingStore;
  config: ResolvedPaymentsClientConfig;
  /**
   * Called with the developer-facing reason a reference was refused. The browser gets a
   * bare `403` either way — this is how "you never recorded a customer mapping" reaches a
   * log instead of dying silently.
   */
  onDeny?: (reason: string) => void;
}

/** A plain JSON response: an HTTP status and a serializable body. */
export interface ClientApiResponse {
  status: number;
  body: unknown;
}

/**
 * The entire success body. Deliberately four fields.
 *
 * Not the payload, not the customer, not the gateway ids: even the rightful owner's browser
 * has no business holding a raw gateway payload, and a body this small cannot leak a field
 * somebody adds to the row later without thinking.
 *
 * `amount` is integer minor units, as stored. Format at the edge.
 */
export interface PaymentStatusBody {
  status: string;
  amount: number;
  currency: string;
  /** ISO 8601, or `null` while the payment has not settled. */
  paidAt: string | null;
}

const badRequest = (message: string): ClientApiResponse => ({
  status: 400,
  body: { error: message },
});
/** No caller could be resolved. Terminal for the browser — retrying will not grow a user. */
const unauthorized = (): ClientApiResponse => ({ status: 401, body: { error: 'unauthorized' } });
/** A caller was resolved and does not own this reference. Also terminal. */
const forbidden = (): ClientApiResponse => ({ status: 403, body: { error: 'forbidden' } });
/**
 * No payment row for that reference — which is the NORMAL state of a Pix charge that has
 * not been paid yet: `billing_payments` is written by the webhook, so nothing exists until
 * the gateway calls. The browser keeps polling on this one.
 */
const notFound = (): ClientApiResponse => ({ status: 404, body: { error: 'unknown reference' } });

/** `Date`, Luxon `DateTime` (Lucid) or nothing → a `Date` or `null`. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const asLuxon = value as { toJSDate?: () => Date } | null | undefined;
  if (asLuxon && typeof asLuxon.toJSDate === 'function') return asLuxon.toJSDate();
  return null;
}

/**
 * Read a store row into {@link ClientPayment} by NAMED column.
 *
 * The store is generic over its row type — a Lucid model instance in one implementation, a
 * plain object in the other — so this reads structurally, exactly as `listPayments` does.
 * `amount` goes through `Number` because Postgres hands `bigint` back as a string.
 */
export function normalizePayment(row: unknown): ClientPayment | null {
  const record = row as Record<string, unknown> | null | undefined;
  if (!record) return null;
  const gatewayId = record.gatewayId;
  const provider = record.provider;
  const status = record.status;
  const currency = record.currency;
  if (
    typeof gatewayId !== 'string' ||
    typeof provider !== 'string' ||
    typeof status !== 'string' ||
    typeof currency !== 'string'
  ) {
    return null;
  }
  return {
    gatewayId,
    provider,
    status,
    amount: Number(record.amount ?? 0),
    currency,
    customerId: typeof record.customerId === 'string' ? record.customerId : null,
    paidAt: toDate(record.paidAt),
  };
}

/**
 * The payment behind the reference the browser sent.
 *
 * Two lookups, in this order, and both indexed:
 *
 * 1. `external_reference` — the app's OWN id for the charge. This is the routing key: a
 *    checkout page polls for `order-1042`, not for `pi_3Qx...`, and the column exists so it
 *    can. Answers `null` for every row an install wrote before it ran the
 *    an earlier schema migration, which is exactly why (2) is still here.
 * 2. `gateway_id` — the old behaviour, kept because several Pix gateways make the two equal
 *    (Woovi's `correlationID`, Efí's `txid`) and because a not-yet-migrated install has
 *    nothing else to match on.
 *
 * An app-supplied `resolveReference` REPLACES both: it says "my reference is neither of
 * those, here is the gateway id", and second-guessing that with a fallback would be the
 * endpoint quietly answering a question the app already said it owns.
 */
async function findPayment(
  store: BillingStore,
  config: ResolvedPaymentsClientConfig,
  ctx: HttpContext,
  reference: string,
): Promise<ClientPayment | null> {
  if (config.resolveReference) {
    const gatewayId = await config.resolveReference(ctx, reference);
    if (typeof gatewayId !== 'string' || gatewayId === '') return null;
    return normalizePayment(await store.findPaymentByGatewayId(gatewayId));
  }
  const byReference = normalizePayment(await store.findPaymentByExternalReference(reference));
  if (byReference) return byReference;
  return normalizePayment(await store.findPaymentByGatewayId(reference));
}

/**
 * `GET <path>/status?reference=<reference>`.
 *
 * See the module note above for the order the guards run in and why.
 */
export async function paymentStatus(
  deps: PaymentStatusDeps,
  ctx: HttpContext,
  reference: string | undefined,
): Promise<ClientApiResponse> {
  const { store, config } = deps;

  if (typeof reference !== 'string' || reference.trim() === '') {
    return badRequest('reference is required');
  }
  const trimmed = reference.trim();

  // ── 1. The caller, before the reference. ───────────────────────────────────────────
  if (!(await config.authorize(ctx))) return unauthorized();
  const owner = await config.owner(ctx);
  if (!owner) return unauthorized();

  // ── 2. The payment. ────────────────────────────────────────────────────────────────
  const payment = await findPayment(store, config, ctx, trimmed);
  if (!payment) return notFound();

  // ── 3. Ownership. Nothing below this line is reachable without it. ─────────────────
  const outcome = await config.guard({ ctx, reference: trimmed, payment, owner, store });
  if (!outcome.allowed) {
    deps.onDeny?.(outcome.reason);
    return forbidden();
  }

  const body: PaymentStatusBody = {
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
  };
  return { status: 200, body };
}
