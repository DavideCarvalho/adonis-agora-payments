import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  PAYMENTS_DIAGNOSTIC_EVENTS,
  type PaymentsDiagnosticEvent,
  claimPaymentsDiagnostics,
} from '../diagnostics.js';
import type { WatcherContext } from './telescope-sdk.js';

/** All payments milestones are low-frequency — record every one of them. */
const RECORDED_EVENTS: PaymentsDiagnosticEvent[] = [...PAYMENTS_DIAGNOSTIC_EVENTS];

/** The `agora:payments:<event>` `node:diagnostics_channel` name — the cross-repo wire contract, replicated structurally (payments never imports `@adonis-agora/diagnostics`). */
function paymentsChannelName(event: string): string {
  return `agora:payments:${event}`;
}

/** The `DiagnosticEvent` envelope shape published on a payments channel (structural mirror). */
interface PaymentsDiagnosticEnvelope {
  event: string;
  ts?: number;
  traceId?: string;
  payload?: Record<string, unknown>;
}

/**
 * A payments-specific Telescope watcher: records a typed `payments` entry for every
 * milestone `agora:payments:*` event the library emits (charges, refunds,
 * subscriptions, invoice emission, webhook lifecycle), flattening the event's payload
 * into structured content rather than storing the raw envelope like the generic
 * diagnostics bridge does.
 *
 * Zero coupling: payments publishes via the structural `@adonis-agora/diagnostics`
 * emit slot; this subscribes to the same `node:diagnostics_channel` channels — neither
 * package is imported.
 *
 * De-dup: `register()` CLAIMS every recorded channel via
 * {@link claimPaymentsDiagnostics} (the reference-counted
 * `Symbol.for('@agora/diagnostics:claims')` registry), so the generic
 * `DiagnosticsWatcher` (its `recordClaimed: false` default) skips them and no event is
 * recorded twice. `dispose()` releases the claim and detaches every subscription.
 */
export class PaymentsWatcher {
  readonly type = 'payments';
  private readonly disposers: Array<() => void> = [];

  /** Claim the recorded channels and start recording a typed `payments` entry per event. */
  register(ctx: WatcherContext): void {
    this.disposers.push(claimPaymentsDiagnostics(RECORDED_EVENTS));

    for (const event of RECORDED_EVENTS) {
      const channel = paymentsChannelName(event);
      const onMessage = (message: unknown) => {
        const envelope = message as PaymentsDiagnosticEnvelope;
        if (envelope === null || typeof envelope !== 'object') return;
        ctx.record({
          type: this.type,
          content: {
            event: envelope.event,
            ...(envelope.ts !== undefined ? { ts: envelope.ts } : {}),
            ...(envelope.traceId !== undefined ? { traceId: envelope.traceId } : {}),
            ...(envelope.payload ?? {}),
          },
        });
      };
      subscribe(channel, onMessage);
      this.disposers.push(() => unsubscribe(channel, onMessage));
    }
  }

  /** Release the channel claims and detach every subscription (e.g. on shutdown). */
  dispose(): void {
    while (this.disposers.length) this.disposers.pop()?.();
  }
}
