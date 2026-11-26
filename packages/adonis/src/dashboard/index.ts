// The federated console: other apps' own payments, shown here and operated through them (`apps`).

export type { AuthkitClientLike, CryptoRuntimeLike } from '../federation/auto_auth.js';
export { CONSOLE_AUTH_DOCS, ConsoleAuthConfigError } from '../federation/auto_auth.js';
export type {
  ConsoleCommandsOption,
  FederatedAppInfo,
  FederatedCallMeta,
  FederatedControlPlane,
  FederatedPaymentsAction,
  FederatedPaymentsAppConfig,
  OwningAppRuntime,
  PaymentsConsoleProfile,
} from '../federation/console.js';
export {
  answerPaymentsConsoleCommands,
  CAPABILITIES_REQUIRED,
  CONSOLE_CAPABILITIES,
  CONSOLE_READ_CAPABILITY,
  CONSOLE_WRITE_CAPABILITY,
  consoleCommandKeys,
  consoleTokenAllows,
  consoleViewerAllows,
  FEDERATED_ACTIONS,
  FEDERATED_READS,
  FederatedPaymentsConsole,
  LOCAL_ACTIONS,
  PAYMENTS_CONSOLE_CAPABILITIES,
  paymentsConsoleCommandHandler,
  viewerConsoleCapabilities,
  viewerLocalActions,
  viewerLocalRefusal,
} from '../federation/console.js';
export type { OkpJwk } from '../federation/console_key.js';
export type { ConsoleIdempotencyStore, IdempotencyState } from '../federation/idempotency.js';
export { memoryIdempotencyStore, redisIdempotencyStore } from '../federation/idempotency.js';
export type {
  ChannelSecret,
  ConsoleChannelAuthOptions,
  ConsoleCipher,
  ConsoleCipherSource,
  ConsoleCryptoOption,
} from '../federation/redis_channel.js';
export {
  CONSOLE_CRYPTO_KEY,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../federation/redis_channel.js';
export {
  capabilityAllows,
  federatedSafe,
  maskDocument,
  readOnlyBillingStore,
} from '../federation/safety.js';
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
  ConsoleAccess,
  ConsoleAuthorize,
  ConsoleAuthorizeDecision,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from './console_authorize.js';
export {
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console_authorize.js';
// The console-capability matcher shared (by copy) with every Agora console.
export type { ConsoleCapabilityKind, ConsoleCapabilityTable } from './console_capabilities.js';
export { consoleCapabilityAllows, consoleCapabilityKind } from './console_capabilities.js';
export type { ConsoleApps, ConsoleTenants } from './console_scope.js';
// The console shell's data-block fields: who is signed in, and how to sign out.
export type {
  ConsoleSignOut,
  ConsoleViewer,
  SignOutOption,
  ViewerHook,
} from './console_shell.js';
export { resolveSignOut, resolveViewer, viewerFromUser } from './console_shell.js';
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
export type { InjectedConfig, ShellFields, SwitcherConfig } from './spa.js';
export {
  BASE_PLACEHOLDER,
  CONFIG_ELEMENT_ID,
  CONTENT_TYPES,
  contentTypeFor,
  renderIndexHtml,
} from './spa.js';
export type { ConsoleTenantScope } from './tenant_scope.js';
export { resolveConsoleTenantScope } from './tenant_scope.js';
