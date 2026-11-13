import { useQuery } from '@tanstack/react-query';
import { RegionError } from '../agora-kit/blocks/error-boundary';
import { Button } from '../agora-kit/ui/button';
import { Skeleton } from '../agora-kit/ui/skeleton';
import { paymentsClient } from '../client/payments-client';
import { deadlineTone, formatCountdown } from './disputes';
import { failingChecks, healthTarget, healthyLine } from './health';
import { formatCount, formatWhen } from './money';
import { Badge } from './ui/badge';

/**
 * The first thing on the page, above the revenue tiles.
 *
 * Revenue answers "how did we do"; this answers "what is broken right now", and those are not the
 * same question. `billingHealth()` counts the three silent failures of a billing install — events
 * claimed and never finished, events the dispatcher gave up on, charges created that never
 * confirmed — every one of which keeps returning `200` everywhere while revenue quietly stops
 * landing.
 *
 * A healthy install gets ONE quiet line. An unhealthy one leads with what is wrong, says what it
 * means, and hands over a button to the rows themselves.
 */
export function HealthPanel({
  onNavigate,
}: {
  onNavigate: (
    screen: 'payments' | 'webhooks' | 'disputes' | 'activity' | 'subscriptions',
    status?: string,
  ) => void;
}) {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: () => paymentsClient.health(),
    // The panel that tells you the worker died is not useful if it is a snapshot from when you
    // opened the tab an hour ago.
    refetchInterval: 30_000,
  });

  if (query.isError && query.data === undefined) {
    return (
      <RegionError
        title="The health check failed"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (query.data === undefined) {
    return (
      <div
        className="agora-surface flex items-center gap-3 rounded-lg border border-border px-4 py-3.5"
        role="status"
        aria-label="Checking health"
      >
        <Skeleton className="size-2 rounded-full" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-64 max-w-[40%]" />
        <Skeleton className="ml-auto h-3 w-28" />
      </div>
    );
  }

  const report = query.data;
  const failing = failingChecks(report);

  if (report.healthy) {
    return (
      <div className="agora-surface agora-rise flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-good/25 px-4 py-3">
        <span className="s-processed dot" aria-hidden />
        <p className="text-[13px] font-semibold text-fg">All clear</p>
        <p className="text-[11.5px] text-dim">{healthyLine(report)}</p>
        <p className="mono ml-auto text-[11px] text-faint">
          checked {formatWhen(report.checkedAt)}
        </p>
      </div>
    );
  }

  return (
    <section className="agora-rise overflow-hidden rounded-lg border border-bad/30 bg-bad/[0.05]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-bad/25 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="s-failed dot" aria-hidden />
          <h2 className="text-[13px] font-semibold text-fg">
            {failing.length === 1
              ? '1 thing needs attention'
              : `${failing.length} things need attention`}
          </h2>
        </div>
        <p className="mono text-[11px] text-dim">checked {formatWhen(report.checkedAt)}</p>
      </header>

      <ul>
        {failing.map((check) => {
          const target = healthTarget(check.key);
          return (
            <li
              key={check.key}
              className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-bad/15 px-4 py-3 last:border-0"
            >
              <span className="mono tnum s-failed min-w-[3ch] text-[26px] font-semibold leading-none tracking-[-0.02em]">
                {formatCount(check.count)}
              </span>
              <div className="min-w-[16rem] flex-1">
                <p className="text-[13px] font-medium text-fg">{check.label}</p>
                <p className="mt-0.5 text-[11px] text-dim">{check.hint}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate(target.screen, target.status)}
              >
                {target.label}
              </Button>
            </li>
          );
        })}
      </ul>

      {report.deadlines.length > 0 && (
        <div className="border-t border-bad/25 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            Which windows are closing
          </p>
          {/* WHICH ones, not just how many: a count names no dispute to open at the gateway. The
              server caps this list — `disputes_due.count` above is the real number. */}
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.deadlines.map((dispute) => (
              <li
                key={dispute.id}
                className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1"
              >
                <Badge variant="provider">{dispute.provider}</Badge>
                <span className="mono text-[11px] text-dim">{dispute.gatewayId}</span>
                <span
                  className={
                    deadlineTone(dispute.evidenceDueBy) === 'past'
                      ? 'mono text-[11px] text-bad'
                      : 'mono text-[11px] text-warn'
                  }
                >
                  {formatCountdown(dispute.evidenceDueBy)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.openDisputes.length > 0 && (
        <div className="border-t border-bad/25 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            Open and unanswered
          </p>
          {/* Named separately from the closing windows, and overlapping them on purpose: on a
              gateway that publishes no deadline this is the ONLY list that is ever non-empty,
              and a dispute here with no countdown is not "no hurry" — nobody told us. */}
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.openDisputes.map((dispute) => (
              <li
                key={dispute.id}
                className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1"
              >
                <Badge variant="provider">{dispute.provider}</Badge>
                <span className="mono text-[11px] text-dim">{dispute.gatewayId}</span>
                <span className="mono text-[11px] text-dim">
                  {dispute.evidenceDueBy === null
                    ? 'no deadline sent'
                    : formatCountdown(dispute.evidenceDueBy)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.failures.length > 0 && (
        <div className="border-t border-bad/25 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            What is failing
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.failures.map((failure) => (
              <li
                key={`${failure.provider}:${failure.type}`}
                className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1"
              >
                <Badge variant="provider">{failure.provider}</Badge>
                <Badge variant="type">{failure.type}</Badge>
                <span className="mono tnum text-[11px] text-bad">
                  ×{formatCount(failure.count)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
