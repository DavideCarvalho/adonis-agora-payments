import type { BillingStore, WebhookEventBreakdownLine } from './billing_store.js';

/** 15 minutes — an event claimed but unfinished for longer is not slow, it is abandoned. */
const DEFAULT_STUCK_AFTER = 15 * 60 * 1000;
/** 2 hours — every gateway confirms or fails a charge well inside this. */
const DEFAULT_UNCONFIRMED_AFTER = 2 * 60 * 60 * 1000;
/** 24 hours — the window failures are counted over. */
const DEFAULT_FAILED_WITHIN = 24 * 60 * 60 * 1000;

export interface BillingHealthOptions {
  /** Milliseconds an event may sit in `received` before it counts as stuck. Default 15 min. */
  stuckAfter?: number;
  /** Milliseconds a `pending` payment may age before it counts as unconfirmed. Default 2 h. */
  unconfirmedAfter?: number;
  /** The window `failed` events are counted over. Default 24 h. */
  failedWithin?: number;
  /** Overridable clock — the tests pass a fixed instant. Defaults to now. */
  now?: Date;
}

export interface BillingHealthCheck {
  key: 'stuck_webhooks' | 'failed_webhooks' | 'unconfirmed_payments';
  label: string;
  count: number;
  /** `true` when `count` is zero — every check here is a "should be nothing" check. */
  healthy: boolean;
  /** What a non-zero count means, and what to do about it. */
  hint: string;
}

export interface BillingHealth {
  /** `false` when any check is non-zero — the exit code `payments:health` returns. */
  healthy: boolean;
  checkedAt: Date;
  checks: BillingHealthCheck[];
  /** Which provider/event pairs make up `failed_webhooks`, worst first. */
  failures: WebhookEventBreakdownLine[];
}

/**
 * The three operational questions about a billing install that nothing else answers, asked
 * through the store instead of by hand against the tables.
 *
 * Each is a silent failure — the kind where the endpoint keeps returning `200` and revenue
 * quietly stops landing:
 *
 * - **Stuck events**: claimed in the ledger, never finished. Almost always the worker the
 *   dispatcher depends on (`durable:work` / `queue:listen`) is not running.
 * - **Failed events**: the handler threw and retries were exhausted, so the effect that
 *   event described — the grant, the activation — never happened.
 * - **Unconfirmed charges**: created and never confirmed. This is what a webhook endpoint
 *   that stopped being reachable looks like from the inside, and nothing errors.
 *
 * Pure store reads, no gateway calls — safe to run on a schedule and to alert on.
 */
export async function billingHealth(
  store: BillingStore,
  options: BillingHealthOptions = {},
): Promise<BillingHealth> {
  const now = options.now ?? new Date();
  const stuckAfter = options.stuckAfter ?? DEFAULT_STUCK_AFTER;
  const unconfirmedAfter = options.unconfirmedAfter ?? DEFAULT_UNCONFIRMED_AFTER;
  const failedWithin = options.failedWithin ?? DEFAULT_FAILED_WITHIN;
  const since = (ms: number) => new Date(now.getTime() - ms);

  const [stuck, failed, unconfirmed, failures] = await Promise.all([
    store.countWebhookEvents({ status: 'received', createdBefore: since(stuckAfter) }),
    store.countWebhookEvents({ status: 'failed', createdAfter: since(failedWithin) }),
    store.countPayments({ status: 'pending', createdBefore: since(unconfirmedAfter) }),
    store.webhookEventBreakdown({ status: 'failed', createdAfter: since(failedWithin) }),
  ]);

  const checks: BillingHealthCheck[] = [
    {
      key: 'stuck_webhooks',
      label: `Events claimed but unfinished for over ${formatDuration(stuckAfter)}`,
      count: stuck,
      healthy: stuck === 0,
      hint: 'Nothing is consuming the dispatcher. Check that the worker is running (durable:work / queue:listen).',
    },
    {
      key: 'failed_webhooks',
      label: `Events the dispatcher gave up on in the last ${formatDuration(failedWithin)}`,
      count: failed,
      healthy: failed === 0,
      hint: 'Handlers threw and retries ran out; those events never took effect. Read the errors with listWebhookEvents({ status: "failed" }), fix the cause, then replay them from the gateway dashboard.',
    },
    {
      key: 'unconfirmed_payments',
      label: `Charges created over ${formatDuration(unconfirmedAfter)} ago and still pending`,
      count: unconfirmed,
      healthy: unconfirmed === 0,
      hint: 'Charges are being created but never confirmed — the shape of a webhook endpoint that stopped being reachable. Check the gateway dashboard delivery log.',
    },
  ];

  return {
    healthy: checks.every((check) => check.healthy),
    checkedAt: now,
    checks,
    failures,
  };
}

/** `900000` reads as nothing in a label; `15m` reads as a threshold. */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${trim(hours)}h`;
  return `${trim(hours / 24)}d`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
