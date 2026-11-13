import type { ReactNode } from 'react';
import { cn } from '../../agora-kit/lib/utils';

/**
 * The toolbar's form controls on the kit tokens: a small caps label beside a 26px control
 * (authkit's input look). Native elements on purpose — a `<select>` is keyboard- and
 * screen-reader-complete as it is, and on a phone it opens the platform picker.
 */
export const CONTROL_CLASS =
  'h-[26px] rounded-md border border-border bg-panel-2 px-2 text-xs text-fg outline-none transition-colors placeholder:text-faint hover:border-line-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50';

export function FieldLabel({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the `children`, nested inside
    <label
      className={cn(
        'flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint',
        className,
      )}
    >
      {label}
      {children}
    </label>
  );
}
