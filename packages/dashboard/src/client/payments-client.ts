/**
 * API client for the `@adonis-agora/payments` dashboard SPA. Talks JSON over `fetch` to the routes
 * mounted by `packages/adonis/providers/dashboard_provider.ts` (default base `/payments-dashboard`,
 * JSON API at `<base>/api`).
 *
 * Mirrors `@adonis-agora/durable-dashboard`'s `durable-client.ts`: the same injected-globals base
 * resolution, the same `http()` helper and the same 401 → auth-surface redirect. The surface is much
 * smaller — this console has three READ endpoints and no control actions, because payments has no
 * run graph and no retry/replay.
 *
 * MONEY: every amount here is INTEGER CENTS, exactly as stored. Nothing in this file divides by 100;
 * `src/app/money.ts` formats at render.
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
}

/** Echoed paging. `count === limit` is the ONLY "there might be more" signal: the server never
 *  counts the full match set, so there is no total to compare against. */
export interface Page {
  limit: number;
  offset: number;
  count: number;
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
    // The billing layer is off in this deployment. A generic "500" would send an operator hunting
    // for a bug; the server's own message names the actual cause.
    throw new Error(await readError(res, 'The billing layer is disabled in this deployment.'));
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
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
  limit?: number | undefined;
  offset?: number | undefined;
}

export const paymentsClient = {
  overview(period?: PeriodPreset): Promise<Overview> {
    return http<Overview>(`/overview${buildQuery({ period })}`);
  },
  payments(opts: ListOptions = {}): Promise<PaymentsPage> {
    return http<PaymentsPage>(
      `/payments${buildQuery({ status: opts.status, limit: opts.limit, offset: opts.offset })}`,
    );
  },
  webhookEvents(opts: ListOptions = {}): Promise<WebhookEventsPage> {
    return http<WebhookEventsPage>(
      `/webhook-events${buildQuery({
        status: opts.status,
        limit: opts.limit,
        offset: opts.offset,
      })}`,
    );
  },
};
