import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../agora-kit/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../agora-kit/ui/dialog';
import type { PaymentRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { formatCents, parseMajorToMinor } from './money';
import { CONTROL_CLASS } from './ui/field';

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
    <Dialog
      open
      onOpenChange={(open) => {
        // Never mid-request: closing would hide whether the refund went through.
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-label="Confirm refund"
        className="gap-0 p-0 sm:max-w-md"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-[15px] font-semibold">Refund this payment?</DialogTitle>
          <DialogDescription className="text-[11.5px]">
            This calls {payment.provider}. A refund is not idempotent at most gateways.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-5 py-4 text-sm">
          <dt className={LABEL}>Amount</dt>
          <dd className="mono tnum text-fg">{formatCents(payment.amount, payment.currency)}</dd>
          <dt className={LABEL}>Customer</dt>
          <dd className="mono text-fg-2">{payment.customerId ?? '— (no customer recorded)'}</dd>
          <dt className={LABEL}>Payment</dt>
          <dd className="mono break-all text-dim">{payment.gatewayId}</dd>
          <dt className={LABEL}>Gateway</dt>
          <dd className="mono text-dim">{payment.provider}</dd>
        </dl>

        <div className="border-t border-border px-5 py-4">
          <label className={`block ${LABEL}`}>
            Partial amount (optional)
            <input
              type="text"
              inputMode="decimal"
              value={partial}
              disabled={mutation.isPending}
              onChange={(event) => setPartial(event.target.value)}
              placeholder={`Leave empty to refund ${formatCents(payment.amount, payment.currency)}`}
              className={`mono mt-1.5 block h-8 w-full normal-case tracking-normal ${CONTROL_CLASS}`}
            />
          </label>
          {amountInvalid && (
            <p className="mt-1.5 text-[11px] text-bad">
              Not an amount in {payment.currency}. Use up to the currency’s own number of decimals.
            </p>
          )}
          {amountTooLarge && (
            <p className="mt-1.5 text-[11px] text-bad">
              Larger than the payment itself ({formatCents(payment.amount, payment.currency)}).
            </p>
          )}
          {parsed != null && !amountTooLarge && (
            <p className="mt-1.5 text-[11px] text-dim">
              Refunding {formatCents(parsed, payment.currency)} of{' '}
              {formatCents(payment.amount, payment.currency)}.
            </p>
          )}
        </div>

        {mutation.isError && (
          <div className="mx-5 mb-4 rounded-md border border-bad/25 bg-bad/[0.06] p-2.5">
            <p className="mono whitespace-pre-wrap wrap-break-word text-[11px] text-bad">
              {mutation.error instanceof Error ? mutation.error.message : 'The refund failed.'}
            </p>
          </div>
        )}

        {mutation.isSuccess && (
          <div className="mx-5 mb-4 rounded-md border border-good/25 bg-good/[0.08] p-2.5">
            <p className="text-[11px] text-good">
              Refund accepted by {payment.provider} (
              {formatCents(mutation.data.refund.amount, mutation.data.refund.currency)},{' '}
              {mutation.data.refund.status}). {mutation.data.note}
            </p>
          </div>
        )}

        <DialogFooter className="m-0 rounded-b-xl border-t border-border bg-transparent px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {mutation.isSuccess ? 'Close' : 'Cancel'}
          </Button>
          {!mutation.isSuccess && (
            <Button variant="destructive" onClick={() => mutation.mutate()} disabled={blocked}>
              {mutation.isPending
                ? 'Refunding…'
                : `Refund ${formatCents(amount ?? payment.amount, payment.currency)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.1em] text-faint';
