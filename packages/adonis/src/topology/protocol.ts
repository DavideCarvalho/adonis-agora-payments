import { randomUUID } from 'node:crypto';

/**
 * The wire contract between a payments **tenant** (an app) and the payments **control plane**
 * (the Agora Hub). Every transport (HTTP, Redis) carries the same envelope and reaches the same
 * handler, so a call means the same thing whichever way it travelled.
 */

/** Version of the envelope. A control plane refuses any other. */
export const HUB_MESSAGE_VERSION = 1 as const;

/** What a tenant may ask the control plane. */
export const HUB_OPERATIONS = [
  'whoami',
  'describe',
  'driver',
  'customers.ensure',
  'billing.account',
  'events.pull',
  'events.ack',
] as const;

export type HubOperation = (typeof HUB_OPERATIONS)[number];

/**
 * The gateway calls a tenant may run through the control plane, and the capability each needs.
 * `parseWebhook` and `webhookEventIds` are absent on purpose: webhooks reach the control plane
 * directly from the gateway, never through a tenant.
 */
export const HUB_DRIVER_CALLS = {
  createCustomer: 'payments:customers',
  findCustomer: 'payments:customers',
  updateCustomer: 'payments:customers',
  charge: 'payments:charge',
  findPayment: 'payments:charge',
  refund: 'payments:refund',
  tokenizeCard: 'payments:charge',
  createCheckout: 'payments:charge',
  listInvoices: 'payments:charge',
  cardSetup: 'payments:charge',
  saveCard: 'payments:charge',
  cardUpdateUrl: 'payments:charge',
  createSubscription: 'payments:subscriptions',
  cancelSubscription: 'payments:subscriptions',
  updateSubscription: 'payments:subscriptions',
  findSubscription: 'payments:subscriptions',
  findDispute: 'payments:disputes',
  submitDisputeEvidence: 'payments:disputes',
} as const;

export type HubDriverCall = keyof typeof HUB_DRIVER_CALLS;

/** The capability every operation other than `driver` needs. */
export const HUB_OPERATION_CAPABILITY: Record<Exclude<HubOperation, 'driver'>, string | null> = {
  whoami: null,
  describe: 'payments:read',
  'customers.ensure': 'payments:customers',
  'billing.account': 'payments:read',
  'events.pull': 'payments:events',
  'events.ack': 'payments:events',
};

/** Whether `granted` covers `needed` (`payments:*` covers every payments capability). */
export function hasCapability(granted: readonly string[], needed: string | null): boolean {
  if (needed === null) return granted.length > 0;
  return granted.includes(needed) || granted.includes('payments:*') || granted.includes('*');
}

/** One call, as it travels. */
export interface HubCallMessage {
  v: typeof HUB_MESSAGE_VERSION;
  /** Unique per call. A retry of the SAME call reuses it: the control plane replays the answer. */
  id: string;
  operation: HubOperation;
  input?: unknown;
  /** The tenant's bearer token (authkit service token, or a shared secret). */
  token: string;
  /**
   * The app the caller claims. Advisory: an authkit token names its app itself; a shared secret
   * needs it to know which secret to compare against.
   */
  partition?: string;
  /** Epoch ms. A control plane refuses a message older than its `maxAgeMs`. */
  issuedAt: number;
}

export type HubErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'gateway'
  | 'unavailable'
  | 'timeout'
  /**
   * The control plane stopped while this call was running and cannot tell whether the gateway
   * ran it (no gateway idempotency to lean on). Do NOT retry with a fresh id: look the object up
   * first (e.g. by `externalReference`). See {@link isHubOutcomeUnknown}.
   */
  | 'indeterminate';

/** One answer, as it travels. */
export interface HubReplyMessage {
  v: typeof HUB_MESSAGE_VERSION;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: HubErrorCode; message: string };
}

/**
 * A failed call to the payments control plane. `unavailable` and `timeout` mean the call never
 * reached the gateway, or its answer never came back: see {@link isHubUnavailable}.
 */
export class PaymentsHubError extends Error {
  readonly code: HubErrorCode;
  constructor(code: HubErrorCode, message: string) {
    super(`[payments] ${message}`);
    this.name = 'PaymentsHubError';
    this.code = code;
  }
}

/**
 * Whether an error means "the control plane could not be reached". The managed renewal pass
 * stops on it instead of counting a failed charge, and an app shows "try again" instead of
 * "your card was declined".
 */
export function isHubUnavailable(error: unknown): boolean {
  return (
    error instanceof PaymentsHubError && (error.code === 'unavailable' || error.code === 'timeout')
  );
}

/**
 * Whether a call's outcome at the gateway is unknown: the control plane crashed mid-call and the
 * gateway offers nothing to deduplicate a re-run on. The gateway MAY have charged; reconcile (look
 * the payment up by your `externalReference`) before charging again with a new call.
 */
export function isHubOutcomeUnknown(error: unknown): boolean {
  return error instanceof PaymentsHubError && error.code === 'indeterminate';
}

export function newHubMessageId(): string {
  return randomUUID();
}

/** What `describe` answers for one provider configured on the control plane. */
export interface HubProviderDescription {
  /** The provider key on the control plane (`config.providers`). */
  name: string;
  /** The driver's own provider name (`'asaas'`). */
  provider: string;
  supportedMethods: string[];
  capabilities?: Record<string, unknown>;
}

/** One forwarded webhook event, as a tenant pulls it. */
export interface HubEventEnvelope {
  /** The control plane's id for this delivery. Ack it once the tenant processed it. */
  seq: string;
  event: {
    id: string;
    provider: string;
    type: string;
    createdAt?: string;
    data: unknown;
    raw: Record<string, unknown>;
  };
}
