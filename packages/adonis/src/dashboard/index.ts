/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.2.0';

export { defineConfig, defaultAuthorize, resolveConfig } from './define_config.js';
export type {
  AuthorizeHook,
  PaymentsDashboardConfig,
  ResolvedPaymentsDashboardConfig,
} from './define_config.js';

export { overview, payments, webhookEvents, ok } from './handlers.js';
export { PAYMENT_STATUSES, WEBHOOK_EVENT_STATUSES } from './handlers.js';
export type { ApiRequest, ApiResponse, Deps } from './handlers.js';

export { resolvePeriod, PERIOD_PRESETS, DEFAULT_PERIOD } from './period.js';
export type { Period, PeriodPreset } from './period.js';

export { BASE_PLACEHOLDER, CONTENT_TYPES, contentTypeFor, renderIndexHtml } from './spa.js';

// Built-in `dashboardAuth` login screen (optional; opt-in via `config/payments_dashboard.ts`).
export {
  resolveDashboardAuth,
  performLogin,
  performSession,
  readSession,
  sanitizeReturnTo,
  SESSION_COOKIE_NAME,
} from './auth.js';
export type {
  AuthMode,
  DashboardAuthOptions,
  ResolvedDashboardAuth,
  LoginHook,
  LoginOutcome,
  SessionHook,
  SessionOutcome,
} from './auth.js';
export { signSessionCookie, verifySessionCookie } from './session_cookie.js';
export type {
  DashboardSession,
  DashboardSessionUser,
  SignOptions,
  VerifyOptions,
} from './session_cookie.js';
export { renderLoginPage } from './login_page.js';
