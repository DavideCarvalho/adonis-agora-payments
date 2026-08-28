import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { paymentsClient } from '../client/payments-client';
import { formatCount, formatDay, formatDaysUntil, formatWhen } from './money';
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
export function Subscriptions({ initialStatus }: { initialStatus?: string | undefined } = {}) {
  const [status, setStatus] = useState<string | undefined>(initialStatus ?? 'past_due');
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['subscriptions', status, provider, offset],
    queryFn: () => paymentsClient.subscriptions({ status, provider, limit: PAGE_SIZE, offset }),
  });

  const rows = query.data?.subscriptions ?? [];
  const pastDue = query.data?.counts.past_due ?? 0;
  const refilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <Panel
      title="Subscriptions"
      subtitle={
        pastDue > 0
          ? `${formatCount(pastDue)} past due — payments failing, access about to lapse.`
          : 'Recurring subscriptions, newest first. Nothing is past due.'
      }
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <ProviderFilter value={provider} onChange={(v) => refilter(() => setProvider(v))} />
          <Segmented
            aria-label="Subscription status"
            options={STATUS_OPTIONS.map((option) =>
              option.value === 'past_due' && pastDue > 0
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
        emptyMessage={emptyMessage(status, provider)}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Plan</th>
              <th className="px-4 py-2 font-normal">Customer</th>
              <th className="px-4 py-2 font-normal">Provider</th>
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
                <td className="mono px-4 py-2 text-zinc-300">{row.planId || '—'}</td>
                <td className="mono px-4 py-2 text-zinc-400">{row.customerId ?? '—'}</td>
                <td className="px-4 py-2">
                  <Badge variant="provider">{row.provider}</Badge>
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
        <ScanNotice page={query.data?.page} noun="subscriptions" />
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

function emptyMessage(status: string | undefined, provider: string | undefined): string {
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
