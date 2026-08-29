import type { Health, HealthCheck } from '../client/payments-client';

/**
 * Where each health check's rows actually live.
 *
 * A count an operator cannot act on is decoration, so every non-zero check has to lead somewhere:
 * "12 events the dispatcher gave up on" is only useful if clicking it lands on those twelve rows.
 * The mapping is pure and lives here rather than inline in the panel, because getting it wrong
 * sends someone to a screen full of healthy rows and teaches them to distrust the number.
 */
export interface HealthTarget {
  screen: 'payments' | 'webhooks' | 'disputes' | 'activity';
  /**
   * The filter that isolates exactly the rows the check counted, or `undefined` when the target
   * screen already opens on them — the disputes screen leads with the closing windows, so
   * seeding its LOG with a status would filter the wrong list.
   *
   * A status on the three row screens; an ACTION on the activity screen, whose rows have no
   * status at all. One field rather than two because the target's job is "narrow the screen you
   * are about to open to these rows", and each screen has exactly one thing to narrow on.
   */
  status?: string;
  /** The button's label. */
  label: string;
}

export function healthTarget(key: HealthCheck['key']): HealthTarget {
  switch (key) {
    case 'stuck_webhooks':
      // Claimed and never finished — they are still sitting at `received`.
      return { screen: 'webhooks', status: 'received', label: 'Show the in-flight events' };
    case 'failed_webhooks':
      return { screen: 'webhooks', status: 'failed', label: 'Show the failed events' };
    case 'unconfirmed_payments':
      return { screen: 'payments', status: 'pending', label: 'Show the pending charges' };
    case 'disputes_due':
      // No status: the disputes screen opens on the work list, which IS this check's rows —
      // the same open-with-a-deadline set, on the same 72 h horizon the cron alerts on.
      return { screen: 'disputes', label: 'Show the closing windows' };
    case 'open_disputes':
      // Also no status, and NOT `open`: this check counts `warning`, `open` and `under_review`
      // alike, so seeding any single one of them would hide part of what it just counted. The
      // panel names the actual rows underneath instead.
      return { screen: 'disputes', label: 'Show every dispute' };
    case 'rejected_deliveries':
      // Rejected deliveries are not ledger rows — that is the whole point of the check — so
      // this must not land on the webhook-events screen, which would show none of them.
      return {
        screen: 'activity',
        status: 'webhook.rejected',
        label: 'Show the refused deliveries',
      };
  }
}

/** The checks that are firing, in the report's own order (stuck, failed, unconfirmed). */
export function failingChecks(report: Health): HealthCheck[] {
  return report.checks.filter((check) => !check.healthy);
}

/**
 * The one-line summary a healthy install shows.
 *
 * Deliberately names what was checked rather than saying "OK": a green line that does not say what
 * it looked at is a green line nobody believes on the day it matters.
 */
export function healthyLine(report: Health): string {
  return `No stuck events, nothing the dispatcher gave up on, no unconfirmed charges, no open disputes, no refused deliveries — ${report.checks.length} checks clear.`;
}
