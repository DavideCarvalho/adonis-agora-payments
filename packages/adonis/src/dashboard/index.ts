/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.2.0';

export type {
  AccessDeniedInfo,
  AccessDeniedPageOptions,
  AccessDeniedReason,
} from './access_denied_page.js';
// The built-in "access denied" page (what a browser sees on a refused page navigation).
export {
  CONSOLE as ACCESS_DENIED_CONSOLE,
  escapeHtml,
  renderAccessDeniedPage,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
export type {
  EvidenceAction,
  EvidenceCapableDriver,
  EvidenceOutcome,
  RefundAction,
  RefundCapableDriver,
  RefundOutcome,
  ReplayAction,
  ReplayableWebhookEvent,
  ReplayOutcome,
} from './actions.js';
// The gateway WRITE actions (refund, webhook retry, dispute evidence), as framework-light ports.
export { createEvidenceAction, createRefundAction, createReplayAction } from './actions.js';
export type {
  ConsoleActionsManager,
  ServeConsoleRouteOptions,
} from './api_core.js';
// The console's handlers as one core: the JSON API, the dev tools and the `payments:*` commands.
export {
  CONSOLE_ROUTES,
  consoleCapabilities,
  createConsoleActions,
  serveConsoleRoute,
} from './api_core.js';
// The dashboard-gate contract shared (by copy) with every @adonis-agora console.
export type {
  AuthorizeDecision,
  AuthorizeResult,
  ResolvedAuthorizeResult,
} from './authorize_decision.js';
export { resolveAuthorizeResult, runAuthorize } from './authorize_decision.js';
// The console access contract (function, class or lazy import) shared by every Agora console.
export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeDecision,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
  ConsoleTenants,
} from './console_authorize.js';
export {
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console_authorize.js';
export type {
  AgoraConsoleEntry,
  AgoraConsoleIcon,
  AgoraConsoleRegistry,
  AgoraConsoleSearchHit,
} from './console_switcher.js';
// The Agora console switcher: join it from a console the app mounts itself.
export { AGORA_CONSOLES_BINDING, registerAgoraConsole } from './console_switcher.js';
export type {
  AccessDeniedOption,
  AccessDeniedRenderer,
  AuthorizeHook,
  PaymentsDashboardConfig,
  ResolvedPaymentsDashboardConfig,
} from './define_config.js';
export { defineConfig, resolveConfig } from './define_config.js';
export type {
  DevTool,
  DevToolCall,
  DevToolInputProperty,
  DevToolInputSchema,
  DevToolsCaller,
  DevToolsDecision,
  DevToolsHub,
  DevToolsLib,
  PaymentsApiRoute,
  PaymentsDevToolsOptions,
} from './dev_tools.js';
// Developer tools for the app's dev MCP endpoint (`@adonis-agora/agent`), when it has one.
export { DEV_TOOLS_BINDING, paymentsDevTools, registerPaymentsDevTools } from './dev_tools.js';
export type {
  ApiRequest,
  ApiResponse,
  DashboardActions,
  Deps,
  ProviderCapabilities,
  SubscriptionOperations,
} from './handlers.js';
export {
  AUDIT_ACTION_FILTERS,
  auditEvents,
  cancelSubscription,
  customers,
  DISPUTE_DEFAULT_DUE_WITHIN_HOURS,
  DISPUTE_RESOLUTION_STATUSES,
  DISPUTE_STATUSES,
  disputes,
  health,
  ok,
  overview,
  PAYMENT_STATUSES,
  paymentDetail,
  payments,
  providers,
  refundPayment,
  repriceSubscription,
  resolveDispute,
  resumeSubscription,
  retryWebhookEvent,
  SUBSCRIPTION_DEFAULT_STATUS,
  SUBSCRIPTION_STATUSES,
  submitDisputeEvidence,
  subscriptionDetail,
  subscriptions,
  WEBHOOK_EVENT_STATUSES,
  webhookEvents,
} from './handlers.js';
export type { Period, PeriodPreset } from './period.js';
export { DEFAULT_PERIOD, PERIOD_PRESETS, resolvePeriod } from './period.js';
export type { InjectedConfig, SwitcherConfig } from './spa.js';
export {
  BASE_PLACEHOLDER,
  CONFIG_ELEMENT_ID,
  CONTENT_TYPES,
  contentTypeFor,
  renderIndexHtml,
} from './spa.js';
export type { ConsoleTenantScope } from './tenant_scope.js';
export { resolveConsoleTenantScope } from './tenant_scope.js';
