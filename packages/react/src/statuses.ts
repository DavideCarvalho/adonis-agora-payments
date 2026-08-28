/**
 * The payment statuses this hook understands.
 *
 * Mirrors `BillingStatus` from `@adonis-agora/payments` — deliberately RESTATED rather than
 * imported: this package runs in a browser and must not pull an AdonisJS server package
 * (and its Lucid/driver graph) into a bundle to name seven strings.
 *
 * The copy is not left to trust. `packages/adonis/test/client/status_parity.spec.ts` reads
 * this file and fails if the two lists ever disagree, so a status added on the server
 * cannot quietly fall out of a consumer's exhaustive `switch`.
 */
export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'refunded',
  'canceled',
  'disputed',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The statuses a payment does not move out of — where the hook stops asking.
 *
 * `pending` and `authorized` are absent on purpose: an unpaid Pix is `pending` forever until
 * someone pays it, and authorized card money is held rather than captured. Both still move.
 */
export const TERMINAL_PAYMENT_STATUSES = [
  'paid',
  'failed',
  'refunded',
  'canceled',
  'disputed',
] as const;

export type TerminalPaymentStatus = (typeof TERMINAL_PAYMENT_STATUSES)[number];

/** Whether the endpoint reported one of the statuses this hook knows. */
export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** Whether a payment has stopped moving. */
export function isTerminalPaymentStatus(status: PaymentStatus): status is TerminalPaymentStatus {
  return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(status);
}
