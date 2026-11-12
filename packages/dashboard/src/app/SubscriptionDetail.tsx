import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { paymentsClient } from '../client/payments-client';
import { formatCents, formatWhen } from './money';
import {
  paymentStatusClass,
  subscriptionIsBilling,
  subscriptionStatusClass,
  webhookStatusClass,
} from './status';
import { Badge } from './ui/badge';

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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <dialog
        open
        aria-modal="true"
        aria-label="Subscription detail"
        className="relative m-0 w-full max-w-3xl rounded-sm border border-line bg-panel-2 p-0 text-inherit shadow-xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="mono min-w-0 break-all text-sm text-zinc-100">{sub?.gatewayId ?? id}</h2>
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

        {data !== undefined && sub !== undefined && (
          <div className="flex flex-col gap-4 px-4 py-4">
            <section>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Current state</p>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-[11px] text-zinc-500">Status</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span className={subscriptionStatusClass(sub.status)}>
                    <Badge variant="status">{sub.status}</Badge>
                  </span>
                  {!subscriptionIsBilling(sub.status) && (
                    <span className="text-[10px] uppercase tracking-wider text-zinc-600">
                      not billing
                    </span>
                  )}
                  {sub.cancelAtPeriodEnd && (
                    <span className="text-[11px] text-amber-300">cancels at period end</span>
                  )}
                </dd>
                <dt className="text-[11px] text-zinc-500">Plan</dt>
                <dd className="mono text-zinc-200">{sub.planId || '—'}</dd>
                <dt className="text-[11px] text-zinc-500">Amount</dt>
                <dd className="mono tnum text-zinc-100">
                  {sub.amount === null
                    ? '— (the gateway owns the price)'
                    : `${formatCents(sub.amount, sub.currency ?? data.currency)}${
                        sub.cycle ? ` / ${sub.cycle.toLowerCase()}` : ''
                      }`}
                </dd>
                <dt className="text-[11px] text-zinc-500">Provider</dt>
                <dd className="flex items-center gap-2">
                  <Badge variant="provider">{sub.provider}</Badge>
                  {sub.managed && (
                    <span className="text-[10px] uppercase tracking-wider text-zinc-600">
                      managed — nothing to open at the gateway
                    </span>
                  )}
                </dd>
                <dt className="text-[11px] text-zinc-500">Customer</dt>
                <dd className="flex flex-wrap items-center gap-2 text-zinc-300">
                  <span className="mono">{customerLabel(data.customer, sub.customerId)}</span>
                  {sub.customerId !== null && onOpenCustomer !== undefined && (
                    <button
                      type="button"
                      onClick={() => onOpenCustomer(sub.customerId as string)}
                      className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-panel"
                    >
                      Their payments
                    </button>
                  )}
                </dd>
                {sub.externalReference ? (
                  <>
                    <dt className="text-[11px] text-zinc-500">Reference</dt>
                    <dd className="mono break-all text-zinc-200">{sub.externalReference}</dd>
                  </>
                ) : null}
                <Dated label="Started" value={sub.createdAt} />
                <Dated label="Trial ends" value={sub.trialEndsAt} />
                <Dated label="Period ends" value={sub.currentPeriodEnd} />
                <Dated label="Next charge" value={sub.nextChargeAt} />
                <Dated label="Ends" value={sub.endsAt} />
                {sub.renewalFailureCount > 0 && (
                  <>
                    <dt className="text-[11px] text-zinc-500">Renewal</dt>
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
                  <li key={payment.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={paymentStatusClass(payment.status)}>
                      <Badge variant="status">{payment.status}</Badge>
                    </span>
                    {onOpenPayment !== undefined ? (
                      <button
                        type="button"
                        onClick={() => onOpenPayment(payment.gatewayId)}
                        className="mono text-zinc-300 underline decoration-line underline-offset-2 hover:text-zinc-100"
                      >
                        {payment.gatewayId}
                      </button>
                    ) : (
                      <span className="mono text-zinc-300">{payment.gatewayId}</span>
                    )}
                    <span className="mono tnum text-zinc-200">
                      {formatCents(payment.amount, payment.currency)}
                    </span>
                    <span className="mono ml-auto text-zinc-500">
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
              empty="Nothing recorded against this subscription."
              count={data.audit.length}
            >
              <ul className="mt-2 flex flex-col gap-1.5">
                {data.audit.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <Badge variant="type">{entry.action}</Badge>
                    <span className="text-zinc-300">{entry.actor ?? '— unattributed'}</span>
                    {entry.message && <span className="text-zinc-500">{entry.message}</span>}
                    <span className="mono ml-auto text-zinc-500">
                      {formatWhen(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Strand>
          </div>
        )}
      </dialog>
    </div>
  );
}

function Dated({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="mono text-zinc-400">{formatWhen(value)}</dd>
    </>
  );
}

function Strand({
  title,
  empty,
  count,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{title}</p>
      {count === 0 ? <p className="mt-1 text-[11px] text-zinc-500">{empty}</p> : children}
    </section>
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
