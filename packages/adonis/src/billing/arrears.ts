import type { BillingStore } from './billing_store.js';

/** Where a payer stands on their bills, whoever drives the recurrence. */
export interface Arrears {
  /** Whether the most recent charge failed and nothing has settled since. */
  inArrears: boolean;
  /**
   * When the CURRENT run of failures started — the `createdAt` of its oldest charge.
   *
   * Deliberately not the newest failure. A gateway's dunning retries the same bill for days
   * and each attempt is another failed row; dating the arrears from the last attempt resets
   * the clock on exactly the payer who is furthest behind, which is the opposite of what the
   * number is for.
   */
  since: Date | null;
  /** How many consecutive charges have failed. `0` when up to date. */
  failedCount: number;
  /** The last charge that settled, if any — `null` for a payer who never paid. */
  lastPaidAt: Date | null;
}

const UP_TO_DATE: Arrears = {
  inArrears: false,
  since: null,
  failedCount: 0,
  lastPaidAt: null,
};

/**
 * Is this payer behind on their bills, and since when?
 *
 * WHY THIS IS NOT ALREADY ANSWERABLE. `SubscriptionListItem` carries `renewalFailureCount`,
 * `lastRenewalError` and `lastRenewalAttemptAt` — but those are written by this library's own
 * renewal pass, which only runs for `managed` subscriptions. In `gateway` mode (the DEFAULT,
 * see {@link SubscriptionsConfig}) the gateway retries and those three stay null forever. The
 * information is there, spread across `billing_payments`; every app in gateway mode ends up
 * writing this same walk, and the subtle part — dating from the START of the failure run — is
 * the part each one gets to rediscover.
 *
 * Keyed by `externalReference` because that is the id the APP owns: the same value it set on
 * the subscription, echoed by the gateway onto every charge the subscription generates.
 *
 * ```ts
 * const status = await arrears(store, { externalReference: clinic.id })
 * if (status.inArrears && status.since) notifyOverdue(clinic, status.since)
 * ```
 *
 * Reads at most `limit` recent charges (default 50) — a failure run longer than that is a
 * subscription nobody is collecting on, and the answer ("yes, badly") does not change.
 */
export async function arrears(
  store: BillingStore,
  query: { externalReference: string; limit?: number },
): Promise<Arrears> {
  const payments = await store.listPayments({
    externalReference: query.externalReference,
    size: query.limit ?? 50,
  });
  if (payments.length === 0) return UP_TO_DATE;

  // Newest first. `listPayments` already orders by `created_at` desc, but sorting here keeps
  // the helper honest against a store implementation that does not.
  const newestFirst = [...payments].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  );

  const lastPaid = newestFirst.find((p) => p.status === 'paid') ?? null;
  const lastPaidAt = lastPaid?.paidAt ?? lastPaid?.createdAt ?? null;

  const newest = newestFirst[0];
  if (newest?.status !== 'failed') {
    return { ...UP_TO_DATE, lastPaidAt };
  }

  let oldestOfRun = newest;
  let failedCount = 1;
  for (const payment of newestFirst.slice(1)) {
    if (payment.status !== 'failed') break;
    oldestOfRun = payment;
    failedCount += 1;
  }

  return {
    inArrears: true,
    since: oldestOfRun.createdAt,
    failedCount,
    lastPaidAt,
  };
}
