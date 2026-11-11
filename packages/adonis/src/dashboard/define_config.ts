import type { HttpContext } from '@adonisjs/core/http';
import type {
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import {
  type DashboardAuthOptions,
  type ResolvedDashboardAuth,
  resolveDashboardAuth,
} from './auth.js';
import type { ConsoleAuthorize, ConsoleAuthorizeResult } from './console_authorize.js';

export type { AuthorizeDecision, AuthorizeResult } from './authorize_decision.js';
export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from './console_authorize.js';

/**
 * The function form of {@link PaymentsDashboardConfig.accessDenied}: render (or answer) a refused
 * page navigation yourself. Receives the refusal ({@link AccessDeniedInfo}) and the AdonisJS
 * {@link HttpContext}. Return an HTML string to have it served; answer the request yourself (a
 * redirect, most commonly) and return nothing to make the provider stand down; return nothing
 * WITHOUT answering and the built-in page is served.
 */
export type AccessDeniedRenderer = GenericAccessDeniedRenderer<HttpContext>;

/** `accessDenied` in either form — an options object for the built-in page, or a renderer. */
export type AccessDeniedOption = GenericAccessDeniedOption<HttpContext>;

/**
 * The inline-function form of the dashboard's `authorize` option. Runs before every dashboard
 * route (API + HTML) and may be async. Answer with:
 *
 * - `true` / `{ allowed: true }` — let the request through;
 * - `{ allowed: false, reason: 'unauthenticated' }` — nobody is signed in: `401`;
 * - `{ allowed: false, reason: 'forbidden' }`, `{ allowed: false }` or `false` — `403`;
 * - `{ redirectTo: '/login' }` — a page navigation is redirected (`302`), an API call gets `401`.
 *
 * A hook that throws is a `403`. A hook that already answered the request (wrote a redirect)
 * keeps that answer. `@adonis-agora/authz`'s `authorizeByRoles` fits here as-is. The option also
 * takes an authorizer class or a lazy import of one: see {@link ConsoleAuthorize}.
 */
export type AuthorizeHook = (
  ctx: HttpContext,
) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;

/** Shape of `config/payments_dashboard.ts`. */
export interface PaymentsDashboardConfig {
  /**
   * Master switch. When `false`, the provider registers no routes at all — the
   * dashboard is completely absent. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * URL prefix the dashboard + its API mount under. Defaults to `/payments`. The HTML is
   * served at the prefix root; the JSON API lives under `<path>/api`.
   *
   * It shares that prefix with the machine endpoints — `POST /payments/webhook/:provider`
   * and `GET /payments/client/status` — and does so safely, because every route this
   * provider registers is an EXACT path (`/payments`, `/payments/assets/:file`,
   * `/payments/api/…`, login/session/logout). There is no SPA catch-all, so the dashboard's
   * `enforce` guard cannot reach a delivery it was never routed. If you ever add one, the
   * webhook route is what it would swallow, and a 403'd webhook looks exactly like a gateway
   * outage from the outside.
   */
  path?: string;
  /**
   * ISO 4217 code the SPA formats the money columns with. Cents stay integer cents on the
   * wire either way — this only decides how the edge renders them. Defaults to `'BRL'`.
   */
  currency?: string;
  /**
   * Who may open the console: an inline function, an authorizer class (built through the
   * container, so `@inject()` works), or a lazy import of one (`() => import('#policies/…')`).
   * For machine access, use `authorizeByToken({ token })`.
   *
   * Omitted: the console is open outside production and answers every request with `403` in
   * production; the provider logs a one-time warning at boot saying so.
   */
  authorize?: ConsoleAuthorize;
  /**
   * Optional built-in login screen. When set, the provider mounts a
   * server-rendered `GET <path>/login` page plus `POST <path>/login` /
   * `GET <path>/logout`, and stamps a session guard on the dashboard: an
   * unauthenticated page navigation is redirected (`302`) to the login page and
   * an unauthenticated API request gets `401`. The signed session cookie is
   * minted only by the host's {@link DashboardAuthOptions.login} hook.
   *
   * This is ADDITIVE and composes WITH {@link authorize} (both must pass) — it
   * does not replace it. Omit it entirely for no login/logout routes and no
   * session guard. Missing `secret`/`login` fails closed at boot.
   */
  dashboardAuth?: DashboardAuthOptions;
  /**
   * What a BROWSER sees when the guard refuses a page navigation (the SPA shell, its assets, or —
   * Mode A only — a session-less visit). API requests are unaffected: they keep getting the JSON
   * the SPA relies on (`403 { error: 'forbidden' }` / `401 { error: 'unauthenticated' }`, or
   * `401 { error: 'unauthorized', auth }` from the `dashboardAuth` session guard).
   *
   * Omit it for the built-in page — a dark card in the console's own visual language, with the
   * status, a sentence explaining the refusal, a "Back to app" link and, when `dashboardAuth.login`
   * exists, a "Sign in" button. Pass an object to tweak that page (`brand`, `title`, `message`,
   * `homeHref`, `loginHref`, `accent`, …), or a function to render/answer it yourself — see
   * {@link AccessDeniedRenderer}. Either way, an `authorize` hook that already wrote a redirect
   * still wins: the provider never overwrites a `location` header.
   */
  accessDenied?: AccessDeniedOption;
}

/** A fully-resolved config — every field present (defaults applied). */
export interface ResolvedPaymentsDashboardConfig {
  enabled: boolean;
  path: string;
  currency: string;
  /** The configured `authorize` as given, or `null` when omitted (open outside production, `403` in it). */
  authorize: ConsoleAuthorize | null;
  /** Resolved built-in login config, or `null` when `dashboardAuth` is unconfigured. */
  dashboardAuth: ResolvedDashboardAuth | null;
  /** The host's `accessDenied` option as given, or `null` for the built-in page with defaults. */
  accessDenied: AccessDeniedOption | null;
}

/** Apply defaults to a partial config, producing a fully-resolved one. */
export function resolveConfig(
  config: PaymentsDashboardConfig = {},
): ResolvedPaymentsDashboardConfig {
  const rawPath = config.path ?? '/payments';
  // Normalize: ensure a single leading slash and no trailing slash (root stays '/').
  const trimmed = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return {
    enabled: config.enabled ?? true,
    path: trimmed === '/' ? '' : trimmed,
    currency: config.currency ?? 'BRL',
    authorize: config.authorize ?? null,
    // Validate + resolve now so a misconfigured secret/login fails closed at boot,
    // not on the first login attempt. `null` when `dashboardAuth` is omitted.
    dashboardAuth: resolveDashboardAuth(config.dashboardAuth),
    accessDenied: config.accessDenied ?? null,
  };
}

/** Identity helper giving `config/payments_dashboard.ts` full type-checking. */
export function defineConfig(config: PaymentsDashboardConfig = {}): PaymentsDashboardConfig {
  return config;
}
