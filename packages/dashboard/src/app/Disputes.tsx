import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DisputeRow } from '../client/payments-client';
import { displayCurrency, paymentsClient } from '../client/payments-client';
import {
  DEFAULT_DUE_WITHIN_HOURS,
  type DeadlineTone,
  HORIZONS,
  NO_DEADLINE,
  deadlineTone,
  disputeAmountLabel,
  formatCountdown,
  logEmptyMessage,
  workListEmptyMessage,
  workListSubtitle,
} from './disputes';
import { formatDay, formatWhen } from './money';
import { Pager, Panel, QueryState } from './shell';
import { disputeIsChargeback, disputeStatusClass } from './status';
import { Badge } from './ui/badge';
import { ProviderFilter } from './ui/provider-filter';
import { Segmented } from './ui/segmented';

const PAGE_SIZE = 50;

/** `DISPUTE_STATUSES`, in the server's order: what still needs an answer first. */
const STATUS_OPTIONS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'warning', label: 'Warning' },
  { value: 'open', label: 'Open' },
  { value: 'under_review', label: 'Under review' },
  { value: 'lost', label: 'Lost' },
  { value: 'expired', label: 'Expired' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'won', label: 'Won' },
];

/** Deadline hues. `unknown` is grey, never a shade of "fine": nobody told us anything. */
const TONE_CLASS: Record<DeadlineTone, string> = {
  past: 'text-rose-300',
  urgent: 'text-amber-300',
  soon: 'text-zinc-200',
  later: 'text-zinc-400',
  unknown: 'text-zinc-500',
};

/**
 * Disputes — chargebacks and the alerts that precede them.
 *
 * A chargeback is the only event in this package with a clock that runs against you: every network
 * gives a fixed window to respond, and missing it loses the money **by default rather than on the
 * merits**. So the screen leads with the work list — the open windows closing soonest — and the
 * log sits underneath it. Opening on "every dispute, newest first" would put the one that expires
 * tonight somewhere on page three.
 *
 * READ-ONLY, deliberately, and it must stay that way. There is no "fight this", no "accept", no
 * "refund": whether contesting is worth it turns on margin, customer value, the dispute fee, the
 * evidence the app actually holds and the chargeback ratio that puts a merchant into a card
 * network's monitoring programme. That is a business rule, it lives in the app's code, and a
 * button here would invite someone to press it without any of that context. The JSON API has no
 * action route for disputes either.
 */
export function Disputes({ initialStatus }: { initialStatus?: string | undefined } = {}) {
  return (
    <div className="flex flex-col gap-4">
      <ClosingWindows />
      <DisputeLog initialStatus={initialStatus} />
    </div>
  );
}

/**
 * The work list: open disputes with a deadline, soonest first.
 *
 * No gateway filter here, unlike every other list in this console. This is the one list whose
 * whole job is "nothing gets missed", and a filter on it hides a deadline — narrowing to Stripe
 * while an Asaas window shuts tonight is exactly the failure the screen exists to prevent. Filter
 * the log below instead; it is the same table.
 */
function ClosingWindows() {
  const [hours, setHours] = useState(DEFAULT_DUE_WITHIN_HOURS);
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['disputes', 'due-within', hours, offset],
    queryFn: () => paymentsClient.disputes({ dueWithin: hours, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.disputes ?? [];
  const total = query.data?.dueWithin?.total;

  return (
    <Panel
      title="Evidence windows closing"
      subtitle={workListSubtitle(total, hours)}
      actions={
        <Segmented
          aria-label="Deadline horizon"
          options={HORIZONS.map((horizon) => ({
            value: String(horizon.hours),
            label: horizon.label,
          }))}
          value={String(hours)}
          onChange={(value) => {
            setHours(Number(value));
            // A different horizon is a different list; page 3 of "3 days" is not page 3 of "30".
            setOffset(0);
          }}
        />
      }
    >
      <QueryState
        query={query}
        empty={rows.length === 0}
        emptyMessage={workListEmptyMessage(hours)}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              {/* The deadline leads. Everything else on this table is context for it. */}
              <th className="px-4 py-2 font-normal">Evidence due</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 text-right font-normal">Amount</th>
              <th className="px-4 py-2 font-normal">Reason</th>
              <th className="px-4 py-2 font-normal">Dispute id</th>
              <th className="px-4 py-2 font-normal">Payment</th>
              <th className="px-4 py-2 font-normal">Provider</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tone = deadlineTone(row.evidenceDueBy);
              return (
                <tr
                  key={row.id}
                  className={
                    tone === 'past'
                      ? 'border-b border-line-soft bg-bad/[0.06]'
                      : 'border-b border-line-soft'
                  }
                >
                  <td className="px-4 py-2">
                    <DeadlineCell iso={row.evidenceDueBy} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusCell row={row} />
                  </td>
                  <td className="mono tnum px-4 py-2 text-right text-zinc-100">
                    <AmountCell row={row} />
                  </td>
                  <td className="mono px-4 py-2 text-zinc-400">{row.reason ?? '—'}</td>
                  <td className="mono px-4 py-2 text-zinc-400">{row.gatewayId}</td>
                  <td className="mono px-4 py-2 text-zinc-500">{row.paymentGatewayId}</td>
                  <td className="px-4 py-2">
                    <Badge variant="provider">{row.provider}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pager
          limit={query.data?.page.limit ?? PAGE_SIZE}
          offset={query.data?.page.offset ?? offset}
          count={query.data?.page.count ?? 0}
          onOffset={setOffset}
        />
      </QueryState>
    </Panel>
  );
}

/** The log: every dispute, newest first, filterable — including the ones with no deadline at all,
 *  which the work list cannot show because there is nothing to be late for. */
function DisputeLog({ initialStatus }: { initialStatus?: string | undefined }) {
  const [status, setStatus] = useState<string | undefined>(initialStatus);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['disputes', 'log', status, provider, offset],
    queryFn: () => paymentsClient.disputes({ status, provider, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.disputes ?? [];
  const refilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <Panel
      title="All disputes"
      subtitle="Every chargeback and pre-chargeback alert recorded locally, newest first."
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
          <Segmented
            aria-label="Dispute status"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(value) => refilter(() => setStatus(value))}
          />
        </div>
      }
    >
      <QueryState
        query={query}
        empty={rows.length === 0}
        emptyMessage={logEmptyMessage(status, provider)}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 text-right font-normal">Amount</th>
              <th className="px-4 py-2 font-normal">Reason</th>
              <th className="px-4 py-2 font-normal">Evidence due</th>
              <th className="px-4 py-2 font-normal">Payment</th>
              <th className="px-4 py-2 font-normal">Provider</th>
              <th className="px-4 py-2 font-normal">Opened</th>
              <th className="px-4 py-2 font-normal">Closed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line-soft last:border-0">
                <td className="px-4 py-2">
                  <StatusCell row={row} />
                </td>
                <td className="mono tnum px-4 py-2 text-right text-zinc-100">
                  <AmountCell row={row} />
                </td>
                <td className="mono px-4 py-2 text-zinc-400">{row.reason ?? '—'}</td>
                <td className="px-4 py-2">
                  <DeadlineCell iso={row.evidenceDueBy} />
                </td>
                <td className="mono px-4 py-2 text-zinc-500">{row.paymentGatewayId}</td>
                <td className="px-4 py-2">
                  <Badge variant="provider">{row.provider}</Badge>
                </td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.openedAt)}</td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.closedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager
          limit={query.data?.page.limit ?? PAGE_SIZE}
          offset={query.data?.page.offset ?? offset}
          count={query.data?.page.count ?? 0}
          onOffset={setOffset}
        />
      </QueryState>
    </Panel>
  );
}

/**
 * The deadline, and what it means right now.
 *
 * Three cases, three sentences, none of them an empty cell:
 * - a window already shut says **past due** and stays on the screen. It is still open and still
 *   unanswered; going quiet the moment it expires would read as "handled";
 * - a real deadline shows the day plus how long is left, because the countdown is the part that
 *   gets acted on;
 * - no deadline at all says the gateway sent none, rather than rendering a dash that reads like a
 *   bug or a blank that reads like "no hurry".
 */
function DeadlineCell({ iso }: { iso: string | null }) {
  const tone = deadlineTone(iso);
  if (tone === 'unknown') {
    return <span className="text-[11px] text-zinc-500">{NO_DEADLINE}</span>;
  }
  return (
    <span className={`mono ${TONE_CLASS[tone]}`}>
      {tone === 'past' && (
        <span className="mr-1.5 text-[10px] uppercase tracking-wider">past due</span>
      )}
      {formatDay(iso)}
      <span className="ml-1.5 text-[10px] opacity-80">{formatCountdown(iso)}</span>
    </span>
  );
}

/** The status, plus the one thing colour alone must not be trusted to carry. */
function StatusCell({ row }: { row: DisputeRow }) {
  return (
    <>
      <span className={disputeStatusClass(row.status)}>
        <Badge variant="status">{row.status}</Badge>
      </span>
      {/* Spelled out, like the subscriptions screen's "not billing": a `warning` is an alert, not
          a debit — the money is still yours and a refund now stops the chargeback being filed. */}
      {!disputeIsChargeback(row.status) && (
        <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-600">
          no money moved
        </span>
      )}
      {row.outcome !== null && row.outcome !== '' && (
        <span className="mono ml-2 text-[10px] text-zinc-600">{row.outcome}</span>
      )}
    </>
  );
}

/**
 * The disputed amount — or the sentence for a dispute that names none.
 *
 * A Stripe early fraud warning carries no money at all. `R$ 0,00` would be a claim about the
 * amount; this renders the absence of one, and renders it quietly so it does not read as a figure.
 */
function AmountCell({ row }: { row: DisputeRow }) {
  const label = disputeAmountLabel(row.amount, row.currency, displayCurrency());
  if (row.amount === null) {
    return <span className="text-[11px] text-zinc-500">{label}</span>;
  }
  return <>{label}</>;
}
