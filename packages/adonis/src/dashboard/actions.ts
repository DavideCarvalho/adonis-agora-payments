import type { BillingStore } from '../billing/billing_store.js';

/**
 * The dashboard's two WRITE actions, as framework-light ports.
 *
 * Everything else this console does is a store read. These two are not: a refund moves money at
 * the gateway, and a retry re-runs an app's webhook handlers. Both need things the handlers
 * deliberately do not know about (a `PaymentsDriver`, a `WebhookProcessor`), so they cross the
 * boundary as narrow function types the provider supplies and a test can fake — the same shape
 * `@adonis-agora/durable`'s dashboard uses for its engine port.
 *
 * Every failure mode is a VALUE here, never a thrown error: an operator who clicks "Refund" and
 * gets nothing back has no way to tell "the gateway said no" from "the button is broken", so each
 * outcome carries the message that names which one happened.
 */

/** The slice of `PaymentsDriver` a refund needs. Structural on purpose: the real driver satisfies
 *  it, and a test can hand over eight lines instead of a gateway. */
export interface RefundCapableDriver {
  readonly provider: string;
  readonly capabilities?: { refunds?: boolean };
  refund(
    paymentGatewayId: string,
    amount?: number,
    options?: { idempotencyKey?: string },
  ): Promise<{
    gatewayId: string;
    provider: string;
    amount: { amount: number; currency: string };
    status: string;
    createdAt: string;
  }>;
}

/** What the operator gets back from the refund button. */
export type RefundOutcome =
  | {
      kind: 'ok';
      /** Integer minor units, as the gateway reported them back. */
      refund: { gatewayId: string; amount: number; currency: string; status: string };
    }
  /** The provider that took this payment is not in `config/payments.ts` any more, or the app has
   *  no manager at all. Nothing was attempted. */
  | { kind: 'unavailable'; message: string }
  /** The gateway has no refund API (Woovi/OpenPix). Nothing was attempted. */
  | { kind: 'unsupported'; message: string }
  /** The gateway refused. `message` is ITS message, verbatim — a silent failure here is worse
   *  than no button. */
  | { kind: 'gateway-error'; message: string };

export type RefundAction = (input: {
  provider: string;
  gatewayId: string;
  /** Integer minor units. Omitted = refund the whole payment. */
  amount?: number;
}) => Promise<RefundOutcome>;

/**
 * Build the refund action over a driver resolver (the app's `PaymentsManager.driver`).
 *
 * The capability check happens BEFORE the call, matching `PaymentsManager.assertCapability`: a
 * driver that declares `refunds: false` implements `refund()` only to throw, and discovering that
 * from a gateway round-trip reads to the operator like a network failure.
 */
export function createRefundAction(
  resolveDriver: (provider: string) => RefundCapableDriver | Promise<RefundCapableDriver>,
): RefundAction {
  return async ({ provider, gatewayId, amount }) => {
    let driver: RefundCapableDriver;
    try {
      driver = await resolveDriver(provider);
    } catch (error) {
      // The manager's own message names which drivers ARE configured, which is exactly the
      // next thing the operator needs to know.
      return { kind: 'unavailable', message: messageOf(error, `provider "${provider}" not found`) };
    }
    if (driver.capabilities?.refunds !== true) {
      return {
        kind: 'unsupported',
        message: `The "${provider}" gateway has no refund API. Refund this payment from the gateway's own dashboard.`,
      };
    }
    try {
      const refund = await driver.refund(gatewayId, amount);
      return {
        kind: 'ok',
        refund: {
          gatewayId: refund.gatewayId,
          amount: refund.amount.amount,
          currency: refund.amount.currency,
          status: refund.status,
        },
      };
    } catch (error) {
      return { kind: 'gateway-error', message: messageOf(error, 'the gateway refused the refund') };
    }
  };
}

/** The normalized webhook event the replay rebuilds and re-runs. Structurally `WebhookEvent`. */
export interface ReplayableWebhookEvent {
  id: string;
  provider: string;
  type: string;
  data: unknown;
  raw: Record<string, unknown>;
}

/** What the operator gets back from the retry button. */
export type ReplayOutcome =
  /** The handlers ran to completion; the ledger row is `processed`. */
  | { kind: 'processed' }
  /** Something else claimed the row between the read and the write — it is no longer `failed`. */
  | { kind: 'conflict' }
  /**
   * The ledger row carries no normalized event, so there is nothing to replay. That means the
   * row was written before this install ran the `add_billing_external_reference` migration —
   * the raw payload alone is not replayable, because turning it back into an event would mean
   * calling `parseWebhook`, which re-verifies a signature computed from headers the ledger
   * never kept. The row is put back exactly as it was, original error and all.
   */
  | { kind: 'undeliverable'; message: string }
  /** The handlers threw again. The ledger row carries the NEW error (the processor wrote it). */
  | { kind: 'failed'; message: string };

export type ReplayAction = (input: {
  gatewayEventId: string;
  provider: string;
  type: string;
  /** The error the row carried before we touched it, so a driver refusal can restore it verbatim. */
  previousError: string | null;
}) => Promise<ReplayOutcome>;

/**
 * Build the retry action over the store plus the app's webhook processor.
 *
 * The ledger dance is the fiddly part and it lives here, once:
 *
 * 1. `recordWebhookEvent` re-claims a `failed` row and hands the ORIGINAL delivery back — both
 *    the raw payload and the NORMALIZED event recorded beside it. That is the only way to read
 *    a stored delivery through the `BillingStore` contract.
 * 2. The event is rebuilt from those two columns. It is NEVER re-parsed: `parseWebhook`
 *    re-verifies a signature computed over headers the ledger does not keep, so rebuilding that
 *    way answered `422` on Stripe, Adyen and every other gateway that signs — a retry that
 *    worked for a minority of gateways, and only for the ones an attacker would not need to
 *    forge. A row with no `normalized` (written before the migration) is `undeliverable`,
 *    stated plainly, rather than half-replayed.
 * 3. The row is put BACK to `failed` before `process` runs, because `WebhookProcessor.process`
 *    claims through `recordWebhookEvent` itself, and a row sitting at `received` reads to it as
 *    "in flight" — it would return `false` and run nothing at all. This is the one place that
 *    subtlety is written down.
 * 4. `process` claims it properly and marks it `processed` or `failed` with the real reason.
 */
export function createReplayAction(deps: {
  store: BillingStore;
  /** Run it through the app's `WebhookProcessor` (built-in sync + the app's own handlers). */
  process: (event: ReplayableWebhookEvent) => Promise<unknown>;
}): ReplayAction {
  return async ({ gatewayEventId, provider, type, previousError }) => {
    const claimed = await deps.store.recordWebhookEvent({
      gatewayEventId,
      provider,
      type,
      // Ignored on the re-claim path — the row keeps the payload and the normalized event it
      // was recorded with, which is precisely what we need back.
      payload: {},
    });
    if (claimed === null) return { kind: 'conflict' };

    const row = claimed as unknown as {
      id: string | number;
      payload?: Record<string, unknown>;
      normalized?: Record<string, unknown> | null;
    };
    const ledgerId = String(row.id);
    const restore = () => deps.store.markWebhookFailed(ledgerId, previousError ?? '');

    if (row.normalized === null || row.normalized === undefined) {
      // Put the row back exactly as the operator found it: this refusal is about THIS retry, and
      // stamping it over the handler's original message would destroy the only record of why the
      // event failed in the first place.
      await restore();
      return {
        kind: 'undeliverable',
        message:
          'This event was recorded before the `add_billing_external_reference` migration added `billing_webhook_events.normalized`, so the normalized event it carried was never stored and cannot be rebuilt without re-verifying the gateway signature. Run the migration; events delivered after it replay normally.',
      };
    }

    const event: ReplayableWebhookEvent = {
      id: gatewayEventId,
      provider,
      type,
      data: row.normalized,
      raw: row.payload ?? {},
    };

    await restore();
    try {
      await deps.process(event);
      return { kind: 'processed' };
    } catch (error) {
      return { kind: 'failed', message: messageOf(error, 'the handler threw again') };
    }
  };
}

/** Every action reports a cause; an unreadable throw still gets a sentence rather than `{}`. */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return fallback;
}
