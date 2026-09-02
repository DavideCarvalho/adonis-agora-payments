import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { OverviewMetric, PeriodPreset } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { HealthPanel } from './HealthPanel';
import { formatCents, formatCount } from './money';
import { Panel, QueryState } from './shell';
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rise rounded-sm border border-line bg-panel p-4">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mono tnum mt-2 text-2xl text-zinc-100">{value}</p>
      {hint !== undefined && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

export function Overview({
  onNavigate,
}: {
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
  const usage = data?.metrics.filter(isUsageMetric) ?? [];
  const headline = data?.metrics.filter((m) => !isUsageMetric(m)) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Health comes FIRST, above the money. Revenue answers "how did we do"; this answers "is
          anything broken right now", and an operator opening the console in the morning needs the
          second one before the first. */}
      <HealthPanel onNavigate={onNavigate} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          aria-label="Period"
          options={PERIODS}
          value={period}
          onChange={(value) => setPeriod(value)}
        />
        {data !== undefined && (
          <p className="mono text-[11px] text-zinc-500">
            {new Date(data.period.from).toLocaleString()} →{' '}
            {new Date(data.period.to).toLocaleString()}
          </p>
        )}
      </div>

      <QueryState query={query} empty={false}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {headline.map((metric) => {
            const copy = STAT_COPY[metric.key];
            return (
              <Stat
                key={metric.key}
                label={copy?.label ?? metric.label}
                value={
                  isMoneyMetric(metric)
                    ? formatCents(metric.value, data?.currency ?? 'BRL')
                    : formatCount(metric.value)
                }
                {...(copy !== undefined ? { hint: copy.hint } : {})}
              />
            );
          })}
        </div>

        <Panel
          title="Usage"
          subtitle="Metered consumption recorded in this window, per meter."
          className="mt-4"
        >
          {usage.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">No metered usage recorded in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-2 font-normal">Meter</th>
                  <th className="px-4 py-2 text-right font-normal">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((metric) => (
                  <tr key={metric.key} className="border-b border-line-soft last:border-0">
                    <td className="mono px-4 py-2 text-zinc-300">{meterName(metric)}</td>
                    <td className="mono tnum px-4 py-2 text-right text-zinc-100">
                      {formatCount(metric.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </QueryState>
    </div>
  );
}
