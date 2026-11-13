import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Column } from '../agora-kit/blocks/data-table';
import { PageHeader, Toolbar } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { paymentsClient, type SubscriptionRow } from '../client/payments-client';
import { RepeatIcon } from './icons';
import { formatCents, formatCount, formatDay, formatDaysUntil, formatWhen } from './money';
import { SubscriptionDetail } from './SubscriptionDetail';
import { ListPanel, Mono } from './shell';
import {
  subscriptionIsBilling,
  subscriptionNeedsAttention,
  subscriptionStatusClass,
} from './status';
import { Badge, Qualifier, StatusBadge } from './ui/badge';
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

  const pastDue = query.data?.counts.past_due ?? 0;
  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <PageBody>
      <PageHeader
        title="Subscriptions"
        description={
          // The past-due total is the whole install's: on one customer's view it would read as theirs.
          customerId !== undefined
            ? `Subscriptions of customer ${customerId}, newest first.`
            : pastDue > 0
              ? `${formatCount(pastDue)} past due — payments failing, access about to lapse.`
              : 'Recurring subscriptions, newest first. Nothing is past due.'
        }
      />
      <Toolbar label="Subscription filters" className="gap-3">
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
      </Toolbar>
      <ListPanel
        title={status === undefined ? 'All subscriptions' : `${statusLabel(status)} subscriptions`}
        description={
          query.data !== undefined ? `${formatCount(query.data.meta.total)} total` : undefined
        }
        query={query}
        rowKey={(row) => row.id}
        onPage={setPage}
        emptyIcon={<RepeatIcon />}
        emptyTitle={status === 'past_due' ? 'Nothing past due' : 'No subscriptions'}
        emptyDescription={emptyMessage(status, provider, customerId)}
        rowClassName={(row) =>
          subscriptionNeedsAttention(row.status) ? 'bg-bad/[0.04]' : undefined
        }
        columns={subscriptionColumns(setOpened)}
      >
        {opened !== null && (
          <SubscriptionDetail
            id={opened}
            onClose={() => setOpened(null)}
            onOpenPayment={onOpenPayment}
            onOpenCustomer={onOpenCustomer}
          />
        )}
      </ListPanel>
    </PageBody>
  );
}

function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

/** The subscriptions table's columns (presentational). */
function subscriptionColumns(onOpen: (id: string) => void): Column<SubscriptionRow>[] {
  return [
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge statusClass={subscriptionStatusClass(row.status)}>{row.status}</StatusBadge>
          {/* Spelled out, not implied by a hue: colour alone is not a thing to bet someone's
              access on. */}
          {!subscriptionIsBilling(row.status) && <Qualifier>not billing</Qualifier>}
        </span>
      ),
    },
    {
      id: 'subscription',
      header: 'Subscription',
      cell: (row) => (
        <button
          type="button"
          onClick={() => onOpen(row.id)}
          className="mono text-left text-[12px] text-fg-2 underline decoration-line-strong decoration-dotted underline-offset-4 hover:text-brand"
        >
          {row.gatewayId ?? row.id}
        </button>
      ),
    },
    {
      id: 'plan',
      header: 'Plan',
      hideBelow: 'md',
      cell: (row) => <Mono className="text-fg-2">{row.planId || '—'}</Mono>,
    },
    {
      id: 'customer',
      header: 'Customer',
      hideBelow: 'lg',
      cell: (row) => <Mono>{row.customerId ?? '—'}</Mono>,
    },
    {
      id: 'provider',
      header: 'Provider',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <Badge variant="provider">{row.provider}</Badge>
          {/* Uma assinatura gerenciada não tem o que abrir no painel do gateway — o operador
              precisa saber disso ANTES de ir procurar lá. */}
          {row.managed && <Qualifier>managed</Qualifier>}
        </span>
      ),
    },
    {
      id: 'amount',
      header: 'Amount',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="mono tnum text-[12px] text-fg">
          {row.amount === null
            ? '—'
            : `${formatCents(row.amount, row.currency ?? 'BRL')}${
                row.cycle ? ` / ${row.cycle.toLowerCase()}` : ''
              }`}
        </span>
      ),
    },
    {
      id: 'next',
      header: 'Next charge',
      hideBelow: 'md',
      cell: (row) => (
        <Mono className="text-faint">
          {row.lastRenewalError ? (
            // A falha ganha a célula da PRÓXIMA cobrança porque é isso que ela significa: não vai
            // haver uma até alguém resolver. Uma renovação que falha não muda mais nada na linha —
            // sem isto, "falhando há uma semana" e "vence amanhã" eram visualmente idênticas.
            <span className="text-bad" title={row.lastRenewalError}>
              failed ×{row.renewalFailureCount}
            </span>
          ) : row.cancelAtPeriodEnd ? (
            <span className="text-faint">cancels at period end</span>
          ) : (
            <WhenCell iso={row.nextChargeAt} />
          )}
        </Mono>
      ),
    },
    {
      id: 'trial',
      header: 'Trial ends',
      hideBelow: 'lg',
      cell: (row) => (
        <Mono className="text-faint">
          <WhenCell iso={row.trialEndsAt} />
        </Mono>
      ),
    },
    {
      id: 'period',
      header: 'Period ends',
      hideBelow: 'lg',
      cell: (row) => (
        <Mono className="text-faint">
          <WhenCell iso={row.endsAt} />
        </Mono>
      ),
    },
    {
      id: 'started',
      header: 'Started',
      hideBelow: 'lg',
      cell: (row) => <Mono className="text-faint">{formatWhen(row.createdAt)}</Mono>,
    },
  ];
}

/** A boundary date plus how far away it is — "in 3 days" is what gets acted on; the date alone is
 *  a subtraction the reader has to do themselves. */
function WhenCell({ iso }: { iso: string | null }) {
  const relative = formatDaysUntil(iso);
  return (
    <>
      {formatDay(iso)}
      {relative !== null && <span className="ml-1.5 text-[10px] text-faint">{relative}</span>}
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
