import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * A non-interactive label chip: the provider, the event type, a gateway id.
 *
 * The `status` variant is colourless on purpose — a status badge takes its hue from the
 * `s-<status>` class in `index.css`, which is the single place status colour is defined.
 * Copied in shape from `@adonis-agora/durable-dashboard`'s `ui/badge.tsx`.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-sm border px-1.5 text-[10px] leading-relaxed',
  {
    variants: {
      variant: {
        outline: 'border-line bg-zinc-800/40 text-zinc-400',
        /** The gateway that produced the row (stripe/asaas/woovi/abacate). */
        provider: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
        /** The webhook event type (`payment.succeeded`, ...). */
        type: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
        /** Something that needs acting on. */
        danger: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
        /** Status — colour comes from the caller's `s-<status>` class. */
        status: 'border-transparent px-0 uppercase tracking-wider',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';
