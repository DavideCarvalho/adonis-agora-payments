import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary, RegionError } from '../agora-kit/blocks/error-boundary';
import { Pager as KitPager } from '../agora-kit/blocks/pager';
import { Panel } from '../agora-kit/blocks/panel';
import { errorStatus } from '../agora-kit/blocks/query-boundary';
import type { ListMeta } from '../client/payments-client';

/**
 * The payments console's list region: one titled kit `Panel` holding a `DataTable` over an offset
 * page (`@adonis-agora/filter`'s `{ data, meta }` envelope) and its pager.
 *
 * The four states every list has are rendered here once instead of at each screen: skeleton rows
 * while the first page loads, a retryable error (an access message on 401/403), a designed empty
 * state, then the rows. The error keeps the server's sentence rather than a generic "something went
 * wrong": the two errors this console actually produces — a 503 because the billing layer is off,
 * and a 401 that has already redirected — are both things the operator can only act on if they can
 * read them. The whole region sits in its own error boundary, so a crash in one table never blanks
 * the page around it.
 *
 * Presentational: the screen's container owns the query and hands it in.
 */
export function ListPanel<T>({
  title,
  description,
  action,
  query,
  columns,
  rowKey,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  onPage,
  rowClassName,
  subRow,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  query: Pick<UseQueryResult<{ data: T[]; meta: ListMeta }>, 'data' | 'error' | 'refetch'>;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  emptyTitle: string;
  emptyDescription?: ReactNode;
  emptyIcon?: ReactNode;
  onPage: (page: number) => void;
  rowClassName?: (row: T) => string | undefined;
  subRow?: (row: T) => ReactNode;
  /** Dialogs owned by the list (detail, refund…), rendered after it. */
  children?: ReactNode;
}) {
  const page = query.data;
  return (
    <ErrorBoundary label={title} onReset={() => void query.refetch()}>
      <Panel
        title={title}
        description={description}
        action={action}
        flush
        bodyClassName="overflow-x-auto"
      >
        {query.error && page === undefined ? (
          <div className="p-4">
            <ListError label={title} error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              label={title}
              columns={columns}
              rows={page?.data}
              loading={page === undefined}
              rowKey={rowKey}
              {...(rowClassName ? { rowClassName } : {})}
              {...(subRow ? { subRow } : {})}
              empty={
                <EmptyState
                  title={emptyTitle}
                  description={emptyDescription}
                  {...(emptyIcon ? { icon: emptyIcon } : {})}
                />
              }
            />
            {page !== undefined && page.data.length > 0 && (
              <Pager meta={page.meta} onPage={onPage} />
            )}
          </>
        )}
      </Panel>
      {children}
    </ErrorBoundary>
  );
}

/** The kit's offset pager under a list, on the list's own `meta`. */
export function Pager({ meta, onPage }: { meta: ListMeta; onPage: (page: number) => void }) {
  return (
    <div className="border-t border-border px-3">
      <KitPager meta={meta} onPage={onPage} />
    </div>
  );
}

/** A region's load failure: the server's sentence, a retry, and plain words on 401/403. */
export function ListError({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: unknown;
  onRetry?: () => void;
}) {
  const status = errorStatus(error);
  if (status === 401 || status === 403) {
    return (
      <RegionError
        title={status === 401 ? 'Signed out' : `You can't see ${label.toLowerCase()} here`}
        error={
          status === 401
            ? 'Your session ended. Sign in again to continue.'
            : 'Your account is not allowed to read this.'
        }
      />
    );
  }
  return (
    <RegionError
      title={`${label} could not be loaded`}
      error={error instanceof Error ? error : 'Request failed.'}
      {...(onRetry ? { onRetry } : {})}
    />
  );
}

/** A mono id or timestamp cell, in the table's dim ink. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={`mono text-[12px] ${className ?? 'text-dim'}`}>{children}</span>;
}
