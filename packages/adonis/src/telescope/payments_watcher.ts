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
 * The fields that lead an entry, in this order — the ones a developer scans a timeline
 * by. Everything else in the payload follows, unreordered.
 *
 * `traceId` is handled separately (it can come from either the envelope or the payload)
 * and always sits right after `event`.
 */
const LEAD_KEYS = [
  'provider',
  'gatewayId',
  'id',
  'type',
  'method',
  'host',
  'path',
  'query',
  'status',
  'outcome',
  'scheme',
  'amount',
  'currency',
  'durationMs',
  'error',
  'reason',
] as const;

/**
 * Build the entry content: `event`, the correlation id, the {@link LEAD_KEYS} that are
 * present, then the rest of the payload, then `ts`.
 *
 * The trace id can arrive two ways. `@adonis-agora/diagnostics` fills the ENVELOPE's
 * `traceId` from the host's request-context accessor; payments cannot set that field
 * (the structural emit slot is `(lib, event, payload)`) so it puts its own webhook-chain
 * id on the PAYLOAD. The envelope's wins when both are there — it is the host's real
 * request trace, and correlating to it reaches other libraries too.
 */
function shapeContent(envelope: PaymentsDiagnosticEnvelope): Record<string, unknown> {
  const payload = envelope.payload ?? {};
  const traceId = envelope.traceId ?? (payload.traceId as string | undefined);
  const content: Record<string, unknown> = { event: envelope.event };
  if (traceId !== undefined) content.traceId = traceId;
  for (const key of LEAD_KEYS) {
    if (payload[key] !== undefined) content[key] = payload[key];
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'traceId' || key in content) continue;
    content[key] = value;
  }
  if (envelope.ts !== undefined) content.ts = envelope.ts;
  return content;
}

/**
 * A payments-specific Telescope watcher: records a typed `payments` entry for every
 * `agora:payments:*` event the library emits — the milestones (charges, refunds,
 * subscriptions, invoice emission, webhook lifecycle) and the debug events
 * (`gateway.request*`, `webhook.verification`) — flattening the event's payload into
 * structured content rather than storing the raw envelope like the generic diagnostics
 * bridge does.
 *
 * Entries are SHAPED, not spread blindly: the fields you scan a timeline by lead
 * ({@link LEAD_KEYS} — who, which object, what happened, how long), then whatever else
 * the payload carried, then `ts`. Same family as the other Agora watchers, which is why
 * the `event` + flattened-payload envelope handling is identical to media's.
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
        ctx.record({ type: this.type, content: shapeContent(envelope) });
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
