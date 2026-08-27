import { billingOverview } from '../billing/billing_overview.js';
import type { BillingStore } from '../billing/billing_store.js';
import { BILLING_LIST_DEFAULT_LIMIT, clampLimit, clampOffset } from '../billing/list_query.js';
import { resolvePeriod } from './period.js';

/**
 * Framework-light JSON handlers over a {@link BillingStore}.
 *
 * Each handler takes a {@link Deps} bundle (the store the app already resolved, plus the display
 * currency) and a plain {@link ApiRequest} (a thin view of the parts of an HTTP request it needs),
 * and returns a plain {@link ApiResponse} (status + JSON body). No AdonisJS types leak in, so the
 * handlers are unit-testable against the real `InMemoryBillingStore` with no HTTP server. The
 * provider adapts an AdonisJS `HttpContext` to these shapes.
 *
 * Mirrors `@adonis-agora/durable`'s `src/dashboard/handlers.ts` convention exactly (`Deps` /
 * `ApiRequest` / `ApiResponse` / `ok`), so the two consoles' server halves read the same. The
 * surface is much smaller: payments has no run graph and no retry/replay, so there are three READ
 * endpoints and no control actions at all.
 *
 * MONEY: `amount` and `revenue` cross this boundary as integer cents, exactly as they are stored.
 * Nothing here divides by 100 — the SPA formats at render (`src/app/money.ts`).
 */

/** What the handlers need to answer a request. */
export interface Deps {
  store: BillingStore;
  /** ISO 4217 code echoed to the client so it knows how to format the cents it receives. */
  currency: string;
  /** Injectable clock (for the period presets) — defaults to the wall clock. */
  now?: () => Date;
}

/** The subset of an HTTP request the handlers read. */
export interface ApiRequest {
  /** Route params (unused today — kept so the shape matches the ecosystem's convention). */
  params: Record<string, string | undefined>;
  /** Parsed query string, e.g. `{ status: 'failed', limit: '20' }`. */
  query: Record<string, string | string[] | undefined>;
  /** Parsed JSON body (for POST actions; this console has none). */
  body?: unknown;
}

/** A plain JSON response: an HTTP status and a serializable body. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** A `200 OK` JSON response. Exported so sibling handlers share one convention. */
export const ok = (body: unknown): ApiResponse => ({ status: 200, body });

/** The statuses the payments filter offers. `status` is a free string in the store (a gateway may
 *  send its own), so this is a UI convenience list, not a validation whitelist. */
export const PAYMENT_STATUSES = ['paid', 'pending', 'failed', 'refunded', 'canceled'] as const;

/** The ledger's three statuses. `failed` is the one that means "a handler threw and the dispatcher
 *  gave up" — i.e. the event's effect never happened. */
export const WEBHOOK_EVENT_STATUSES = ['received', 'processed', 'failed'] as const;

function firstQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
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

/**
 * `GET <api>/overview` — the `billingOverview()` aggregates for a selectable window.
 *
 * Straight passthrough of the headless function this package already ships: revenue (integer
 * cents), active subscriptions (which INCLUDES `trialing` — see `countActiveSubscriptions`), and
 * one line per metered meter.
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

/** `GET <api>/payments` — a page of `billing_payments`, newest first, optional `status` filter. */
export async function payments(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const status = firstQuery(req.query.status);
  const page = pageOf(req);
  const rows = await deps.store.listPayments({
    ...(status !== undefined && status !== '' ? { status } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    payments: rows.map((row) => ({
      id: row.id,
      gatewayId: row.gatewayId,
      provider: row.provider,
      status: row.status,
      // Integer cents, as stored. The SPA formats.
      amount: row.amount,
      currency: row.currency,
      customerId: row.customerId,
      subscriptionId: row.subscriptionId,
      paidAt: iso(row.paidAt),
      createdAt: iso(row.createdAt),
    })),
    page: { ...page, count: rows.length },
    statuses: PAYMENT_STATUSES,
    currency: deps.currency,
  });
}

/**
 * `GET <api>/webhook-events` — a page of the idempotency ledger, newest first, optional `status`
 * filter.
 *
 * The `error` column is carried through verbatim: a `failed` row is the only record that a handler
 * threw, and its message is the only place the reason survives.
 */
export async function webhookEvents(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const status = firstQuery(req.query.status);
  const page = pageOf(req);
  const rows = await deps.store.listWebhookEvents({
    ...(status !== undefined && status !== '' ? { status } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    events: rows.map((row) => ({
      id: row.id,
      gatewayEventId: row.gatewayEventId,
      provider: row.provider,
      type: row.type,
      status: row.status,
      error: row.error,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })),
    page: { ...page, count: rows.length },
    statuses: WEBHOOK_EVENT_STATUSES,
  });
}

/** Re-exported so the provider and the SPA agree on the default page size without duplicating it. */
export { BILLING_LIST_DEFAULT_LIMIT };
