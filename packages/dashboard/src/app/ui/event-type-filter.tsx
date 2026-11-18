import { useQuery } from '@tanstack/react-query';
import { ComboSelect } from '../../agora-kit/blocks/combo-field';
import { paymentsClient } from '../../client/payments-client';
import { FieldLabel } from './field';

/**
 * "Which event type?" — driven by the DATA, exactly like {@link ProviderFilter}, but a select with
 * autocomplete: event types are dotted names (`payment.refunded`, `invoice.paid`…) and an install
 * that has seen a few gateways has dozens, so typing `refund` beats scrolling a native list.
 *
 * `GET /api/providers` reports the types this install has actually RECEIVED, taken from the
 * ledger's own group-by. A hardcoded list would offer every type the package can emit, most of
 * which return nothing on any given install, and bury the two or three that matter.
 *
 * The filter this screen was missing entirely: `status` + `provider` answers "what is failing on
 * Asaas", and could not answer "did a refund event arrive at all" — which is the question the
 * ledger gets opened for the moment one specific charge is in doubt.
 */
export function EventTypeFilter({
  value,
  onChange,
  className,
}: {
  value: string | undefined;
  onChange: (type: string | undefined) => void;
  className?: string;
}) {
  const query = useQuery({
    queryKey: ['providers'],
    queryFn: () => paymentsClient.providers(),
    staleTime: 5 * 60_000,
  });

  const types = query.data?.eventTypes ?? [];
  // Keep it visible while a filter is applied even if the list came back short — hiding it would
  // strand the operator on a filtered view with no way to clear it.
  if (types.length < 2 && value === undefined) return null;

  return (
    <FieldLabel label="Type" {...(className !== undefined ? { className } : {})}>
      <ComboSelect
        aria-label="Event type"
        placeholder="All"
        options={types}
        loading={query.isLoading}
        value={value ?? null}
        onValueChange={(next) => onChange(next ?? undefined)}
        className="h-[26px] w-52 bg-panel-2 text-xs font-normal normal-case tracking-normal"
      />
    </FieldLabel>
  );
}
