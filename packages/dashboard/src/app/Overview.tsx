import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import {
  MetricCard,
  MetricGrid,
  MetricGridSkeleton,
  type MetricTone,
} from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { PageBody } from '../agora-kit/shell/app-shell';
import type { OverviewMetric, PeriodPreset } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { HealthPanel } from './HealthPanel';
import { GaugeIcon } from './icons';
import { formatCents, formatCount } from './money';
import { ListError } from './shell';
import { Segmented } from './ui/segmented';

const PERIODS: ReadonlyArray<{ value: PeriodPreset; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

/**
 * Which metrics are money and which are plain counts.
 *
 * `billingOverview` returns a flat `{ key, label, value }` list where `revenue` happens to be cents
 * and everything else happens not to be. Rendering that list uniformly would print `123456` for
 * R$ 1.234,56 or `R$ 12,00` for twelve subscriptions, so the distinction is made HERE, by key,
 * rather than guessed from the number.
 */
const MONEY_METRICS = new Set(['revenue', 'net_revenue', 'mrr']);

function isMoneyMetric(metric: OverviewMetric): boolean {
  return MONEY_METRICS.has(metric.key);
}

/**
 * The tile label and the sentence under it, for the metrics whose server-side label is a
 * headless string with `(cents)` in it.
 *
 * Both money tiles are here, and both say which figure they are IN WORDS. `revenue` is gross —
 * a charge that was half refunded counts at its full value in it — and for two releases that
 * was the only revenue number the console had and nothing on screen admitted it. Showing gross
 * and net side by side without labelling them would be the same bug with an extra tile.
 */
const STAT_COPY: Record<string, { label: string; hint: string }> = {
  revenue: {
    label: 'Revenue (gross)',
    hint: 'Paid payments settled in this window. Refunds NOT subtracted.',
  },
  net_revenue: {
    label: 'Revenue (net)',
    hint: 'The same payments, minus what was refunded. This is what you kept.',
  },
  active_subscriptions: {
    label: 'Active subscriptions',
    hint: 'Includes trialing. Not windowed — a live count.',
  },
  mrr: {
    label: 'Recurring revenue (MRR)',
    // Diz o recorte em voz alta: as duas de cima olham o que ENTROU na janela, esta olha o
    // que entra por mês enquanto nada mudar. Conta as assinaturas do gateway e as gerenciadas;
    // o que fica de fora é linha sem preço ou sem ciclo conhecido, que é ignorada em vez de
    // chutada como mensal.
    hint: 'Active subscriptions with a known price and cycle, normalised to a month. Not windowed.',
  },
};

/** `Usage · api_calls` reads better as its meter name once it is under a "Usage" heading. */
function isUsageMetric(metric: OverviewMetric): boolean {
  return metric.key.startsWith('meter:');
}

function meterName(metric: OverviewMetric): string {
  return metric.key.slice('meter:'.length);
}

const METRIC_TONE: Record<string, MetricTone> = {
  revenue: 'brand',
  net_revenue: 'good',
  mrr: 'violet',
  active_subscriptions: 'info',
};

/**
 * Overview (MONITOR): health first, then the money for a window, then metered usage.
 *
 * Container: owns the period and the overview query; the health panel is its own region with its
 * own poll. Everything under it is presentational.
 */
export function Overview({
  onNavigate,
  showHealth = true,
}: {
  /** Show the health panel (it reads across every organization, so not in one). */
  showHealth?: boolean;
  /** Jump to the screen that shows a failing check's actual rows. */
  onNavigate: (
    screen: 'payments' | 'webhooks' | 'disputes' | 'activity' | 'subscriptions',
    status?: string,
  ) => void;
}) {
  const [period, setPeriod] = useState<PeriodPreset>('30d');
  const query = useQuery({
    queryKey: ['overview', period],
    queryFn: () => paymentsClient.overview(period),
  });
  const data = query.data;

  return (
    <PageBody>
      <PageHeader
        title="Overview"
        description={
          data !== undefined && data.period.from !== ''
            ? `${new Date(data.period.from).toLocaleString()} → ${new Date(data.period.to).toLocaleString()}`
            : 'Revenue, subscriptions and metered usage for a window.'
        }
        actions={
          <Segmented
            aria-label="Period"
            options={PERIODS}
            value={period}
            onChange={(value) => setPeriod(value)}
          />
        }
      />

      {/* Health comes FIRST, above the money. Revenue answers "how did we do"; this answers "is
          anything broken right now", and an operator opening the console in the morning needs the
          second one before the first. */}
      {showHealth && (
        <ErrorBoundary label="Health">
          <HealthPanel onNavigate={onNavigate} />
        </ErrorBoundary>
      )}

      <ErrorBoundary label="Metrics" onReset={() => void query.refetch()}>
        {query.error && data === undefined ? (
          <ListError label="Overview" error={query.error} onRetry={() => void query.refetch()} />
        ) : data === undefined ? (
          <>
            <MetricGridSkeleton count={4} />
            <Panel title="Usage" description="per meter" flush>
              <DataTable
                label="Usage"
                columns={USAGE_COLUMNS}
                rows={undefined}
                loading
                rowKey={(m) => m.key}
                skeletonRows={3}
              />
            </Panel>
          </>
        ) : (
          <OverviewMetrics metrics={data.metrics} currency={data.currency} />
        )}
      </ErrorBoundary>
    </PageBody>
  );
}

/** The metric tiles and the usage table (presentational). */
export function OverviewMetrics({
  metrics,
  currency,
}: {
  metrics: OverviewMetric[];
  currency: string;
}) {
  const usage = metrics.filter(isUsageMetric);
  const headline = metrics.filter((m) => !isUsageMetric(m));
  return (
    <>
      {headline.length > 0 && (
        <MetricGrid className="md:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
          {headline.map((metric) => {
            const copy = STAT_COPY[metric.key];
            return (
              <MetricCard
                key={metric.key}
                label={copy?.label ?? metric.label}
                tone={METRIC_TONE[metric.key] ?? 'default'}
                value={
                  isMoneyMetric(metric)
                    ? formatCents(metric.value, currency)
                    : formatCount(metric.value)
                }
                caption={
                  copy !== undefined ? (
                    <span className="block whitespace-normal font-sans text-[11px] leading-snug">
                      {copy.hint}
                    </span>
                  ) : undefined
                }
              />
            );
          })}
        </MetricGrid>
      )}

      <Panel title="Usage" description="metered consumption in this window, per meter" flush>
        <DataTable
          label="Usage"
          columns={USAGE_COLUMNS}
          rows={usage}
          rowKey={(metric) => metric.key}
          empty={
            <EmptyState
              icon={<GaugeIcon />}
              title="No metered usage"
              description="Nothing was recorded against a meter in this window."
            />
          }
        />
      </Panel>
    </>
  );
}

const USAGE_COLUMNS: Column<OverviewMetric>[] = [
  {
    id: 'meter',
    header: 'Meter',
    cell: (metric) => <span className="mono text-[12px] text-fg-2">{meterName(metric)}</span>,
  },
  {
    id: 'quantity',
    header: 'Quantity',
    align: 'right',
    cell: (metric) => (
      <span className="mono tnum text-[12.5px] text-fg">{formatCount(metric.value)}</span>
    ),
  },
];
