import { useQuery } from '@tanstack/react-query';
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
  onNavigate: (screen: 'payments' | 'webhooks' | 'disputes' | 'activity', status?: string) => void;
}) {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: () => paymentsClient.health(),
    // The panel that tells you the worker died is not useful if it is a snapshot from when you
    // opened the tab an hour ago.
    refetchInterval: 30_000,
  });

  if (query.isPending) {
    return (
      <div className="rounded-sm border border-line bg-panel px-4 py-3 text-sm text-zinc-500">
        Checking…
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-sm border border-bad/40 bg-bad/10 px-4 py-3">
        <p className="text-sm text-rose-300">
          {query.error instanceof Error ? query.error.message : 'The health check failed.'}
        </p>
      </div>
    );
  }

  const report = query.data;
  const failing = failingChecks(report);

  if (report.healthy) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-sm border border-good/30 bg-good/[0.06] px-4 py-3">
        <span className="s-processed dot" aria-hidden />
        <p className="text-sm text-zinc-200">All clear</p>
        <p className="text-[11px] text-zinc-500">{healthyLine(report)}</p>
        <p className="mono ml-auto text-[11px] text-zinc-600">
          checked {formatWhen(report.checkedAt)}
        </p>
      </div>
    );
  }

  return (
    <section className="rise rounded-sm border border-bad/40 bg-bad/[0.05]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-bad/25 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="s-failed dot" aria-hidden />
          <h2 className="text-sm text-zinc-100">
            {failing.length === 1
              ? '1 thing needs attention'
              : `${failing.length} things need attention`}
          </h2>
        </div>
        <p className="mono text-[11px] text-zinc-500">checked {formatWhen(report.checkedAt)}</p>
      </header>

      <ul>
        {failing.map((check) => {
          const target = healthTarget(check.key);
          return (
            <li
              key={check.key}
              className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line-soft px-4 py-3 last:border-0"
            >
              <span className="mono tnum s-failed min-w-[3ch] text-2xl leading-none">
                {formatCount(check.count)}
              </span>
              <div className="min-w-[16rem] flex-1">
                <p className="text-sm text-zinc-200">{check.label}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">{check.hint}</p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate(target.screen, target.status)}
                className="rounded-sm border border-line bg-panel px-2 py-1 text-xs text-zinc-300 hover:bg-panel-2 hover:text-zinc-100"
              >
                {target.label}
              </button>
            </li>
          );
        })}
      </ul>

      {report.deadlines.length > 0 && (
        <div className="border-t border-bad/25 px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            Which windows are closing
          </p>
          {/* WHICH ones, not just how many: a count names no dispute to open at the gateway. The
              server caps this list — `disputes_due.count` above is the real number. */}
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.deadlines.map((dispute) => (
              <li
                key={dispute.id}
                className="flex items-center gap-1.5 rounded-sm border border-line bg-panel px-2 py-1"
              >
                <Badge variant="provider">{dispute.provider}</Badge>
                <span className="mono text-[11px] text-zinc-400">{dispute.gatewayId}</span>
                <span
                  className={
                    deadlineTone(dispute.evidenceDueBy) === 'past'
                      ? 'mono text-[11px] text-rose-300'
                      : 'mono text-[11px] text-amber-300'
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
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">Open and unanswered</p>
          {/* Named separately from the closing windows, and overlapping them on purpose: on a
              gateway that publishes no deadline this is the ONLY list that is ever non-empty,
              and a dispute here with no countdown is not "no hurry" — nobody told us. */}
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.openDisputes.map((dispute) => (
              <li
                key={dispute.id}
                className="flex items-center gap-1.5 rounded-sm border border-line bg-panel px-2 py-1"
              >
                <Badge variant="provider">{dispute.provider}</Badge>
                <span className="mono text-[11px] text-zinc-400">{dispute.gatewayId}</span>
                <span className="mono text-[11px] text-zinc-500">
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
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">What is failing</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {report.failures.map((failure) => (
              <li
                key={`${failure.provider}:${failure.type}`}
                className="flex items-center gap-1.5 rounded-sm border border-line bg-panel px-2 py-1"
              >
                <Badge variant="provider">{failure.provider}</Badge>
                <Badge variant="type">{failure.type}</Badge>
                <span className="mono tnum text-[11px] text-rose-300">
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
