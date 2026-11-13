import type { ReactNode } from 'react';
import { RegionError } from '../agora-kit/blocks/error-boundary';
import { Button } from '../agora-kit/ui/button';
import { Sheet, SheetContent } from '../agora-kit/ui/sheet';
import { Skeleton } from '../agora-kit/ui/skeleton';

/**
 * One record's detail, as a sheet sliding over the list it was opened from (kit `Sheet`, Base UI
 * dialog): a mono title, a Close button, and a scrolling body. The list stays mounted underneath,
 * so closing lands back on the same page and filters. Escape and the backdrop close it too.
 *
 * `label` is the dialog's accessible name ("Payment detail") — the visible title is an id, which
 * says which record but not what kind of view this is.
 */
export function DetailSheet({
  label,
  title,
  onClose,
  children,
}: {
  label: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-label={label}
        className="w-full gap-0 border-border bg-panel p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
              {label}
            </p>
            <h2 className="mono mt-0.5 min-w-0 break-all text-[13px] font-semibold text-fg">
              {title}
            </h2>
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** Shaped stand-in for a detail body while it loads: the state grid, then two strands. */
export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-hidden>
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2.5">
        {['a', 'b', 'c', 'd', 'e'].map((key) => (
          <div key={key} className="contents">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </div>
      {['x', 'y'].map((key) => (
        <div key={key} className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/** A detail's load failure, with the server's own sentence. */
export function DetailError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <RegionError
      title="This record could not be loaded"
      error={error instanceof Error ? error : 'Request failed.'}
      onRetry={onRetry}
    />
  );
}

/** One titled section of a detail ("Disputes", "What people did to it"), with its empty line. */
export function Strand({
  title,
  empty,
  count,
  caveat,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  caveat?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        {title}
        {count > 0 && <span className="mono tnum ml-1.5 text-dim">{count}</span>}
      </h3>
      {count === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-dim">{empty}</p>
      ) : (
        <>
          {children}
          {caveat !== undefined && <p className="mt-2 text-[11px] text-faint">{caveat}</p>}
        </>
      )}
    </section>
  );
}
