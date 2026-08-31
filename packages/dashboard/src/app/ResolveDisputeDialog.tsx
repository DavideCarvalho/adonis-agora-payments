import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DisputeRow } from '../client/payments-client';
import { paymentsClient } from '../client/payments-client';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <dialog
        open
        aria-modal="true"
        aria-label="Record dispute outcome"
        className="relative m-0 w-full max-w-md rounded-sm border border-line bg-panel-2 p-0 text-inherit shadow-xl"
      >
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm text-zinc-100">How did this dispute end?</h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Recorded locally. Nothing is sent to {dispute.provider} — this closes a row the gateway
            may never close on its own.
          </p>
        </header>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-3 text-sm">
          <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Dispute</dt>
          <dd className="mono break-all text-zinc-300">{dispute.gatewayId}</dd>
          <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Payment</dt>
          <dd className="mono break-all text-zinc-400">{dispute.paymentGatewayId}</dd>
          <dt className="text-[11px] uppercase tracking-wider text-zinc-500">Now</dt>
          <dd className="text-zinc-400">{dispute.status}</dd>
        </dl>

        <div className="border-t border-line px-4 py-3">
          <label className="block text-[11px] uppercase tracking-wider text-zinc-500">
            Outcome
            <select
              value={status}
              disabled={mutation.isPending}
              onChange={(event) => setStatus(event.target.value)}
              className="mt-1 w-full rounded-sm border border-line bg-panel px-2 py-1.5 text-sm text-zinc-100 focus:border-brand focus:outline-hidden disabled:opacity-50"
            >
              {OUTCOMES.map((outcome) => (
                <option key={outcome.value} value={outcome.value}>
                  {outcome.label}
                </option>
              ))}
            </select>
          </label>
          {chosen !== undefined && <p className="mt-1 text-[11px] text-zinc-500">{chosen.hint}</p>}

          <label className="mt-3 block text-[11px] uppercase tracking-wider text-zinc-500">
            Note (optional)
            <input
              type="text"
              value={note}
              disabled={mutation.isPending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Where you read the outcome, the case number…"
              className="mt-1 w-full rounded-sm border border-line bg-panel px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-brand focus:outline-hidden disabled:opacity-50"
            />
          </label>
        </div>

        {mutation.isError && (
          <div className="mx-4 mb-3 rounded-sm border border-bad/40 bg-bad/10 p-2">
            <p className="mono whitespace-pre-wrap wrap-break-word text-[11px] text-rose-300">
              {mutation.error instanceof Error ? mutation.error.message : 'It could not be saved.'}
            </p>
          </div>
        )}

        {mutation.isSuccess && (
          <div className="mx-4 mb-3 rounded-sm border border-good/40 bg-good/10 p-2">
            <p className="text-[11px] text-emerald-300">
              Recorded as “{mutation.data.dispute.outcome}”
              {mutation.data.audit?.actor != null && ` by ${mutation.data.audit.actor}`}.{' '}
              {mutation.data.audit === null &&
                'The audit table is not present on this install, so no note was filed.'}
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
              disabled={mutation.isPending}
              className="rounded-sm border border-line bg-panel px-3 py-1.5 text-xs text-zinc-200 enabled:hover:bg-panel-2 disabled:opacity-40"
            >
              {mutation.isPending ? 'Saving…' : 'Record outcome'}
            </button>
          )}
        </footer>
      </dialog>
    </div>
  );
}
