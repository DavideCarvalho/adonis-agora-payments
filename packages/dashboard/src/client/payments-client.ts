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

/** The app-side owner of a payment, resolved through `billing_customers`. */
export interface PaymentOwner {
  /** `'users'`, or whatever the app passed to `ensureCustomer`. */
  type: string | null;
  /** The app's own row id for that owner. */
  id: string | null;
  name: string | null;
  email: string | null;
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
  /**
   * The APP's own id for this charge — its order number, its enrolment id.
   *
   * The only field on this row the app itself chose, and therefore the only one that can answer
   * "did THIS student's payment land?". `null` when the gateway echoed none back.
   */
  externalReference: string | null;
  /** INTEGER MINOR UNITS already refunded; `null` on a row older than the column. Net is
   *  `amount - refundedAmount` — NEVER divide here. */
  refundedAmount: number | null;
  /** Who this payment belongs to in the APP, or `null` when nothing mapped the gateway customer. */
  owner: PaymentOwner | null;
  paidAt: string | null;
  createdAt: string | null;
  /** Whether the server will accept a refund for this row (only a `paid` payment). Taken from the
   *  server rather than re-derived, so the button and the endpoint can never disagree. */
  refundable: boolean;
}

/** One `billing_customers` row — the mapping that ties a gateway customer to an app user. */
export interface CustomerRow {
  id: string;
  /** The GATEWAY's customer id (`cus_…`) — what a payment row carries. */
  gatewayId: string;
  provider: string;
  ownerType: string | null;
  ownerId: string | null;
  email: string | null;
  name: string | null;
  taxId: string | null;
  createdAt: string | null;
}

/** One audit row — who did what, and when. `actor: null` means unattributed, not "the system". */
export interface AuditRow {
  id: string;
  /** `payment.refunded` | `dispute.resolved` | `webhook.rejected`. */
  action: string;
  actor: string | null;
  provider: string | null;
  subjectType: string | null;
  subjectId: string | null;
  /** INTEGER MINOR UNITS, or `null`. */
  amount: number | null;
  currency: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
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
  /** `true` quando a recorrência é da biblioteca — não há assinatura no gateway. */
  managed: boolean;
  amount: number | null;
  currency: string | null;
  cycle: string | null;
  currentPeriodEnd: string | null;
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  lastRenewalError: string | null;
  lastRenewalAttemptAt: string | null;
  renewalFailureCount: number;
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

/**
 * One `billing_disputes` row — a chargeback or a pre-chargeback alert.
 *
 * Three fields here are nullable for reasons that are NOT "missing data", and the screen has to
 * render each one as the thing it means:
 *
 * - `amount`: a Stripe early fraud warning names no money at all. Not zero — absent.
 * - `currency`: same row, same reason.
 * - `evidenceDueBy`: the gateway sent no deadline. Never "no hurry" — several gateways send none,
 *   and Woovi's three-day rule is policy rather than a field.
 */
export interface DisputeRow {
  id: string;
  /** The DISPUTE's own gateway id — what you search for in the gateway's dashboard. */
  gatewayId: string;
  /** The disputed payment's gateway id — the join back to the payments screen. */
  paymentGatewayId: string;
  provider: string;
  /** A `DisputeStatus`: warning | open | under_review | won | lost | canceled | expired. */
  status: string;
  /** The gateway's own reason code, verbatim — the vocabulary is per-network. */
  reason: string | null;
  /** INTEGER MINOR UNITS, or `null` when the gateway named no money. NEVER divide here. */
  amount: number | null;
  currency: string | null;
  /** When evidence must be submitted by, or `null` when the gateway sent none. */
  evidenceDueBy: string | null;
  outcome: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
}

/** One `billingHealth()` check. Every one is a "should be zero" check, so `count > 0` IS the alarm. */
export interface HealthCheck {
  key:
    | 'stuck_webhooks'
    | 'failed_webhooks'
    | 'unconfirmed_payments'
    | 'disputes_due'
    | 'open_disputes'
    | 'rejected_deliveries'
    | 'overdue_renewals'
    | 'failing_renewals';
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
  /** WHICH windows are closing, soonest first — a count names no gateway dashboard to open.
   *  Capped by the server; `disputes_due.count` is the real number. */
  deadlines: DisputeRow[];
  /** The unanswered disputes, OLDEST first, deadline or not. On a gateway that publishes no
   *  deadline this is the only one of the two lists that is ever non-empty. */
  openDisputes: DisputeRow[];
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
  /** The lookup filters the server applied, echoed back so an empty page can say "no payment
   *  carries reference X" instead of the much less useful "no payments". */
  filters: {
    reference: string | null;
    gatewayId: string | null;
    customerId: string | null;
  };
}

/**
 * Everything this system knows about ONE payment.
 *
 * Deliberately not called a history. `billing_payments` is a single mutable row upserted in
 * place, so what changed and when is not recorded anywhere; this assembles what IS knowable —
 * the current state, the owner, the disputes filed against it, the ledger rows whose delivery
 * names it, and who refunded it from this console.
 */
export interface PaymentDetail {
  payment: PaymentRow;
  disputes: DisputeRow[];
  events: {
    rows: WebhookEventRow[];
    /** How the ledger rows were found. `payload-substring` means an unindexed substring scan
     *  over the stored payload — it can miss, and it can over-match. Say so on screen. */
    matchedBy: string;
  };
  audit: AuditRow[];
  currency: string;
}

export interface AuditPage {
  audit: AuditRow[];
  page: { limit: number; offset: number; count: number };
  /** The actions the filter offers. A UI list, not a whitelist — an app may record its own. */
  actions: readonly string[];
}

export interface CustomersPage {
  customers: CustomerRow[];
  /** Narrower than {@link Page}: every filter here is a column the store applies, so there is
   *  no bounded scan and therefore no `scanned`/`truncated` caveat to report. */
  page: { limit: number; offset: number; count: number };
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
  counts: { past_due: number; failing_renewals: number };
}

/**
 * A page of disputes.
 *
 * `page` is NARROWER than {@link Page} on purpose: the store filters disputes by provider on a
 * column, so there is no bounded scan behind this list and therefore no `scanned`/`truncated` to
 * report. Claiming those here would be claiming a caveat that does not apply.
 *
 * `dueWithin` is present only in work-list mode (`?dueWithin=<hours>`). Its `total` is a SEPARATE,
 * unbounded count: a full page says nothing about how many more windows are closing, and that is
 * the number an operator plans the day around.
 */
export interface DisputesPage {
  disputes: DisputeRow[];
  page: { limit: number; offset: number; count: number };
  statuses: readonly string[];
  dueWithin?: { hours: number; total: number };
}

/** The gateways this install actually has data for — the provider filter is built from this, never
 *  from a hardcoded list of the eighteen drivers the package ships. */
export interface ProvidersList {
  providers: string[];
  /** The event types this install has actually RECEIVED, for the ledger's type filter. Same
   *  reason as `providers`: a filter offering types that return nothing hides the ones that do. */
  eventTypes: string[];
  /**
   * O que cada gateway sabe fazer, por nome. `{}` quando não foi possível perguntar ao
   * manager — a UI trata ausência como "mostra a ação", que é o comportamento anterior.
   */
  capabilities: Record<string, ProviderCapabilities>;
}

/** O que um gateway suporta, para o console não oferecer botão que sempre falha. */
export interface ProviderCapabilities {
  refunds: boolean;
  disputes: boolean;
  cancelSubscription: boolean;
}

export interface RefundResult {
  refund: { gatewayId: string; amount: number; currency: string; status: string };
  payment: { gatewayId: string; provider: string; amount: number; currency: string };
  /** The trail entry recording WHO refunded this. `null` on an install whose audit table is not
   *  there yet — the refund still happened, and saying so beats pretending it was filed. */
  audit: AuditRow | null;
  note: string;
}

export interface ResolveDisputeResult {
  dispute: {
    gatewayId: string;
    paymentGatewayId: string;
    provider: string;
    status: string;
    outcome: string;
    closedAt: string;
  };
  audit: AuditRow | null;
  note: string;
}

export interface RetryResult {
  gatewayEventId: string;
  status: 'processed';
}

declare global {
  interface Window {
    /** UI mount base (e.g. `/payments-dashboard`). Test/escape-hatch override; see {@link readConfig}. */
    __PAYMENTS_BASE__?: string;
    /** JSON API base (e.g. `/payments-dashboard/api`). */
    __PAYMENTS_API__?: string;
    /** ISO 4217 display currency (`config.currency`). */
    __PAYMENTS_CURRENCY__?: string;
    /** The `dashboardAuth` surface(s), or `null` when the deployment has none. */
    __PAYMENTS_AUTH__?: { modes: string[] } | null;
  }
}

/** `id` of the JSON data block the provider injects into `index.html` (`spa.ts`'s `CONFIG_ELEMENT_ID`). */
export const CONFIG_ELEMENT_ID = 'payments-dashboard-config';

interface InjectedConfig {
  base?: unknown;
  api?: unknown;
  currency?: unknown;
  auth?: unknown;
}

/**
 * The deployment config the provider handed this page.
 *
 * It arrives as a `<script type="application/json">` DATA block, not as globals set by an inline
 * script. The difference is the whole bug it fixes: a host Content-Security-Policy of
 * `script-src 'self' 'nonce-…'` (shield's `@nonce`) refuses an un-nonced inline script without a
 * word, so the globals were never set, every URL below fell back to the default mount, and a
 * console that had rendered perfectly answered 404 to all of its own requests. A data block is
 * never executed, so no policy can refuse it.
 *
 * The `window.__PAYMENTS_*__` globals are still honoured, AFTER the block, so a test or a host
 * embedding the bundle by hand can set them — but they are no longer how the provider speaks.
 */
function readConfig(): InjectedConfig {
  if (typeof document === 'undefined') return {};
  const element = document.getElementById(CONFIG_ELEMENT_ID);
  if (element === null) return {};
  try {
    const parsed: unknown = JSON.parse(element.textContent ?? '');
    return typeof parsed === 'object' && parsed !== null ? (parsed as InjectedConfig) : {};
  } catch {
    return {};
  }
}

export function uiBase(): string {
  // Checked with `typeof ... === 'string'` (not a truthy check): the provider sends `''` for a
  // root-mounted dashboard (`path: ''`), which is a deliberate, valid base — a truthy check would
  // silently fall through to the default instead of honoring it.
  const injected = readConfig().base;
  if (typeof injected === 'string') return injected;
  if (typeof window !== 'undefined' && typeof window.__PAYMENTS_BASE__ === 'string') {
    return window.__PAYMENTS_BASE__;
  }
  return '/payments-dashboard';
}

export function apiBase(): string {
  const injected = readConfig().api;
  if (typeof injected === 'string') return injected;
  if (typeof window !== 'undefined' && typeof window.__PAYMENTS_API__ === 'string') {
    return window.__PAYMENTS_API__;
  }
  return `${uiBase()}/api`;
}

/** The display currency the server was configured with; `'BRL'` when the page was not injected. */
export function displayCurrency(): string {
  const injected = readConfig().currency;
  if (typeof injected === 'string') return injected;
  if (typeof window !== 'undefined' && typeof window.__PAYMENTS_CURRENCY__ === 'string') {
    return window.__PAYMENTS_CURRENCY__;
  }
  return 'BRL';
}

/**
 * The auth surface the page was served with — `null` when this deployment configures no
 * `dashboardAuth`. Only a deployment with one has a session to end: the provider registers
 * `GET <path>/logout` ONLY alongside `dashboardAuth`, so a Sign out link on any other deployment
 * points at a 404. A page with no config at all reads as "none" too, which errs towards hiding a
 * link rather than showing a broken one.
 */
export function authSurface(): { modes: string[] } | null {
  const config = readConfig();
  const candidate =
    'auth' in config
      ? config.auth
      : typeof window !== 'undefined'
        ? window.__PAYMENTS_AUTH__
        : undefined;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const modes = (candidate as { modes?: unknown }).modes;
  if (!Array.isArray(modes)) return null;
  return { modes: modes.filter((m): m is string => typeof m === 'string') };
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

/**
 * The host app's CSRF token, when it sets one.
 *
 * `@adonisjs/shield` guards every state-changing route of the app this console is mounted
 * in, and it publishes the token as an `XSRF-TOKEN` cookie for exactly this: a browser
 * client echoes it back in `x-xsrf-token`. Without it the two POST actions below are
 * rejected before they reach the dashboard's own authorization, and the refund button does
 * nothing for a reason no message explains.
 *
 * Absent cookie → no header, which is the right answer for a host that does not use shield:
 * sending an empty token would be worse than sending none.
 */
function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie);
  const token = match?.[1];
  if (!token) return {};
  return { 'x-xsrf-token': decodeURIComponent(token) };
}

/** A JSON `POST` — the two actions. Kept separate from `http` so no read can ever reach it by
 *  accident, and so the body/`content-type` are stated in exactly one place. */
async function post<T>(path: string, body?: unknown): Promise<T> {
  return http<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...csrfHeader() },
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

/** {@link ListOptions} plus the three EXACT lookups only payments have. */
export interface PaymentListOptions extends ListOptions {
  /** The APP's own reference for the charge — an order number, an enrolment id. Exact match. */
  reference?: string | undefined;
  /** The gateway's payment id. Exact match. */
  gatewayId?: string | undefined;
  /** The gateway's customer id — every payment recorded for one customer. Exact match. */
  customerId?: string | undefined;
}

/** {@link ListOptions} plus the ledger's own filter: which EVENT TYPE. */
export interface WebhookEventListOptions extends ListOptions {
  type?: string | undefined;
}

/** The customers screen's filters. `ownerType` + `ownerId` is the key; an id alone is not. */
export interface AuditListOptions {
  action?: string | undefined;
  actor?: string | undefined;
  provider?: string | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface CustomerListOptions {
  provider?: string | undefined;
  ownerType?: string | undefined;
  ownerId?: string | undefined;
  gatewayId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** {@link ListOptions} plus the one filter only disputes have: a deadline horizon in HOURS. */
export interface DisputeListOptions extends ListOptions {
  /**
   * Ask for the WORK LIST instead of the log: only open disputes carrying a deadline inside this
   * many hours, soonest first. A row already past its deadline is still in it — it is still open
   * and still unanswered.
   */
  dueWithin?: number | undefined;
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
  payments(opts: PaymentListOptions = {}): Promise<PaymentsPage> {
    return http<PaymentsPage>(
      `/payments${buildQuery({
        status: opts.status,
        provider: opts.provider,
        reference: opts.reference,
        gatewayId: opts.gatewayId,
        customerId: opts.customerId,
        limit: opts.limit,
        offset: opts.offset,
      })}`,
    );
  },
  /** Everything knowable about ONE payment — see {@link PaymentDetail}. */
  payment(gatewayId: string): Promise<PaymentDetail> {
    return http<PaymentDetail>(`/payments/${encodeURIComponent(gatewayId)}`);
  },
  customers(opts: CustomerListOptions = {}): Promise<CustomersPage> {
    return http<CustomersPage>(
      `/customers${buildQuery({
        provider: opts.provider,
        ownerType: opts.ownerType,
        ownerId: opts.ownerId,
        gatewayId: opts.gatewayId,
        limit: opts.limit,
        offset: opts.offset,
      })}`,
    );
  },
  /**
   * The audit trail — refunds issued here, disputes resolved here, and the deliveries this
   * endpoint REFUSED. The last kind exists nowhere else: a rejected delivery never becomes a
   * ledger row, so a rotated webhook secret is otherwise indistinguishable from a quiet week.
   */
  audit(opts: AuditListOptions = {}): Promise<AuditPage> {
    return http<AuditPage>(
      `/audit${buildQuery({
        action: opts.action,
        actor: opts.actor,
        provider: opts.provider,
        subjectType: opts.subjectType,
        subjectId: opts.subjectId,
        limit: opts.limit,
        offset: opts.offset,
      })}`,
    );
  },
  subscriptions(opts: ListOptions = {}): Promise<SubscriptionsPage> {
    return http<SubscriptionsPage>(`/subscriptions${listQuery(opts)}`);
  },
  webhookEvents(opts: WebhookEventListOptions = {}): Promise<WebhookEventsPage> {
    return http<WebhookEventsPage>(
      `/webhook-events${buildQuery({
        status: opts.status,
        provider: opts.provider,
        type: opts.type,
        limit: opts.limit,
        offset: opts.offset,
      })}`,
    );
  },
  /**
   * A page of disputes — the LOG by default, the work list when `dueWithin` (in hours) is given.
   *
   * `status` is dropped in work-list mode rather than passed along. The server's work list is
   * already scoped to the open statuses that carry a deadline, so a status sent alongside
   * `dueWithin` is silently ignored — and a filter that appears to apply and does not is worse
   * than no filter at all.
   */
  disputes(opts: DisputeListOptions = {}): Promise<DisputesPage> {
    const workList = opts.dueWithin !== undefined;
    return http<DisputesPage>(
      `/disputes${buildQuery({
        status: workList ? undefined : opts.status,
        provider: opts.provider,
        dueWithin: opts.dueWithin,
        limit: opts.limit,
        offset: opts.offset,
      })}`,
    );
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
  /**
   * Record how a dispute ENDED. Sends nothing to the gateway.
   *
   * The loop most gateways never close: Asaas publishes no lost-dispute event at all, so a
   * dispute that was lost sits `open` forever and the health check stays red until nobody
   * reads it. `status` must be a finished one (`lost` | `won` | `expired` | `canceled`).
   */
  resolveDispute(
    gatewayId: string,
    input: { status: string; outcome?: string; note?: string },
  ): Promise<ResolveDisputeResult> {
    return post<ResolveDisputeResult>(`/disputes/${encodeURIComponent(gatewayId)}/resolve`, input);
  },
};
