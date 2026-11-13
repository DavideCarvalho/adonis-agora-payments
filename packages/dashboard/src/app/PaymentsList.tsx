import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Column } from '../agora-kit/blocks/data-table';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import type { PaymentRow, TenantPicker } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { CardIcon } from './icons';
import { formatCents, formatCount, formatWhen } from './money';
import { PaymentDetail } from './PaymentDetail';
import { RefundDialog } from './RefundDialog';
import { ListPanel, Mono } from './shell';
import { paymentStatusClass } from './status';
import { Badge, StatusBadge } from './ui/badge';
import { CONTROL_CLASS, FieldLabel } from './ui/field';
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

export function PaymentsList({
  initialStatus,
  initialCustomerId,
  openedGatewayId,
  onOpen,
  organizations,
}: {
  initialStatus?: string | undefined;
  initialCustomerId?: string | undefined;
  /**
   * The payment whose detail dialog is open, owned by the CALLER: it lives in the URL hash
   * (`#/payments/<gatewayId>`, see `routes.ts`) so a detail view survives a reload and can be
   * pasted into a ticket. `null` = closed.
   */
  openedGatewayId?: string | null | undefined;
  /** Open (`gatewayId`) or close (`null`) the detail dialog. */
  onOpen?: ((gatewayId: string | null) => void) | undefined;
  /** Viewing every organization at once (tenancy): adds an "Organization" column. */
  organizations?: TenantPicker | undefined;
} = {}) {
  const [status, setStatus] = useState<string | undefined>(initialStatus);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);
  // Uncontrolled fallback for a caller that does not route the detail dialog (a test, a host
  // embedding just this screen). `App` always does.
  const [openedLocal, setOpenedLocal] = useState<string | null>(null);
  const opened = onOpen === undefined ? openedLocal : (openedGatewayId ?? null);
  const setOpened = onOpen ?? setOpenedLocal;
  /**
   * The lookup box. One field, two meanings, resolved by the SERVER: it is sent as both
   * `reference` and `gatewayId`, and whichever matches wins.
   *
   * An operator holding a paste from a support ticket does not know which of the two they have —
   * `order-4102` and `pay_8f2…` look different to us and identical to them — and making them
   * choose the right field first is how a lookup becomes a thing nobody uses.
   */
  const [lookup, setLookup] = useState('');
  const [submitted, setSubmitted] = useState('');

  const term = submitted.trim() === '' ? undefined : submitted.trim();
  const query = useQuery({
    queryKey: ['payments', status, provider, term, initialCustomerId, page],
    queryFn: async () => {
      if (term === undefined) {
        return paymentsClient.payments({
          status,
          provider,
          customerId: initialCustomerId,
          size: PAGE_SIZE,
          page,
        });
      }
      // Both keys, in that order: `externalReference` is the id the app itself chose, so it is
      // the one an operator is most likely to be holding, and a hit on it is unambiguous. Only
      // if nothing carries the term as a reference is it tried as the gateway's own id.
      const byReference = await paymentsClient.payments({
        provider,
        externalReference: term,
        size: PAGE_SIZE,
        page,
      });
      if (byReference.data.length > 0) return byReference;
      return paymentsClient.payments({ provider, gatewayId: term, size: PAGE_SIZE, page });
    },
  });

  // A filter change makes the current page meaningless — page 3 of "all" is not page 3 of
  // "failed", nor page 3 of "asaas".
  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <PageBody>
      <PageHeader
        title="Payments"
        description="Every payment recorded locally by webhook processing, newest first."
      />
      <Toolbar label="Payment filters" className="gap-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            refilter(() => setSubmitted(lookup));
          }}
        >
          <FieldLabel label="Find">
            <input
              type="search"
              value={lookup}
              onChange={(event) => {
                setLookup(event.target.value);
                // Clearing the box clears the search, without needing a second keystroke.
                if (event.target.value === '') refilter(() => setSubmitted(''));
              }}
              placeholder="order-4102 or pay_8f2…"
              aria-label="Reference or gateway id"
              className={`mono w-48 ${CONTROL_CLASS}`}
            />
          </FieldLabel>
        </form>
        <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
        <Segmented
          aria-label="Payment status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => refilter(() => setStatus(value))}
        />
      </Toolbar>

      <ListPanel
        title="Recorded payments"
        description={
          query.data !== undefined ? `${formatCount(query.data.meta.total)} total` : undefined
        }
        query={query}
        rowKey={(row) => row.id}
        onPage={setPage}
        emptyIcon={<CardIcon />}
        emptyTitle={term !== undefined ? 'No match' : 'No payments'}
        emptyDescription={emptyMessage(status, provider, term)}
        columns={paymentColumns({
          organizations,
          onOpen: (row) => setOpened(row.gatewayId),
          onRefund: setRefunding,
        })}
      >
        {refunding !== null && (
          <RefundDialog payment={refunding} onClose={() => setRefunding(null)} />
        )}
        {opened !== null && <PaymentDetail gatewayId={opened} onClose={() => setOpened(null)} />}
      </ListPanel>
    </PageBody>
  );
}

/** The payments table's columns (presentational: rows in, cells out). */
function paymentColumns({
  organizations,
  onOpen,
  onRefund,
}: {
  organizations: TenantPicker | undefined;
  onOpen: (row: PaymentRow) => void;
  onRefund: (row: PaymentRow) => void;
}): Column<PaymentRow>[] {
  const columns: Column<PaymentRow>[] = [
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <StatusBadge statusClass={paymentStatusClass(row.status)}>{row.status}</StatusBadge>
      ),
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (row) => (
        <span className="mono tnum text-[12.5px] text-fg">
          {/* Integer minor units came over the wire; this is the only shift. */}
          {formatCents(row.amount, row.currency)}
          {row.refundedAmount !== null && row.refundedAmount > 0 && (
            <span className="block text-[10px] text-warn">
              −{formatCents(row.refundedAmount, row.currency)} back
            </span>
          )}
        </span>
      ),
    },
    // The APP's own id leads the two identity columns: it is the one an operator arrives
    // holding, and the one this table used to hide entirely.
    {
      id: 'reference',
      header: 'Reference',
      cell: (row) => <Mono className="text-fg-2">{row.externalReference ?? '—'}</Mono>,
    },
  ];
  if (organizations !== undefined) {
    columns.push({
      id: 'organization',
      header: 'Organization',
      hideBelow: 'md',
      cell: (row) => (
        <span className="text-fg-2" data-column="organization">
          {organizationOf(row, organizations)}
        </span>
      ),
    });
  }
  columns.push(
    {
      // The app-side owner, not the gateway's `cus_…`: the gateway id names nobody, and it is what
      // this column used to show. The raw id stays in the tooltip.
      id: 'owner',
      header: 'Owner',
      hideBelow: 'md',
      cell: (row) => <span title={row.customerId ?? ''}>{ownerCell(row)}</span>,
    },
    {
      id: 'gateway',
      header: 'Gateway id',
      hideBelow: 'sm',
      cell: (row) => (
        // A link, not just a button: the detail has a URL, and a URL is what an operator drags
        // into a ticket.
        <a
          href={`#/payments/${encodeURIComponent(row.gatewayId)}`}
          onClick={(event) => {
            event.preventDefault();
            onOpen(row);
          }}
          className="mono text-[12px] text-dim underline decoration-line-strong decoration-dotted underline-offset-4 hover:text-brand"
        >
          {row.gatewayId}
        </a>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      hideBelow: 'lg',
      cell: (row) => <Badge variant="provider">{row.provider}</Badge>,
    },
    {
      // One column for both dates: a paid row shows when it settled, any other when it was created.
      id: 'when',
      header: 'Paid / created',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="flex flex-col">
          <Mono className="text-fg-2">{formatWhen(row.paidAt ?? row.createdAt)}</Mono>
          <span className="text-[10px] text-faint">{row.paidAt !== null ? 'paid' : 'created'}</span>
        </span>
      ),
    },
    {
      id: 'action',
      header: <span className="sr-only">Action</span>,
      align: 'right',
      cell: (row) => (
        <span className="inline-flex justify-end gap-1">
          <Button variant="outline" size="sm" onClick={() => onOpen(row)}>
            Detail
          </Button>
          {/* `refundable` is the SERVER's rule, not a re-derivation of it: a button that offers
              what the endpoint will refuse is a button that only ever errors. */}
          {row.refundable && (
            <Button variant="outline" size="sm" onClick={() => onRefund(row)}>
              Refund
            </Button>
          )}
        </span>
      ),
    },
  );
  return columns;
}

/**
 * Who this payment belongs to IN THE APP.
 *
 * `null` renders as a named absence, not a dash: it means nothing mapped this gateway customer,
 * so no screen in this console can ever say whose payment it is. That is a finding about the
 * install (`ensureCustomer` is not being called), and it should read like one.
 */
/** The organization a payment belongs to (its customer's owner, when that is an organization). */
function organizationOf(row: PaymentRow, picker: TenantPicker): string {
  const owner = row.owner;
  if (owner === null || owner.id === null || owner.type === null) return '—';
  if (!picker.ownerTypes.includes(owner.type)) return '—';
  return picker.tenants.find((t) => t.id === owner.id)?.label ?? owner.id;
}

function ownerCell(row: PaymentRow) {
  const owner = row.owner;
  if (owner === null || owner.id === null) {
    return <span className="text-faint">unmapped</span>;
  }
  return (
    <span className="mono text-[12px] text-fg-2">
      {owner.name ?? `${owner.type ?? '?'} · ${owner.id}`}
    </span>
  );
}

function emptyMessage(
  status: string | undefined,
  provider: string | undefined,
  term: string | undefined,
): string {
  // The lookup answer first, and it is a DIFFERENT sentence: "no payments" reads as an empty
  // install, when what actually happened is that this one reference matched nothing.
  if (term !== undefined) {
    return `No payment carries the reference or gateway id “${term}”. If the charge was created, its webhook never arrived — check the Activity screen for refused deliveries.`;
  }
  if (status === undefined && provider === undefined) return 'No payments recorded yet.';
  const parts = [
    status !== undefined ? `status “${status}”` : undefined,
    provider !== undefined ? `gateway “${provider}”` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `No payments with ${parts.join(' and ')}.`;
}
