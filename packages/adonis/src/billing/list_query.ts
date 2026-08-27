/**
 * Shared paging bounds for {@link import('./billing_store.js').BillingListQuery}.
 *
 * Every {@link import('./billing_store.js').BillingStore} implementation imports these rather
 * than picking its own numbers: a page size that differs between the Lucid store and the
 * in-memory one turns "it works in the tests" into a claim about the wrong store.
 */

/** Rows returned when the caller asks for no particular page size. */
export const BILLING_LIST_DEFAULT_LIMIT = 50;

/** Hard ceiling — an unbounded `limit` from a query string must not be able to select the table. */
export const BILLING_LIST_MAX_LIMIT = 200;

/** Clamp a requested page size into `1..BILLING_LIST_MAX_LIMIT`, defaulting when absent/invalid. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return BILLING_LIST_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return BILLING_LIST_DEFAULT_LIMIT;
  return Math.min(floored, BILLING_LIST_MAX_LIMIT);
}

/** Clamp a requested offset to a non-negative integer, defaulting to `0`. */
export function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const floored = Math.floor(offset);
  return floored < 0 ? 0 : floored;
}
