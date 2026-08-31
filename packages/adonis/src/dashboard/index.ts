/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.2.0';

export type {
  RefundAction,
  RefundCapableDriver,
  RefundOutcome,
  ReplayAction,
  ReplayableWebhookEvent,
  ReplayOutcome,
} from './actions.js';
// The two WRITE actions (refund + webhook retry), as framework-light ports.
export { createRefundAction, createReplayAction } from './actions.js';
export type {
  AuthMode,
  DashboardAuthOptions,
  LoginHook,
  LoginOutcome,
  ResolvedDashboardAuth,
  SessionHook,
  SessionOutcome,
} from './auth.js';
// Built-in `dashboardAuth` login screen (optional; opt-in via `config/payments_dashboard.ts`).
export {
  performLogin,
  performSession,
  readSession,
  resolveDashboardAuth,
  SESSION_COOKIE_NAME,
  sanitizeReturnTo,
} from './auth.js';
export type {
  AuthorizeHook,
  PaymentsDashboardConfig,
  ResolvedPaymentsDashboardConfig,
} from './define_config.js';
export { defaultAuthorize, defineConfig, resolveConfig } from './define_config.js';
export type { ApiRequest, ApiResponse, DashboardActions, Deps } from './handlers.js';
export {
  AUDIT_ACTION_FILTERS,
  auditEvents,
  customers,
  DISPUTE_DEFAULT_DUE_WITHIN_HOURS,
  DISPUTE_RESOLUTION_STATUSES,
  DISPUTE_STATUSES,
  disputes,
  health,
  ok,
  overview,
  PAYMENT_STATUSES,
  PROVIDER_SCAN_CAP,
  paymentDetail,
  payments,
  providers,
  refundPayment,
  resolveDispute,
  retryWebhookEvent,
  SUBSCRIPTION_DEFAULT_STATUS,
  SUBSCRIPTION_STATUSES,
  subscriptions,
  WEBHOOK_EVENT_STATUSES,
  webhookEvents,
} from './handlers.js';
export { renderLoginPage } from './login_page.js';
export type { Period, PeriodPreset } from './period.js';
export { DEFAULT_PERIOD, PERIOD_PRESETS, resolvePeriod } from './period.js';
export type {
  DashboardSession,
  DashboardSessionUser,
  SignOptions,
  VerifyOptions,
} from './session_cookie.js';
export { signSessionCookie, verifySessionCookie } from './session_cookie.js';
export type { InjectedAuth, InjectedConfig } from './spa.js';
export {
  BASE_PLACEHOLDER,
  CONFIG_ELEMENT_ID,
  CONTENT_TYPES,
  contentTypeFor,
  renderIndexHtml,
} from './spa.js';
