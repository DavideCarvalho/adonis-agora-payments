import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { formatCents, formatWhen } from './money';
import { Pager, Panel, QueryState } from './shell';
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
];

const ACTION_LABEL: Record<string, string> = {
  'webhook.rejected': 'refused delivery',
  'payment.refunded': 'refund',
  'dispute.resolved': 'dispute resolved',
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
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['audit', action, offset],
    queryFn: () => paymentsClient.audit({ action, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.audit ?? [];

  return (
    <Panel
      title="Activity"
      subtitle="Refunds issued here, dispute outcomes recorded here, and the gateway deliveries this endpoint refused."
      actions={
        <Segmented
          aria-label="Action"
          options={ACTION_OPTIONS}
          value={action}
          onChange={(value) => {
            setAction(value);
            setOffset(0);
          }}
        />
      }
    >
      <QueryState query={query} empty={rows.length === 0} emptyMessage={emptyMessage(action)}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">When</th>
              <th className="px-4 py-2 font-normal">Action</th>
              <th className="px-4 py-2 font-normal">Who</th>
              <th className="px-4 py-2 font-normal">Subject</th>
              <th className="px-4 py-2 text-right font-normal">Amount</th>
              <th className="px-4 py-2 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line-soft last:border-0">
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.createdAt)}</td>
                <td className="px-4 py-2">
                  <Badge variant={row.action === 'webhook.rejected' ? 'danger' : 'type'}>
                    {ACTION_LABEL[row.action] ?? row.action}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-zinc-300">{actorLabel(row)}</td>
                <td className="mono px-4 py-2 text-zinc-400">
                  {row.subjectId ?? '—'}
                  {row.provider !== null && (
                    <span className="ml-1.5">
                      <Badge variant="provider">{row.provider}</Badge>
                    </span>
                  )}
                </td>
                <td className="mono tnum px-4 py-2 text-right text-zinc-200">
                  {row.amount === null ? '—' : formatCents(row.amount, row.currency ?? 'BRL')}
                </td>
                <td className="px-4 py-2 text-[11px] text-zinc-500">{detailLabel(row)}</td>
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
 * WHO — and `null` renders as "unattributed", never as "system".
 *
 * The distinction is the whole reason the column exists: a console with no `dashboardAuth`
 * configured genuinely cannot name anybody, and writing "system" there would invent an actor for
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
  return 'Nothing recorded yet.';
}
