import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { paymentsClient } from '../client/payments-client';
import { formatWhen } from './money';
import { Pager, Panel, QueryState, ScanNotice } from './shell';
import { isActionable, webhookStatusClass } from './status';
import { Badge } from './ui/badge';
import { ProviderFilter } from './ui/provider-filter';
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
 *
 * Retry is the one thing that closes the loop: fix the handler, click it, and the event's effect
 * finally happens. It is safe to repeat — the ledger re-claims a `failed` event and refuses an
 * in-flight or already-processed one, so a redelivery can never double-apply.
 */
export function WebhookEvents({ initialStatus }: { initialStatus?: string | undefined } = {}) {
  const [status, setStatus] = useState<string | undefined>(initialStatus ?? 'failed');
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['webhook-events', status, provider, offset],
    queryFn: () => paymentsClient.webhookEvents({ status, provider, limit: PAGE_SIZE, offset }),
  });

  const retry = useMutation({
    mutationFn: (gatewayEventId: string) => paymentsClient.retryWebhookEvent(gatewayEventId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['webhook-events'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const rows = query.data?.events ?? [];
  const refilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <Panel
      title="Webhook events"
      subtitle="The idempotency ledger. A failed row means a handler threw and the dispatcher gave up — its effect never happened."
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
          <Segmented
            aria-label="Event status"
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
        emptyMessage={emptyMessage(status, provider)}
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
              <th className="px-4 py-2 text-right font-normal">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const inFlight = retry.isPending && retry.variables === row.gatewayEventId;
              const failedHere = retry.isError && retry.variables === row.gatewayEventId;
              return (
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
                    <td className="px-4 py-2 text-right">
                      {/* `retryable` is the server's rule. Disabled while in flight: the ledger
                          would refuse a second claim anyway, but a button that still looks
                          clickable reads as one that did nothing. */}
                      {row.retryable && (
                        <button
                          type="button"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(row.gatewayEventId)}
                          className="rounded border border-line px-2 py-1 text-xs text-zinc-300 enabled:hover:bg-panel-2 enabled:hover:text-zinc-100 disabled:opacity-40"
                        >
                          {inFlight ? 'Retrying…' : 'Retry'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {row.error !== null && row.error !== '' && (
                    <tr className="border-b border-line-soft">
                      <td />
                      <td colSpan={6} className="px-4 pb-3">
                        <pre className="mono whitespace-pre-wrap break-words rounded border border-bad/30 bg-bad/[0.06] p-2 text-[11px] text-rose-300">
                          {row.error}
                        </pre>
                      </td>
                    </tr>
                  )}
                  {failedHere && (
                    <tr className="border-b border-line-soft">
                      <td />
                      <td colSpan={6} className="px-4 pb-3">
                        <p className="rounded border border-warn/40 bg-warn/[0.08] p-2 text-[11px] text-amber-300">
                          Retry refused:{' '}
                          {retry.error instanceof Error ? retry.error.message : 'unknown reason'}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <ScanNotice page={query.data?.page} noun="events" />
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

function emptyMessage(status: string | undefined, provider: string | undefined): string {
  if (provider !== undefined) {
    return status === undefined
      ? `No webhook events from “${provider}”.`
      : `No “${status}” webhook events from “${provider}”.`;
  }
  if (status === 'failed') return 'No failed webhook events. Nothing is stuck.';
  if (status === undefined) return 'No webhook events recorded yet.';
  return `No webhook events with status “${status}”.`;
}
