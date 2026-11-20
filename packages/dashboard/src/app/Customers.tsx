import { useQuery } from '@tanstack/react-query';
import { parseAsString, useQueryStates } from 'nuqs';
import type { Column } from '../agora-kit/blocks/data-table';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { UsersIcon } from '../agora-kit/icons';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { type CustomerRow, paymentsClient } from '../client/payments-client';
import { formatCount } from './money';
import { ListPanel, Mono, Stamp } from './shell';
import { Badge } from './ui/badge';
import { CONTROL_CLASS, FieldLabel } from './ui/field';
import { ProviderFilter } from './ui/provider-filter';
import { afterParam, cursorPaging, optionalParam } from './url-state';

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
export const customersParams = {
  provider: optionalParam,
  owner: parseAsString.withDefault(''),
  after: afterParam,
};

export function Customers({
  onOpenPayments,
  onOpenSubscriptions,
}: {
  onOpenPayments?: (customerId: string) => void;
  onOpenSubscriptions?: (customerId: string) => void;
}) {
  // `#/customers?provider=asaas&owner=4102&page=2`. Typing the owner id replaces the history
  // entry; a gateway or page pick adds one. Any filter change goes back to page 1.
  const [view, setView] = useQueryStates(customersParams, { history: 'push' });
  const provider = view.provider ?? undefined;
  const owner = view.owner;
  const paging = cursorPaging(view.after, (next) => void setView({ after: next }));

  const ownerId = owner.trim() === '' ? undefined : owner.trim();
  const query = useQuery({
    queryKey: ['customers', provider, ownerId, paging.after],
    queryFn: () =>
      paymentsClient.customers({ provider, ownerId, size: PAGE_SIZE, after: paging.after }),
  });

  return (
    <PageBody>
      <PageHeader
        title="Customers"
        description="The gateway customer ↔ app owner mapping written by ensureCustomer. Without a row here, a payment names nobody."
      />
      <Toolbar label="Customer filters" className="gap-3">
        <ProviderFilter
          value={provider}
          onChange={(v) => void setView({ provider: v ?? null, after: null })}
        />
        <FieldLabel label="Owner id">
          <input
            type="search"
            value={owner}
            onChange={(event) =>
              void setView({ owner: event.target.value, after: null }, { history: 'replace' })
            }
            placeholder="4102"
            className={`mono w-32 ${CONTROL_CLASS}`}
          />
        </FieldLabel>
      </Toolbar>
      <ListPanel
        title="Customer mappings"
        query={query}
        rowKey={(row) => row.id}
        cursor={paging}
        emptyIcon={<UsersIcon />}
        emptyTitle={ownerId === undefined ? 'No customer mapping recorded' : 'No match'}
        emptyDescription={
          ownerId === undefined
            ? 'If charges are landing anyway, the app is not calling ensureCustomer — nothing here can tie them to a user.'
            : `No customer mapped to owner “${ownerId}”.`
        }
        columns={customerColumns({
          ...(onOpenPayments ? { onOpenPayments } : {}),
          ...(onOpenSubscriptions ? { onOpenSubscriptions } : {}),
        })}
      />
    </PageBody>
  );
}

/** The customers table's columns (presentational). */
function customerColumns({
  onOpenPayments,
  onOpenSubscriptions,
}: {
  onOpenPayments?: (customerId: string) => void;
  onOpenSubscriptions?: (customerId: string) => void;
}): Column<CustomerRow>[] {
  return [
    {
      id: 'owner',
      header: 'Owner',
      cell: (row) =>
        row.ownerId === null ? (
          // Not a blank: this is a gateway customer nobody mapped, and every payment it takes is a
          // payment this console can never attribute.
          <span className="mono text-[12px] text-warn">unmapped</span>
        ) : (
          <Mono className="text-fg">{`${row.ownerType ?? '?'} · ${row.ownerId}`}</Mono>
        ),
    },
    {
      id: 'name',
      header: 'Name',
      hideBelow: 'md',
      cell: (row) => <span className="text-fg-2">{row.name ?? '—'}</span>,
    },
    { id: 'email', header: 'Email', hideBelow: 'md', cell: (row) => row.email ?? '—' },
    {
      id: 'gateway',
      header: 'Gateway customer',
      hideBelow: 'sm',
      cell: (row) => <Mono>{row.gatewayId}</Mono>,
    },
    {
      id: 'provider',
      header: 'Provider',
      hideBelow: 'lg',
      cell: (row) => <Badge variant="provider">{row.provider}</Badge>,
    },
    {
      id: 'recorded',
      header: 'Created',
      hideBelow: 'lg',
      cell: (row) => <Stamp iso={row.createdAt} />,
    },
    {
      id: 'action',
      header: <span className="sr-only">Action</span>,
      align: 'right',
      cell: (row) => (
        <span className="inline-flex justify-end gap-1">
          {onOpenSubscriptions !== undefined && (
            <Button variant="outline" size="sm" onClick={() => onOpenSubscriptions(row.gatewayId)}>
              Subscriptions
            </Button>
          )}
          {onOpenPayments !== undefined && (
            <Button variant="outline" size="sm" onClick={() => onOpenPayments(row.gatewayId)}>
              Payments
            </Button>
          )}
        </span>
      ),
    },
  ];
}
