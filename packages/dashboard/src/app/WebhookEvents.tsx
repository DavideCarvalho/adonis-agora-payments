import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Column } from '../agora-kit/blocks/data-table';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { paymentsClient, type WebhookEventRow } from '../client/payments-client';
import { PlugIcon } from './icons';
import { formatCount, formatWhen } from './money';
import { ListPanel, Mono } from './shell';
import { isActionable, webhookStatusClass } from './status';
import { Badge, StatusBadge } from './ui/badge';
import { EventTypeFilter } from './ui/event-type-filter';
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
  const [type, setType] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['webhook-events', status, provider, type, page],
    queryFn: () => paymentsClient.webhookEvents({ status, provider, type, size: PAGE_SIZE, page }),
  });

  const retry = useMutation({
    mutationFn: (gatewayEventId: string) => paymentsClient.retryWebhookEvent(gatewayEventId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['webhook-events'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const columns: Column<WebhookEventRow>[] = [
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <StatusBadge statusClass={webhookStatusClass(row.status)}>{row.status}</StatusBadge>
      ),
    },
    { id: 'type', header: 'Type', cell: (row) => <Badge variant="type">{row.type}</Badge> },
    {
      id: 'provider',
      header: 'Provider',
      hideBelow: 'md',
      cell: (row) => <Badge variant="provider">{row.provider}</Badge>,
    },
    {
      id: 'event',
      header: 'Gateway event id',
      hideBelow: 'sm',
      cell: (row) => <Mono>{row.gatewayEventId}</Mono>,
    },
    {
      id: 'received',
      header: 'Received',
      hideBelow: 'lg',
      cell: (row) => <Mono className="text-faint">{formatWhen(row.createdAt)}</Mono>,
    },
    {
      id: 'updated',
      header: 'Updated',
      hideBelow: 'lg',
      cell: (row) => <Mono className="text-faint">{formatWhen(row.updatedAt)}</Mono>,
    },
    {
      id: 'action',
      header: <span className="sr-only">Action</span>,
      align: 'right',
      // `retryable` is the server's rule. Disabled while in flight: the ledger would refuse a
      // second claim anyway, but a button that still looks clickable reads as one that did nothing.
      cell: (row) =>
        row.retryable ? (
          <Button
            variant="outline"
            size="sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate(row.gatewayEventId)}
          >
            {retry.isPending && retry.variables === row.gatewayEventId ? 'Retrying…' : 'Retry'}
          </Button>
        ) : null,
    },
  ];

  return (
    <PageBody>
      <PageHeader
        title="Webhook events"
        description="The idempotency ledger. A failed row means a handler threw and the dispatcher gave up — its effect never happened."
      />
      <Toolbar label="Event filters" className="gap-3">
        <EventTypeFilter value={type} onChange={(v) => refilter(() => setType(v))} />
        <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
        <Segmented
          aria-label="Event status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => refilter(() => setStatus(value))}
        />
      </Toolbar>
      <ListPanel
        title="Ledger"
        description={
          query.data !== undefined ? `${formatCount(query.data.meta.total)} events` : undefined
        }
        query={query}
        rowKey={(row) => row.id}
        onPage={setPage}
        emptyIcon={<PlugIcon />}
        emptyTitle={status === 'failed' && type === undefined ? 'Nothing is stuck' : 'No events'}
        emptyDescription={emptyMessage(status, provider, type)}
        rowClassName={(row) => (isActionable(row.status) ? 'bg-bad/[0.04]' : undefined)}
        columns={columns}
        subRow={(row) => {
          const failedHere = retry.isError && retry.variables === row.gatewayEventId;
          const hasError = row.error !== null && row.error !== '';
          if (!hasError && !failedHere) return null;
          return (
            <div className="flex flex-col gap-2">
              {hasError && (
                <pre className="mono whitespace-pre-wrap wrap-break-word rounded-md border border-bad/25 bg-bad/[0.06] p-2 text-[11px] text-bad">
                  {row.error}
                </pre>
              )}
              {failedHere && (
                <p className="rounded-md border border-warn/30 bg-warn/[0.08] p-2 text-[11px] text-warn">
                  Retry refused:{' '}
                  {retry.error instanceof Error ? retry.error.message : 'unknown reason'}
                </p>
              )}
            </div>
          );
        }}
      />
    </PageBody>
  );
}

function emptyMessage(
  status: string | undefined,
  provider: string | undefined,
  type?: string | undefined,
): string {
  // The type answer first: "no webhook events" would read as a dead endpoint, when what was
  // actually asked was whether ONE kind of event ever arrived.
  if (type !== undefined) {
    const scope = provider === undefined ? '' : ` from “${provider}”`;
    return `No “${type}” event has ever arrived${scope}. If the gateway says it sent one, it was refused before it reached the ledger — check the Activity screen.`;
  }
  if (provider !== undefined) {
    return status === undefined
      ? `No webhook events from “${provider}”.`
      : `No “${status}” webhook events from “${provider}”.`;
  }
  if (status === 'failed') return 'No failed webhook events. Nothing is stuck.';
  if (status === undefined) return 'No webhook events recorded yet.';
  return `No webhook events with status “${status}”.`;
}
