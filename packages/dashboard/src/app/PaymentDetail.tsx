import { useQuery } from '@tanstack/react-query';
import { paymentsClient } from '../client/payments-client';
import { formatCents, formatWhen } from './money';
import { disputeStatusClass, paymentStatusClass, webhookStatusClass } from './status';
import { Badge } from './ui/badge';

/**
 * Everything this system knows about ONE payment.
 *
 * Deliberately NOT titled "history", and the panel says so out loud. `billing_payments` is a
 * single mutable row upserted in place: there is no record of what it used to be, so "what
 * changed, and when?" genuinely has no answer here. What this assembles is what IS knowable —
 * the current state, who it belongs to in the app, the disputes filed against it, the deliveries
 * whose stored payload names it, and who refunded it from this console.
 *
 * The ledger strand carries a caveat on screen rather than in a comment: it is found by a
 * substring scan over the stored payload, which can over-match and can miss. Reading "3 events"
 * as "exactly the 3 events that touched this payment" is the mistake the caveat exists to stop.
 */
export function PaymentDetail({ gatewayId, onClose }: { gatewayId: string; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['payment', gatewayId],
    queryFn: () => paymentsClient.payment(gatewayId),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <dialog
        open
        aria-modal="true"
        aria-label="Payment detail"
        className="relative m-0 w-full max-w-3xl rounded-sm border border-line bg-panel-2 p-0 text-inherit shadow-xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="mono min-w-0 break-all text-sm text-zinc-100">{gatewayId}</h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-sm border border-line px-2 py-1 text-xs text-zinc-300 hover:bg-panel"
          >
            Close
          </button>
        </header>

        {query.isPending && <p className="p-4 text-sm text-zinc-500">Loading…</p>}
        {query.isError && (
          <p className="m-4 rounded-sm border border-bad/40 bg-bad/10 p-3 text-sm text-rose-300">
            {query.error instanceof Error ? query.error.message : 'Request failed.'}
          </p>
        )}

        {query.data !== undefined && (
          <div className="flex flex-col gap-4 px-4 py-4">
            <section>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Current state</p>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-[11px] text-zinc-500">Status</dt>
                <dd>
                  <span className={paymentStatusClass(query.data.payment.status)}>
                    <Badge variant="status">{query.data.payment.status}</Badge>
                  </span>
                </dd>
                <dt className="text-[11px] text-zinc-500">Amount</dt>
                <dd className="mono tnum text-zinc-100">
                  {formatCents(query.data.payment.amount, query.data.payment.currency)}
                  {/* Net, spelled out. A partial refund leaves `status: 'paid'` at the full
                      amount on purpose — the row is not lying, it is just not the whole story. */}
                  {query.data.payment.refundedAmount !== null &&
                    query.data.payment.refundedAmount > 0 && (
                      <span className="ml-2 text-[11px] text-amber-300">
                        −
                        {formatCents(
                          query.data.payment.refundedAmount,
                          query.data.payment.currency,
                        )}{' '}
                        refunded
                      </span>
                    )}
                </dd>
                <dt className="text-[11px] text-zinc-500">Reference</dt>
                <dd className="mono break-all text-zinc-200">
                  {query.data.payment.externalReference ?? '— (the gateway echoed none)'}
                </dd>
                <dt className="text-[11px] text-zinc-500">Owner</dt>
                <dd className="mono text-zinc-300">{ownerLabel(query.data.payment.owner)}</dd>
                <dt className="text-[11px] text-zinc-500">Paid at</dt>
                <dd className="mono text-zinc-400">{formatWhen(query.data.payment.paidAt)}</dd>
              </dl>
            </section>

            <Strand
              title="Disputes"
              empty="No dispute has been filed against this payment."
              count={query.data.disputes.length}
            >
              <ul className="mt-2 flex flex-col gap-1.5">
                {query.data.disputes.map((dispute) => (
                  <li key={dispute.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={disputeStatusClass(dispute.status)}>
                      <Badge variant="status">{dispute.status}</Badge>
                    </span>
                    <span className="mono text-zinc-400">{dispute.gatewayId}</span>
                    <span className="text-zinc-500">{dispute.reason ?? 'no reason given'}</span>
                    <span className="mono ml-auto text-zinc-500">
                      {formatWhen(dispute.openedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Strand>

            <Strand
              title="Deliveries naming this payment"
              empty="No stored delivery names this payment."
              count={query.data.events.rows.length}
              caveat={`Found by ${query.data.events.matchedBy} — an unindexed scan over the stored payload. It can match a delivery that merely mentions this id, and it cannot see one that never stored it.`}
            >
              <ul className="mt-2 flex flex-col gap-1.5">
                {query.data.events.rows.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={webhookStatusClass(event.status)}>
                      <Badge variant="status">{event.status}</Badge>
                    </span>
                    <Badge variant="type">{event.type}</Badge>
                    <Badge variant="provider">{event.provider}</Badge>
                    <span className="mono ml-auto text-zinc-500">
                      {formatWhen(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Strand>

            <Strand
              title="What people did to it"
              empty="Nobody has refunded this payment from the console."
              count={query.data.audit.length}
            >
              <ul className="mt-2 flex flex-col gap-1.5">
                {query.data.audit.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <Badge variant="type">{entry.action}</Badge>
                    <span className="text-zinc-300">{entry.actor ?? '— unattributed'}</span>
                    {entry.amount !== null && (
                      <span className="mono tnum text-zinc-200">
                        {formatCents(entry.amount, entry.currency ?? query.data.currency)}
                      </span>
                    )}
                    <span className="mono ml-auto text-zinc-500">
                      {formatWhen(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Strand>

            <p className="text-[11px] text-zinc-600">
              This is not a history. `billing_payments` is one mutable row upserted in place, so
              what the payment used to be is not recorded anywhere — only what is knowable now.
            </p>
          </div>
        )}
      </dialog>
    </div>
  );
}

/** One section of the detail view, with its own empty state. */
function Strand({
  title,
  empty,
  count,
  caveat,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  caveat?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{title}</p>
      {count === 0 ? (
        <p className="mt-1 text-[11px] text-zinc-500">{empty}</p>
      ) : (
        <>
          {children}
          {caveat !== undefined && <p className="mt-2 text-[11px] text-zinc-600">{caveat}</p>}
        </>
      )}
    </section>
  );
}

/** `null` reads as "nothing mapped this", never as a blank cell. */
function ownerLabel(owner: { type: string | null; id: string | null; name: string | null } | null) {
  if (owner === null || owner.id === null) return '— (no app owner mapped)';
  return owner.name === null
    ? `${owner.type ?? '?'} · ${owner.id}`
    : `${owner.name} (${owner.type ?? '?'} · ${owner.id})`;
}
