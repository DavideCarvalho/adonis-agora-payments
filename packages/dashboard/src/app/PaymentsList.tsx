import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { paymentsClient } from '../client/payments-client';
import { formatCents, formatWhen } from './money';
import { Pager, Panel, QueryState } from './shell';
import { paymentStatusClass } from './status';
import { Badge } from './ui/badge';
import { Segmented } from './ui/segmented';

const PAGE_SIZE = 50;

const STATUS_OPTIONS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'paid', label: 'Paid' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'canceled', label: 'Canceled' },
];

export function PaymentsList() {
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['payments', status, offset],
    queryFn: () => paymentsClient.payments({ status, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.payments ?? [];

  return (
    <Panel
      title="Payments"
      subtitle="Every payment recorded locally by webhook processing, newest first."
      actions={
        <Segmented
          aria-label="Payment status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            // A filter change makes the current offset meaningless — page 3 of "all" is not
            // page 3 of "failed".
            setOffset(0);
          }}
        />
      }
    >
      <QueryState
        query={query}
        empty={rows.length === 0}
        emptyMessage={
          status === undefined
            ? 'No payments recorded yet.'
            : `No payments with status “${status}”.`
        }
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 text-right font-normal">Amount</th>
              <th className="px-4 py-2 font-normal">Gateway id</th>
              <th className="px-4 py-2 font-normal">Provider</th>
              <th className="px-4 py-2 font-normal">Paid at</th>
              <th className="px-4 py-2 font-normal">Created</th>
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
                  {/* Integer cents came over the wire; this is the only division. */}
                  {formatCents(row.amount, row.currency)}
                </td>
                <td className="mono px-4 py-2 text-zinc-400">{row.gatewayId}</td>
                <td className="px-4 py-2">
                  <Badge variant="provider">{row.provider}</Badge>
                </td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.paidAt)}</td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.createdAt)}</td>
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
