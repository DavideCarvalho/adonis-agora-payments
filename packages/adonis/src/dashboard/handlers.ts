import { billingHealth } from '../billing/billing_health.js';
import { billingOverview } from '../billing/billing_overview.js';
import {
  AUDIT_ACTIONS,
  type AuditEventListItem,
  type BillingStore,
  type CustomerListItem,
  type DisputeListItem,
  OPEN_DISPUTE_STATUSES,
  type PaymentListItem,
} from '../billing/billing_store.js';
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
  /**
   * WHO is making this request, as the provider's `enforce()` guard already knew them.
   *
   * Per-request, unlike everything else on `Deps`. The guard has verified a signed session
   * carrying a user before any handler runs, and until now it threw that away — so the only
   * record of a refund issued from this console was a diagnostic naming a gateway id, an amount
   * and no person at all. `undefined` on a console with no `dashboardAuth` configured, which is
   * recorded honestly as "unattributed" rather than invented.
   */
  actor?: string;
  /**
   * O que cada gateway configurado SABE fazer, por nome de provider.
   *
   * Sem isto o console oferecia botões que não podiam funcionar: todo pagamento Pix via
   * Woovi mostrava "Refund", e o OpenPix não tem estorno por API — o operador descobria
   * clicando. Ausente quando o `PaymentsManager` não está alcançável; aí a UI volta a mostrar
   * as ações, que é o comportamento anterior e melhor que esconder tudo por falta de dado.
   */
  capabilities?: Record<string, ProviderCapabilities>;
}

/** O que um gateway sabe fazer, como o console precisa saber. */
export interface ProviderCapabilities {
  refunds: boolean;
  disputes: boolean;
  /** Se a assinatura pode ser cancelada NO GATEWAY. Irrelevante no modo gerenciado. */
  cancelSubscription: boolean;
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

/** The statuses the disputes filter offers — `DisputeStatus`, ordered the way an operator reads
 *  them: what still needs an answer first. `warning` leads because it is the only one where a
 *  refund still stops the chargeback from ever being filed. */
export const DISPUTE_STATUSES = [
  'warning',
  'open',
  'under_review',
  'lost',
  'expired',
  'canceled',
  'won',
] as const;

/** How far ahead `?dueWithin=` looks when the caller asks for closing windows but names no
 *  horizon. Matches `billingHealth`'s default, so the panel and the cron agree about "soon". */
export const DISPUTE_DEFAULT_DUE_WITHIN_HOURS = 72;

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
    // WHICH windows are closing, not just how many — a count names no gateway dashboard to
    // open. Dates cross the wire as ISO strings, like everywhere else here.
    deadlines: report.deadlines.map(disputeJson),
    // The deadline-free list. On a gateway that publishes no deadline this is the only one of
    // the two that is ever non-empty, which is exactly why it is separate.
    openDisputes: report.openDisputes.map(disputeJson),
  });
}

/** One dispute row as JSON. `amount` stays integer minor units — the SPA formats. */
function disputeJson(row: DisputeListItem) {
  return {
    id: row.id,
    gatewayId: row.gatewayId,
    paymentGatewayId: row.paymentGatewayId,
    provider: row.provider,
    status: row.status,
    reason: row.reason,
    amount: row.amount,
    currency: row.currency,
    /** `null` means the gateway sent no deadline — never "no hurry". The SPA must say so. */
    evidenceDueBy: iso(row.evidenceDueBy),
    outcome: row.outcome,
    openedAt: iso(row.openedAt),
    closedAt: iso(row.closedAt),
    createdAt: iso(row.createdAt),
  };
}

/**
 * `GET <api>/disputes` — a page of `billing_disputes`.
 *
 * Two modes, because a dispute list has two questions:
 *
 * - default: newest first, `status`/`provider` filters — the log.
 * - `?dueWithin=<hours>`: only OPEN disputes carrying a deadline, soonest window first — the
 *   work. Rows already past their deadline stay in it: they are still open and still
 *   unanswered, and dropping them the moment they expire would make the panel go quiet at
 *   exactly the moment it became urgent.
 *
 * There is still no "accept" and no "fight" button: whether to submit evidence or refund is a
 * business rule (it turns on the fee, the evidence you actually have, and the chargeback ratio
 * that puts a merchant into a card network's monitoring programme), and it stays in the app's
 * code. The one write this screen does have is {@link resolveDispute}, which records an outcome
 * that has ALREADY happened at the gateway — see the note there for why that is not the same
 * thing.
 */
export async function disputes(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const status = filterQuery(req.query.status);
  const provider = filterQuery(req.query.provider);
  const page = pageOf(req);
  // `firstQuery`, not `filterQuery`: a bare `?dueWithin` (no value) is a request for the work
  // list at the DEFAULT horizon, not an absent filter. A value that is present and unreadable
  // is a `400` — silently falling back to the default would answer a different question than
  // the one asked, and the caller could not tell.
  const dueWithinRaw = firstQuery(req.query.dueWithin);

  if (dueWithinRaw !== undefined) {
    const parsed =
      dueWithinRaw === '' ? DISPUTE_DEFAULT_DUE_WITHIN_HOURS : Number.parseInt(dueWithinRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return badRequest('dueWithin must be a number of hours, and not negative');
    }
    const withinHours = parsed;
    const now = deps.now?.();
    const rows = await deps.store.listDisputesDueWithin({
      withinHours,
      ...(now !== undefined ? { now } : {}),
      ...(provider !== undefined ? { provider } : {}),
      limit: page.limit,
      offset: page.offset,
    });
    // The full count, not `rows.length`: a page that fills says nothing about how many more
    // windows are closing, and that number is the one an operator plans their day around.
    const total = await deps.store.countDisputesDueWithin({
      withinHours,
      ...(now !== undefined ? { now } : {}),
      ...(provider !== undefined ? { provider } : {}),
    });
    return ok({
      disputes: rows.map(disputeJson),
      dueWithin: { hours: withinHours, total },
      page: { limit: page.limit, offset: page.offset, count: rows.length },
      statuses: DISPUTE_STATUSES,
    });
  }

  const rows = await deps.store.listDisputes({
    ...(status !== undefined ? { status } : {}),
    ...(provider !== undefined ? { provider } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    disputes: rows.map(disputeJson),
    page: { limit: page.limit, offset: page.offset, count: rows.length },
    statuses: DISPUTE_STATUSES,
  });
}

/** The app-side owner of a payment, resolved through `billing_customers`. */
interface OwnerJson {
  type: string | null;
  id: string | null;
  name: string | null;
  email: string | null;
}

/**
 * One payment row as JSON.
 *
 * `externalReference` is here, and its absence was the bug: the store has returned it since the
 * column existed and this serializer dropped it, so the console showed a gateway id where the
 * operator was holding an order number. It is the ONLY field on this row the app itself chose,
 * which makes it the only one that can answer "did THIS student's payment land?".
 *
 * `owner` is the other half of the same question. A payment carries the GATEWAY's customer id
 * (`cus_…`), which names nobody; `billing_customers.owner_type`/`owner_id`, written by
 * `ensureCustomer`, is the only thing tying it to an app user. `null` when the payment has no
 * customer id, or when nothing mapped it.
 */
function paymentJson(
  row: PaymentListItem,
  owner: OwnerJson | null,
  capabilities?: Record<string, ProviderCapabilities>,
) {
  return {
    id: row.id,
    gatewayId: row.gatewayId,
    provider: row.provider,
    status: row.status,
    // Integer minor units, as stored. The SPA formats.
    amount: row.amount,
    currency: row.currency,
    customerId: row.customerId,
    subscriptionId: row.subscriptionId,
    /** The APP's own id for this charge. `null` when the gateway echoed none. */
    externalReference: row.externalReference,
    /** Integer minor units already refunded; `null` on a row older than the column. */
    refundedAmount: row.refundedAmount,
    owner,
    paidAt: iso(row.paidAt),
    createdAt: iso(row.createdAt),
    /**
     * Whether the Refund button is offered for this row. The SPA must not have to re-derive
     * the server's rule, because the two disagreeing means a button that always errors.
     *
     * Status was the whole rule, and it was half of it: Woovi/OpenPix has no refund API at
     * all, so every paid Pix row offered a Refund that could only ever fail — the operator
     * found out by clicking. When capabilities are unknown (no reachable manager) the button
     * is still offered, which is the previous behaviour and better than hiding a working
     * action because a lookup was unavailable.
     */
    refundable: row.status === REFUNDABLE_STATUS && capabilities?.[row.provider]?.refunds !== false,
  };
}

/**
 * Resolve the app-side owner for a page of payments, in ONE store read.
 *
 * A lookup per row would be a query per row of every page. `listCustomersByGatewayIds` takes the
 * distinct ids instead; rows whose customer is unmapped simply get `null`, which is the honest
 * answer — `ensureCustomer` is what writes the mapping, and an app that charges without it has
 * no owner to report.
 */
async function ownersFor(
  store: BillingStore,
  rows: readonly PaymentListItem[],
): Promise<Map<string, OwnerJson>> {
  const ids = [...new Set(rows.map((row) => row.customerId).filter((id): id is string => !!id))];
  const owners = new Map<string, OwnerJson>();
  if (ids.length === 0) return owners;
  for (const customer of await store.listCustomersByGatewayIds(ids)) {
    owners.set(customer.gatewayId, {
      type: customer.ownerType,
      id: customer.ownerId,
      name: customer.name,
      email: customer.email,
    });
  }
  return owners;
}

/**
 * `GET <api>/payments` — a page of `billing_payments`, newest first.
 *
 * Filters: `status`, `provider`, and the three that answer "did this one land?" —
 * `reference` (the app's own `externalReference`), `gatewayId`, and `customerId`. All three are
 * EXACT: they are join keys, and a prefix match on `order-4` returning `order-42` is a wrong
 * answer to a question about money.
 */
export async function payments(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const status = filterQuery(req.query.status);
  const provider = filterQuery(req.query.provider);
  // `reference` in the query string, `externalReference` in the store — the short name is what
  // an operator types, and both are accepted so a link built from either keeps working.
  const reference = filterQuery(req.query.reference) ?? filterQuery(req.query.externalReference);
  const gatewayId = filterQuery(req.query.gatewayId);
  const customerId = filterQuery(req.query.customerId);
  const page = pageOf(req);
  const filtered = await pageBy(
    (limit, offset) =>
      deps.store.listPayments({
        ...(status !== undefined ? { status } : {}),
        ...(reference !== undefined ? { externalReference: reference } : {}),
        ...(gatewayId !== undefined ? { gatewayId } : {}),
        ...(customerId !== undefined ? { customerId } : {}),
        limit,
        offset,
      }),
    page,
    provider,
  );
  const owners = await ownersFor(deps.store, filtered.rows);
  return ok({
    payments: filtered.rows.map((row) =>
      paymentJson(row, (row.customerId && owners.get(row.customerId)) || null, deps.capabilities),
    ),
    page: pageEnvelope(page, filtered),
    statuses: PAYMENT_STATUSES,
    currency: deps.currency,
    /** Echoed so the SPA can render "no payment carries reference X" rather than "no payments". */
    filters: {
      reference: reference ?? null,
      gatewayId: gatewayId ?? null,
      customerId: customerId ?? null,
    },
  });
}

/**
 * `GET <api>/payments/:gatewayId` — everything this system knows about ONE payment.
 *
 * The screen that did not exist, and the honest name for it is "what IS knowable", not "history".
 * `billing_payments` is a single mutable row upserted in place: it has a current state and no
 * past, so "what changed on this payment, and when?" cannot be answered from it and this endpoint
 * does not pretend otherwise. What it assembles instead:
 *
 * - the row's CURRENT state, including `refundedAmount` and the app's own reference;
 * - the app-side OWNER, through `billing_customers`;
 * - every DISPUTE filed against it — that table does carry a real link (`payment_gateway_id`);
 * - the LEDGER rows whose stored delivery names it, newest first. That is a payload substring
 *   scan, with everything that implies: it is unindexed, and it can match a delivery that merely
 *   mentions the id. `events.matchedBy` says so on the wire rather than in a comment nobody sees.
 * - the AUDIT rows naming it — who refunded it, from this console, and when.
 *
 * The stored payload is still never returned. The timeline says an event ARRIVED and what type it
 * was; what was inside it is telescope's job.
 */
export async function paymentDetail(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const gatewayId = req.params.gatewayId;
  if (gatewayId === undefined || gatewayId === '') {
    return badRequest('A payment gateway id is required.');
  }

  // The LIST read, not `findPaymentByGatewayId`: that one hands back the implementation's row
  // (a Lucid model in one store, a plain object in the other) and this response needs the
  // normalized shape every other endpoint here serializes.
  const [row] = await deps.store.listPayments({ gatewayId, limit: 1 });
  if (row === undefined) {
    return notFound(`No payment "${gatewayId}" is recorded locally.`);
  }

  const [owners, disputeRows, eventRows, auditRows] = await Promise.all([
    ownersFor(deps.store, [row]),
    deps.store.listDisputes({ limit: PAYMENT_TIMELINE_LIMIT }),
    deps.store.listWebhookEventsForPayment(gatewayId, { limit: PAYMENT_TIMELINE_LIMIT }),
    deps.store.listAuditEvents({
      subjectType: 'payment',
      subjectId: gatewayId,
      limit: PAYMENT_TIMELINE_LIMIT,
    }),
  ]);

  return ok({
    payment: paymentJson(
      row,
      (row.customerId && owners.get(row.customerId)) || null,
      deps.capabilities,
    ),
    // Filtered here rather than in the store: `listDisputes` has no payment filter, and adding
    // one for a page that is already bounded would be a second read to maintain. A dispute list
    // this long on one install is itself the emergency.
    disputes: disputeRows.filter((d) => d.paymentGatewayId === gatewayId).map(disputeJson),
    events: {
      rows: eventRows.map(webhookEventJson),
      /** How the rows were found — see the note on `listWebhookEventsForPayment`. */
      matchedBy: 'payload-substring',
    },
    audit: auditRows.map(auditJson),
    currency: deps.currency,
  });
}

/** How many rows each strand of the per-payment view returns. A payment with more than this many
 *  ledger rows is not a timeline, it is an incident. */
const PAYMENT_TIMELINE_LIMIT = 50;

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
      // Numa linha GERENCIADA não há `gatewayId` para abrir no painel do gateway, então isto
      // é a única descrição da assinatura que existe. Sem estes campos a tela mostrava um id
      // nulo e nada sobre quanto cobra ou quando.
      managed: row.managed,
      amount: row.amount,
      currency: row.currency,
      cycle: row.cycle,
      currentPeriodEnd: iso(row.currentPeriodEnd),
      nextChargeAt: iso(row.nextChargeAt),
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      lastRenewalError: row.lastRenewalError,
      lastRenewalAttemptAt: iso(row.lastRenewalAttemptAt),
      renewalFailureCount: row.renewalFailureCount,
    })),
    page: pageEnvelope(page, filtered),
    statuses: SUBSCRIPTION_STATUSES,
    counts: {
      past_due: pastDue,
      // Quantas estão falhando a renovação AGORA, no total e não na página. O mesmo motivo do
      // `past_due`: é o número que decide a manhã de quem opera.
      failing_renewals: await deps.store.countSubscriptions({
        status: 'active',
        managed: true,
        minRenewalFailures: 1,
      }),
    },
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
  // The filter the ledger was missing. `status` + `provider` answers "what is failing on Asaas";
  // it could not answer "did a refund event arrive at all", which is the question the ledger gets
  // read for the moment one specific charge is in doubt.
  const type = filterQuery(req.query.type);
  const page = pageOf(req);
  const filtered = await pageBy(
    (limit, offset) =>
      deps.store.listWebhookEvents({
        ...(status !== undefined ? { status } : {}),
        ...(type !== undefined ? { type } : {}),
        limit,
        offset,
      }),
    page,
    provider,
  );
  return ok({
    events: filtered.rows.map(webhookEventJson),
    page: pageEnvelope(page, filtered),
    statuses: WEBHOOK_EVENT_STATUSES,
  });
}

/** One ledger row as JSON. The stored payload is never part of it — telescope's job. */
function webhookEventJson(row: {
  id: string;
  gatewayEventId: string;
  provider: string;
  type: string;
  status: string;
  error: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}) {
  return {
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
  };
}

/** One audit row as JSON. `amount` stays integer minor units. */
function auditJson(row: AuditEventListItem) {
  return {
    id: row.id,
    action: row.action,
    /** `null` is "unattributed" — a console with no `dashboardAuth` cannot name anybody. */
    actor: row.actor,
    provider: row.provider,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    amount: row.amount,
    currency: row.currency,
    message: row.message,
    metadata: row.metadata,
    createdAt: iso(row.createdAt),
  };
}

/** One `billing_customers` row as JSON — the mapping that ties a gateway customer to an app user. */
function customerJson(row: CustomerListItem) {
  return {
    id: row.id,
    gatewayId: row.gatewayId,
    provider: row.provider,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    email: row.email,
    name: row.name,
    taxId: row.taxId,
    createdAt: iso(row.createdAt),
  };
}

/**
 * `GET <api>/customers` — a page of `billing_customers`, newest first.
 *
 * The endpoint that did not exist. `billing_customers` holds `owner_type`/`owner_id`, written by
 * the app itself through `ensureCustomer`, and that mapping is the ONLY thing tying a payment to
 * a person: a payment row carries `cus_…` and nothing else. Without this the console could show
 * every charge in the system and never answer "which of these is user 4102's".
 *
 * Filters: `provider`, `ownerType`, `ownerId`, `gatewayId` — all exact. Pair `ownerType` with
 * `ownerId`: one owner may legitimately hold a customer at every configured gateway, so an id
 * alone is not a key.
 */
export async function customers(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const provider = filterQuery(req.query.provider);
  const ownerType = filterQuery(req.query.ownerType);
  const ownerId = filterQuery(req.query.ownerId);
  const gatewayId = filterQuery(req.query.gatewayId);
  const page = pageOf(req);
  const rows = await deps.store.listCustomers({
    ...(provider !== undefined ? { provider } : {}),
    ...(ownerType !== undefined ? { ownerType } : {}),
    ...(ownerId !== undefined ? { ownerId } : {}),
    ...(gatewayId !== undefined ? { gatewayId } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    customers: rows.map(customerJson),
    // No `scanned`/`truncated`: every filter here is a column the store applies, so there is no
    // bounded scan behind this list and claiming the caveat would be claiming one that does not
    // apply. Same reason the disputes page reports a narrower envelope.
    page: { limit: page.limit, offset: page.offset, count: rows.length },
  });
}

/** The audit actions the filter offers. A free string in the column, so this is a UI convenience
 *  list, not a validation whitelist — an app that records its own actions still sees them. */
export const AUDIT_ACTION_FILTERS = [
  AUDIT_ACTIONS.webhookRejected,
  AUDIT_ACTIONS.refund,
  AUDIT_ACTIONS.disputeResolved,
] as const;

/**
 * `GET <api>/audit` — the trail of things that happened which no other table records.
 *
 * Three kinds of row, and each of them used to be a diagnostic and nothing else:
 *
 * - `webhook.rejected` — a delivery the endpoint REFUSED. This is the one that matters most,
 *   because it is otherwise invisible: a rejected delivery never becomes a ledger row, so a
 *   rotated webhook secret looks exactly like a quiet week — zero events, zero failures, every
 *   check green — while every refund, chargeback and dispute closure is dropped on the floor.
 * - `payment.refunded` — WHO refunded what, from this console. The payment row moves only when
 *   the gateway's webhook lands, and that row names no person.
 * - `dispute.resolved` — who closed a dispute the gateway will never close itself.
 *
 * Filters: `action`, `actor`, `provider`, `subjectType`, `subjectId` — all exact.
 */
export async function auditEvents(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const action = filterQuery(req.query.action);
  const actor = filterQuery(req.query.actor);
  const provider = filterQuery(req.query.provider);
  const subjectType = filterQuery(req.query.subjectType);
  const subjectId = filterQuery(req.query.subjectId);
  const page = pageOf(req);
  const rows = await deps.store.listAuditEvents({
    ...(action !== undefined ? { action } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(subjectType !== undefined ? { subjectType } : {}),
    ...(subjectId !== undefined ? { subjectId } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    audit: rows.map(auditJson),
    // Column filters throughout, so no bounded scan and no `truncated` caveat to claim.
    page: { limit: page.limit, offset: page.offset, count: rows.length },
    actions: AUDIT_ACTION_FILTERS,
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
  const types = new Set<string>();
  for (const row of paymentRows) names.add(row.provider);
  for (const row of subscriptionRows) names.add(row.provider);
  for (const line of breakdown) {
    names.add(line.provider);
    types.add(line.type);
  }
  // The event-type vocabulary, from the DATA for the same reason the provider list is: the types
  // an install actually receives are a handful, the ones this package can emit are many, and a
  // filter offering twenty that return nothing hides the three that do not.
  return ok({
    providers: [...names].sort(),
    eventTypes: [...types].sort(),
    // `{}` e não ausente: o cliente distingue "nenhum gateway sabe estornar" de "não deu para
    // perguntar" olhando a chave do provider, não a existência do objeto.
    capabilities: deps.capabilities ?? {},
  });
}

/** The dispute statuses that mean the matter is FINISHED — `DISPUTE_STATUSES` minus the open
 *  ones. Only these can be recorded through {@link resolveDispute}: "resolve" that could put a
 *  row back into `open` is not a resolution, it is an edit box over a money table. */
export const DISPUTE_RESOLUTION_STATUSES = DISPUTE_STATUSES.filter(
  (status) => !(OPEN_DISPUTE_STATUSES as readonly string[]).includes(status),
);

/**
 * `POST <api>/disputes/:gatewayId/resolve` — record how a dispute ENDED.
 *
 * The one thing this console could not do, and the reason the dispute alarm was permanently red
 * on a real install: Asaas publishes no lost-dispute event at all, and the driver hardcodes
 * `outcome: 'won'` when it closes one — so a dispute that was LOST stays `open` in
 * `billing_disputes` forever. `listDisputesDueWithin` counts past-deadline rows on purpose, so
 * the check stays red, and a fifteen-minute cron logs the same failure until nobody reads it.
 * A gateway that never closes the loop is the NORMAL case here, not the exception.
 *
 * This does not fight, accept or refund anything — nothing here talks to a gateway. It records
 * an outcome that has already happened somewhere else, with the status, the outcome and WHO said
 * so, which is the difference between a resolution and an edit box.
 *
 * Body: `{ status, outcome?, note? }`. `status` must be a finished one
 * ({@link DISPUTE_RESOLUTION_STATUSES}); `outcome` defaults to it.
 */
export async function resolveDispute(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const gatewayId = req.params.gatewayId;
  if (gatewayId === undefined || gatewayId === '') {
    return badRequest('A dispute gateway id is required.');
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
    status?: unknown;
    outcome?: unknown;
    note?: unknown;
  };
  const status = typeof body.status === 'string' ? body.status : '';
  if (!DISPUTE_RESOLUTION_STATUSES.includes(status as (typeof DISPUTE_STATUSES)[number])) {
    return badRequest(
      `\`status\` must be one of ${DISPUTE_RESOLUTION_STATUSES.map((s) => `"${s}"`).join(', ')} — a dispute is only resolved by ending.`,
    );
  }
  if (body.outcome !== undefined && body.outcome !== null && typeof body.outcome !== 'string') {
    return badRequest('`outcome` must be a string when given.');
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return badRequest('`note` must be a string when given.');
  }
  const outcome = typeof body.outcome === 'string' && body.outcome !== '' ? body.outcome : status;
  const note = typeof body.note === 'string' && body.note !== '' ? body.note : null;

  const existing = await deps.store.findDisputeByGatewayId(gatewayId);
  if (existing === null) {
    return notFound(`No dispute "${gatewayId}" is recorded locally.`);
  }
  const dispute = readDisputeRow(existing);

  const now = (deps.now ?? (() => new Date()))();
  // `saveDispute` leaves absent fields alone, so the deadline and the reason the OPENING event
  // carried survive this write — which is the whole point of that rule.
  await deps.store.saveDispute({
    gatewayId,
    paymentGatewayId: dispute.paymentGatewayId,
    provider: dispute.provider,
    status,
    outcome,
    closedAt: now,
  });

  // WHO closed it. The row itself records the outcome; only this records the person, and on a
  // gateway that publishes no closing event a human IS the entire provenance of that outcome.
  const audit = await deps.store.recordAuditEvent({
    action: AUDIT_ACTIONS.disputeResolved,
    ...(deps.actor !== undefined ? { actor: deps.actor } : {}),
    provider: dispute.provider,
    subjectType: 'dispute',
    subjectId: gatewayId,
    ...(dispute.amount !== null ? { amount: dispute.amount } : {}),
    ...(dispute.currency !== null ? { currency: dispute.currency } : {}),
    message: note,
    metadata: {
      status,
      outcome,
      previousStatus: dispute.status,
      paymentGatewayId: dispute.paymentGatewayId,
    },
    createdAt: now,
  });

  return ok({
    dispute: {
      gatewayId,
      paymentGatewayId: dispute.paymentGatewayId,
      provider: dispute.provider,
      status,
      outcome,
      closedAt: now.toISOString(),
    },
    /** `null` on an install whose `billing_audit_events` table is not there yet — the dispute
     *  still closed, and saying so beats pretending the note was filed. */
    audit: audit === null ? null : auditJson(audit),
    note: 'Recorded locally. Nothing was sent to the gateway — this closes the row a gateway that publishes no lost-dispute event would otherwise leave open forever.',
  });
}

/**
 * Read the fields a resolution needs off whatever row the store returned.
 *
 * `findDisputeByGatewayId` hands back the IMPLEMENTATION's row (a Lucid model in one store, a
 * plain object in the other), not the normalized `DisputeListItem` the lists get — the same
 * situation, and the same defensive read, as {@link readPaymentRow}. `amount` goes through
 * `Number` because Postgres hands a `bigint` back as a string.
 */
function readDisputeRow(row: unknown): {
  paymentGatewayId: string;
  provider: string;
  status: string;
  amount: number | null;
  currency: string | null;
} {
  const r = row as {
    paymentGatewayId?: unknown;
    provider?: unknown;
    status?: unknown;
    amount?: unknown;
    currency?: unknown;
  };
  return {
    paymentGatewayId: String(r.paymentGatewayId ?? ''),
    provider: String(r.provider ?? ''),
    status: String(r.status ?? ''),
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    currency: typeof r.currency === 'string' ? r.currency : null,
  };
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
    case 'ok': {
      // WHO refunded WHAT. The only record of a console refund used to be a diagnostic carrying
      // a gateway id, a provider and an amount — and no actor at all, even though `enforce()`
      // had already verified exactly who authorised the request. The payment row will not carry
      // it either: the gateway's webhook moves that row and it names no person. Partial refunds
      // make it sharper still, now that several of them can land on one payment.
      const audit = await deps.store.recordAuditEvent({
        action: AUDIT_ACTIONS.refund,
        ...(deps.actor !== undefined ? { actor: deps.actor } : {}),
        provider: payment.provider,
        subjectType: 'payment',
        subjectId: gatewayId,
        // What was ASKED for, in the payment's own currency — `amount` absent means the whole
        // charge, and recording the figure rather than a null is what makes a partial legible.
        amount: amount ?? payment.amount,
        currency: payment.currency,
        metadata: {
          partial: amount !== undefined,
          paymentAmount: payment.amount,
          refundGatewayId: outcome.refund.gatewayId,
          refundStatus: outcome.refund.status,
        },
      });
      return ok({
        refund: outcome.refund,
        payment: {
          gatewayId,
          provider: payment.provider,
          amount: payment.amount,
          currency: payment.currency,
        },
        /** `null` when this install has no `billing_audit_events` table yet. The refund still
         *  happened — failing it because the note could not be filed would be strictly worse. */
        audit: audit === null ? null : auditJson(audit),
        // The row still says `paid` until the gateway's webhook lands. Say so, rather than
        // letting the operator read the unchanged list as a failed refund.
        note: 'The payment row updates when the gateway’s refund webhook arrives.',
      });
    }
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
