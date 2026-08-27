/**
 * The dashboard's period selector, as a pure function — no HTTP, no clock of its own.
 *
 * Every screen that shows an aggregate has to agree on what "last 7 days" means, and the
 * overview handler is not the place to re-derive it per request.
 */

/** The named windows the SPA's period selector offers. */
export const PERIOD_PRESETS = ['24h', '7d', '30d', '90d'] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** The window fed to `billingOverview` — half-open `[from, to)`. */
export interface Period {
  from: Date;
  to: Date;
  /** The preset this window came from, or `'custom'` when explicit `from`/`to` were supplied. */
  preset: PeriodPreset | 'custom';
}

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESET_MS: Record<PeriodPreset, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

/** The preset used when the request names none (or names one that does not exist). */
export const DEFAULT_PERIOD: PeriodPreset = '30d';

function isPreset(value: unknown): value is PeriodPreset {
  return typeof value === 'string' && (PERIOD_PRESETS as readonly string[]).includes(value);
}

/** Parse an ISO timestamp, returning `undefined` for anything unparseable. */
function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Resolve `{ period }` or `{ from, to }` query params into a concrete window.
 *
 * Explicit `from`/`to` win when BOTH parse and `from < to`; a half-supplied or backwards
 * custom range falls back to the preset rather than silently producing an empty window that
 * would read as "no revenue" instead of "you asked for nothing".
 */
export function resolvePeriod(
  query: { period?: unknown; from?: unknown; to?: unknown },
  now: Date,
): Period {
  const from = parseDate(query.from);
  const to = parseDate(query.to);
  if (from !== undefined && to !== undefined && from.getTime() < to.getTime()) {
    return { from, to, preset: 'custom' };
  }
  const preset = isPreset(query.period) ? query.period : DEFAULT_PERIOD;
  return { from: new Date(now.getTime() - PRESET_MS[preset]), to: now, preset };
}
