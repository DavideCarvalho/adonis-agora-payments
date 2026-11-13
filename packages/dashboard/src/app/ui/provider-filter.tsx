import { useQuery } from '@tanstack/react-query';
import { paymentsClient } from '../../client/payments-client';
import { CONTROL_CLASS, FieldLabel } from './field';

/**
 * "Which gateway?" — as a native select, driven by the DATA.
 *
 * The package ships eighteen drivers and an install runs two or three, so a hardcoded list would
 * offer fifteen filters that return nothing and bury the one that matters. `GET /api/providers`
 * reports what is actually present; when only one gateway is in use the control hides itself
 * entirely rather than sitting there as a one-option menu.
 *
 * A `<select>` rather than the `Segmented` pills the status filters use: statuses are a fixed few,
 * providers are however many the install has, and a pill row that wraps to three lines is not a
 * filter any more.
 */
export function ProviderFilter({
  value,
  onChange,
  className,
}: {
  value: string | undefined;
  onChange: (provider: string | undefined) => void;
  className?: string;
}) {
  const query = useQuery({
    queryKey: ['providers'],
    queryFn: () => paymentsClient.providers(),
    // The set of gateways an install uses changes at deploy time, not per request.
    staleTime: 5 * 60_000,
  });

  const providers = query.data?.providers ?? [];
  // Keep the control visible while a filter is applied even if the list came back short — hiding
  // it would strand the operator on a filtered view with no way to clear it.
  if (providers.length < 2 && value === undefined) return null;

  return (
    <FieldLabel label="Gateway" {...(className !== undefined ? { className } : {})}>
      <select
        aria-label="Gateway"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        className={CONTROL_CLASS}
      >
        <option value="">All</option>
        {providers.map((provider) => (
          <option key={provider} value={provider}>
            {provider}
          </option>
        ))}
      </select>
    </FieldLabel>
  );
}
