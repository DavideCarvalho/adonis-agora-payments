/**
 * The browser-facing half of `@adonis-agora/payments`: one polled, opt-in endpoint that
 * answers "has this payment settled yet" for a caller proven to own it.
 *
 * Mounted by `@adonis-agora/payments/payments_client_provider` from
 * `config/payments_client.ts`. The React hook that polls it lives in
 * `@adonis-agora/payments-react`.
 */

export { defineConfig, resolveConfig } from './define_config.js';
export {
  defaultAuthorize,
  defaultOwner,
  registryReferenceGuard,
  resolveRequestUser,
} from './define_config.js';
export type {
  ClientAuthorizeHook,
  ClientAuthorizeReferenceHook,
  ClientOwnerHook,
  ClientPayment,
  ClientResolveReferenceHook,
  PaymentOwner,
  PaymentsClientConfig,
  ReferenceDenied,
  ReferenceGuard,
  ReferenceGuardRequest,
  ReferenceOutcome,
  ResolvedPaymentsClientConfig,
} from './define_config.js';

export { normalizePayment, paymentStatus } from './handlers.js';
export type { ClientApiResponse, PaymentStatusBody, PaymentStatusDeps } from './handlers.js';

export {
  PAYMENT_STATUSES,
  PAYMENT_STATUSES_ARE_EXHAUSTIVE,
  TERMINAL_PAYMENT_STATUSES,
  isTerminalPaymentStatus,
} from './statuses.js';
export type {
  PaymentStatus,
  PaymentStatusesAreExhaustive,
  TerminalPaymentStatus,
} from './statuses.js';
