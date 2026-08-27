import { cn } from './cn';

/**
 * A one-of-N pill selector — the tab bar, the period picker, the status filter.
 *
 * This console's whole interaction surface is "pick one of a few things", so it gets ONE control
 * instead of three near-identical ones. `value` may be `undefined` for an "all" option, which is
 * why options carry `value?: string` rather than a bare string.
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
        'inline-flex items-center gap-1 rounded border border-line bg-panel p-1',
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
              'rounded px-2.5 py-1 text-xs transition-colors',
              selected
                ? 'bg-brand/15 text-brand'
                : 'text-zinc-400 hover:bg-panel-2 hover:text-zinc-200',
            )}
          >
            {option.label}
            {option.hint !== undefined && (
              <span className="ml-1.5 text-[10px] text-zinc-500">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
