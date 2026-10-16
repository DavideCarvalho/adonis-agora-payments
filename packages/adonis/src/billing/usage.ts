import type { BillingStore, UsageScope } from './billing_store.js';
import { advancePeriodBy, toDate } from './managed_subscriptions.js';

/**
 * The slice of a store the usage helpers read. Row types are `unknown` so the Lucid store and
 * `InMemoryBillingStore` both satisfy it — the subscription row is read structurally below.
 */
export type UsageStore = Pick<
  BillingStore<unknown, unknown, unknown, unknown, unknown, unknown>,
  'recordUsage' | 'usageReport' | 'findSubscriptionById' | 'findSubscriptionByGatewayId'
>;

/**
 * The window usage is summed over.
 *
 * - `{ from, to }` — explicit. Either end may be omitted; both omitted means all time.
 * - `{ subscription, at }` — the billing cycle of that subscription that contains `at`
 *   (default: now). `subscription` is the local row id, or the gateway id as a fallback. It is
 *   ONLY the source of the window, not a filter: a project's usage is summed over the owner's
 *   cycle without having to carry the owner's subscription id.
 */
export type UsagePeriod = { from?: Date; to?: Date } | { subscription: string; at?: Date };

/** What to sum. Every filter is exact and they combine — see {@link BillingStore.usageReport}. */
export interface UsageQuery {
  meter: string;
  scope?: UsageScope;
  subscriptionId?: string;
  customerId?: string;
  /** Omit for all time. */
  period?: UsagePeriod;
}

/** A meter's consumption against a limit, over a resolved window. */
export interface UsageAllowance {
  meter: string;
  used: number;
  limit: number;
  /** `limit - used`, never below zero. */
  remaining: number;
  /** Whether `used` went PAST the limit. Reaching it exactly is not exceeding it. */
  exceeded: boolean;
  /** The window that was summed — `null` on an open end. */
  from: Date | null;
  to: Date | null;
}

/** The subset of a subscription row the window is derived from, whatever the store. */
interface PeriodSourceRow {
  cycle?: string | null;
  currentPeriodStart?: Date | { toJSDate(): Date } | null;
  currentPeriodEnd?: Date | { toJSDate(): Date } | null;
  createdAt?: Date | { toJSDate(): Date } | null;
}

/**
 * The billing cycle of a subscription row that contains `at`.
 *
 * In order of preference:
 *
 * 1. The stored `currentPeriodStart`/`currentPeriodEnd`, when `at` falls inside them — what a
 *    managed subscription's renewal pass keeps current.
 * 2. Stepped by `cycle` from `currentPeriodStart`, or from `createdAt` when there is no stored
 *    period. This is what makes a FREE plan work: nothing renews a row no gateway backs, so its
 *    stored period goes stale after the first cycle, while its anchor and cycle stay true. For a
 *    gateway-owned row it is an approximation — the gateway may anchor the cycle differently —
 *    and an app that needs the gateway's exact window should pass `{ from, to }`.
 * 3. The stored period as-is, when there is no cycle to step by.
 *
 * Throws when the row carries none of it: guessing a window would let a quota silently reset
 * on the wrong day.
 */
export function usagePeriodFor(
  row: PeriodSourceRow,
  at: Date = new Date(),
): { from: Date; to: Date } {
  const start = toDate(row.currentPeriodStart);
  const end = toDate(row.currentPeriodEnd);
  if (start !== null && end !== null && start <= at && at < end) return { from: start, to: end };

  const anchor = start ?? toDate(row.createdAt);
  const cycle = row.cycle ?? null;
  if (anchor !== null && cycle !== null) {
    // Anchored arithmetic (see `advancePeriodBy`), so a cycle starting on the 31st does not
    // drift. A rough estimate first, then corrected by a step or two either way — never a walk
    // from the anchor, which would be thousands of iterations for a weekly plan years old.
    if (at < anchor) return { from: anchor, to: advancePeriodBy(anchor, cycle, 1) };
    const roughLength = advancePeriodBy(anchor, cycle, 1).getTime() - anchor.getTime();
    let n = Math.max(0, Math.floor((at.getTime() - anchor.getTime()) / roughLength));
    while (n > 0 && advancePeriodBy(anchor, cycle, n) > at) n--;
    while (advancePeriodBy(anchor, cycle, n + 1) <= at) n++;
    return { from: advancePeriodBy(anchor, cycle, n), to: advancePeriodBy(anchor, cycle, n + 1) };
  }

  if (start !== null && end !== null) return { from: start, to: end };

  throw new Error(
    '[payments] Cannot derive a usage period from this subscription: it has no `cycle` and no ' +
      'stored current period. Pass `period: { from, to }` instead.',
  );
}

async function resolvePeriod(
  store: UsageStore,
  period: UsagePeriod | undefined,
): Promise<{ from: Date | null; to: Date | null }> {
  if (period === undefined) return { from: null, to: null };
  if (!('subscription' in period)) return { from: period.from ?? null, to: period.to ?? null };

  const row =
    (await store.findSubscriptionById(period.subscription)) ??
    (await store.findSubscriptionByGatewayId(period.subscription));
  if (row === null || row === undefined) {
    throw new Error(
      `[payments] No subscription ${period.subscription} to derive a usage period from.`,
    );
  }
  return usagePeriodFor(row as PeriodSourceRow, period.at ?? new Date());
}

/**
 * How much of one meter was consumed, optionally per scope and over a billing cycle.
 *
 * ```ts
 * const used = await usageTotal(store, {
 *   meter: 'ai_chat',
 *   scope: { type: 'project', id: project.id },
 *   period: { subscription: ownerSubscription.id },
 * })
 * ```
 *
 * In an application, `payments.usage().total(...)` is the same call with the store resolved.
 */
export async function usageTotal(store: UsageStore, query: UsageQuery): Promise<number> {
  const window = await resolvePeriod(store, query.period);
  return sumMeter(store, query, window);
}

/**
 * How much of one meter is left under `limit`, over the same window {@link usageTotal} sums.
 *
 * The limit is the app's: plans and their quotas are product logic and live in the app's own
 * catalog, not in this library.
 */
export async function usageRemaining(
  store: UsageStore,
  query: UsageQuery & { limit: number },
): Promise<UsageAllowance> {
  const window = await resolvePeriod(store, query.period);
  const used = await sumMeter(store, query, window);
  return {
    meter: query.meter,
    used,
    limit: query.limit,
    remaining: Math.max(0, query.limit - used),
    exceeded: used > query.limit,
    from: window.from,
    to: window.to,
  };
}

async function sumMeter(
  store: UsageStore,
  query: UsageQuery,
  window: { from: Date | null; to: Date | null },
): Promise<number> {
  const lines = await store.usageReport({
    meter: query.meter,
    ...(query.scope !== undefined ? { scope: query.scope } : {}),
    ...(query.subscriptionId !== undefined ? { subscriptionId: query.subscriptionId } : {}),
    ...(query.customerId !== undefined ? { customerId: query.customerId } : {}),
    ...(window.from !== null ? { from: window.from } : {}),
    ...(window.to !== null ? { to: window.to } : {}),
  });
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * The usage helpers with the store already resolved — what `payments.usage()` returns.
 */
export interface UsageApi {
  /** Record one event. Same input as {@link BillingStore.recordUsage}. */
  record(event: Parameters<UsageStore['recordUsage']>[0]): Promise<void>;
  total(query: UsageQuery): Promise<number>;
  remaining(query: UsageQuery & { limit: number }): Promise<UsageAllowance>;
  /** The billing cycle {@link UsagePeriod} `{ subscription, at }` resolves to. */
  period(subscription: string, at?: Date): Promise<{ from: Date; to: Date }>;
}

/** Bind the usage helpers to a (lazily resolved) store. */
export function createUsageApi(store: () => UsageStore): UsageApi {
  return {
    async record(event) {
      await store().recordUsage(event);
    },
    // `async`, so a missing store surfaces as a rejection like every other failure here
    // rather than a synchronous throw from a method that returns a promise.
    total: async (query) => usageTotal(store(), query),
    remaining: async (query) => usageRemaining(store(), query),
    async period(subscription, at) {
      const window = await resolvePeriod(store(), {
        subscription,
        ...(at !== undefined ? { at } : {}),
      });
      return window as { from: Date; to: Date };
    },
  };
}
