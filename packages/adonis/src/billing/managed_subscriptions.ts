import type { CreateSubscriptionInput, PaymentsDriver } from '../driver.js';
import type { BillingStore, ManagedSubscriptionInput } from './billing_store.js';

/** The cycles a managed subscription can advance by. Mirrors `CreateSubscriptionInput.cycle`. */
export type ManagedCycle =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUALLY'
  | 'YEARLY';

/** Whole months per cycle, for the cycles measured in months. */
const MONTHS_PER_CYCLE: Partial<Record<ManagedCycle, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUALLY: 6,
  YEARLY: 12,
};

/** Days per cycle, for the cycles measured in days. */
const DAYS_PER_CYCLE: Partial<Record<ManagedCycle, number>> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
};

/**
 * The end of the period that starts at `from`.
 *
 * Month arithmetic clamps to the last day of the target month rather than rolling over:
 * naive `setMonth` turns 31 January into 3 March, and a subscription that starts on the 31st
 * would drift a day or two forward every short month until it no longer resembles the date
 * the customer agreed to. Clamping keeps 31 January → 28 February → 31 March.
 */
export function advancePeriod(from: Date, cycle: string): Date {
  const days = DAYS_PER_CYCLE[cycle as ManagedCycle];
  if (days !== undefined) {
    const next = new Date(from.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  const months = MONTHS_PER_CYCLE[cycle as ManagedCycle] ?? 1;
  const day = from.getUTCDate();
  // Day 1 first, so the intermediate value cannot overflow the target month while we set it.
  const next = new Date(from.getTime());
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDayOfTarget = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, lastDayOfTarget));
  return next;
}

/**
 * The idempotency key for one cycle's charge.
 *
 * Keyed by subscription AND period start, so a renewal pass that runs twice — a retried
 * worker, an overlapping cron, an operator running the command by hand after one looked
 * stuck — asks the gateway for the same charge rather than a second one. This is the only
 * thing standing between a duplicated tick and a double debit.
 */
export function cycleIdempotencyKey(subscriptionId: string, periodStart: Date): string {
  return `sub:${subscriptionId}:${periodStart.toISOString().slice(0, 10)}`;
}

/** What a managed subscription needs at creation. */
export interface CreateManagedInput extends CreateSubscriptionInput {
  currency?: string;
}

/** A created managed subscription and the charge that opened its first period. */
export interface ManagedSubscriptionResult {
  id: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  /** The first cycle's charge, so the caller can show a Pix QR code or a link immediately. */
  charge: Awaited<ReturnType<PaymentsDriver['charge']>>;
}

/**
 * Create a subscription this library owns.
 *
 * The gateway is never asked for a subscription — only for a charge, which every gateway can
 * do. That is the whole point: cancelling becomes "stop issuing charges" and re-pricing
 * becomes "the next one is a different number", both local writes, on gateways whose
 * subscription API cannot do either (Woovi/OpenPix) or has no subscription API at all.
 *
 * The first cycle is charged immediately and synchronously. A subscription whose first charge
 * silently failed is worse than one that failed to start: the app would have a row saying
 * `active` and no money behind it.
 */
export async function createManagedSubscription(
  driver: PaymentsDriver,
  store: BillingStore,
  input: CreateManagedInput,
): Promise<ManagedSubscriptionResult> {
  const amount = input.amount ?? 0;
  const cycle = input.cycle ?? 'MONTHLY';
  const currency = input.currency ?? 'brl';
  const periodStart = input.startDate ? new Date(input.startDate) : new Date();
  const periodEnd = advancePeriod(periodStart, cycle);

  const row = await store.createManagedSubscription({
    provider: driver.provider,
    customerId: input.customerId,
    status: 'active',
    planId: input.planId,
    amount,
    currency,
    cycle,
    method: input.method ?? null,
    description: input.description ?? null,
    externalReference: input.externalReference ?? null,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    // The next cycle is due when this one ends.
    nextChargeAt: periodEnd,
    payload: {},
  } satisfies ManagedSubscriptionInput);

  const charge = await chargeCycle(driver, {
    id: row.id,
    amount,
    customerId: input.customerId,
    description: input.description ?? null,
    externalReference: input.externalReference ?? null,
    method: input.method ?? null,
    periodStart,
    card: input.card,
  });

  return {
    id: row.id,
    status: 'active',
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    charge,
  };
}

/** One cycle's charge. Shared by creation and renewal so both carry the same reference. */
async function chargeCycle(
  driver: PaymentsDriver,
  cycle: {
    id: string;
    amount: number;
    customerId: string;
    description: string | null;
    externalReference: string | null;
    method: string | null;
    periodStart: Date;
    card?: CreateSubscriptionInput['card'];
  },
): Promise<Awaited<ReturnType<PaymentsDriver['charge']>>> {
  return driver.charge({
    customerId: cycle.customerId,
    amount: cycle.amount,
    idempotencyKey: cycleIdempotencyKey(cycle.id, cycle.periodStart),
    // The app's own reference, on EVERY cycle. This is what makes a renewal route through
    // the ordinary webhook path — no per-gateway lookup, because the charge says who it is
    // for in the same field a one-off does.
    ...(cycle.externalReference !== null ? { externalReference: cycle.externalReference } : {}),
    ...(cycle.description !== null ? { description: cycle.description } : {}),
    ...(cycle.method !== null ? { method: cycle.method } : {}),
    ...(cycle.card !== undefined ? { card: cycle.card } : {}),
  });
}

/** What one renewal pass did. */
export interface RenewalOutcome {
  subscriptionId: string;
  /** `charged` advanced the period; `ended` stopped a subscription asked to cancel. */
  result: 'charged' | 'ended' | 'failed';
  error?: string;
}

/**
 * Charge every managed subscription whose cycle is due, and advance its period.
 *
 * A failed charge does NOT advance the period and does not stop the pass: the subscription
 * stays due and is retried next tick, and one gateway hiccup cannot skip a customer's month
 * or abort everyone else's renewal. Repeated failure is a dunning policy the application
 * owns — this reports, it does not cancel anyone.
 */
export async function renewDueManagedSubscriptions(
  resolveDriver: (provider: string) => PaymentsDriver,
  store: BillingStore,
  options: { now?: Date; limit?: number } = {},
): Promise<RenewalOutcome[]> {
  const now = options.now ?? new Date();
  const due = await store.listDueManagedSubscriptions(now, options.limit ?? 100);
  const outcomes: RenewalOutcome[] = [];

  for (const row of due as unknown as ManagedRow[]) {
    // Asked to cancel at period end: the period just ended, so stop here. Checked BEFORE
    // charging — the whole promise of "cancel at period end" is that no further money moves.
    if (row.cancelAtPeriodEnd === true) {
      await store.updateManagedSubscription(row.id, {
        status: 'canceled',
        nextChargeAt: null,
        endsAt: now,
      });
      outcomes.push({ subscriptionId: row.id, result: 'ended' });
      continue;
    }

    const periodStart = toDate(row.currentPeriodEnd) ?? now;
    const periodEnd = advancePeriod(periodStart, row.cycle ?? 'MONTHLY');

    try {
      await chargeCycle(resolveDriver(row.provider), {
        id: row.id,
        amount: row.amount ?? 0,
        customerId: row.customerId,
        description: row.description ?? null,
        externalReference: row.externalReference ?? null,
        method: row.method ?? null,
        periodStart,
      });
    } catch (error) {
      // Period untouched on purpose: it stays due and is retried, rather than silently
      // rolling forward a month the customer never paid for.
      outcomes.push({
        subscriptionId: row.id,
        result: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    await store.updateManagedSubscription(row.id, {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextChargeAt: periodEnd,
    });
    outcomes.push({ subscriptionId: row.id, result: 'charged' });
  }

  return outcomes;
}

/**
 * Cancel a managed subscription.
 *
 * `atPeriodEnd` keeps the access the customer already paid for and stops the next charge;
 * immediate ends it now. Neither calls the gateway — there is nothing there to call, which
 * is exactly why this works on Woovi.
 */
export async function cancelManagedSubscription(
  store: BillingStore,
  id: string,
  options: { atPeriodEnd?: boolean; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  if (options.atPeriodEnd === true) {
    await store.updateManagedSubscription(id, { cancelAtPeriodEnd: true });
    return;
  }
  await store.updateManagedSubscription(id, {
    status: 'canceled',
    nextChargeAt: null,
    endsAt: now,
  });
}

/**
 * Undo a cancel-at-period-end, putting the subscription back on renewal.
 *
 * The counterpart of `cancel({ atPeriodEnd: true })`, and the reason that flag is a flag
 * rather than a terminal state: an application that offers "you can change your mind until
 * the period ends" needs a way to act on that. Without this the only route back was creating
 * a second subscription, which charges again for a period already paid.
 *
 * Refuses a subscription that is already over. `cancelAtPeriodEnd` is a decision that can be
 * reversed; a `canceled` one has stopped, and quietly restarting it would put a customer back
 * on a recurring debit they finished — the reverse of the mistake this method exists to fix.
 */
export async function resumeManagedSubscription(store: BillingStore, id: string): Promise<void> {
  const row = (await store.findSubscriptionById(id)) as { status?: string } | null;
  if (row === null) throw new Error(`[payments] No subscription ${id}.`);
  if (row.status !== 'active') {
    throw new Error(
      `[payments] Subscription ${id} is "${row.status}", not active — only a subscription still ` +
        'running can have a scheduled cancellation undone. Create a new one instead.',
    );
  }
  await store.updateManagedSubscription(id, { cancelAtPeriodEnd: false });
}

/**
 * Re-price or re-describe a managed subscription.
 *
 * Takes effect on the NEXT cycle — the current one is already paid, and silently re-charging
 * the difference is a decision the application makes, not this function. No proration here on
 * purpose: guessing it wrong moves money nobody authorized.
 */
export async function updateManagedSubscription(
  store: BillingStore,
  id: string,
  patch: { amount?: number; description?: string | null; cycle?: string },
): Promise<void> {
  await store.updateManagedSubscription(id, patch);
}

/** The subset of a stored row this module reads, whatever the store implementation is. */
interface ManagedRow {
  id: string;
  provider: string;
  customerId: string;
  amount?: number | null;
  cycle?: string | null;
  method?: string | null;
  description?: string | null;
  externalReference?: string | null;
  currentPeriodEnd?: Date | { toJSDate(): Date } | null;
  cancelAtPeriodEnd?: boolean | null;
}

/** Lucid hands back a Luxon `DateTime`; the in-memory store a `Date`. Accept both. */
function toDate(value: Date | { toJSDate(): Date } | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : value.toJSDate();
}
