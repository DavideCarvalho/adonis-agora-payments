import { useQuery } from '@tanstack/react-query';
import { Button } from '../agora-kit/ui/button';
import { paymentsClient } from '../client/payments-client';
import { DetailError, DetailSheet, DetailSkeleton, Strand } from './DetailSheet';
import { formatCents, formatWhen } from './money';
import {
  paymentStatusClass,
  subscriptionIsBilling,
  subscriptionStatusClass,
  webhookStatusClass,
} from './status';
import { Badge, Qualifier, StatusBadge } from './ui/badge';

/**
 * Everything this system knows about ONE subscription: its current state, the customer it bills,
 * the payments charged for it, the deliveries naming those payments, and what people did to it.
 * Opened on top of the subscriptions list (`#/subscriptions/<id>`), like a payment's detail.
 */
export function SubscriptionDetail({
  id,
  onClose,
  onOpenPayment,
  onOpenCustomer,
}: {
  id: string;
  onClose: () => void;
  /** Open one payment's detail. */
  onOpenPayment?: ((gatewayId: string) => void) | undefined;
  /** Open every payment of the customer (gateway customer id). */
  onOpenCustomer?: ((customerId: string) => void) | undefined;
}) {
  const query = useQuery({
    queryKey: ['subscription', id],
    queryFn: () => paymentsClient.subscription(id),
  });
  const data = query.data;
  const sub = data?.subscription;

  return (
    <DetailSheet label="Subscription detail" title={sub?.gatewayId ?? id} onClose={onClose}>
      {query.isPending && <DetailSkeleton />}
      {query.isError && <DetailError error={query.error} onRetry={() => void query.refetch()} />}

      {data !== undefined && sub !== undefined && (
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
              Current state
            </h3>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-[11px] text-faint">Status</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <StatusBadge statusClass={subscriptionStatusClass(sub.status)}>
                  {sub.status}
                </StatusBadge>
                {!subscriptionIsBilling(sub.status) && <Qualifier>not billing</Qualifier>}
                {sub.cancelAtPeriodEnd && (
                  <span className="text-[11px] text-warn">cancels at period end</span>
                )}
              </dd>
              <dt className="text-[11px] text-faint">Plan</dt>
              <dd className="mono text-fg">{sub.planId || '—'}</dd>
              <dt className="text-[11px] text-faint">Amount</dt>
              <dd className="mono tnum text-fg">
                {sub.amount === null
                  ? '— (the gateway owns the price)'
                  : `${formatCents(sub.amount, sub.currency ?? data.currency)}${
                      sub.cycle ? ` / ${sub.cycle.toLowerCase()}` : ''
                    }`}
              </dd>
              <dt className="text-[11px] text-faint">Provider</dt>
              <dd className="flex items-center gap-2">
                <Badge variant="provider">{sub.provider}</Badge>
                {sub.managed && <Qualifier>managed — nothing to open at the gateway</Qualifier>}
              </dd>
              <dt className="text-[11px] text-faint">Customer</dt>
              <dd className="flex flex-wrap items-center gap-2 text-fg-2">
                <span className="mono">{customerLabel(data.customer, sub.customerId)}</span>
                {sub.customerId !== null && onOpenCustomer !== undefined && (
                  <Button
                    variant="outline"
                    size="micro"
                    onClick={() => onOpenCustomer(sub.customerId as string)}
                  >
                    Their payments
                  </Button>
                )}
              </dd>
              {sub.externalReference ? (
                <>
                  <dt className="text-[11px] text-faint">Reference</dt>
                  <dd className="mono break-all text-fg">{sub.externalReference}</dd>
                </>
              ) : null}
              <Dated label="Started" value={sub.createdAt} />
              <Dated label="Trial ends" value={sub.trialEndsAt} />
              <Dated label="Period ends" value={sub.currentPeriodEnd} />
              <Dated label="Next charge" value={sub.nextChargeAt} />
              <Dated label="Ends" value={sub.endsAt} />
              {sub.renewalFailureCount > 0 && (
                <>
                  <dt className="text-[11px] text-faint">Renewal</dt>
                  <dd className="text-[11px] text-bad">
                    failed ×{sub.renewalFailureCount}
                    {sub.lastRenewalError ? ` — ${sub.lastRenewalError}` : ''}
                    {sub.lastRenewalAttemptAt
                      ? ` (last tried ${formatWhen(sub.lastRenewalAttemptAt)})`
                      : ''}
                  </dd>
                </>
              )}
            </dl>
          </section>

          <Strand
            title="Payments charged for it"
            empty="No payment recorded for this subscription."
            count={data.payments.length}
          >
            <ul className="mt-2 flex flex-col gap-1.5">
              {data.payments.map((payment) => (
                <li key={payment.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <StatusBadge statusClass={paymentStatusClass(payment.status)}>
                    {payment.status}
                  </StatusBadge>
                  {onOpenPayment !== undefined ? (
                    <button
                      type="button"
                      onClick={() => onOpenPayment(payment.gatewayId)}
                      className="mono text-fg-2 underline decoration-line-strong decoration-dotted underline-offset-4 hover:text-brand"
                    >
                      {payment.gatewayId}
                    </button>
                  ) : (
                    <span className="mono text-fg-2">{payment.gatewayId}</span>
                  )}
                  <span className="mono tnum text-fg">
                    {formatCents(payment.amount, payment.currency)}
                  </span>
                  <span className="mono ml-auto text-dim">
                    {formatWhen(payment.paidAt ?? payment.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Strand>

          <Strand
            title="Deliveries naming its payments"
            empty="No stored delivery names its payments."
            count={data.events.rows.length}
          >
            <ul className="mt-2 flex flex-col gap-1.5">
              {data.events.rows.map((event) => (
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
            empty="Nothing recorded against this subscription."
            count={data.audit.length}
          >
            <ul className="mt-2 flex flex-col gap-1.5">
              {data.audit.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <Badge variant="type">{entry.action}</Badge>
                  <span className="text-fg-2">{entry.actor ?? '— unattributed'}</span>
                  {entry.message && <span className="text-dim">{entry.message}</span>}
                  <span className="mono ml-auto text-dim">{formatWhen(entry.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Strand>
        </div>
      )}
    </DetailSheet>
  );
}

function Dated({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd className="mono text-dim">{formatWhen(value)}</dd>
    </>
  );
}

function customerLabel(
  customer: {
    gatewayId: string;
    email: string | null;
    name: string | null;
    ownerType: string | null;
    ownerId: string | null;
  } | null,
  customerId: string | null,
): string {
  if (customer === null) return customerId ?? '— (no customer recorded)';
  const who = customer.email ?? customer.name ?? customer.gatewayId;
  return customer.ownerId === null
    ? `${who} · unmapped`
    : `${who} (${customer.ownerType ?? '?'} · ${customer.ownerId})`;
}
