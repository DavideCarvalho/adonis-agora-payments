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
import type { DisputeRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';
import { CONTROL_CLASS } from './ui/field';

/** The finished statuses — `DisputeStatus` minus the three that still need an answer. Mirrors the
 *  server's `DISPUTE_RESOLUTION_STATUSES`; anything else is rejected there, not here. */
const OUTCOMES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'lost', label: 'Lost', hint: 'The bank ruled for the cardholder. The money is gone.' },
  { value: 'won', label: 'Won', hint: 'The bank ruled for you and the funds were returned.' },
  {
    value: 'expired',
    label: 'Expired',
    hint: 'The window shut with no evidence submitted — lost by default rather than on the merits.',
  },
  {
    value: 'canceled',
    label: 'Canceled',
    hint: 'The cardholder withdrew it before it became a debit.',
  },
];

/**
 * Close a dispute the gateway will never close.
 *
 * This sends NOTHING to a gateway, and the dialog says so twice, because that is the whole risk
 * of the control: it looks like a decision and it is a record. The decision was made somewhere
 * else — at the bank, at the gateway's own console — and this writes down which way it went.
 *
 * It exists because a real install cannot get out of the alarm otherwise. Asaas publishes no
 * lost-dispute event at all and the driver hardcodes `outcome: 'won'` when it closes one, so a
 * dispute that was LOST sits `open` in `billing_disputes` forever; the deadline check counts
 * past-due rows on purpose, so it stays red and a fifteen-minute cron logs the same failure until
 * everyone stops reading it — which buries every other finding with it.
 */
export function ResolveDisputeDialog({
  dispute,
  onClose,
}: {
  dispute: DisputeRow;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('lost');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      paymentsClient.resolveDispute(dispute.gatewayId, {
        status,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['disputes'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  const chosen = OUTCOMES.find((outcome) => outcome.value === status);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-label="Record dispute outcome"
        className="gap-0 p-0 sm:max-w-md"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-[15px] font-semibold">How did this dispute end?</DialogTitle>
          <DialogDescription className="text-[11.5px]">
            Recorded locally. Nothing is sent to {dispute.provider} — this closes a row the gateway
            may never close on its own.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-5 py-4 text-sm">
          <dt className={LABEL}>Dispute</dt>
          <dd className="mono break-all text-fg-2">{dispute.gatewayId}</dd>
          <dt className={LABEL}>Payment</dt>
          <dd className="mono break-all text-dim">{dispute.paymentGatewayId}</dd>
          <dt className={LABEL}>Now</dt>
          <dd className="text-dim">{dispute.status}</dd>
        </dl>

        <div className="border-t border-border px-5 py-4">
          <label className={`block ${LABEL}`}>
            Outcome
            <select
              value={status}
              disabled={mutation.isPending}
              onChange={(event) => setStatus(event.target.value)}
              className={`mt-1.5 block h-8 w-full normal-case tracking-normal ${CONTROL_CLASS}`}
            >
              {OUTCOMES.map((outcome) => (
                <option key={outcome.value} value={outcome.value}>
                  {outcome.label}
                </option>
              ))}
            </select>
          </label>
          {chosen !== undefined && <p className="mt-1.5 text-[11px] text-dim">{chosen.hint}</p>}

          <label className={`mt-4 block ${LABEL}`}>
            Note (optional)
            <input
              type="text"
              value={note}
              disabled={mutation.isPending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Where you read the outcome, the case number…"
              className={`mt-1.5 block h-8 w-full normal-case tracking-normal ${CONTROL_CLASS}`}
            />
          </label>
        </div>

        {mutation.isError && (
          <div className="mx-5 mb-4 rounded-md border border-bad/25 bg-bad/[0.06] p-2.5">
            <p className="mono whitespace-pre-wrap wrap-break-word text-[11px] text-bad">
              {mutation.error instanceof Error ? mutation.error.message : 'It could not be saved.'}
            </p>
          </div>
        )}

        {mutation.isSuccess && (
          <div className="mx-5 mb-4 rounded-md border border-good/25 bg-good/[0.08] p-2.5">
            <p className="text-[11px] text-good">
              Recorded as “{mutation.data.dispute.outcome}”
              {mutation.data.audit?.actor != null && ` by ${mutation.data.audit.actor}`}.{' '}
              {mutation.data.audit === null &&
                'The audit table is not present on this install, so no note was filed.'}
            </p>
          </div>
        )}

        <DialogFooter className="m-0 rounded-b-xl border-t border-border bg-transparent px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {mutation.isSuccess ? 'Close' : 'Cancel'}
          </Button>
          {!mutation.isSuccess && (
            <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Record outcome'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.1em] text-faint';
