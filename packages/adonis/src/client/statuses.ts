import type { BillingStatus } from '../types.js';

/**
 * The payment statuses the client endpoint can report, in the order a payment moves
 * through them.
 *
 * This is the canonical {@link BillingStatus} union restated as a VALUE, because the
 * browser half of this feature (`@adonis-agora/payments-react`) needs the same set at
 * runtime and cannot import a server package to get it. `test/client/status_parity.spec.ts`
 * asserts the two lists are still the same list.
 */
export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'refunded',
  'canceled',
  'disputed',
] as const satisfies readonly BillingStatus[];

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * `true` only while {@link PAYMENT_STATUSES} lists every member of {@link BillingStatus}.
 *
 * `as const satisfies readonly BillingStatus[]` above proves each listed status is real; it
 * cannot prove none is MISSING. A status added to `BillingStatus` and forgotten here would
 * reach a consumer's exhaustive `switch` as a string outside the union — so the omission is
 * made a compile error instead.
 */
export type PaymentStatusesAreExhaustive = [Exclude<BillingStatus, PaymentStatus>] extends [never]
  ? true
  : never;

/** Exported so the assertion above is a real reference rather than dead code. */
export const PAYMENT_STATUSES_ARE_EXHAUSTIVE: PaymentStatusesAreExhaustive = true;

/**
 * The statuses a payment does not move out of — where the browser stops asking.
 *
 * `pending` and `authorized` are deliberately absent: a Pix that has not been paid is
 * `pending`, and authorized card money is held, not captured. Both can still change.
 */
export const TERMINAL_PAYMENT_STATUSES = [
  'paid',
  'failed',
  'refunded',
  'canceled',
  'disputed',
] as const satisfies readonly BillingStatus[];

export type TerminalPaymentStatus = (typeof TERMINAL_PAYMENT_STATUSES)[number];

/**
 * Whether a status is terminal. Takes a plain `string` on purpose: the store's `status`
 * column is a free string (a gateway may write its own), so an unrecognized value must
 * answer "not terminal" rather than fail a narrowing.
 */
export function isTerminalPaymentStatus(status: string): status is TerminalPaymentStatus {
  return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(status);
}
