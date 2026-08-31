import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUE_WITHIN_HOURS,
  deadlineTone,
  disputeAmountLabel,
  formatCountdown,
  HORIZONS,
  horizonLabel,
  hoursUntil,
  logEmptyMessage,
  NO_DEADLINE,
  workListEmptyMessage,
  workListSubtitle,
} from './disputes';

/** A fixed instant, so every boundary below is asserted rather than observed. */
const NOW = new Date('2026-08-27T12:00:00.000Z');

/** `NOW` plus (or minus) some hours, as the ISO string the wire carries. */
function inHours(hours: number): string {
  return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

describe('hoursUntil', () => {
  it('is signed: negative once the window has shut', () => {
    expect(hoursUntil(inHours(5), NOW)).toBe(5);
    expect(hoursUntil(inHours(-5), NOW)).toBe(-5);
    expect(hoursUntil(inHours(0.5), NOW)).toBe(0.5);
  });

  it('is null for no date and for an unparseable one, never 0', () => {
    // 0 would read as "due right now", which is the single most alarming thing a clock can say.
    expect(hoursUntil(null, NOW)).toBeNull();
    expect(hoursUntil('not a date', NOW)).toBeNull();
  });
});

describe('deadlineTone', () => {
  it('calls a window that already shut past — it does not disappear and it does not read as fine', () => {
    // The store keeps it deliberately: still open, still unanswered. Going quiet the moment it
    // expires reads as resolved, which is the opposite of what happened.
    expect(deadlineTone(inHours(-1), NOW)).toBe('past');
    expect(deadlineTone(inHours(-500), NOW)).toBe('past');
    expect(deadlineTone(inHours(0), NOW)).toBe('past');
  });

  it('is urgent inside a day and soon inside the cron horizon', () => {
    expect(deadlineTone(inHours(1), NOW)).toBe('urgent');
    expect(deadlineTone(inHours(24), NOW)).toBe('urgent');
    expect(deadlineTone(inHours(25), NOW)).toBe('soon');
    expect(deadlineTone(inHours(DEFAULT_DUE_WITHIN_HOURS), NOW)).toBe('soon');
    expect(deadlineTone(inHours(DEFAULT_DUE_WITHIN_HOURS + 1), NOW)).toBe('later');
  });

  it('gives "no deadline at all" its OWN tone instead of folding it into later', () => {
    // `null` means the gateway told us nothing — several send no date, and Woovi's three-day rule
    // is policy rather than a field. "We were told nothing" and "there is time" are different
    // facts, and only one of them is safe to act on.
    expect(deadlineTone(null, NOW)).toBe('unknown');
    expect(deadlineTone(null, NOW)).not.toBe(deadlineTone(inHours(500), NOW));
  });
});

describe('formatCountdown', () => {
  it('counts in hours, not just days — five hours must not read as "today"', () => {
    expect(formatCountdown(inHours(5), NOW)).toBe('in 5 hours');
    expect(formatCountdown(inHours(1), NOW)).toBe('in 1 hour');
    expect(formatCountdown(inHours(0.5), NOW)).toBe('in 30 minutes');
  });

  it('says how long ago a window shut, never how long is left', () => {
    expect(formatCountdown(inHours(-5), NOW)).toBe('5 hours ago');
    expect(formatCountdown(inHours(-72), NOW)).toBe('3 days ago');
  });

  it('switches to days only past two of them', () => {
    expect(formatCountdown(inHours(47), NOW)).toBe('in 47 hours');
    expect(formatCountdown(inHours(48), NOW)).toBe('in 2 days');
    expect(formatCountdown(inHours(72), NOW)).toBe('in 3 days');
  });

  it('rounds DOWN, so a countdown never claims more time than there is', () => {
    expect(formatCountdown(inHours(5.9), NOW)).toBe('in 5 hours');
    expect(formatCountdown(inHours(71.9), NOW)).toBe('in 2 days');
  });

  it('is null when there is no deadline, so the caller has to say so in words', () => {
    expect(formatCountdown(null, NOW)).toBeNull();
    expect(NO_DEADLINE).toContain('no deadline');
  });
});

describe('horizonLabel', () => {
  it('names the horizons the picker offers', () => {
    expect(horizonLabel(24)).toBe('24h');
    expect(horizonLabel(72)).toBe('3 days');
    expect(horizonLabel(168)).toBe('7 days');
  });

  it('falls back to raw hours for a horizon nobody listed', () => {
    expect(horizonLabel(5)).toBe('5h');
  });

  it('defaults to the horizon the payments:health cron alerts on', () => {
    // The console and the cron disagreeing about "soon" makes the panel unable to explain the page.
    expect(DEFAULT_DUE_WITHIN_HOURS).toBe(72);
    expect(HORIZONS.some((horizon) => horizon.hours === DEFAULT_DUE_WITHIN_HOURS)).toBe(true);
  });
});

describe('disputeAmountLabel', () => {
  it('renders integer minor units in the dispute’s own currency', () => {
    expect(disputeAmountLabel(123456, 'BRL', 'BRL').replace(/\u00a0/g, ' ')).toBe('R$ 1.234,56');
  });

  it('does NOT render a missing amount as zero', () => {
    // A Stripe early fraud warning carries no money at all. `R$ 0,00` is a claim about the amount;
    // this row has none to claim.
    expect(disputeAmountLabel(null, null, 'BRL')).toBe('no amount');
    expect(disputeAmountLabel(0, 'BRL', 'BRL')).not.toBe('no amount');
  });

  it('formats with the console’s currency when the row carries none', () => {
    expect(disputeAmountLabel(1000, null, 'JPY')).toContain('1.000');
  });

  it('prefers the row’s currency over the console’s', () => {
    // The dispute is denominated in what was charged, not in what the console displays.
    expect(disputeAmountLabel(1000, 'JPY', 'BRL')).toContain('1.000');
    expect(disputeAmountLabel(1000, 'BRL', 'JPY').replace(/\u00a0/g, ' ')).toBe('R$ 10,00');
  });
});

describe('workListSubtitle', () => {
  it('leads with the unbounded total and names the horizon', () => {
    const line = workListSubtitle(8, 72);
    expect(line).toContain('8');
    expect(line).toContain('3 days');
    expect(line).toContain('past-due');
  });

  it('says nothing is due rather than going silent, and still promises past-due rows', () => {
    expect(workListSubtitle(0, 24)).toContain('No evidence window closes within 24h');
    expect(workListSubtitle(0, 24)).toContain('past its deadline');
    expect(workListSubtitle(undefined, 24)).toBe(workListSubtitle(0, 24));
  });

  it('agrees with itself on singular and plural', () => {
    expect(workListSubtitle(1, 72)).toContain('1 evidence window closing');
    expect(workListSubtitle(2, 72)).toContain('2 evidence windows closing');
  });
});

describe('empty messages', () => {
  it('names the horizon and rules out past-due rows too', () => {
    expect(workListEmptyMessage(72)).toContain('3 days');
    expect(workListEmptyMessage(72)).toContain('past due');
  });

  it('says the log is empty because nothing was charged back', () => {
    expect(logEmptyMessage(undefined, undefined)).toContain('Nothing has been charged back');
  });

  it('names the filters that came up empty, so "none" is not read as "none at all"', () => {
    expect(logEmptyMessage('lost', undefined)).toContain('status “lost”');
    expect(logEmptyMessage(undefined, 'stripe')).toContain('gateway “stripe”');
    expect(logEmptyMessage('lost', 'stripe')).toBe(
      'No disputes with status “lost” and gateway “stripe”.',
    );
  });
});
