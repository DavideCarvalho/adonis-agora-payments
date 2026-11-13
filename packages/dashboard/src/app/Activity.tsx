import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Column } from '../agora-kit/blocks/data-table';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import type { AuditRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { LogIcon } from './icons';
import { formatCents, formatCount, formatWhen } from './money';
import { ListPanel, Mono } from './shell';
import { Badge } from './ui/badge';
import { Segmented } from './ui/segmented';

const PAGE_SIZE = 50;

/**
 * The three actions the library records itself, in the order an operator cares about them.
 *
 * `webhook.rejected` leads, and that is not arbitrary: it is the only one of the three that
 * nothing else in this console can show. A refund leaves a payment row and a dispute resolution
 * leaves a dispute row; a REFUSED delivery leaves nothing at all — it never becomes a ledger row
 * — so a rotated webhook secret reads as a quiet week on every other screen.
 */
const ACTION_OPTIONS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'webhook.rejected', label: 'Refused deliveries' },
  { value: 'payment.refunded', label: 'Refunds' },
  { value: 'dispute.resolved', label: 'Dispute outcomes' },
  { value: 'webhook.retried', label: 'Retries' },
];

const ACTION_LABEL: Record<string, string> = {
  'webhook.rejected': 'refused delivery',
  'payment.refunded': 'refund',
  'dispute.resolved': 'dispute resolved',
  'webhook.retried': 'event retried',
};

/**
 * Activity — what happened to this install that no other table records.
 *
 * Every row here was a diagnostic and nothing else before: a line on an event bus the app may not
 * subscribe to, going to a log that has usually rotated by the time anybody asks who refunded a
 * customer in March, or why three weeks of Asaas deliveries never arrived.
 */
export function Activity({ initialAction }: { initialAction?: string | undefined } = {}) {
  const [action, setAction] = useState<string | undefined>(initialAction);
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['audit', action, page],
    queryFn: () => paymentsClient.audit({ action, size: PAGE_SIZE, page }),
  });

  return (
    <PageBody>
      <PageHeader
        title="Activity"
        description="Refunds issued here, dispute outcomes recorded here, and the gateway deliveries this endpoint refused."
      />
      <Toolbar label="Activity filters">
        <Segmented
          aria-label="Action"
          options={ACTION_OPTIONS}
          value={action}
          onChange={(value) => {
            setAction(value);
            setPage(1);
          }}
        />
      </Toolbar>
      <ListPanel
        title="Audit log"
        description={
          query.data !== undefined ? `${formatCount(query.data.meta.total)} entries` : undefined
        }
        query={query}
        rowKey={(row) => row.id}
        onPage={setPage}
        emptyIcon={<LogIcon />}
        emptyTitle="Nothing here"
        emptyDescription={emptyMessage(action)}
        columns={ACTIVITY_COLUMNS}
      />
    </PageBody>
  );
}

/** The audit table's columns (presentational). */
const ACTIVITY_COLUMNS: Column<AuditRow>[] = [
  {
    id: 'when',
    header: 'When',
    cell: (row) => <Mono className="text-faint">{formatWhen(row.createdAt)}</Mono>,
  },
  {
    id: 'action',
    header: 'Action',
    cell: (row) => (
      <Badge variant={row.action === 'webhook.rejected' ? 'danger' : 'type'}>
        {ACTION_LABEL[row.action] ?? row.action}
      </Badge>
    ),
  },
  {
    id: 'who',
    header: 'Who',
    hideBelow: 'sm',
    cell: (row) => <span className="text-fg-2">{actorLabel(row)}</span>,
  },
  {
    id: 'subject',
    header: 'Subject',
    hideBelow: 'md',
    cell: (row) => (
      <span className="inline-flex items-center gap-1.5">
        <Mono>{row.subjectId ?? '—'}</Mono>
        {row.provider !== null && <Badge variant="provider">{row.provider}</Badge>}
      </span>
    ),
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (row) => (
      <span className="mono tnum text-[12.5px] text-fg">
        {row.amount === null ? '—' : formatCents(row.amount, row.currency ?? 'BRL')}
      </span>
    ),
  },
  {
    id: 'detail',
    header: 'Detail',
    hideBelow: 'lg',
    className: 'whitespace-normal',
    cell: (row) => <span className="text-[11px] text-faint">{detailLabel(row)}</span>,
  },
];

/**
 * WHO — and `null` renders as "unattributed", never as "system".
 *
 * The distinction is the whole reason the column exists: a request with no signed-in user
 * genuinely cannot name anybody, and writing "system" there would invent an actor for
 * an action a person took.
 */
function actorLabel(row: AuditRow): string {
  return row.actor ?? '— unattributed';
}

/** The sentence, or the machine detail when there is no sentence. */
function detailLabel(row: AuditRow): string {
  if (row.message !== null && row.message !== '') return row.message;
  const meta = row.metadata;
  if (meta === null) return '';
  if (typeof meta.outcome === 'string') return `outcome: ${meta.outcome}`;
  if (typeof meta.reason === 'string') return meta.reason;
  if (meta.partial === true) return 'partial refund';
  return '';
}

function emptyMessage(action: string | undefined): string {
  if (action === 'webhook.rejected') {
    return 'No delivery has been refused. A rotated webhook secret would show up here, and nowhere else.';
  }
  if (action === 'payment.refunded') return 'No refund has been issued from this console.';
  if (action === 'dispute.resolved') return 'No dispute outcome has been recorded here.';
  if (action === 'webhook.retried') return 'No failed event has been retried from here.';
  return 'Nothing recorded yet.';
}
