import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { paymentsClient } from '../client/payments-client';
import { formatWhen } from './money';
import { Pager, Panel, QueryState } from './shell';
import { isActionable, webhookStatusClass } from './status';
import { Badge } from './ui/badge';
import { Segmented } from './ui/segmented';

const PAGE_SIZE = 50;

const STATUS_OPTIONS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'received', label: 'Received' },
  { value: 'processed', label: 'Processed' },
];

/**
 * The idempotency ledger.
 *
 * This is the operationally useful screen. A `failed` row means a handler THREW and the dispatcher
 * gave up: the event's effect — a subscription activated, a payment recorded — never happened, and
 * nothing will retry it on its own. The `error` column is the only place that reason survives, so
 * it is rendered in full rather than truncated behind a click.
 *
 * `received` is not automatically a problem (a handler may simply be mid-flight), but a `received`
 * row that is hours old is a stuck one, which is why the timestamps are shown next to it.
 */
export function WebhookEvents() {
  const [status, setStatus] = useState<string | undefined>('failed');
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['webhook-events', status, offset],
    queryFn: () => paymentsClient.webhookEvents({ status, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.events ?? [];

  return (
    <Panel
      title="Webhook events"
      subtitle="The idempotency ledger. A failed row means a handler threw and the dispatcher gave up — its effect never happened."
      actions={
        <Segmented
          aria-label="Event status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setOffset(0);
          }}
        />
      }
    >
      <QueryState
        query={query}
        empty={rows.length === 0}
        emptyMessage={
          status === 'failed'
            ? 'No failed webhook events. Nothing is stuck.'
            : status === undefined
              ? 'No webhook events recorded yet.'
              : `No webhook events with status “${status}”.`
        }
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Type</th>
              <th className="px-4 py-2 font-normal">Provider</th>
              <th className="px-4 py-2 font-normal">Gateway event id</th>
              <th className="px-4 py-2 font-normal">Received</th>
              <th className="px-4 py-2 font-normal">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.id}>
                <tr
                  className={
                    isActionable(row.status)
                      ? 'border-b border-line-soft bg-bad/[0.04]'
                      : 'border-b border-line-soft'
                  }
                >
                  <td className="px-4 py-2">
                    <span className={webhookStatusClass(row.status)}>
                      <Badge variant="status">{row.status}</Badge>
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="type">{row.type}</Badge>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="provider">{row.provider}</Badge>
                  </td>
                  <td className="mono px-4 py-2 text-zinc-400">{row.gatewayEventId}</td>
                  <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.createdAt)}</td>
                  <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.updatedAt)}</td>
                </tr>
                {row.error !== null && row.error !== '' && (
                  <tr className="border-b border-line-soft">
                    <td />
                    <td colSpan={5} className="px-4 pb-3">
                      <pre className="mono whitespace-pre-wrap break-words rounded border border-bad/30 bg-bad/[0.06] p-2 text-[11px] text-rose-300">
                        {row.error}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
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
