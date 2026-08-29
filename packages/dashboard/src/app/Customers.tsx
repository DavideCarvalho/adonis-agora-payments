import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { paymentsClient } from '../client/payments-client';
import { formatWhen } from './money';
import { Pager, Panel, QueryState } from './shell';
import { Badge } from './ui/badge';
import { ProviderFilter } from './ui/provider-filter';

const PAGE_SIZE = 50;

/**
 * Customers — the mapping between the gateway and the app.
 *
 * The screen the console did not have, over a table it already wrote. `billing_customers` holds
 * `owner_type`/`owner_id`, put there by the app itself through `ensureCustomer`, and that pair is
 * the ONLY thing tying a payment to a person: a payment row carries `cus_…` and nothing more.
 * Without this the console could show every charge in the system and still not answer "which of
 * these belongs to user 4102".
 *
 * An empty `owner` column is worth reading as a finding rather than a blank: it means charges are
 * being taken through a gateway customer nobody mapped, and no screen here will ever be able to
 * name who they belong to.
 */
export function Customers({ onOpenPayments }: { onOpenPayments?: (customerId: string) => void }) {
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [owner, setOwner] = useState('');
  const [offset, setOffset] = useState(0);

  const ownerId = owner.trim() === '' ? undefined : owner.trim();
  const query = useQuery({
    queryKey: ['customers', provider, ownerId, offset],
    queryFn: () => paymentsClient.customers({ provider, ownerId, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.customers ?? [];

  return (
    <Panel
      title="Customers"
      subtitle="The gateway customer ↔ app owner mapping written by ensureCustomer. Without a row here, a payment names nobody."
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <ProviderFilter
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setOffset(0);
            }}
          />
          <label className="flex items-center gap-2 text-[11px] text-zinc-500">
            Owner id
            <input
              type="search"
              value={owner}
              onChange={(event) => {
                setOwner(event.target.value);
                setOffset(0);
              }}
              placeholder="4102"
              className="mono w-32 rounded border border-line bg-panel px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-brand focus:outline-none"
            />
          </label>
        </div>
      }
    >
      <QueryState
        query={query}
        empty={rows.length === 0}
        emptyMessage={
          ownerId === undefined
            ? 'No customer mapping recorded. If charges are landing anyway, the app is not calling ensureCustomer — nothing here can tie them to a user.'
            : `No customer mapped to owner “${ownerId}”.`
        }
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">Owner</th>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Email</th>
              <th className="px-4 py-2 font-normal">Gateway customer</th>
              <th className="px-4 py-2 font-normal">Provider</th>
              <th className="px-4 py-2 font-normal">Recorded</th>
              <th className="px-4 py-2 text-right font-normal">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line-soft last:border-0">
                <td className="mono px-4 py-2 text-zinc-200">
                  {row.ownerId === null ? (
                    // Not a blank: this is a gateway customer nobody mapped, and every payment
                    // it takes is a payment this console can never attribute.
                    <span className="text-amber-300">unmapped</span>
                  ) : (
                    `${row.ownerType ?? '?'} · ${row.ownerId}`
                  )}
                </td>
                <td className="px-4 py-2 text-zinc-300">{row.name ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-400">{row.email ?? '—'}</td>
                <td className="mono px-4 py-2 text-zinc-400">{row.gatewayId}</td>
                <td className="px-4 py-2">
                  <Badge variant="provider">{row.provider}</Badge>
                </td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.createdAt)}</td>
                <td className="px-4 py-2 text-right">
                  {onOpenPayments !== undefined && (
                    <button
                      type="button"
                      onClick={() => onOpenPayments(row.gatewayId)}
                      className="rounded border border-line px-2 py-1 text-xs text-zinc-300 hover:bg-panel-2 hover:text-zinc-100"
                    >
                      Payments
                    </button>
                  )}
                </td>
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
