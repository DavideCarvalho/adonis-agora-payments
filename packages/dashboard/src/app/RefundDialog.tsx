import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { PaymentRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { formatCents, parseMajorToMinor } from './money';

/**
 * The refund confirmation.
 *
 * This is the one control in the console that moves money, so it is deliberately slower than a
 * click: it restates the AMOUNT and the CUSTOMER before doing anything, because "refund the row I
 * meant to refund" is the entire safety property here, and a gateway id alone does not let anyone
 * check that.
 *
 * The submit button disables itself for the whole round-trip — a refund is not idempotent at most
 * gateways, and a double click is a double refund. On a refusal the gateway's own sentence is what
 * is shown; a silent failure here is worse than no button at all.
 */
export function RefundDialog({ payment, onClose }: { payment: PaymentRow; onClose: () => void }) {
  const [partial, setPartial] = useState('');
  const queryClient = useQueryClient();

  const trimmed = partial.trim();
  const parsed = trimmed === '' ? undefined : parseMajorToMinor(trimmed, payment.currency);
  const amountInvalid = trimmed !== '' && parsed === null;
  const amountTooLarge = parsed != null && parsed > payment.amount;
  const amount = parsed ?? undefined;

  const mutation = useMutation({
    mutationFn: () => paymentsClient.refundPayment(payment.gatewayId, amount),
    onSuccess: () => {
      // The row still says `paid` until the gateway's refund webhook lands, but the ledger and the
      // health panel may already have moved.
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const blocked = amountInvalid || amountTooLarge || mutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      {/* The native element, not a div with `role="dialog"`: it comes with the semantics for free
          and browsers keep improving them. Its UA styles (absolute, auto margins, 1em padding,
          `canvas` background) are all overridden below. */}
      <dialog
        open
        aria-modal="true"
        aria-label="Confirm refund"
        className="relative m-0 w-full max-w-md rounded-sm border border-line bg-panel-2 p-0 text-inherit shadow-xl"
      >
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm text-zinc-100">Refund this payment?</h2>
        </header>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm">
          <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Amount</dt>
          <dd className="mono tnum text-zinc-100">
            {formatCents(payment.amount, payment.currency)}
          </dd>
          <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Customer</dt>
          <dd className="mono text-zinc-300">{payment.customerId ?? '— (no customer recorded)'}</dd>
          <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Payment</dt>
          <dd className="mono break-all text-zinc-400">{payment.gatewayId}</dd>
          <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Gateway</dt>
          <dd className="mono text-zinc-400">{payment.provider}</dd>
        </dl>

        <div className="border-t border-line px-4 py-3">
          <label className="block text-[11px] uppercase tracking-wider text-zinc-500">
            Partial amount (optional)
            <input
              type="text"
              inputMode="decimal"
              value={partial}
              disabled={mutation.isPending}
              onChange={(event) => setPartial(event.target.value)}
              placeholder={`Leave empty to refund ${formatCents(payment.amount, payment.currency)}`}
              className="mono mt-1 w-full rounded-sm border border-line bg-panel px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-brand focus:outline-hidden disabled:opacity-50"
            />
          </label>
          {amountInvalid && (
            <p className="mt-1 text-[11px] text-rose-300">
              Not an amount in {payment.currency}. Use up to the currency’s own number of decimals.
            </p>
          )}
          {amountTooLarge && (
            <p className="mt-1 text-[11px] text-rose-300">
              Larger than the payment itself ({formatCents(payment.amount, payment.currency)}).
            </p>
          )}
          {parsed != null && !amountTooLarge && (
            <p className="mt-1 text-[11px] text-zinc-500">
              Refunding {formatCents(parsed, payment.currency)} of{' '}
              {formatCents(payment.amount, payment.currency)}.
            </p>
          )}
        </div>

        {mutation.isError && (
          <div className="mx-4 mb-3 rounded-sm border border-bad/40 bg-bad/10 p-2">
            <p className="mono whitespace-pre-wrap wrap-break-word text-[11px] text-rose-300">
              {mutation.error instanceof Error ? mutation.error.message : 'The refund failed.'}
            </p>
          </div>
        )}

        {mutation.isSuccess && (
          <div className="mx-4 mb-3 rounded-sm border border-good/40 bg-good/10 p-2">
            <p className="text-[11px] text-emerald-300">
              Refund accepted by {payment.provider} (
              {formatCents(mutation.data.refund.amount, mutation.data.refund.currency)},{' '}
              {mutation.data.refund.status}). {mutation.data.note}
            </p>
          </div>
        )}

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
            className="rounded-sm border border-line px-3 py-1.5 text-xs text-zinc-300 enabled:hover:bg-panel disabled:opacity-40"
          >
            {mutation.isSuccess ? 'Close' : 'Cancel'}
          </button>
          {!mutation.isSuccess && (
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={blocked}
              className="rounded-sm border border-bad/50 bg-bad/15 px-3 py-1.5 text-xs text-rose-200 enabled:hover:bg-bad/25 disabled:opacity-40"
            >
              {mutation.isPending
                ? 'Refunding…'
                : `Refund ${formatCents(amount ?? payment.amount, payment.currency)}`}
            </button>
          )}
        </footer>
      </dialog>
    </div>
  );
}
