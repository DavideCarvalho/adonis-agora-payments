import { useQuery } from '@tanstack/react-query';
import { paymentsClient } from '../client/payments-client';
import { DetailError, DetailSheet, DetailSkeleton, Strand } from './DetailSheet';
import { formatCents, formatWhen } from './money';
import { disputeStatusClass, paymentStatusClass, webhookStatusClass } from './status';
import { Badge, StatusBadge } from './ui/badge';

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
    <DetailSheet label="Payment detail" title={gatewayId} onClose={onClose}>
      {query.isPending && <DetailSkeleton />}
      {query.isError && <DetailError error={query.error} onRetry={() => void query.refetch()} />}

      {query.data !== undefined && (
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
              Current state
            </h3>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-[11px] text-faint">Status</dt>
              <dd>
                <StatusBadge statusClass={paymentStatusClass(query.data.payment.status)}>
                  {query.data.payment.status}
                </StatusBadge>
              </dd>
              <dt className="text-[11px] text-faint">Amount</dt>
              <dd className="mono tnum text-fg">
                {formatCents(query.data.payment.amount, query.data.payment.currency)}
                {/* Net, spelled out. A partial refund leaves `status: 'paid'` at the full
                      amount on purpose — the row is not lying, it is just not the whole story. */}
                {query.data.payment.refundedAmount !== null &&
                  query.data.payment.refundedAmount > 0 && (
                    <span className="ml-2 text-[11px] text-warn">
                      −{formatCents(query.data.payment.refundedAmount, query.data.payment.currency)}{' '}
                      refunded
                    </span>
                  )}
              </dd>
              <dt className="text-[11px] text-faint">Reference</dt>
              <dd className="mono break-all text-fg">
                {query.data.payment.externalReference ?? '— (the gateway echoed none)'}
              </dd>
              <dt className="text-[11px] text-faint">Owner</dt>
              <dd className="mono text-fg-2">{ownerLabel(query.data.payment.owner)}</dd>
              <dt className="text-[11px] text-faint">Paid at</dt>
              <dd className="mono text-dim">{formatWhen(query.data.payment.paidAt)}</dd>
            </dl>
          </section>

          <Strand
            title="Disputes"
            empty="No dispute has been filed against this payment."
            count={query.data.disputes.length}
          >
            <ul className="mt-2 flex flex-col gap-1.5">
              {query.data.disputes.map((dispute) => (
                <li key={dispute.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <StatusBadge statusClass={disputeStatusClass(dispute.status)}>
                    {dispute.status}
                  </StatusBadge>
                  <span className="mono text-dim">{dispute.gatewayId}</span>
                  <span className="text-dim">{dispute.reason ?? 'no reason given'}</span>
                  <span className="mono ml-auto text-dim">{formatWhen(dispute.openedAt)}</span>
                </li>
              ))}
            </ul>
          </Strand>

          <Strand
            title="Deliveries naming this payment"
            empty="No stored delivery names this payment."
            count={query.data.events.rows.length}
            caveat={`Found by ${query.data.events.matchedBy} — the payment each delivery was recorded for. Deliveries recorded before that was kept are found by their stored payload instead, which can include one that merely mentions this id.`}
          >
            <ul className="mt-2 flex flex-col gap-1.5">
              {query.data.events.rows.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <StatusBadge statusClass={webhookStatusClass(event.status)}>
                    {event.status}
                  </StatusBadge>
                  <Badge variant="type">{event.type}</Badge>
                  <Badge variant="provider">{event.provider}</Badge>
                  <span className="mono ml-auto text-dim">{formatWhen(event.createdAt)}</span>
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
                <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <Badge variant="type">{entry.action}</Badge>
                  <span className="text-fg-2">{entry.actor ?? '— unattributed'}</span>
                  {entry.amount !== null && (
                    <span className="mono tnum text-fg">
                      {formatCents(entry.amount, entry.currency ?? query.data.currency)}
                    </span>
                  )}
                  <span className="mono ml-auto text-dim">{formatWhen(entry.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Strand>

          <p className="text-[11px] text-faint">
            This is not a history. `billing_payments` is one mutable row upserted in place, so what
            the payment used to be is not recorded anywhere — only what is knowable now.
          </p>
        </div>
      )}
    </DetailSheet>
  );
}

/** `null` reads as "nothing mapped this", never as a blank cell. */
function ownerLabel(owner: { type: string | null; id: string | null; name: string | null } | null) {
  if (owner === null || owner.id === null) return '— (no app owner mapped)';
  return owner.name === null
    ? `${owner.type ?? '?'} · ${owner.id}`
    : `${owner.name} (${owner.type ?? '?'} · ${owner.id})`;
}
