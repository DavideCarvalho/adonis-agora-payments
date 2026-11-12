import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { paymentsClient } from '../client/payments-client';
import { formatCents, formatCount, formatDay, formatDaysUntil, formatWhen } from './money';
import { SubscriptionDetail } from './SubscriptionDetail';
import { Pager, Panel, QueryState, ScanNotice } from './shell';
import {
  subscriptionIsBilling,
  subscriptionNeedsAttention,
  subscriptionStatusClass,
} from './status';
import { Badge } from './ui/badge';
import { ProviderFilter } from './ui/provider-filter';
import { Segmented } from './ui/segmented';

const PAGE_SIZE = 50;

/**
 * The status filter, ordered by what an operator needs to see first rather than by the union's
 * declaration order. `past_due` leads because it is the one that costs money today.
 */
const STATUS_OPTIONS: ReadonlyArray<{ value: string | undefined; label: string }> = [
  { value: 'past_due', label: 'Past due' },
  { value: 'paused', label: 'Paused' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'trialing', label: 'Trialing' },
  { value: 'active', label: 'Active' },
  { value: 'canceled', label: 'Canceled' },
  { value: undefined, label: 'All' },
];

/**
 * Subscriptions — for a subscription business, the daily surface.
 *
 * Opens on `past_due` on purpose: those are customers whose payment failed and who are days away
 * from losing access, and they are the only rows on this screen that go away if nobody looks. An
 * "all subscriptions" default would bury eight of them under four hundred healthy ones.
 *
 * `paused` is rendered as its own thing, never as a shade of `active`: a paused subscription
 * exists, will bill again, and is NOT billing now. Several gateways collapse the two, and an
 * operator who reads them as the same grants access to someone who is not paying.
 */
export function Subscriptions({
  initialStatus,
  customerId,
  openedId,
  onOpen,
  onOpenPayment,
  onOpenCustomer,
}: {
  initialStatus?: string | undefined;
  /** Only this gateway customer's subscriptions (`#/subscriptions?customer=…`). */
  customerId?: string | undefined;
  /** The subscription open in the detail dialog (`#/subscriptions/<id>`). */
  openedId?: string | null | undefined;
  /** Open (or close, with `null`) one subscription's detail. Without it the dialog is local. */
  onOpen?: ((id: string | null) => void) | undefined;
  onOpenPayment?: ((gatewayId: string) => void) | undefined;
  onOpenCustomer?: ((customerId: string) => void) | undefined;
} = {}) {
  // One customer's subscriptions open on all of them: a past-due default would hide the rest.
  const [status, setStatus] = useState<string | undefined>(
    initialStatus ?? (customerId !== undefined ? undefined : 'past_due'),
  );
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [openedLocal, setOpenedLocal] = useState<string | null>(null);
  const opened = onOpen === undefined ? openedLocal : (openedId ?? null);
  const setOpened = onOpen ?? setOpenedLocal;

  const query = useQuery({
    queryKey: ['subscriptions', status, provider, customerId, page],
    queryFn: () =>
      paymentsClient.subscriptions({ status, provider, customerId, size: PAGE_SIZE, page }),
  });

  const rows = query.data?.subscriptions ?? [];
  const pastDue = query.data?.counts.past_due ?? 0;
  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <Panel
      title="Subscriptions"
      subtitle={
        // The past-due total is the whole install's: on one customer's view it would read as theirs.
        customerId !== undefined
          ? `Subscriptions of customer ${customerId}, newest first.`
          : pastDue > 0
            ? `${formatCount(pastDue)} past due — payments failing, access about to lapse.`
            : 'Recurring subscriptions, newest first. Nothing is past due.'
      }
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
          <Segmented
            aria-label="Subscription status"
            options={STATUS_OPTIONS.map((option) =>
              option.value === 'past_due' && pastDue > 0 && customerId === undefined
                ? { ...option, hint: formatCount(pastDue) }
                : option,
            )}
            value={status}
            onChange={(value) => refilter(() => setStatus(value))}
          />
        </div>
      }
    >
      <QueryState
        query={query}
        empty={rows.length === 0}
        emptyMessage={emptyMessage(status, provider, customerId)}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Subscription</th>
              <th className="px-4 py-2 font-normal">Plan</th>
              <th className="px-4 py-2 font-normal">Customer</th>
              <th className="px-4 py-2 font-normal">Provider</th>
              <th className="px-4 py-2 font-normal">Amount</th>
              <th className="px-4 py-2 font-normal">Next charge</th>
              <th className="px-4 py-2 font-normal">Trial ends</th>
              <th className="px-4 py-2 font-normal">Period ends</th>
              <th className="px-4 py-2 font-normal">Started</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={
                  subscriptionNeedsAttention(row.status)
                    ? 'border-b border-line-soft bg-bad/[0.04]'
                    : 'border-b border-line-soft'
                }
              >
                <td className="px-4 py-2">
                  <span className={subscriptionStatusClass(row.status)}>
                    <Badge variant="status">{row.status}</Badge>
                  </span>
                  {/* Spelled out, not implied by a hue: colour alone is not a thing to bet
                      someone's access on. */}
                  {!subscriptionIsBilling(row.status) && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-600">
                      not billing
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => setOpened(row.id)}
                    className="mono text-left text-zinc-300 underline decoration-line underline-offset-2 hover:text-zinc-100"
                  >
                    {row.gatewayId ?? row.id}
                  </button>
                </td>
                <td className="mono px-4 py-2 text-zinc-300">{row.planId || '—'}</td>
                <td className="mono px-4 py-2 text-zinc-400">{row.customerId ?? '—'}</td>
                <td className="px-4 py-2">
                  <Badge variant="provider">{row.provider}</Badge>
                  {/* Uma assinatura gerenciada não tem o que abrir no painel do gateway — o
                      operador precisa saber disso ANTES de ir procurar lá. */}
                  {row.managed && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-600">
                      managed
                    </span>
                  )}
                </td>
                <td className="mono px-4 py-2 text-zinc-300">
                  {row.amount === null
                    ? '—'
                    : `${formatCents(row.amount, row.currency ?? 'BRL')}${
                        row.cycle ? ` / ${row.cycle.toLowerCase()}` : ''
                      }`}
                </td>
                <td className="mono px-4 py-2 text-zinc-500">
                  {row.lastRenewalError ? (
                    // A falha ganha a célula da PRÓXIMA cobrança porque é isso que ela
                    // significa: não vai haver uma até alguém resolver. Uma renovação que
                    // falha não muda mais nada na linha — sem isto, "falhando há uma semana"
                    // e "vence amanhã" eram visualmente idênticas.
                    <span className="text-bad" title={row.lastRenewalError}>
                      failed ×{row.renewalFailureCount}
                    </span>
                  ) : row.cancelAtPeriodEnd ? (
                    <span className="text-zinc-600">cancels at period end</span>
                  ) : (
                    <WhenCell iso={row.nextChargeAt} />
                  )}
                </td>
                <td className="mono px-4 py-2 text-zinc-500">
                  <WhenCell iso={row.trialEndsAt} />
                </td>
                <td className="mono px-4 py-2 text-zinc-500">
                  <WhenCell iso={row.endsAt} />
                </td>
                <td className="mono px-4 py-2 text-zinc-500">{formatWhen(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ScanNotice meta={query.data?.meta} noun="subscriptions" />
        <Pager
          page={query.data?.meta.page ?? page}
          size={query.data?.meta.size ?? PAGE_SIZE}
          count={query.data?.meta.count ?? 0}
          onPage={setPage}
        />
      </QueryState>
      {opened !== null && (
        <SubscriptionDetail
          id={opened}
          onClose={() => setOpened(null)}
          onOpenPayment={onOpenPayment}
          onOpenCustomer={onOpenCustomer}
        />
      )}
    </Panel>
  );
}

/** A boundary date plus how far away it is — "in 3 days" is what gets acted on; the date alone is
 *  a subtraction the reader has to do themselves. */
function WhenCell({ iso }: { iso: string | null }) {
  const relative = formatDaysUntil(iso);
  return (
    <>
      {formatDay(iso)}
      {relative !== null && <span className="ml-1.5 text-[10px] text-zinc-600">{relative}</span>}
    </>
  );
}

function emptyMessage(
  status: string | undefined,
  provider: string | undefined,
  customerId?: string | undefined,
): string {
  if (customerId !== undefined) {
    const narrowed = [
      status !== undefined ? `status “${status}”` : undefined,
      provider !== undefined ? `gateway “${provider}”` : undefined,
    ].filter((part): part is string => part !== undefined);
    return narrowed.length === 0
      ? `Customer ${customerId} has no subscriptions.`
      : `Customer ${customerId} has no subscriptions with ${narrowed.join(' and ')}.`;
  }
  if (status === 'past_due' && provider === undefined) {
    return 'Nothing is past due. Every subscription is paying.';
  }
  if (status === undefined && provider === undefined) return 'No subscriptions recorded yet.';
  const parts = [
    status !== undefined ? `status “${status}”` : undefined,
    provider !== undefined ? `gateway “${provider}”` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `No subscriptions with ${parts.join(' and ')}.`;
}
