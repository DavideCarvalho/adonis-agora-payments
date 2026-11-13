import { cn } from '../../agora-kit/lib/utils';

/**
 * A one-of-N pill selector — the period picker and the status filters (authkit's segmented
 * control on the kit tokens).
 *
 * `value` may be `undefined` for an "all" option, which is why options carry `value?: string`
 * rather than a bare string.
 *
 * It scrolls sideways rather than wrapping or overflowing: eight payment statuses do not fit a
 * phone, and a flex item's default `min-width: auto` would let this row push the WHOLE page wider
 * than the viewport. Scrolling keeps it one line, keeps the selected pill findable by swiping, and
 * — because `overflow` other than `visible` zeroes that min-width — stops it dictating the page
 * width. The pills themselves must not shrink or wrap, or the labels do.
 */
export interface SegmentedOption<T extends string | undefined> {
  value: T;
  label: string;
  /** Rendered after the label, dimmer — a count, a hint. */
  hint?: string;
}

export interface SegmentedProps<T extends string | undefined> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  className?: string;
}

export function Segmented<T extends string | undefined>({
  options,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'scroll-x inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-panel-2 p-0.5 align-top',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value ?? '__all__'}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-6 shrink-0 whitespace-nowrap rounded-[5px] border border-transparent px-2.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              selected
                ? 'border-brand-border bg-brand-soft text-fg'
                : 'text-dim hover:bg-hover hover:text-fg',
            )}
          >
            {option.label}
            {option.hint !== undefined && (
              <span className="mono tnum ml-1.5 text-[10px] text-bad">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
