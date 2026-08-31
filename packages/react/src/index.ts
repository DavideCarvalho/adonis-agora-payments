/**
 * `@adonis-agora/payments-react` — the browser half of `@adonis-agora/payments`.
 *
 * One hook, for the one thing every app that takes Pix has to write by hand: waiting for a
 * charge that is not paid until the gateway's webhook says it is.
 *
 * It deliberately does NOT wrap any gateway's card SDK. Stripe, Mercado Pago and Adyen each
 * ship their own React SDK, maintained by people who ship the API alongside it; replicating
 * that for eighteen gateways is a surface this package could not keep honest.
 */

export type { PaymentStatus, TerminalPaymentStatus } from './statuses.js';
export {
  isPaymentStatus,
  isTerminalPaymentStatus,
  PAYMENT_STATUSES,
  TERMINAL_PAYMENT_STATUSES,
} from './statuses.js';
export type {
  PaymentStatusSnapshot,
  UsePaymentStatusOptions,
  UsePaymentStatusResult,
} from './use_payment_status.js';
export { usePaymentStatus } from './use_payment_status.js';
