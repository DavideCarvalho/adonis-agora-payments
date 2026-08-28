/**
 * API client for the `@adonis-agora/payments` dashboard SPA. Talks JSON over `fetch` to the routes
 * mounted by `packages/adonis/providers/dashboard_provider.ts` (default base `/payments-dashboard`,
 * JSON API at `<base>/api`).
 *
 * Mirrors `@adonis-agora/durable-dashboard`'s `durable-client.ts`: the same injected-globals base
 * resolution, the same `http()` helper and the same 401 → auth-surface redirect.
 *
 * Reads are `GET`; the two things that CHANGE something — refunding a payment and retrying a failed
 * webhook event — are `POST`, and are the only calls in this file that are not idempotent.
 *
 * MONEY: every amount here is INTEGER MINOR UNITS, exactly as stored. Nothing in this file divides;
 * the divisor is not always 100 either (`src/app/money.ts` knows the rule and formats at render).
 */

// ── Wire types (every `Date` is already an ISO string by the time it reaches this client — see
// `packages/adonis/src/dashboard/handlers.ts`). ─────────────────────────────────────────────────

/** One aggregate line of the billing overview (`billingOverview`'s `BillingOverviewMetric`). */
export interface OverviewMetric {
  key: string;
  label: string;
  value: number;
}

/** The named windows the period selector offers, matching the server's `PERIOD_PRESETS`. */
export type PeriodPreset = '24h' | '7d' | '30d' | '90d';

export interface Overview {
  period: { from: string; to: string; preset: PeriodPreset | 'custom' };
  /** ISO 4217 code the server was configured with — what `formatCents` should render in. */
  currency: string;
  metrics: OverviewMetric[];
}

export interface PaymentRow {
  id: string;
  gatewayId: string;
  provider: string;
  status: string;
  /** INTEGER CENTS. */
  amount: number;
  /** The currency the PAYMENT was taken in, which may differ from the console's display currency. */
  currency: string;
  customerId: string | null;
  subscriptionId: string | null;
  paidAt: string | null;
  createdAt: string | null;
  /** Whether the server will accept a refund for this row (only a `paid` payment). Taken from the
   *  server rather than re-derived, so the button and the endpoint can never disagree. */
  refundable: boolean;
}

/** One `billing_subscriptions` row. `paused` is NOT a flavour of `active`: the subscriber is not
 *  paying and must not be entitled. */
export interface SubscriptionRow {
  id: string;
  gatewayId: string;
  provider: string;
  status: string;
  planId: string;
  customerId: string | null;
  trialEndsAt: string | null;
  endsAt: string | null;
  createdAt: string | null;
}

export interface WebhookEventRow {
  id: string;
  gatewayEventId: string;
  provider: string;
  type: string;
  status: string;
  /** The handler's failure message when `status === 'failed'` — the only record of why. */
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Only a `failed` row can be retried — the ledger refuses to re-claim anything else. */
  retryable: boolean;
}

/** One `billingHealth()` check. Every one is a "should be zero" check, so `count > 0` IS the alarm. */
export interface HealthCheck {
  key: 'stuck_webhooks' | 'failed_webhooks' | 'unconfirmed_payments';
  label: string;
  count: number;
  healthy: boolean;
  /** What a non-zero count means and what to do about it. */
  hint: string;
}

/** Which provider/event pairs make up the failed-events count, worst first. */
export interface HealthFailure {
  provider: string;
  type: string;
  count: number;
}

export interface Health {
  healthy: boolean;
  checkedAt: string;
  checks: HealthCheck[];
  failures: HealthFailure[];
}

/** Echoed paging. `count === limit` is the ONLY "there might be more" signal: the server never
 *  counts the full match set, so there is no total to compare against. */
export interface Page {
  limit: number;
  offset: number;
  count: number;
  /** How many rows the server read to build this page. Equal to `count` unless a provider filter
   *  made it scan past non-matching rows. */
  scanned: number;
  /** `true` when the provider scan stopped at its cap before filling the page — "none found" here
   *  means "none in the rows scanned", which is a different answer and has to look like one. */
  truncated: boolean;
}

export interface PaymentsPage {
  payments: PaymentRow[];
  page: Page;
  statuses: readonly string[];
  currency: string;
}

export interface WebhookEventsPage {
  events: WebhookEventRow[];
  page: Page;
  statuses: readonly string[];
}

export interface SubscriptionsPage {
  subscriptions: SubscriptionRow[];
  page: Page;
  statuses: readonly string[];
  /** Whole-table counts, not page counts — `past_due` is the figure that decides the morning. */
  counts: { past_due: number };
}

/** The gateways this install actually has data for — the provider filter is built from this, never
 *  from a hardcoded list of the eighteen drivers the package ships. */
export interface ProvidersList {
  providers: string[];
}

export interface RefundResult {
  refund: { gatewayId: string; amount: number; currency: string; status: string };
  payment: { gatewayId: string; provider: string; amount: number; currency: string };
  note: string;
}

export interface RetryResult {
  gatewayEventId: string;
  status: 'processed';
}

declare global {
  interface Window {
    /** UI mount base (e.g. `/payments-dashboard`) injected by the provider. */
    __PAYMENTS_BASE__?: string;
    /** JSON API base (e.g. `/payments-dashboard/api`) injected by the provider. */
    __PAYMENTS_API__?: string;
    /** ISO 4217 display currency injected by the provider (`config.currency`). */
    __PAYMENTS_CURRENCY__?: string;
  }
}

export function uiBase(): string {
  // Checked with `typeof ... === 'string'` (not a truthy check): the provider injects `''` for a
  // root-mounted dashboard (`path: ''`), which is a deliberate, valid base — a truthy check would
  // silently fall through to the default instead of honoring it.
  if (typeof window !== 'undefined' && typeof window.__PAYMENTS_BASE__ === 'string') {
    return window.__PAYMENTS_BASE__;
  }
  return '/payments-dashboard';
}

export function apiBase(): string {
  if (typeof window !== 'undefined' && typeof window.__PAYMENTS_API__ === 'string') {
    return window.__PAYMENTS_API__;
  }
  return `${uiBase()}/api`;
}

/** The display currency the server was configured with; `'BRL'` when the page was not injected. */
export function displayCurrency(): string {
  if (typeof window !== 'undefined' && typeof window.__PAYMENTS_CURRENCY__ === 'string') {
    return window.__PAYMENTS_CURRENCY__;
  }
  return 'BRL';
}

/** Best-effort read of an `{ error: 'unauthorized', auth: { modes } }` 401 body. */
async function readAuthModes(res: Response): Promise<string[] | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || !('auth' in body)) return undefined;
    const auth = (body as { auth?: unknown }).auth;
    if (typeof auth !== 'object' || auth === null || !('modes' in auth)) return undefined;
    const modes = (auth as { modes?: unknown }).modes;
    return Array.isArray(modes)
      ? modes.filter((m): m is string => typeof m === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

function redirectToAuthSurface(modes: readonly string[] | undefined): void {
  if (typeof window === 'undefined') return;
  const base = uiBase();
  if (modes?.includes('login')) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${base}/login?returnTo=${returnTo}`;
    return;
  }
  window.location.href = base;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + path, init);
  if (res.status === 401) {
    redirectToAuthSurface(await readAuthModes(res));
    throw new Error('Session expired; redirecting to sign-in.');
  }
  if (res.status === 503) {
    // The billing layer (or the payments manager) is off in this deployment. A generic "500" would
    // send an operator hunting for a bug; the server's own message names the actual cause.
    throw new Error(await readError(res, 'The billing layer is disabled in this deployment.'));
  }
  if (!res.ok) {
    // The server's `{ error }` beats `502 Bad Gateway` every time: when a refund is refused, THAT
    // sentence is the gateway's own reason, and it is the only thing the operator can act on.
    throw new Error(await readError(res, `${res.status} ${res.statusText}`));
  }
  return (await res.json()) as T;
}

/** A JSON `POST` — the two actions. Kept separate from `http` so no read can ever reach it by
 *  accident, and so the body/`content-type` are stated in exactly one place. */
async function post<T>(path: string, body?: unknown): Promise<T> {
  return http<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/** Read `{ error }` off a failed response, falling back to `fallback` for an unreadable body. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === 'string' && error !== '') return error;
    }
  } catch {
    // fall through
  }
  return fallback;
}

/** Build a query string, skipping empty/absent values so `?status=` never reaches the server. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    q.set(key, String(value));
  }
  const qs = q.toString();
  return qs === '' ? '' : `?${qs}`;
}

export interface ListOptions {
  status?: string | undefined;
  /** Gateway name (`'stripe'`, `'asaas'`, …). Comes from `providers()`, never from a fixed list. */
  provider?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** The query every list endpoint takes, built once so the three screens cannot drift apart. */
function listQuery(opts: ListOptions): string {
  return buildQuery({
    status: opts.status,
    provider: opts.provider,
    limit: opts.limit,
    offset: opts.offset,
  });
}

export const paymentsClient = {
  health(): Promise<Health> {
    return http<Health>('/health');
  },
  overview(period?: PeriodPreset): Promise<Overview> {
    return http<Overview>(`/overview${buildQuery({ period })}`);
  },
  providers(): Promise<ProvidersList> {
    return http<ProvidersList>('/providers');
  },
  payments(opts: ListOptions = {}): Promise<PaymentsPage> {
    return http<PaymentsPage>(`/payments${listQuery(opts)}`);
  },
  subscriptions(opts: ListOptions = {}): Promise<SubscriptionsPage> {
    return http<SubscriptionsPage>(`/subscriptions${listQuery(opts)}`);
  },
  webhookEvents(opts: ListOptions = {}): Promise<WebhookEventsPage> {
    return http<WebhookEventsPage>(`/webhook-events${listQuery(opts)}`);
  },

  // ── Actions. `POST` only — see the note on `post()`. ──────────────────────────────────────────

  /** Refund a payment at its gateway. `amount` is INTEGER MINOR UNITS; omit it for the full amount. */
  refundPayment(gatewayId: string, amount?: number): Promise<RefundResult> {
    return post<RefundResult>(
      `/payments/${encodeURIComponent(gatewayId)}/refund`,
      amount === undefined ? {} : { amount },
    );
  },
  /** Re-run a failed webhook event's handlers. Safe to repeat: the ledger refuses to re-claim an
   *  event that is in flight or already processed. */
  retryWebhookEvent(gatewayEventId: string): Promise<RetryResult> {
    return post<RetryResult>(`/webhook-events/${encodeURIComponent(gatewayEventId)}/retry`);
  },
};
