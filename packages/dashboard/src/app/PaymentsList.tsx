import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { PaymentRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { formatCents, formatWhen } from './money';
import { PaymentDetail } from './PaymentDetail';
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

export function PaymentsList({
  initialStatus,
  initialCustomerId,
  openedGatewayId,
  onOpen,
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
} = {}) {
  const [status, setStatus] = useState<string | undefined>(initialStatus);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);
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
    queryKey: ['payments', status, provider, term, initialCustomerId, offset],
    queryFn: async () => {
      if (term === undefined) {
        return paymentsClient.payments({
          status,
          provider,
          customerId: initialCustomerId,
          limit: PAGE_SIZE,
          offset,
        });
      }
      // Both keys, in that order: `externalReference` is the id the app itself chose, so it is
      // the one an operator is most likely to be holding, and a hit on it is unambiguous. Only
      // if nothing carries the term as a reference is it tried as the gateway's own id.
      const byReference = await paymentsClient.payments({
        provider,
        reference: term,
        limit: PAGE_SIZE,
        offset,
      });
      if (byReference.payments.length > 0) return byReference;
      return paymentsClient.payments({ provider, gatewayId: term, limit: PAGE_SIZE, offset });
    },
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              refilter(() => setSubmitted(lookup));
            }}
          >
            <label className="flex items-center gap-2 text-[11px] text-zinc-500">
              Find
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
                className="mono w-48 rounded-sm border border-line bg-panel px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-brand focus:outline-hidden"
              />
            </label>
          </form>
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
        emptyMessage={emptyMessage(status, provider, term)}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 text-right font-normal">Amount</th>
              {/* The APP's own id leads the two identity columns: it is the one an operator
                  arrives holding, and the one this table used to hide entirely. */}
              <th className="px-4 py-2 font-normal">Reference</th>
              <th className="px-4 py-2 font-normal">Owner</th>
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
                  {row.refundedAmount !== null && row.refundedAmount > 0 && (
                    <div className="text-[10px] text-amber-300">
                      −{formatCents(row.refundedAmount, row.currency)} back
                    </div>
                  )}
                </td>
                <td className="mono px-4 py-2 text-zinc-200">{row.externalReference ?? '—'}</td>
                {/* The app-side owner, not the gateway's `cus_…`: the gateway id names nobody,
                    and it is what this column used to show. The raw id stays in the tooltip. */}
                <td className="px-4 py-2 text-zinc-400" title={row.customerId ?? ''}>
                  {ownerCell(row)}
                </td>
                <td className="mono px-4 py-2 text-zinc-400">
                  {/* A link, not just a button: the detail has a URL now, and a URL is what an
                      operator drags into a ticket. */}
                  <a
                    href={`#/payments/${encodeURIComponent(row.gatewayId)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setOpened(row.gatewayId);
                    }}
                    className="hover:text-zinc-100 hover:underline"
                  >
                    {row.gatewayId}
                  </a>
                </td>
                <td className="px-4 py-2">
                  <Badge variant="provider">{row.provider}</Badge>
                </td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.paidAt)}</td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.createdAt)}</td>
                <td className="flex justify-end gap-1 px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setOpened(row.gatewayId)}
                    className="rounded-sm border border-line px-2 py-1 text-xs text-zinc-400 hover:bg-panel-2 hover:text-zinc-100"
                  >
                    Detail
                  </button>
                  {/* `refundable` is the SERVER's rule, not a re-derivation of it: a button that
                      offers what the endpoint will refuse is a button that only ever errors. */}
                  {row.refundable && (
                    <button
                      type="button"
                      onClick={() => setRefunding(row)}
                      className="rounded-sm border border-line px-2 py-1 text-xs text-zinc-300 hover:bg-panel-2 hover:text-zinc-100"
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
      {opened !== null && <PaymentDetail gatewayId={opened} onClose={() => setOpened(null)} />}
    </Panel>
  );
}

/**
 * Who this payment belongs to IN THE APP.
 *
 * `null` renders as a named absence, not a dash: it means nothing mapped this gateway customer,
 * so no screen in this console can ever say whose payment it is. That is a finding about the
 * install (`ensureCustomer` is not being called), and it should read like one.
 */
function ownerCell(row: PaymentRow) {
  const owner = row.owner;
  if (owner === null || owner.id === null) {
    return <span className="text-zinc-600">unmapped</span>;
  }
  return <span className="mono">{owner.name ?? `${owner.type ?? '?'} · ${owner.id}`}</span>;
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
