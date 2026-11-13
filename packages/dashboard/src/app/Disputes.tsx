import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Column } from '../agora-kit/blocks/data-table';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import type { DisputeRow } from '../client/payments-client';
import { displayCurrency, paymentsClient } from '../client/payments-client';
import {
  DEFAULT_DUE_WITHIN_HOURS,
  type DeadlineTone,
  deadlineTone,
  disputeAmountLabel,
  formatCountdown,
  HORIZONS,
  logEmptyMessage,
  NO_DEADLINE,
  workListEmptyMessage,
  workListSubtitle,
} from './disputes';
import { ShieldIcon } from './icons';
import { formatDay, formatWhen } from './money';
import { ResolveDisputeDialog } from './ResolveDisputeDialog';
import { ListPanel, Mono } from './shell';
import { disputeIsChargeback, disputeIsOpen, disputeStatusClass } from './status';
import { Badge, Qualifier, StatusBadge } from './ui/badge';
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
  past: 'text-bad',
  urgent: 'text-warn',
  soon: 'text-fg',
  later: 'text-dim',
  unknown: 'text-faint',
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
 * There is still no "fight this", no "accept", no "refund": whether contesting is worth it turns
 * on margin, customer value, the dispute fee, the evidence the app actually holds and the
 * chargeback ratio that puts a merchant into a card network's monitoring programme. That is a
 * business rule, it lives in the app's code, and a button here would invite someone to press it
 * without any of that context.
 *
 * "Record outcome" is a different kind of control and the dialog is at pains to say so: it sends
 * nothing to a gateway. It writes down how a dispute ENDED, because most gateways never publish
 * that — Asaas publishes no lost-dispute event at all — so a lost dispute would otherwise sit
 * `open` forever, holding the health check red until nobody reads it any more.
 */
export function Disputes({ initialStatus }: { initialStatus?: string | undefined } = {}) {
  return (
    <PageBody>
      <PageHeader
        title="Disputes"
        description="Chargebacks and the alerts that precede them. The open windows closing soonest come first."
      />
      <ClosingWindows />
      <DisputeLog initialStatus={initialStatus} />
    </PageBody>
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
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['disputes', 'due-within', hours, page],
    queryFn: () => paymentsClient.disputes({ dueWithin: hours, size: PAGE_SIZE, page }),
  });

  const total = query.data?.meta.total;

  return (
    <ListPanel
      title="Evidence windows closing"
      description={workListSubtitle(total, hours)}
      action={
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
            setPage(1);
          }}
        />
      }
      query={query}
      rowKey={(row) => row.id}
      onPage={setPage}
      emptyIcon={<ShieldIcon />}
      emptyTitle="No window closing"
      emptyDescription={workListEmptyMessage(hours)}
      rowClassName={(row) =>
        deadlineTone(row.evidenceDueBy) === 'past' ? 'bg-bad/[0.06]' : undefined
      }
      columns={WORK_LIST_COLUMNS}
    />
  );
}

/** The work list's columns. The deadline leads: everything else on this table is context for it. */
const WORK_LIST_COLUMNS: Column<DisputeRow>[] = [
  { id: 'due', header: 'Evidence due', cell: (row) => <DeadlineCell iso={row.evidenceDueBy} /> },
  { id: 'status', header: 'Status', hideBelow: 'sm', cell: (row) => <StatusCell row={row} /> },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (row) => <AmountCell row={row} />,
  },
  {
    id: 'reason',
    header: 'Reason',
    hideBelow: 'lg',
    cell: (row) => <Mono>{row.reason ?? '—'}</Mono>,
  },
  {
    id: 'dispute',
    header: 'Dispute id',
    hideBelow: 'md',
    cell: (row) => <Mono>{row.gatewayId}</Mono>,
  },
  {
    id: 'payment',
    header: 'Payment',
    hideBelow: 'lg',
    cell: (row) => <Mono className="text-faint">{row.paymentGatewayId}</Mono>,
  },
  {
    id: 'provider',
    header: 'Provider',
    hideBelow: 'lg',
    cell: (row) => <Badge variant="provider">{row.provider}</Badge>,
  },
];

/** The log: every dispute, newest first, filterable — including the ones with no deadline at all,
 *  which the work list cannot show because there is nothing to be late for. */
function DisputeLog({ initialStatus }: { initialStatus?: string | undefined }) {
  const [status, setStatus] = useState<string | undefined>(initialStatus);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['disputes', 'log', status, provider, page],
    queryFn: () => paymentsClient.disputes({ status, provider, size: PAGE_SIZE, page }),
  });

  const [resolving, setResolving] = useState<DisputeRow | null>(null);
  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const columns: Column<DisputeRow>[] = [
    { id: 'status', header: 'Status', cell: (row) => <StatusCell row={row} /> },
    { id: 'amount', header: 'Amount', align: 'right', cell: (row) => <AmountCell row={row} /> },
    {
      id: 'reason',
      header: 'Reason',
      hideBelow: 'lg',
      cell: (row) => <Mono>{row.reason ?? '—'}</Mono>,
    },
    {
      id: 'due',
      header: 'Evidence due',
      hideBelow: 'md',
      cell: (row) => <DeadlineCell iso={row.evidenceDueBy} />,
    },
    {
      id: 'payment',
      header: 'Payment',
      hideBelow: 'sm',
      cell: (row) => <Mono className="text-faint">{row.paymentGatewayId}</Mono>,
    },
    {
      id: 'provider',
      header: 'Provider',
      hideBelow: 'lg',
      cell: (row) => <Badge variant="provider">{row.provider}</Badge>,
    },
    {
      id: 'opened',
      header: 'Opened',
      hideBelow: 'lg',
      cell: (row) => <Mono className="text-faint">{formatWhen(row.openedAt)}</Mono>,
    },
    {
      id: 'closed',
      header: 'Closed',
      hideBelow: 'lg',
      cell: (row) => <Mono className="text-faint">{formatWhen(row.closedAt)}</Mono>,
    },
    {
      id: 'action',
      header: <span className="sr-only">Action</span>,
      align: 'right',
      // Offered only while the dispute is still open — the same set the health check counts.
      // "Resolve" on a row that is already `lost` would be an edit box over a money table, not a
      // resolution.
      cell: (row) =>
        disputeIsOpen(row.status) ? (
          <Button variant="outline" size="sm" onClick={() => setResolving(row)}>
            Record outcome
          </Button>
        ) : null,
    },
  ];

  return (
    <ListPanel
      title="All disputes"
      description="every chargeback and alert, newest first"
      action={
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
          <Segmented
            aria-label="Dispute status"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(value) => refilter(() => setStatus(value))}
          />
        </div>
      }
      query={query}
      rowKey={(row) => row.id}
      onPage={setPage}
      emptyIcon={<ShieldIcon />}
      emptyTitle="No disputes"
      emptyDescription={logEmptyMessage(status, provider)}
      columns={columns}
    >
      {resolving !== null && (
        <ResolveDisputeDialog dispute={resolving} onClose={() => setResolving(null)} />
      )}
    </ListPanel>
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
    return <span className="text-[11px] text-faint">{NO_DEADLINE}</span>;
  }
  return (
    <span className={`mono text-[12px] ${TONE_CLASS[tone]}`}>
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
    <span className="inline-flex flex-wrap items-center gap-2">
      <StatusBadge statusClass={disputeStatusClass(row.status)}>{row.status}</StatusBadge>
      {/* Spelled out, like the subscriptions screen's "not billing": a `warning` is an alert, not
          a debit — the money is still yours and a refund now stops the chargeback being filed. */}
      {!disputeIsChargeback(row.status) && <Qualifier>no money moved</Qualifier>}
      {row.outcome !== null && row.outcome !== '' && (
        <span className="mono text-[10px] text-faint">{row.outcome}</span>
      )}
    </span>
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
    return <span className="text-[11px] text-faint">{label}</span>;
  }
  return <span className="mono tnum text-[12.5px] text-fg">{label}</span>;
}
