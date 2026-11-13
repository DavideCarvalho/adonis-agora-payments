import type { ReactNode } from 'react';
import { cn } from '../../agora-kit/lib/utils';
import { Badge as KitBadge } from '../../agora-kit/ui/badge';

/**
 * The console's label chips, on the kit's (shadcn) Badge.
 *
 * - `provider` — the gateway that produced the row (stripe/asaas/woovi/abacate): info tone.
 * - `type` — a webhook event type or an audit action: violet tone.
 * - `danger` — something that needs acting on.
 * - `outline` — neutral.
 *
 * Statuses go through {@link StatusBadge}: its hue comes from the `s-<status>` class in
 * `index.css`, the single place status colour is defined.
 */
const TONE = {
  outline: 'neutral',
  provider: 'info',
  type: 'violet',
  danger: 'destructive',
} as const;

export function Badge({
  variant = 'outline',
  className,
  children,
}: {
  variant?: keyof typeof TONE;
  className?: string;
  children: ReactNode;
}) {
  return (
    <KitBadge variant={TONE[variant]} className={className}>
      {children}
    </KitBadge>
  );
}

/** A status pill tinted by its `s-<status>` class (`statusClass`): dot + label. */
export function StatusBadge({
  statusClass,
  children,
  className,
}: {
  statusClass: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <KitBadge
      variant="outline"
      className={cn(
        statusClass,
        'border-current/25 bg-current/10 text-current uppercase tracking-[0.06em]',
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </KitBadge>
  );
}

/** A small caps qualifier next to a status ("not billing", "managed", "no money moved"). */
export function Qualifier({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('text-[10px] uppercase tracking-wider text-faint', className)}>
      {children}
    </span>
  );
}
