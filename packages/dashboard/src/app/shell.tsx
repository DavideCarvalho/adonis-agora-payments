import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
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
    <section className={cn('rounded border border-line bg-panel', className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm text-zinc-200">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</p>}
        </div>
        {actions}
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
      <div className="rounded border border-bad/40 bg-bad/10 p-4">
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
 * Offset paging.
 *
 * `count === limit` is the ONLY signal that another page might exist — the server never counts the
 * full match set — so "Next" is enabled on exactly that and the control never claims a total it
 * does not have.
 */
export function Pager({
  limit,
  offset,
  count,
  onOffset,
}: {
  limit: number;
  offset: number;
  count: number;
  onOffset: (offset: number) => void;
}) {
  const maybeMore = count === limit;
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-zinc-500">
      <span className="mono tnum">{count === 0 ? '0' : `${offset + 1}–${offset + count}`}</span>
      <span className="flex gap-1">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - limit))}
          className="rounded border border-line px-2 py-1 text-zinc-300 enabled:hover:bg-panel-2 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!maybeMore}
          onClick={() => onOffset(offset + limit)}
          className="rounded border border-line px-2 py-1 text-zinc-300 enabled:hover:bg-panel-2 disabled:opacity-40"
        >
          Next
        </button>
      </span>
    </div>
  );
}
