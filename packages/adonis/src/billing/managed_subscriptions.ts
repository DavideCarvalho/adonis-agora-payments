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
  return advancePeriodBy(from, cycle, 1);
}

/**
 * The instant `count` whole cycles after `from`, clamped the same way as {@link advancePeriod}.
 *
 * Computed from the ANCHOR in one step rather than by calling `advancePeriod` `count` times:
 * chained clamps compound — 31 January → 28 February → 28 March — while anchored arithmetic
 * keeps 31 January → 28 February → 31 March, which is the date the customer agreed to.
 */
export function advancePeriodBy(from: Date, cycle: string, count: number): Date {
  const days = DAYS_PER_CYCLE[cycle as ManagedCycle];
  if (days !== undefined) {
    const next = new Date(from.getTime());
    next.setUTCDate(next.getUTCDate() + days * count);
    return next;
  }

  const months = (MONTHS_PER_CYCLE[cycle as ManagedCycle] ?? 1) * count;
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
    // The token, not the card: what lets the NEXT cycle debit without the customer present.
    // Holder data belongs to the sale the customer is sitting in front of, and the token stands
    // in for it afterwards. Asaas still shows `remoteIp` on its token examples, and a renewal
    // has no payer IP to send: unproven against the real gateway, so test it before relying on it.
    paymentMethodId: input.card?.token ?? null,
    payload: {},
  } satisfies ManagedSubscriptionInput);

  let charge: Awaited<ReturnType<PaymentsDriver['charge']>>;
  try {
    charge = await chargeCycle(driver, {
      id: row.id,
      amount,
      customerId: input.customerId,
      description: input.description ?? null,
      externalReference: input.externalReference ?? null,
      method: input.method ?? null,
      periodStart,
      card: input.card,
    });
    if (charge.status === 'failed') {
      throw new Error('The gateway declined the charge.');
    }
  } catch (error) {
    // A row left `active` here would debit, a period from now, a customer told their card was
    // declined and who never subscribed. The row exists first because the idempotency key needs
    // its id, so it has to be closed on the way out.
    await store.updateManagedSubscription(row.id, {
      status: 'canceled',
      nextChargeAt: null,
      endsAt: new Date(),
    });
    throw error;
  }

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
    paymentMethodId?: string | null;
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
    ...(cycle.paymentMethodId ? { paymentMethodId: cycle.paymentMethodId } : {}),
  });
}

/**
 * How long a failed renewal waits before the next attempt, by consecutive failures; the last
 * entry repeats. Hourly crons are the norm here, and re-presenting a declined card every hour
 * is how a merchant gets flagged by the acquirer's antifraud.
 */
export const DEFAULT_RENEWAL_RETRY_DELAYS_HOURS = [1, 6, 24, 72] as const;

function nextRetryAt(now: Date, failureCount: number, delaysHours: readonly number[]): Date {
  const index = Math.min(failureCount - 1, delaysHours.length - 1);
  return new Date(now.getTime() + (delaysHours[index] ?? 1) * 60 * 60 * 1000);
}

/** What one renewal pass did. */
export interface RenewalOutcome {
  subscriptionId: string;
  /** `charged` advanced the period; `ended` stopped a subscription asked to cancel. */
  result: 'charged' | 'ended' | 'failed';
  error?: string;
  /** Consecutive failures so far, on a `failed` outcome: what a dunning policy decides on. */
  failureCount?: number;
  /** The app's own reference, so a dunning policy finds its row without another read. */
  externalReference?: string | null;
  /**
   * The charge a `charged` outcome created. A Pix or boleto renewal is only paid if the customer
   * sees it, and this pass runs in a cron nobody is watching: the code and the link have to reach
   * the application, which is the side that knows how to notify its customers.
   */
  charge?: Awaited<ReturnType<PaymentsDriver['charge']>>;
}

/**
 * Charge every managed subscription whose cycle is due, and advance its period.
 *
 * A failed charge does NOT advance the period and does not stop the pass: the subscription
 * is retried after `retryDelaysHours`, and one gateway hiccup cannot skip a customer's month
 * or abort everyone else's renewal. Repeated failure is a dunning policy the application
 * owns — this reports, it does not cancel anyone.
 */
export async function renewDueManagedSubscriptions(
  resolveDriver: (provider: string) => PaymentsDriver,
  store: BillingStore,
  options: { now?: Date; limit?: number; retryDelaysHours?: readonly number[] } = {},
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

    let charge: Awaited<ReturnType<PaymentsDriver['charge']>>;
    try {
      charge = await chargeCycle(resolveDriver(row.provider), {
        id: row.id,
        amount: row.amount ?? 0,
        customerId: row.customerId,
        description: row.description ?? null,
        externalReference: row.externalReference ?? null,
        method: row.method ?? null,
        periodStart,
        paymentMethodId: row.paymentMethodId ?? null,
      });
      // Some gateways answer a decline with a 200 and a failed payment. Advancing here would
      // grant a month nobody paid for.
      if (charge.status === 'failed') {
        throw new Error('The gateway declined the charge.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Period untouched on purpose: it stays due and is retried, rather than silently
      // rolling forward a month the customer never paid for.
      //
      // But the failure IS recorded, and that is the difference between "retried" and
      // "invisible": because nothing about the row changes on a failure, a subscription that
      // has been failing for a week looked exactly like one due for the first time. These
      // three fields are what the console reads to say which ones, and for how long.
      const failureCount = (row.renewalFailureCount ?? 0) + 1;
      await store.updateManagedSubscription(row.id, {
        lastRenewalError: message.slice(0, RENEWAL_ERROR_MAX_LENGTH),
        lastRenewalAttemptAt: now,
        renewalFailureCount: failureCount,
        // Only `nextChargeAt` moves. The period is what the charge is for, so the eventual
        // success still pays this cycle, under this cycle's idempotency key.
        nextChargeAt: nextRetryAt(
          now,
          failureCount,
          options.retryDelaysHours ?? DEFAULT_RENEWAL_RETRY_DELAYS_HOURS,
        ),
      });
      outcomes.push({
        subscriptionId: row.id,
        result: 'failed',
        error: message,
        failureCount,
        externalReference: row.externalReference ?? null,
      });
      continue;
    }

    await store.updateManagedSubscription(row.id, {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextChargeAt: periodEnd,
      // Zera a série: o contador mede uma SEQUÊNCIA de falhas, não um total histórico. Uma
      // assinatura que falhou três vezes em março e vem pagando desde então não é um problema.
      lastRenewalError: null,
      lastRenewalAttemptAt: now,
      renewalFailureCount: 0,
    });
    outcomes.push({
      subscriptionId: row.id,
      result: 'charged',
      charge,
      externalReference: row.externalReference ?? null,
    });
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

/**
 * Replace the saved card of a managed subscription.
 *
 * A subscription in a failure streak becomes due now: the customer just fixed the problem, and
 * making them wait out the backoff would keep them locked out for nothing. A healthy one keeps
 * its date, because changing card mid-cycle must not bring a charge forward.
 */
export async function updateManagedPaymentMethod(
  store: BillingStore,
  id: string,
  paymentMethodId: string,
  options: { now?: Date } = {},
): Promise<void> {
  const row = (await store.findSubscriptionById(id)) as unknown as ManagedRow | null;
  if (row === null) throw new Error(`[payments] No subscription ${id}.`);
  if (row.status !== 'active') {
    throw new Error(
      `[payments] Subscription ${id} is "${row.status}", not active — it has no next charge to ` +
        'put a new card on.',
    );
  }
  await store.updateManagedSubscription(id, {
    paymentMethodId,
    ...((row.renewalFailureCount ?? 0) > 0 ? { nextChargeAt: options.now ?? new Date() } : {}),
  });
}

/** `VARCHAR(500)`: a gateway error can be a paragraph, and the column is not a log. */
const RENEWAL_ERROR_MAX_LENGTH = 500;

/** The subset of a stored row this module reads, whatever the store implementation is. */
interface ManagedRow {
  id: string;
  status?: string;
  paymentMethodId?: string | null;
  provider: string;
  customerId: string;
  amount?: number | null;
  cycle?: string | null;
  method?: string | null;
  description?: string | null;
  externalReference?: string | null;
  currentPeriodEnd?: Date | { toJSDate(): Date } | null;
  cancelAtPeriodEnd?: boolean | null;
  renewalFailureCount?: number | null;
}

/** Lucid hands back a Luxon `DateTime`; the in-memory store a `Date`. Accept both. */
export function toDate(value: Date | { toJSDate(): Date } | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : value.toJSDate();
}
