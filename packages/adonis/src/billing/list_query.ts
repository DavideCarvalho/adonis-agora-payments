/**
 * Shared paging bounds for {@link import('./billing_store.js').BillingListQuery}.
 *
 * Every {@link import('./billing_store.js').BillingStore} implementation imports these rather
 * than picking its own numbers: a page size that differs between the Lucid store and the
 * in-memory one turns "it works in the tests" into a claim about the wrong store.
 *
 * The `{ page, size }` shape — 1-based `page`, `size` rows per page — intentionally MIRRORS
 * `@adonis-agora/filter`'s `FilterInput.page`/`.size` and its `ResolvedPagination`, so every
 * `@adonis-agora/*` library pages the same way and one console can page another's list without
 * a translation layer. Structural match only: this package does NOT depend on
 * `@adonis-agora/filter`, exactly like the rest of the ecosystem's optional integrations.
 *
 * The 0-based SQL offset is an implementation detail computed here ({@link listOffset}) and
 * never appears in a public type.
 */

/** Rows returned when the caller asks for no particular page size. */
export const BILLING_LIST_DEFAULT_SIZE = 50;

/** Hard ceiling — an unbounded `size` from a query string must not be able to select the table. */
export const BILLING_LIST_MAX_SIZE = 200;

/** Clamp a requested page size into `1..BILLING_LIST_MAX_SIZE`, defaulting when absent/invalid. */
export function clampSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return BILLING_LIST_DEFAULT_SIZE;
  const floored = Math.floor(size);
  if (floored < 1) return BILLING_LIST_DEFAULT_SIZE;
  return Math.min(floored, BILLING_LIST_MAX_SIZE);
}

/** Clamp a requested page number to a 1-based integer, defaulting to the first page. */
export function clampPage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return 1;
  return Math.max(1, Math.floor(page));
}

/**
 * The 0-based SQL offset a clamped `page`/`size` pair selects.
 *
 * Internal on purpose: the public query shape speaks pages, and a store that also accepted a raw
 * offset would let two callers disagree about which row page 2 starts at.
 */
export function listOffset(page: number | undefined, size: number | undefined): number {
  return (clampPage(page) - 1) * clampSize(size);
}
