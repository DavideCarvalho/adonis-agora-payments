import { formatCents, formatCount } from './money';

/**
 * The dispute clock — pure, because the one thing this screen must never get wrong is which
 * windows are about to shut, and that has to be testable without rendering anything or waiting.
 *
 * Everything here takes an explicit `now` so the boundaries (a window that closes in five hours; a
 * window that closed yesterday) are asserted against a fixed instant rather than against whenever
 * the test suite happened to run.
 */

const HOUR = 3_600_000;

/**
 * The horizon `?dueWithin` uses when it is asked for closing windows but named none — and the same
 * one `payments:health`/`billingHealth` alerts on. The console and the cron have to agree about
 * "soon", or the panel disagrees with the pager duty it is supposed to explain.
 */
export const DEFAULT_DUE_WITHIN_HOURS = 72;

/** The horizons the work list offers. `72h` is the default because the cron uses it. */
export const HORIZONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: '24h' },
  { hours: DEFAULT_DUE_WITHIN_HOURS, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

/** How a deadline reads right now. `unknown` is NOT a flavour of `later`: see {@link deadlineTone}. */
export type DeadlineTone = 'past' | 'urgent' | 'soon' | 'later' | 'unknown';

/** Fractional, signed hours from `now` until `iso`. Negative once it has passed; `null` when there
 *  is no usable date at all. */
export function hoursUntil(iso: string | null, now: Date = new Date()): number | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (date.getTime() - now.getTime()) / HOUR;
}

/**
 * Which of the five things a deadline is.
 *
 * - `past` — the window shut and the dispute is still unanswered. It stays on the screen: going
 *   quiet the moment it expires reads as "resolved", and it is the opposite of resolved.
 * - `urgent` — inside 24 h. Whatever evidence exists has to be filed today.
 * - `soon` — inside the cron's horizon, so this row is one of the ones `payments:health` counts.
 * - `later` — a real deadline, further out.
 * - `unknown` — the gateway sent NO deadline. Deliberately its own tone rather than being folded
 *   into `later`: "we were told nothing" and "there is time" are different facts, and only one of
 *   them is safe to act on.
 */
export function deadlineTone(iso: string | null, now: Date = new Date()): DeadlineTone {
  const hours = hoursUntil(iso, now);
  if (hours === null) return 'unknown';
  if (hours <= 0) return 'past';
  if (hours <= 24) return 'urgent';
  if (hours <= DEFAULT_DUE_WITHIN_HOURS) return 'soon';
  return 'later';
}

/**
 * How long is left, in the coarsest unit that still tells the operator what to do: `in 5 hours`,
 * `in 2 days`, `6 hours ago`. `null` when there is no deadline.
 *
 * Hours, not just days — `formatDaysUntil` would render a window closing in five hours as "today",
 * and the difference between "today" and "five hours" is the difference between filing this
 * morning and losing the money by default.
 *
 * Always rounds DOWN, in both directions: a window with 5.9 hours left says five, never six. The
 * error a countdown is allowed to make is understating the time left, never overstating it.
 */
export function formatCountdown(iso: string | null, now: Date = new Date()): string | null {
  const hours = hoursUntil(iso, now);
  if (hours === null) return null;
  const magnitude = Math.abs(hours);
  let phrase: string;
  if (magnitude < 1) {
    const minutes = Math.floor(magnitude * 60);
    phrase = minutes <= 1 ? '1 minute' : `${minutes} minutes`;
  } else if (magnitude < 48) {
    const whole = Math.floor(magnitude);
    phrase = whole === 1 ? '1 hour' : `${whole} hours`;
  } else {
    const days = Math.floor(magnitude / 24);
    phrase = days === 1 ? '1 day' : `${days} days`;
  }
  return hours <= 0 ? `${phrase} ago` : `in ${phrase}`;
}

/**
 * What the deadline cell says when there is no deadline.
 *
 * An em-dash here would read as a bug — an empty cell where a date should be. It is not missing
 * data: several gateways genuinely send no deadline (and Woovi's three-day rule is policy, not a
 * field), so the cell says which of the two it is.
 */
export const NO_DEADLINE = 'gateway sends no deadline';

/** `72` → `3 days`, `24` → `24h` — the horizon named the way the picker names it. */
export function horizonLabel(hours: number): string {
  return HORIZONS.find((horizon) => horizon.hours === hours)?.label ?? `${hours}h`;
}

/**
 * The disputed amount, or the sentence for a dispute that names no money.
 *
 * `null` is not zero: a Stripe early fraud warning carries no amount at all, and `R$ 0,00` would
 * claim the network is disputing nothing. `currency` can be absent on the same row, in which case
 * the console's display currency is the best available guess and is used only to FORMAT — the
 * integer that came over the wire is untouched.
 */
export function disputeAmountLabel(
  amount: number | null,
  currency: string | null,
  displayCurrency: string,
): string {
  if (amount === null) return 'no amount';
  return formatCents(amount, currency ?? displayCurrency);
}

/** The work list's one-line summary. `total` is the server's unbounded count, not the page. */
export function workListSubtitle(total: number | undefined, hours: number): string {
  const horizon = horizonLabel(hours);
  if (total === undefined || total === 0) {
    return `No evidence window closes within ${horizon}. Anything already past its deadline would still be here.`;
  }
  const noun = total === 1 ? 'window' : 'windows';
  return `${formatCount(total)} evidence ${noun} closing within ${horizon}, soonest first — past-due ones included. Miss one and the dispute is lost by default, not on the merits.`;
}

/** What an empty work list says. Names the horizon, and says past-due rows would be here too —
 *  otherwise "nothing due" could be read as "nothing overdue either" without justification. */
export function workListEmptyMessage(hours: number): string {
  return `No evidence window closes within ${horizonLabel(hours)}, and nothing is past due and unanswered.`;
}

/** What an empty dispute LOG says, in the same shape the other screens use. */
export function logEmptyMessage(status: string | undefined, provider: string | undefined): string {
  if (status === undefined && provider === undefined) {
    return 'No disputes recorded. Nothing has been charged back.';
  }
  const parts = [
    status !== undefined ? `status “${status}”` : undefined,
    provider !== undefined ? `gateway “${provider}”` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `No disputes with ${parts.join(' and ')}.`;
}
