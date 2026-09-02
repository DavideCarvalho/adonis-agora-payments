import {
  AUDIT_ACTIONS,
  type BillingStore,
  type DisputeListItem,
  type WebhookEventBreakdownLine,
} from './billing_store.js';

/** 15 minutes — an event claimed but unfinished for longer is not slow, it is abandoned. */
const DEFAULT_STUCK_AFTER = 15 * 60 * 1000;
/** 2 hours — every gateway confirms or fails a charge well inside this. */
const DEFAULT_UNCONFIRMED_AFTER = 2 * 60 * 60 * 1000;
/** 24 hours — the window failures are counted over. */
const DEFAULT_FAILED_WITHIN = 24 * 60 * 60 * 1000;
/**
 * 72 hours — how far ahead a closing evidence window is worth shouting about.
 *
 * Gateways give between 7 and 21 days to respond, so three days is late enough that the
 * check is not permanently red and early enough that somebody can still gather a receipt, a
 * delivery confirmation and an IP log before the window shuts. Past-due disputes stay
 * counted: the window closing is what makes it urgent, not what makes it finished.
 */
const DEFAULT_DISPUTE_DUE_WITHIN = 72 * 60 * 60 * 1000;

/**
 * 24 hours — the window rejected deliveries are counted over.
 *
 * A rejection is not a slow-burning condition like a stuck event: a rotated webhook token, a
 * secret that never made it into the deploy, a gateway pointed at the wrong route, all produce
 * rejections immediately and continuously. A day is long enough to survive a redeploy and short
 * enough that the number means "right now".
 */
const DEFAULT_REJECTED_WITHIN = 24 * 60 * 60 * 1000;

/**
 * Folga antes de considerar uma renovação atrasada.
 *
 * Duas horas, e não minutos: o runner é chamado por um cron, e um cron de hora em hora
 * deixa uma janela normal de até uma hora. Um limiar mais curto acenderia o alerta em toda
 * virada de hora — e um alerta que pisca sozinho é um alerta que ninguém lê.
 */
const DEFAULT_OVERDUE_RENEWAL_AFTER = 2 * 60 * 60 * 1000;

/** How many closing windows the report NAMES. The count is unbounded; this is the list. */
const DISPUTE_DEADLINE_SAMPLE = 20;

/** How many open disputes the report NAMES, oldest first. The count is unbounded. */
const OPEN_DISPUTE_SAMPLE = 20;

export interface BillingHealthOptions {
  /** Milliseconds an event may sit in `received` before it counts as stuck. Default 15 min. */
  stuckAfter?: number;
  /** Milliseconds a `pending` payment may age before it counts as unconfirmed. Default 2 h. */
  unconfirmedAfter?: number;
  /** The window `failed` events are counted over. Default 24 h. */
  failedWithin?: number;
  /**
   * How far ahead to look for a dispute whose evidence window is about to close. Default 72 h.
   *
   * In milliseconds like every other threshold here, though the store's read takes hours —
   * the conversion happens once, at the call.
   */
  disputeDueWithin?: number;
  /** The window rejected deliveries are counted over. Default 24 h. */
  rejectedWithin?: number;
  /** How late a managed renewal must be before it counts as overdue. Default 2 h. */
  overdueRenewalAfter?: number;
  /** Overridable clock — the tests pass a fixed instant. Defaults to now. */
  now?: Date;
}

export interface BillingHealthCheck {
  key:
    | 'stuck_webhooks'
    | 'failed_webhooks'
    | 'unconfirmed_payments'
    | 'disputes_due'
    | 'open_disputes'
    | 'rejected_deliveries'
    | 'overdue_renewals'
    | 'failing_renewals';
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
  /**
   * The disputes behind `disputes_due`, soonest deadline first — WHICH windows are closing,
   * not just how many. Capped at {@link DISPUTE_DEADLINE_SAMPLE}; `disputes_due.count` is the
   * full number, so a report can name twenty and still say there are fifty.
   */
  deadlines: DisputeListItem[];
  /**
   * The disputes behind `open_disputes`, OLDEST first — the ones nobody has answered, whether or
   * not a deadline was ever published for them. Capped at {@link OPEN_DISPUTE_SAMPLE}.
   *
   * Overlaps `deadlines` on purpose: a dispute that has both a deadline and no answer belongs in
   * both lists, and suppressing it from one of them to keep them disjoint would make the
   * deadline-free check quietly incomplete on exactly the install it exists for.
   */
  openDisputes: DisputeListItem[];
}

/**
 * The six operational questions about a billing install that nothing else answers, asked
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
 * - **Closing dispute windows**: an open chargeback whose evidence deadline is inside the
 *   next three days. This is the only check here that alerts on a CLOCK rather than on a
 *   failure — nothing is broken, and the money is lost anyway if the window closes
 *   unanswered, by default rather than on the merits.
 * - **Open disputes**: the same money, without the clock. `disputes_due` can only ever see a
 *   dispute whose gateway PUBLISHED a deadline, and most do not — Asaas' comes from
 *   `chargeback.deadlineToSendDisputeDocuments`, which no published webhook example contains.
 *   On such an install the deadline check is zero forever while a chargeback sits open with the
 *   money already pulled back, and the report says healthy. This one asks the question the
 *   deadline cannot.
 * - **Rejected deliveries**: gateway calls the endpoint REFUSED — a bad signature, an unparsable
 *   body, a provider nobody configured. They never become ledger rows, so a rotated webhook
 *   token used to look exactly like a quiet week: zero events, zero failures, every check green.
 *   `unconfirmed_payments` eventually notices, but only for charges the app itself created;
 *   refunds, chargebacks and dispute closures produce no pending payment and simply vanish.
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
  const disputeDueWithin = options.disputeDueWithin ?? DEFAULT_DISPUTE_DUE_WITHIN;
  const rejectedWithin = options.rejectedWithin ?? DEFAULT_REJECTED_WITHIN;
  const overdueRenewalAfter = options.overdueRenewalAfter ?? DEFAULT_OVERDUE_RENEWAL_AFTER;
  const since = (ms: number) => new Date(now.getTime() - ms);
  // The store's deadline read takes HOURS; every other threshold here is milliseconds.
  const withinHours = disputeDueWithin / 3_600_000;

  const [
    stuck,
    failed,
    unconfirmed,
    failures,
    disputesDue,
    deadlines,
    openDisputeCount,
    openDisputes,
    rejected,
    overdueRenewals,
    failingRenewals,
  ] = await Promise.all([
    store.countWebhookEvents({ status: 'received', createdBefore: since(stuckAfter) }),
    store.countWebhookEvents({ status: 'failed', createdAfter: since(failedWithin) }),
    store.countPayments({ status: 'pending', createdBefore: since(unconfirmedAfter) }),
    store.webhookEventBreakdown({ status: 'failed', createdAfter: since(failedWithin) }),
    // Counted separately from the list, and unbounded: a count taken from a capped page
    // saturates at the cap, and this number is what the exit code is decided on.
    store.countDisputesDueWithin({ withinHours, now }),
    store.listDisputesDueWithin({ withinHours, now, limit: DISPUTE_DEADLINE_SAMPLE }),
    // No window and no deadline: an open dispute is unanswered however old it is, and on a
    // gateway that publishes no deadline this is the ONLY read that can see it at all.
    store.countOpenDisputes({}),
    store.listOpenDisputes({ limit: OPEN_DISPUTE_SAMPLE }),
    store.countAuditEvents({
      action: AUDIT_ACTIONS.webhookRejected,
      createdAfter: since(rejectedWithin),
    }),
    // Assinaturas gerenciadas que já deviam ter sido cobradas e não foram.
    store.countSubscriptions({
      status: 'active',
      managed: true,
      nextChargeBefore: since(overdueRenewalAfter),
    }),
    store.countSubscriptions({ status: 'active', managed: true, minRenewalFailures: 1 }),
  ]);

  const checks: BillingHealthCheck[] = [
    {
      key: 'overdue_renewals',
      label: `Managed subscriptions due to be charged over ${formatDuration(overdueRenewalAfter)} ago`,
      count: overdueRenewals,
      healthy: overdueRenewals === 0,
      // A checagem que percebe um cron morto. Renovação gerenciada só acontece porque algo
      // chama `payments:renew`; se esse algo para, nada renova, nada falha e nada avisa — a
      // receita simplesmente deixa de entrar, e a primeira notícia é um cliente reclamando de
      // acesso que continuou funcionando de graça.
      hint: 'Nothing is renewing them. `payments:renew` is not running — check the cron/scheduler that calls it; the charges themselves are idempotent, so a late run is safe.',
    },
    {
      key: 'failing_renewals',
      label: 'Managed subscriptions whose last renewal charge failed',
      count: failingRenewals,
      healthy: failingRenewals === 0,
      // Distinta da de cima de propósito: aqui o runner ESTÁ rodando e o gateway recusa. Uma
      // falha não muda nada na linha (o período não avança), então sem este contador uma
      // assinatura falhando há uma semana parecia igual a uma vencendo pela primeira vez.
      hint: "The runner is working and the gateway is refusing. Read `lastRenewalError` on each subscription — expired Pix authorizations and declined cards look identical from here, and dunning is the application's policy.",
    },
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
    {
      key: 'disputes_due',
      label: `Open disputes whose evidence window closes within ${formatDuration(disputeDueWithin)}`,
      count: disputesDue,
      healthy: disputesDue === 0,
      hint: 'A chargeback window is closing. Past it the dispute is lost by default rather than on the merits, and nothing can be done — submit evidence at the gateway, or refund if it is cheaper than the fee. Rows already past their deadline are counted here too: they are still open, and still unanswered.',
    },
    {
      key: 'open_disputes',
      label: 'Disputes still open and unanswered',
      count: openDisputeCount,
      healthy: openDisputeCount === 0,
      hint: 'A chargeback is open and the money is already out of the account. This check does NOT need a deadline, which is the point: most gateways publish none, and on those installs the deadline check reports zero forever. Answer it at the gateway, then close it here (POST <dashboard>/api/disputes/:gatewayId/resolve) — several gateways never send a lost-dispute event, so nothing else will ever close the row.',
    },
    {
      key: 'rejected_deliveries',
      label: `Gateway deliveries refused in the last ${formatDuration(rejectedWithin)}`,
      count: rejected,
      healthy: rejected === 0,
      hint: 'The webhook endpoint answered 400: a signature that did not verify, a body it could not parse, or a provider nobody configured. The usual cause is a rotated webhook secret that never reached the deployment — and the deliveries lost that way are invisible everywhere else, because a rejected delivery never becomes a ledger row. Read them with listAuditEvents({ action: "webhook.rejected" }).',
    },
  ];

  return {
    healthy: checks.every((check) => check.healthy),
    checkedAt: now,
    checks,
    failures,
    deadlines,
    openDisputes,
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
