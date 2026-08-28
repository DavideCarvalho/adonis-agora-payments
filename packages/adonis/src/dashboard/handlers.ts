import { billingHealth } from '../billing/billing_health.js';
import { billingOverview } from '../billing/billing_overview.js';
import type { BillingStore } from '../billing/billing_store.js';
import {
  BILLING_LIST_DEFAULT_LIMIT,
  BILLING_LIST_MAX_LIMIT,
  clampLimit,
  clampOffset,
} from '../billing/list_query.js';
import type { RefundAction, ReplayAction } from './actions.js';
import { resolvePeriod } from './period.js';

/**
 * Framework-light JSON handlers over a {@link BillingStore}.
 *
 * Each handler takes a {@link Deps} bundle (the store the app already resolved, the display
 * currency, and — for the two write actions — the ports in `actions.ts`) and a plain
 * {@link ApiRequest} (a thin view of the parts of an HTTP request it needs), and returns a plain
 * {@link ApiResponse} (status + JSON body). No AdonisJS types leak in, so the handlers are
 * unit-testable against the real `InMemoryBillingStore` with no HTTP server. The provider adapts
 * an AdonisJS `HttpContext` to these shapes.
 *
 * Mirrors `@adonis-agora/durable`'s `src/dashboard/handlers.ts` convention exactly (`Deps` /
 * `ApiRequest` / `ApiResponse` / `ok` / `notFound` / `badRequest`, reads as `GET`, actions as
 * `POST`), so the two consoles' server halves read the same.
 *
 * This is a MANAGEMENT console, not a debugger: it answers "what needs my attention, which
 * customer is stuck, can I fix it from here". Raw payloads, verification traces and timings are
 * `@adonis-agora/telescope`'s job and are deliberately absent — nothing here returns a stored
 * gateway payload.
 *
 * MONEY: `amount` and `revenue` cross this boundary as integer MINOR UNITS, exactly as they are
 * stored. Nothing here divides — and the divisor is not always 100 (`src/money.ts`'s
 * `currencyExponent`). The SPA formats at render (`src/app/money.ts`).
 */

/** What the handlers need to answer a request. */
export interface Deps {
  store: BillingStore;
  /** ISO 4217 code echoed to the client so it knows how to format the minor units it receives. */
  currency: string;
  /** Injectable clock (for the period presets) — defaults to the wall clock. */
  now?: () => Date;
  /**
   * The write actions. Absent (or partially absent) when the app has no reachable
   * `PaymentsManager` — the read endpoints keep working and the action endpoints answer `503`
   * with a sentence saying so, rather than a button that silently does nothing.
   */
  actions?: Partial<DashboardActions>;
}

/** The two things this console can CHANGE. See `actions.ts`. */
export interface DashboardActions {
  refund: RefundAction;
  replayWebhook: ReplayAction;
}

/** The subset of an HTTP request the handlers read. */
export interface ApiRequest {
  /** Route params, e.g. `{ gatewayId: 'pi_123' }`. */
  params: Record<string, string | undefined>;
  /** Parsed query string, e.g. `{ status: 'failed', limit: '20' }`. */
  query: Record<string, string | string[] | undefined>;
  /** Parsed JSON body (for the POST actions). */
  body?: unknown;
}

/** A plain JSON response: an HTTP status and a serializable body. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** A `200 OK` JSON response. Exported so sibling handlers share one convention. */
export const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const badRequest = (message: string): ApiResponse => ({ status: 400, body: { error: message } });
const notFound = (message: string): ApiResponse => ({ status: 404, body: { error: message } });
/** The row is not in the state the action needs — a payment that is not `paid`, a ledger row that
 *  is not `failed`. Distinct from `400`: the request was well-formed, the world moved. */
const conflict = (message: string): ApiResponse => ({ status: 409, body: { error: message } });
/** The gateway/handler was reached and refused. `502`, not `500`: nothing here is broken. */
const upstreamFailed = (message: string): ApiResponse => ({
  status: 502,
  body: { error: message },
});
/** The capability is not wired in this deployment. Same shape the provider uses for a missing
 *  billing store, so the SPA reports both the same way. */
const unavailable = (message: string): ApiResponse => ({ status: 503, body: { error: message } });

/** The statuses the payments filter offers. `status` is a free string in the store (a gateway may
 *  send its own), so this is a UI convenience list, not a validation whitelist. Every member of
 *  `BillingStatus` is here: `authorized` money can still evaporate and `disputed` money has already
 *  been pulled back, and an operator who cannot filter for either cannot see either. */
export const PAYMENT_STATUSES = [
  'paid',
  'authorized',
  'pending',
  'failed',
  'refunded',
  'disputed',
  'canceled',
] as const;

/** The ledger's three statuses. `failed` is the one that means "a handler threw and the dispatcher
 *  gave up" — i.e. the event's effect never happened. */
export const WEBHOOK_EVENT_STATUSES = ['received', 'processed', 'failed'] as const;

/** `SubscriptionStatus`, ordered the way an operator reads them: what needs attention first.
 *  `paused` sits apart from `active` deliberately — a paused subscriber is not paying. */
export const SUBSCRIPTION_STATUSES = [
  'past_due',
  'paused',
  'incomplete',
  'trialing',
  'active',
  'canceled',
  'ended',
] as const;

/** The one status the subscriptions screen opens on: someone's payment failed and the subscription
 *  is about to lapse. Everything else can wait until tomorrow. */
export const SUBSCRIPTION_DEFAULT_STATUS = 'past_due';

/** Only a `paid` payment can be refunded from this console. A `pending` one has taken no money
 *  yet, and a `refunded`/`canceled` one has none left to take. */
const REFUNDABLE_STATUS = 'paid';

/**
 * How many rows a provider-filtered page may scan before it gives up and says so.
 *
 * `BillingListQuery` filters on `status` only, so `?provider=` is applied here, over pages read
 * from the store. That is bounded work by construction — but it has to be bounded VISIBLY: a
 * silent "no Asaas payments" that really means "none in the last thousand rows" is the kind of
 * wrong answer an operator acts on. `page.truncated` says which one they are looking at.
 */
export const PROVIDER_SCAN_CAP = 1000;

/** How far back `GET /providers` looks to learn which gateways this install actually uses. */
const PROVIDER_DISCOVERY_SCAN = 600;

function firstQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** A non-empty query param, or `undefined` — `?status=` must read as "no filter", not as `''`. */
function filterQuery(value: string | string[] | undefined): string | undefined {
  const raw = firstQuery(value);
  return raw === undefined || raw === '' ? undefined : raw;
}

/** Parse an integer query param, leaving the clamping to `list_query.ts` so every caller of the
 *  store agrees on the bounds. */
function intQuery(value: string | string[] | undefined): number | undefined {
  const raw = firstQuery(value);
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** The paging the request asked for, already clamped — echoed back so the client can tell whether
 *  another page might exist (`count === limit` is the only "there might be more" signal; nothing
 *  here counts the full match set). */
function pageOf(req: ApiRequest): { limit: number; offset: number } {
  return {
    limit: clampLimit(intQuery(req.query.limit)),
    offset: clampOffset(intQuery(req.query.offset)),
  };
}

/** `Date | null` -> ISO string | null, so every timestamp crosses the wire the same way. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** One page of rows plus the honesty flags a provider-filtered page needs. */
interface FilteredPage<T> {
  rows: T[];
  scanned: number;
  truncated: boolean;
}

/**
 * Read one page, optionally narrowed to a provider.
 *
 * With no `provider` this is a single store call and `truncated` is always `false`. With one, it
 * walks the store in store-sized chunks, keeping matches, until it has filled the requested page,
 * run out of rows, or hit {@link PROVIDER_SCAN_CAP}.
 */
async function pageBy<T extends { provider: string }>(
  fetch: (limit: number, offset: number) => Promise<T[]>,
  page: { limit: number; offset: number },
  provider: string | undefined,
): Promise<FilteredPage<T>> {
  if (provider === undefined) {
    const rows = await fetch(page.limit, page.offset);
    return { rows, scanned: rows.length, truncated: false };
  }

  const wanted = page.offset + page.limit;
  const matched: T[] = [];
  let scanned = 0;
  let exhausted = false;

  while (matched.length < wanted && scanned < PROVIDER_SCAN_CAP && !exhausted) {
    const chunk = Math.min(BILLING_LIST_MAX_LIMIT, PROVIDER_SCAN_CAP - scanned);
    const rows = await fetch(chunk, scanned);
    scanned += rows.length;
    if (rows.length < chunk) exhausted = true;
    for (const row of rows) {
      if (row.provider === provider) matched.push(row);
    }
  }

  return {
    rows: matched.slice(page.offset, wanted),
    scanned,
    // Only a scan that stopped SHORT is truncated. Filling the page or reaching the end of the
    // table are both complete answers.
    truncated: !exhausted && matched.length < wanted,
  };
}

/** The paging envelope every list endpoint echoes back. */
function pageEnvelope<T>(page: { limit: number; offset: number }, filtered: FilteredPage<T>) {
  return {
    limit: page.limit,
    offset: page.offset,
    count: filtered.rows.length,
    scanned: filtered.scanned,
    truncated: filtered.truncated,
  };
}

/**
 * `GET <api>/overview` — the `billingOverview()` aggregates for a selectable window.
 *
 * Straight passthrough of the headless function this package already ships: revenue (integer
 * minor units), active subscriptions (which INCLUDES `trialing` — see `countActiveSubscriptions`),
 * and one line per metered meter.
 */
export async function overview(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const period = resolvePeriod(
    {
      period: firstQuery(req.query.period),
      from: firstQuery(req.query.from),
      to: firstQuery(req.query.to),
    },
    now,
  );
  const result = await billingOverview(deps.store, { from: period.from, to: period.to });
  return ok({
    period: {
      from: result.period.from.toISOString(),
      to: result.period.to.toISOString(),
      preset: period.preset,
    },
    currency: deps.currency,
    metrics: result.metrics,
  });
}

/**
 * `GET <api>/health` — the three silent failures of a billing install, from `billingHealth()`.
 *
 * This is the endpoint the console opens on. Every other screen answers a question the operator
 * had to think of; this one answers the question they did not: an install where the worker died,
 * or the webhook endpoint stopped being reachable, keeps returning `200` everywhere while revenue
 * quietly stops landing. `failures` names WHICH provider and event type is failing, so the answer
 * is a place to look rather than a number.
 *
 * Nothing here is windowed by the period selector: `billingHealth` has its own thresholds
 * (15 min stuck, 2 h unconfirmed, 24 h of failures) and they are the thresholds `payments:health`
 * alerts on, so the console and the cron agree.
 */
export async function health(deps: Deps): Promise<ApiResponse> {
  const now = deps.now?.();
  const report = await billingHealth(deps.store, now !== undefined ? { now } : {});
  return ok({
    healthy: report.healthy,
    checkedAt: report.checkedAt.toISOString(),
    checks: report.checks,
    failures: report.failures,
  });
}

/** `GET <api>/payments` — a page of `billing_payments`, newest first, `status`/`provider` filters. */
export async function payments(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const status = filterQuery(req.query.status);
  const provider = filterQuery(req.query.provider);
  const page = pageOf(req);
  const filtered = await pageBy(
    (limit, offset) =>
      deps.store.listPayments({ ...(status !== undefined ? { status } : {}), limit, offset }),
    page,
    provider,
  );
  return ok({
    payments: filtered.rows.map((row) => ({
      id: row.id,
      gatewayId: row.gatewayId,
      provider: row.provider,
      status: row.status,
      // Integer minor units, as stored. The SPA formats.
      amount: row.amount,
      currency: row.currency,
      customerId: row.customerId,
      subscriptionId: row.subscriptionId,
      paidAt: iso(row.paidAt),
      createdAt: iso(row.createdAt),
      /** Whether the Refund button is offered for this row. The SPA must not have to re-derive
       *  the server's rule, because the two disagreeing means a button that always errors. */
      refundable: row.status === REFUNDABLE_STATUS,
    })),
    page: pageEnvelope(page, filtered),
    statuses: PAYMENT_STATUSES,
    currency: deps.currency,
  });
}

/**
 * `GET <api>/subscriptions` — a page of `billing_subscriptions`, newest first,
 * `status`/`provider` filters.
 *
 * For a subscription business this is the daily surface: `countActiveSubscriptions()` answers "how
 * many", which is the wrong question on any day something is wrong. The operational questions are
 * WHICH subscriptions are `past_due` (someone's card failed and they are about to lose access) and
 * which are `paused` (a subscriber who is not paying and must not be read as active) — and a count
 * cannot name a customer to email.
 */
export async function subscriptions(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const status = filterQuery(req.query.status);
  const provider = filterQuery(req.query.provider);
  const page = pageOf(req);
  const filtered = await pageBy(
    (limit, offset) =>
      deps.store.listSubscriptions({ ...(status !== undefined ? { status } : {}), limit, offset }),
    page,
    provider,
  );
  // The one number that makes the filter tabs worth reading: how many are past due IN TOTAL, not
  // just on this page. Cheap — a single count — and it is the figure that decides the operator's
  // morning.
  const pastDue = await deps.store.countSubscriptions({ status: SUBSCRIPTION_DEFAULT_STATUS });
  return ok({
    subscriptions: filtered.rows.map((row) => ({
      id: row.id,
      gatewayId: row.gatewayId,
      provider: row.provider,
      status: row.status,
      planId: row.planId,
      customerId: row.customerId,
      trialEndsAt: iso(row.trialEndsAt),
      endsAt: iso(row.endsAt),
      createdAt: iso(row.createdAt),
    })),
    page: pageEnvelope(page, filtered),
    statuses: SUBSCRIPTION_STATUSES,
    counts: { past_due: pastDue },
  });
}

/**
 * `GET <api>/webhook-events` — a page of the idempotency ledger, newest first,
 * `status`/`provider` filters.
 *
 * The `error` column is carried through verbatim: a `failed` row is the only record that a handler
 * threw, and its message is the only place the reason survives. The stored gateway payload is NOT
 * returned — that is a debugging question, and telescope is where it belongs.
 */
export async function webhookEvents(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const status = filterQuery(req.query.status);
  const provider = filterQuery(req.query.provider);
  const page = pageOf(req);
  const filtered = await pageBy(
    (limit, offset) =>
      deps.store.listWebhookEvents({ ...(status !== undefined ? { status } : {}), limit, offset }),
    page,
    provider,
  );
  return ok({
    events: filtered.rows.map((row) => ({
      id: row.id,
      gatewayEventId: row.gatewayEventId,
      provider: row.provider,
      type: row.type,
      status: row.status,
      error: row.error,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      /** Only a `failed` row can be retried — see `retryWebhookEvent`. */
      retryable: row.status === 'failed',
    })),
    page: pageEnvelope(page, filtered),
    statuses: WEBHOOK_EVENT_STATUSES,
  });
}

/**
 * `GET <api>/providers` — the gateways this install actually uses, for the provider filter.
 *
 * Driven by the DATA, never by a hardcoded list: this package ships eighteen drivers and an
 * install runs two or three of them, so a static list would offer fifteen filters that return
 * nothing and hide the one that matters behind them. The ledger side is exact
 * (`webhookEventBreakdown` groups the whole table); the payment/subscription side reads the most
 * recent {@link PROVIDER_DISCOVERY_SCAN} rows, which is enough to notice a gateway that is in use.
 */
export async function providers(deps: Deps): Promise<ApiResponse> {
  const [paymentRows, subscriptionRows, breakdown] = await Promise.all([
    deps.store.listPayments({ limit: PROVIDER_DISCOVERY_SCAN }),
    deps.store.listSubscriptions({ limit: PROVIDER_DISCOVERY_SCAN }),
    deps.store.webhookEventBreakdown({}),
  ]);
  const names = new Set<string>();
  for (const row of paymentRows) names.add(row.provider);
  for (const row of subscriptionRows) names.add(row.provider);
  for (const line of breakdown) names.add(line.provider);
  return ok({ providers: [...names].sort() });
}

/**
 * `POST <api>/payments/:gatewayId/refund` — refund a payment through its own gateway.
 *
 * `POST`, never `GET`: a refund reachable by URL is a refund a crawler can trigger. Body is
 * `{ amount?: number }` in integer minor units; omit it for the full amount.
 *
 * The local row is deliberately NOT rewritten here. The gateway confirms a refund with a
 * `payment.refunded` webhook, and that is what moves the row to `refunded` — writing it optimistically
 * would show the operator a refund that may never have settled.
 */
export async function refundPayment(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const gatewayId = req.params.gatewayId;
  if (gatewayId === undefined || gatewayId === '') {
    return badRequest('A payment gateway id is required.');
  }

  const row = await deps.store.findPaymentByGatewayId(gatewayId);
  if (row === null) {
    return notFound(`No payment "${gatewayId}" is recorded locally.`);
  }
  const payment = readPaymentRow(row);
  if (payment.status !== REFUNDABLE_STATUS) {
    return conflict(
      `Payment "${gatewayId}" is "${payment.status}", not "${REFUNDABLE_STATUS}". Only a paid payment can be refunded from here.`,
    );
  }

  const amount = readRefundAmount(req.body);
  if (amount === INVALID_AMOUNT) {
    return badRequest(
      '`amount` must be a positive integer in the currency’s minor units, or omitted for a full refund.',
    );
  }
  if (amount !== undefined && amount > payment.amount) {
    return badRequest(
      `A partial refund of ${amount} is larger than the payment itself (${payment.amount} ${payment.currency}).`,
    );
  }

  const refund = deps.actions?.refund;
  if (refund === undefined) {
    return unavailable(
      'Refunds need the payments manager, which is not available in this deployment.',
    );
  }

  const outcome = await refund({
    provider: payment.provider,
    gatewayId,
    ...(amount !== undefined ? { amount } : {}),
  });
  switch (outcome.kind) {
    case 'ok':
      return ok({
        refund: outcome.refund,
        payment: {
          gatewayId,
          provider: payment.provider,
          amount: payment.amount,
          currency: payment.currency,
        },
        // The row still says `paid` until the gateway's webhook lands. Say so, rather than
        // letting the operator read the unchanged list as a failed refund.
        note: 'The payment row updates when the gateway’s refund webhook arrives.',
      });
    case 'unavailable':
      return unavailable(outcome.message);
    case 'unsupported':
      return conflict(outcome.message);
    case 'gateway-error':
      return upstreamFailed(outcome.message);
  }
}

/**
 * `POST <api>/webhook-events/:gatewayEventId/retry` — re-run a failed event's handlers.
 *
 * The single most useful thing an operator can do after fixing a handler bug: a `failed` row means
 * the dispatcher gave up, so whatever that event described — a subscription activated, a payment
 * recorded — never happened, and nothing will retry it. Replaying is safe because the ledger
 * re-claims a `failed` event (`recordWebhookEvent` returns it again) while refusing an in-flight or
 * already-processed one, so this can never double-apply a redelivery.
 *
 * `POST`, never `GET`, for the same reason the refund is.
 */
export async function retryWebhookEvent(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const gatewayEventId = req.params.gatewayEventId;
  if (gatewayEventId === undefined || gatewayEventId === '') {
    return badRequest('A gateway event id is required.');
  }

  const row = await deps.store.findWebhookEventByGatewayEventId(gatewayEventId);
  if (row === null) {
    return notFound(`No webhook event "${gatewayEventId}" is in the ledger.`);
  }
  if (row.status !== 'failed') {
    return conflict(
      `Event "${gatewayEventId}" is "${row.status}", not "failed". An in-flight event is still running and a processed one already took effect.`,
    );
  }

  const replay = deps.actions?.replayWebhook;
  if (replay === undefined) {
    return unavailable(
      'Retrying an event needs the payments manager, which is not available in this deployment.',
    );
  }

  const outcome = await replay({
    gatewayEventId,
    provider: row.provider,
    type: row.type,
    previousError: row.error,
  });
  switch (outcome.kind) {
    case 'processed':
      return ok({ gatewayEventId, status: 'processed' });
    case 'conflict':
      return conflict(
        `Event "${gatewayEventId}" was claimed by something else before the retry started.`,
      );
    case 'undeliverable':
      // 422: the request was right, the event simply cannot be rebuilt here. The ledger row is
      // untouched, which the message says so the operator does not go looking for a change.
      return {
        status: 422,
        body: {
          error: outcome.message,
          note: 'The ledger row is unchanged. Redeliver this event from the gateway’s own dashboard instead.',
        },
      };
    case 'failed':
      return upstreamFailed(outcome.message);
  }
}

/** Sentinel for an `amount` that was supplied and is not a usable one. Distinct from `undefined`,
 *  which means "no amount given" — a full refund. */
const INVALID_AMOUNT = Symbol('invalid-amount');

/**
 * Read `{ amount }` off a refund body.
 *
 * Strict on purpose: a decimal `19.9` reaching a gateway that wants minor units is a refund of
 * nineteen cents, and a string `'1990'` is a refund of nothing. Both are rejected rather than
 * coerced.
 */
function readRefundAmount(body: unknown): number | undefined | typeof INVALID_AMOUNT {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object') return INVALID_AMOUNT;
  const raw = (body as { amount?: unknown }).amount;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return INVALID_AMOUNT;
  return raw;
}

/**
 * Read the fields the refund needs off whatever row the store returned.
 *
 * `findPaymentByGatewayId` hands back the IMPLEMENTATION's row (a Lucid model in one store, a
 * plain object in the other), not the normalized `PaymentListItem` the list endpoints get — so the
 * few fields used here are read defensively, and `amount` goes through `Number` because Postgres
 * hands a numeric column back as a string.
 */
function readPaymentRow(row: unknown): {
  provider: string;
  status: string;
  amount: number;
  currency: string;
} {
  const r = row as { provider?: unknown; status?: unknown; amount?: unknown; currency?: unknown };
  return {
    provider: String(r.provider ?? ''),
    status: String(r.status ?? ''),
    amount: Number(r.amount ?? 0),
    currency: String(r.currency ?? ''),
  };
}

/** Re-exported so the provider and the SPA agree on the default page size without duplicating it. */
export { BILLING_LIST_DEFAULT_LIMIT };
