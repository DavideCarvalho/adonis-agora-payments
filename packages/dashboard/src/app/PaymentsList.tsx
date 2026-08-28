import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { PaymentRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { formatCents, formatWhen } from './money';
import { RefundDialog } from './RefundDialog';
import { Pager, Panel, QueryState, ScanNotice } from './shell';
import { paymentStatusClass } from './status';
import { Badge } from './ui/badge';
import { ProviderFilter } from './ui/provider-filter';
import { Segmented } from './ui/segmented';

const PAGE_SIZE = 50;

const STATUS_OPTIONS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'paid', label: 'Paid' },
  { value: 'authorized', label: 'Authorized' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'canceled', label: 'Canceled' },
];

export function PaymentsList({ initialStatus }: { initialStatus?: string | undefined } = {}) {
  const [status, setStatus] = useState<string | undefined>(initialStatus);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);

  const query = useQuery({
    queryKey: ['payments', status, provider, offset],
    queryFn: () => paymentsClient.payments({ status, provider, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.payments ?? [];
  // A filter change makes the current offset meaningless — page 3 of "all" is not page 3 of
  // "failed", nor page 3 of "asaas".
  const refilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <Panel
      title="Payments"
      subtitle="Every payment recorded locally by webhook processing, newest first."
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
          <Segmented
            aria-label="Payment status"
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
              <th className="px-4 py-2 text-right font-normal">Amount</th>
              <th className="px-4 py-2 font-normal">Customer</th>
              <th className="px-4 py-2 font-normal">Gateway id</th>
              <th className="px-4 py-2 font-normal">Provider</th>
              <th className="px-4 py-2 font-normal">Paid at</th>
              <th className="px-4 py-2 font-normal">Created</th>
              <th className="px-4 py-2 text-right font-normal">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line-soft last:border-0">
                <td className="px-4 py-2">
                  <span className={paymentStatusClass(row.status)}>
                    <Badge variant="status">{row.status}</Badge>
                  </span>
                </td>
                <td className="mono tnum px-4 py-2 text-right text-zinc-100">
                  {/* Integer minor units came over the wire; this is the only shift. */}
                  {formatCents(row.amount, row.currency)}
                </td>
                <td className="mono px-4 py-2 text-zinc-400">{row.customerId ?? '—'}</td>
                <td className="mono px-4 py-2 text-zinc-400">{row.gatewayId}</td>
                <td className="px-4 py-2">
                  <Badge variant="provider">{row.provider}</Badge>
                </td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.paidAt)}</td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.createdAt)}</td>
                <td className="px-4 py-2 text-right">
                  {/* `refundable` is the SERVER's rule, not a re-derivation of it: a button that
                      offers what the endpoint will refuse is a button that only ever errors. */}
                  {row.refundable && (
                    <button
                      type="button"
                      onClick={() => setRefunding(row)}
                      className="rounded border border-line px-2 py-1 text-xs text-zinc-300 hover:bg-panel-2 hover:text-zinc-100"
                    >
                      Refund
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ScanNotice page={query.data?.page} noun="payments" />
        <Pager
          limit={query.data?.page.limit ?? PAGE_SIZE}
          offset={query.data?.page.offset ?? offset}
          count={query.data?.page.count ?? 0}
          onOffset={setOffset}
        />
      </QueryState>

      {refunding !== null && (
        <RefundDialog payment={refunding} onClose={() => setRefunding(null)} />
      )}
    </Panel>
  );
}

function emptyMessage(status: string | undefined, provider: string | undefined): string {
  if (status === undefined && provider === undefined) return 'No payments recorded yet.';
  const parts = [
    status !== undefined ? `status “${status}”` : undefined,
    provider !== undefined ? `gateway “${provider}”` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `No payments with ${parts.join(' and ')}.`;
}
