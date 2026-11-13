import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ListMeta } from '../client/payments-client';
import { cn } from './ui/cn';

/** A bordered surface with a heading — the one container every screen uses. */
export function Panel({
  title,
  subtitle,
  actions,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('rounded-sm border border-line bg-panel', className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm text-zinc-200">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</p>}
        </div>
        {/* `min-w-0` is what lets the filter row fit a phone. A flex item's default `min-width:
            auto` is its min-content width — for a row of pills, ALL the pills side by side — so
            without it this header pushed the whole page to 570px on a 390px screen. As a
            block-level box inside a shrinkable item, the actions get the header's real width and
            a `Segmented` inside them can scroll instead of overflowing. */}
        {actions !== undefined && <div className="min-w-0 max-w-full">{actions}</div>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

/**
 * The three states every fetch has, rendered once instead of at each call site.
 *
 * The error branch deliberately shows the message rather than a generic "something went wrong":
 * the two errors this console actually produces — a 503 because the billing layer is off, and a
 * 401 that has already redirected — are both things the operator can only act on if they can read
 * them.
 */
export function QueryState<T>({
  query,
  empty,
  emptyMessage,
  children,
}: {
  query: UseQueryResult<T>;
  /** Whether the (successful) result is empty. */
  empty: boolean;
  emptyMessage?: string;
  children: ReactNode;
}) {
  if (query.isPending) {
    return <p className="p-4 text-sm text-zinc-500">Loading…</p>;
  }
  if (query.isError) {
    return (
      <div className="rounded-sm border border-bad/40 bg-bad/10 p-4">
        <p className="text-sm text-rose-300">
          {query.error instanceof Error ? query.error.message : 'Request failed.'}
        </p>
      </div>
    );
  }
  if (empty) {
    return <p className="p-4 text-sm text-zinc-500">{emptyMessage ?? 'Nothing here yet.'}</p>;
  }
  return <>{children}</>;
}

/**
 * Page paging over a list's `meta` (`@adonis-agora/filter`'s offset envelope): 1-based
 * `currentPage`, `perPage` rows, the real `total` and `lastPage`. `count` is the rows on this page.
 */
export function Pager({
  meta,
  count,
  onPage,
}: {
  meta: ListMeta | undefined;
  count: number;
  onPage: (page: number) => void;
}) {
  const page = meta?.currentPage ?? 1;
  const size = meta?.perPage ?? count;
  const total = meta?.total ?? count;
  const maybeMore = page < (meta?.lastPage ?? page);
  const first = (page - 1) * size;
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-zinc-500">
      <span className="mono tnum">
        {count === 0 ? `0 of ${total}` : `${first + 1}–${first + count} of ${total}`}
      </span>
      <span className="flex gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
          className="rounded-sm border border-line px-2 py-1 text-zinc-300 enabled:hover:bg-panel-2 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!maybeMore}
          onClick={() => onPage(page + 1)}
          className="rounded-sm border border-line px-2 py-1 text-zinc-300 enabled:hover:bg-panel-2 disabled:opacity-40"
        >
          Next
        </button>
      </span>
    </div>
  );
}
