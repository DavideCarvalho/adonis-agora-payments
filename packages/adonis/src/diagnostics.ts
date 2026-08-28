/**
 * The `@adonis-agora/diagnostics` emit capability, published on this global slot at that
 * package's module load. `@adonis-agora/payments` reads it STRUCTURALLY — it never imports
 * or depends on the diagnostics package. When diagnostics isn't installed the slot is
 * empty and emitting is an inert no-op. (Same pattern as `@adonis-agora/media`.)
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Payment, Subscription } from './types.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/**
 * The `@adonis-agora/diagnostics` trace capability. Like {@link EMIT_SLOT} it is read
 * STRUCTURALLY — payments never imports the diagnostics package.
 */
const TRACE_SLOT = Symbol.for('@agora/diagnostics:trace');
type TraceFn = <T>(lib: string, event: string, fn: () => T, payload?: unknown) => T;

/**
 * Every payments milestone published on `agora:payments:<event>`. The single runtime
 * source for the {@link PaymentsDiagnosticEvent} union — a Telescope watcher iterates
 * this to subscribe/claim, and apps subscribe with `onDiagnostic('payments', ...)`.
 *
 * Two layers:
 * - **Gateway-action** events, emitted by the drivers on API calls (`charge.created`,
 *   `charge.refunded`, `subscription.created`/`canceled`, `invoice.emitted`).
 * - **Business** events, emitted by the `WebhookProcessor` when a webhook confirms a
 *   state change (`payment.succeeded`/`failed`/`refunded`/`updated`,
 *   `subscription.updated`, plus `subscription.created`/`canceled` from webhooks) and
 *   the webhook lifecycle (`webhook.received`/`processed`/`failed`).
 * - **Debug** events, which exist for the developer holding one broken payment rather
 *   than for the dashboard: `gateway.request`/`gateway.request.failed` (what was actually
 *   sent to the gateway, what came back, how long it took) and `webhook.verification`
 *   (whether the signature verified, under which scheme, or that nothing verified it).
 */
export const PAYMENTS_DIAGNOSTIC_EVENTS = [
  'charge.created',
  'charge.refunded',
  'subscription.created',
  'subscription.updated',
  'subscription.canceled',
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'payment.disputed',
  'payment.updated',
  'invoice.emitted',
  'webhook.received',
  'webhook.verification',
  'webhook.processed',
  'webhook.failed',
  'gateway.request',
  'gateway.request.failed',
] as const;

export type PaymentsDiagnosticEvent = (typeof PAYMENTS_DIAGNOSTIC_EVENTS)[number];

/**
 * The claim registry, published by `@adonis-agora/diagnostics` under this global slot as
 * a reference-counted `Map<`${lib}:${event}`, number>`. Read STRUCTURALLY — same
 * decoupling as {@link EMIT_SLOT}. A lib-specific Telescope watcher claims the channels
 * it records here so the generic `DiagnosticsWatcher` skips them (its `recordClaimed:
 * false` default), avoiding double-recording.
 */
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');

function claimsRegistry(): Map<string, number> {
  const g = globalThis as Record<symbol, unknown>;
  let registry = g[CLAIMS_SLOT] as Map<string, number> | undefined;
  if (registry === undefined) {
    registry = new Map<string, number>();
    g[CLAIMS_SLOT] = registry;
  }
  return registry;
}

/**
 * Claim `payments:<event>` for every event, so the generic diagnostics→telescope bridge
 * skips them. Reference-counted (mirrors `@adonis-agora/diagnostics`'
 * `claimDiagnostics`).
 */
export function claimPaymentsDiagnostics(events: readonly string[]): () => void {
  const registry = claimsRegistry();
  const keys = events.map((event) => `payments:${event}`);
  for (const key of keys) registry.set(key, (registry.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = registry.get(key);
      if (count === undefined) continue;
      if (count <= 1) registry.delete(key);
      else registry.set(key, count - 1);
    }
  };
}

/** Whether `payments:<event>` is currently claimed. */
export function isPaymentsDiagnosticClaimed(event: string): boolean {
  const registry = (globalThis as Record<symbol, unknown>)[CLAIMS_SLOT] as
    | Map<string, number>
    | undefined;
  return registry?.has(`payments:${event}`) ?? false;
}

export interface ChargeCreatedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
  method?: string;
}
export interface ChargeRefundedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
}
export interface SubscriptionCreatedPayload {
  gatewayId: string;
  provider: string;
  customerId: string;
  planId: string;
}
export interface SubscriptionUpdatedPayload {
  gatewayId: string;
  provider: string;
  customerId: string;
  status: string;
}
export interface SubscriptionCanceledPayload {
  gatewayId: string;
  provider: string;
}
/** Webhook-confirmed payment (normalized business event). */
export interface PaymentSucceededPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
  /** The `externalReference` the app set on the charge, echoed back by the gateway. */
  externalReference?: string;
}
export interface PaymentFailedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
  reason?: string;
  externalReference?: string;
}
export interface PaymentRefundedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
}
/**
 * A chargeback. Same shape as a refund because the same facts identify it — but it is not a
 * refund: nobody at your end decided to give the money back.
 */
export interface PaymentDisputedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
}
export interface PaymentUpdatedPayload {
  gatewayId: string;
  provider: string;
  status: string;
}
export interface InvoiceEmittedPayload {
  gatewayId: string;
  provider: string;
  number?: string;
  url?: string;
}
export interface WebhookReceivedPayload {
  id: string;
  provider: string;
  type: string;
}
export interface WebhookProcessedPayload {
  id: string;
  provider: string;
  type: string;
}
export interface WebhookFailedPayload {
  id: string;
  provider: string;
  type: string;
  error: string;
}

/**
 * What actually authenticated (or did not authenticate) one webhook delivery.
 *
 * `webhook.received` only says an event arrived. This says whether the signature checked
 * out and under which scheme — the first question asked whenever a gateway reports
 * rejected deliveries, or whenever an endpoint turns out to have been accepting anything.
 */
export interface WebhookVerificationPayload {
  provider: string;
  /**
   * - `verified` — a shared verification helper ran and the signature matched.
   * - `failed` — the driver rejected the delivery (bad signature, missing header, stale
   *   timestamp, unparsable body); `reason` carries the driver's own message.
   * - `unreported` — the delivery was accepted but **nothing verified it through the
   *   shared helpers**. Either the driver verified inside its own SDK (Stripe does), or
   *   it skipped verification because no webhook credential is configured. That second
   *   case is the usual answer to "why is my endpoint unauthenticated".
   */
  outcome: 'verified' | 'failed' | 'unreported';
  /** The scheme that ran, e.g. `hmac-sha256`, `standard-webhooks`, `rsa-sha256`. */
  scheme?: string;
  /** The rejection message, for `failed`. */
  reason?: string;
  /** How long parsing + verifying the delivery took. */
  durationMs?: number;
}

/**
 * One outbound call to a gateway API, as it actually went out — the entry a developer
 * pastes into a bug report.
 *
 * Deliberately credential-free: no headers are ever recorded, and sensitive query
 * parameters are redacted (see {@link redactQueryString}). Bodies are opt-in and off by
 * default (see {@link configurePaymentsDiagnostics}) because a charge body carries card
 * and CPF data.
 */
export interface GatewayRequestPayload {
  /** The driver's provider name, when the caller passed one. `host` always identifies the gateway. */
  provider?: string;
  method: string;
  /** Host of the resolved URL, e.g. `api.asaas.com`. */
  host: string;
  /** Path only — never the raw query string. */
  path: string;
  /** The query string with credential-bearing values replaced. Absent when there was none. */
  query?: string;
  status: number;
  durationMs: number;
  /** Correlation id, when the call happened inside a traced webhook delivery. */
  traceId?: string;
  /** Opt-in only, redacted. */
  requestBody?: unknown;
  /** Opt-in only, redacted. */
  responseBody?: unknown;
}

/** The same call when it did not come back with a 2xx — a timeout, a transport error, or an HTTP error. */
export interface GatewayRequestFailedPayload {
  provider?: string;
  method: string;
  host: string;
  path: string;
  query?: string;
  /** Present for `http_error`; absent for a timeout or a transport failure. */
  status?: number;
  durationMs: number;
  outcome: 'http_error' | 'timeout' | 'network_error';
  /** A short, credential-free reason — never the thrown error's URL-bearing message. */
  error: string;
  traceId?: string;
  requestBody?: unknown;
  /** The gateway's error body. Opt-in only, redacted — it is also where a 422 explains itself. */
  responseBody?: unknown;
}

/** Maps each event to its payload type, so {@link publishPayments} is checked at the call site. */
export interface PaymentsDiagnosticPayloads {
  'charge.created': ChargeCreatedPayload;
  'charge.refunded': ChargeRefundedPayload;
  'subscription.created': SubscriptionCreatedPayload;
  'subscription.updated': SubscriptionUpdatedPayload;
  'subscription.canceled': SubscriptionCanceledPayload;
  'payment.succeeded': PaymentSucceededPayload;
  'payment.failed': PaymentFailedPayload;
  'payment.refunded': PaymentRefundedPayload;
  'payment.disputed': PaymentDisputedPayload;
  'payment.updated': PaymentUpdatedPayload;
  'invoice.emitted': InvoiceEmittedPayload;
  'webhook.received': WebhookReceivedPayload;
  'webhook.verification': WebhookVerificationPayload;
  'webhook.processed': WebhookProcessedPayload;
  'webhook.failed': WebhookFailedPayload;
  'gateway.request': GatewayRequestPayload;
  'gateway.request.failed': GatewayRequestFailedPayload;
}

// ─── opt-in switches ─────────────────────────────────────────────────────────

/** What the debug diagnostics are allowed to record. */
export interface PaymentsDiagnosticsOptions {
  /**
   * Record the request and response bodies of gateway HTTP calls on
   * `gateway.request`/`gateway.request.failed`.
   *
   * **Off by default, and it should stay off in production.** A charge body carries the
   * cardholder's PAN and the payer's CPF/CNPJ; the response echoes much of it back.
   * Known credential and cardholder keys are redacted even when this is on
   * ({@link redactBody}), but redaction is a key-name heuristic, not a guarantee — turn
   * this on to debug a specific integration, not as a standing setting.
   */
  recordHttpBodies?: boolean;
  /** Cap on a recorded body string, in characters. Default 2000. */
  bodyMaxChars?: number;
}

const diagnosticsOptions: Required<PaymentsDiagnosticsOptions> = {
  recordHttpBodies: false,
  bodyMaxChars: 2_000,
};

/**
 * Turn on the opt-in debug recording. Call it once, before the app serves traffic:
 *
 * ```ts title="start/telescope.ts"
 * import { configurePaymentsDiagnostics } from '@adonis-agora/payments'
 *
 * configurePaymentsDiagnostics({ recordHttpBodies: true })
 * ```
 *
 * It is a module-level switch rather than a `config/payments.ts` key because it is read
 * by {@link publishGatewayRequest} on the HTTP path, which has no access to the app
 * config — and because it is a debugging toggle, not a deployment setting.
 */
export function configurePaymentsDiagnostics(options: PaymentsDiagnosticsOptions): void {
  if (options.recordHttpBodies !== undefined) {
    diagnosticsOptions.recordHttpBodies = options.recordHttpBodies;
  }
  if (options.bodyMaxChars !== undefined) {
    diagnosticsOptions.bodyMaxChars = options.bodyMaxChars;
  }
}

/** The current opt-in switches (a copy — mutating it changes nothing). */
export function paymentsDiagnosticsOptions(): Required<PaymentsDiagnosticsOptions> {
  return { ...diagnosticsOptions };
}

/** Reset the switches to their defaults. Exists for tests. */
export function resetPaymentsDiagnosticsOptions(): void {
  diagnosticsOptions.recordHttpBodies = false;
  diagnosticsOptions.bodyMaxChars = 2_000;
}

// ─── redaction ───────────────────────────────────────────────────────────────

/**
 * Key fragments whose VALUE is a credential, a card, or a tax document. Matched
 * case-insensitively as a substring of the key, so `cpfCnpj`, `X-Api-Key`, `cardNumber`
 * and `access_token` are all caught by one entry each.
 *
 * The list errs towards over-redaction on purpose: a diagnostics entry exists to be
 * pasted into a bug report, so a redacted field that was harmless costs a follow-up
 * question, while a leaked one costs a credential rotation.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'auth',
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'api-key',
  'signature',
  'credential',
  'key',
  'card',
  'cvv',
  'cvc',
  'pan',
  'holder',
  'expiry',
  'exp_month',
  'exp_year',
  'cpf',
  'cnpj',
  'taxid',
  'tax_id',
  'document',
  'ssn',
  'iban',
];

/** The marker left where a value was removed. Recognisable on sight in an entry. */
export const REDACTED = '[redacted]';

/** Whether a query parameter / body key names something that must never be recorded. */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * Redact a URL query string, keeping the parameter NAMES (which are what makes a call
 * identifiable) and dropping any value that names a credential — Asaas passes
 * `access_token`, several gateways accept `?api_key=`.
 *
 * Takes and returns the string with its leading `?`, so it round-trips a `URL.search`.
 */
export function redactQueryString(search: string): string {
  if (search === '' || search === '?') return search;
  const body = search.startsWith('?') ? search.slice(1) : search;
  const redacted = body
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      return isSensitiveKey(decodeURIComponent(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');
  return `?${redacted}`;
}

/**
 * Redact a free-text string that may embed `name=value` credentials — a transport error
 * message that quotes the URL, say. Only the values are removed; the shape of the message
 * survives, which is the part worth reading.
 */
export function redactText(text: string): string {
  return text.replace(/([?&;]\s*)([\w.-]+)=([^&;\s]+)/g, (match, sep: string, name: string) =>
    isSensitiveKey(name) ? `${sep}${name}=${REDACTED}` : match,
  );
}

/**
 * Redact a request/response body: every value under a sensitive key is replaced, long
 * strings are truncated, and long arrays are cut short — so one pathological response
 * cannot flood the Telescope store.
 *
 * Only ever reached when `recordHttpBodies` is on.
 */
export function redactBody(value: unknown, maxChars = diagnosticsOptions.bodyMaxChars): unknown {
  return redactAt(value, maxChars, 0);
}

const MAX_BODY_DEPTH = 6;
const MAX_BODY_ARRAY = 20;

function redactAt(value: unknown, maxChars: number, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…[truncated]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_BODY_DEPTH) return '[depth limit]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_BODY_ARRAY).map((item) => redactAt(item, maxChars, depth + 1));
    return value.length > MAX_BODY_ARRAY
      ? [...head, `…${value.length - MAX_BODY_ARRAY} more`]
      : head;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactAt(item, maxChars, depth + 1);
  }
  return out;
}

// ─── correlation ─────────────────────────────────────────────────────────────

/**
 * One traced webhook delivery. Lives in an {@link AsyncLocalStorage} so everything the
 * delivery triggers — the verification report, the ledger writes, the business events,
 * any gateway call a handler makes — is stamped with the same `traceId` without a single
 * argument being threaded through.
 */
export interface PaymentsTraceFrame {
  traceId: string;
  provider?: string;
  /** Filled by {@link reportWebhookVerification} while the driver parses the delivery. */
  verification?: { scheme: string; ok: boolean };
}

const traceStore = new AsyncLocalStorage<PaymentsTraceFrame>();

/** A fresh correlation id for one webhook delivery attempt. */
export function newPaymentsTraceId(): string {
  return randomUUID();
}

/** Run `fn` with `frame` as the ambient payments trace. The frame is mutable by design. */
export function runWithPaymentsTrace<T>(frame: PaymentsTraceFrame, fn: () => T): T {
  return traceStore.run(frame, fn);
}

/** The ambient trace frame, when one is active. */
export function currentPaymentsTrace(): PaymentsTraceFrame | undefined {
  return traceStore.getStore();
}

/**
 * Record that a shared webhook-verification helper ran, and whether it matched.
 *
 * Called by `webhook_security.ts`, so a driver gets this for free by using the shared
 * primitives. A driver that verifies inside its own SDK (Stripe) reports nothing, which
 * is why the published outcome for that case is `unreported` rather than `verified`.
 *
 * A passing report wins over a failing one: schemes are tried in sequence (Woovi checks
 * HMAC then RSA) and the one that matched is the one that authenticated the delivery.
 */
export function reportWebhookVerification(scheme: string, ok: boolean): void {
  const frame = traceStore.getStore();
  if (frame === undefined) return;
  if (frame.verification?.ok === true) return;
  frame.verification = { scheme, ok };
}

// ─── publishing ──────────────────────────────────────────────────────────────

/** Whether anything is listening — the cheap gate before building a debug payload. */
export function paymentsDiagnosticsEnabled(): boolean {
  return typeof (globalThis as Record<symbol, unknown>)[EMIT_SLOT] === 'function';
}

/**
 * Publish a payments event on `agora:payments:<event>` via the structural diagnostics
 * slot. No-op when diagnostics isn't installed (the slot is empty) — and it never throws
 * back into the library.
 *
 * When a {@link PaymentsTraceFrame} is active and the payload does not already carry a
 * `traceId`, the frame's id is stamped onto the payload. It goes on the PAYLOAD, not on
 * the envelope: the structural emit slot is `(lib, event, payload)`, so payments cannot
 * set `DiagnosticEvent.traceId` — and it should not want to, since diagnostics fills that
 * field from the host's own request-context accessor and overwriting it would break
 * cross-library correlation. The watcher merges the two, envelope first.
 */
export function publishPayments<E extends PaymentsDiagnosticEvent>(
  event: E,
  payload: PaymentsDiagnosticPayloads[E],
): void {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
  if (typeof emit === 'function') {
    try {
      const traceId = traceStore.getStore()?.traceId;
      const withTrace =
        traceId !== undefined && (payload as { traceId?: string }).traceId === undefined
          ? { ...payload, traceId }
          : payload;
      emit('payments', event, withTrace);
    } catch {
      // diagnostics must never break a payment operation
    }
  }
}

/** Wrap a unit of payments work in a structural trace span. */
export function tracePayments<T>(event: string, fn: () => T, payload?: unknown): T {
  const trace = (globalThis as Record<symbol, unknown>)[TRACE_SLOT] as TraceFn | undefined;
  if (typeof trace === 'function') {
    return trace('payments', event, fn, payload);
  }
  return fn();
}

/**
 * Emit the `charge.created` / `charge.refunded` / `subscription.created` /
 * `subscription.canceled` diagnostics for a normalized payment/subscription. Called by
 * the drivers after a successful gateway call; a no-op when diagnostics isn't installed.
 */
export function publishPaymentDiagnostics(payment: Payment): void {
  publishPayments('charge.created', {
    gatewayId: payment.gatewayId,
    provider: payment.provider,
    amount: payment.amount.amount,
    currency: payment.amount.currency,
    ...(payment.method !== undefined ? { method: payment.method } : {}),
  });
}

export function publishRefundDiagnostics(refund: {
  gatewayId: string;
  provider: string;
  amount: { amount: number; currency: string };
}): void {
  publishPayments('charge.refunded', {
    gatewayId: refund.gatewayId,
    provider: refund.provider,
    amount: refund.amount.amount,
    currency: refund.amount.currency,
  });
}

export function publishSubscriptionDiagnostics(
  subscription: Subscription,
  event: 'subscription.created' | 'subscription.canceled',
): void {
  if (event === 'subscription.created') {
    publishPayments('subscription.created', {
      gatewayId: subscription.gatewayId,
      provider: subscription.provider,
      customerId: subscription.customerId,
      planId: subscription.planId,
    });
  } else {
    publishPayments('subscription.canceled', {
      gatewayId: subscription.gatewayId,
      provider: subscription.provider,
    });
  }
}

export function publishInvoiceEmittedDiagnostics(invoice: {
  gatewayId: string;
  provider: string;
  number?: string;
  url?: string;
}): void {
  publishPayments('invoice.emitted', {
    gatewayId: invoice.gatewayId,
    provider: invoice.provider,
    ...(invoice.number !== undefined ? { number: invoice.number } : {}),
    ...(invoice.url !== undefined ? { url: invoice.url } : {}),
  });
}

// ─── gateway HTTP calls ──────────────────────────────────────────────────────

/** Where the call went, split into the parts that are safe to record. */
interface GatewayTarget {
  host: string;
  path: string;
  query?: string;
}

/**
 * Split `baseUrl + path` into host / path / redacted query.
 *
 * The query is kept (redacted) rather than dropped because it is often the whole
 * question — `?limit=100&status=PENDING` is why the list came back empty — while the raw
 * string is never recorded, since Asaas and friends accept `?access_token=`.
 */
function gatewayTarget(baseUrl: string, path: string): GatewayTarget {
  try {
    const url = new URL(`${baseUrl}${path}`);
    return {
      host: url.host,
      path: url.pathname,
      ...(url.search !== '' ? { query: redactQueryString(url.search) } : {}),
    };
  } catch {
    // A driver may pass an already-absolute or otherwise unparsable target; record what
    // we can rather than losing the entry.
    const [rawPath = path, rawQuery] = path.split('?', 2);
    return {
      host: baseUrl,
      path: rawPath,
      ...(rawQuery !== undefined ? { query: redactQueryString(`?${rawQuery}`) } : {}),
    };
  }
}

/** One completed gateway call, as `httpRequest` saw it. */
export interface GatewayCall {
  provider?: string;
  method: string;
  baseUrl: string;
  path: string;
  /** `Date.now()` taken immediately before the fetch. */
  startedAt: number;
  /** The JSON body that was sent, if any. Recorded only when `recordHttpBodies` is on. */
  requestBody?: unknown;
}

/** How the call ended. */
export type GatewayOutcome =
  | { ok: true; status: number; responseBody?: unknown }
  | {
      ok: false;
      outcome: 'http_error' | 'timeout' | 'network_error';
      status?: number;
      /** Already free of credentials — the caller builds it, never the thrown error. */
      error: string;
      responseBody?: unknown;
    };

/**
 * Publish `gateway.request` / `gateway.request.failed` for one outbound gateway call.
 *
 * Everything here is best-effort and swallowed: an observability channel must never be
 * the reason a charge fails. Returns immediately when nothing is listening, so the URL
 * parsing and redaction below are not paid for on an app without diagnostics installed.
 */
export function publishGatewayRequest(call: GatewayCall, outcome: GatewayOutcome): void {
  if (!paymentsDiagnosticsEnabled()) return;
  try {
    const target = gatewayTarget(call.baseUrl, call.path);
    const durationMs = Math.max(0, Date.now() - call.startedAt);
    const bodies = diagnosticsOptions.recordHttpBodies;
    const requestBody =
      bodies && call.requestBody !== undefined ? { requestBody: redactBody(call.requestBody) } : {};
    const responseBody =
      bodies && outcome.responseBody !== undefined
        ? { responseBody: redactBody(outcome.responseBody) }
        : {};
    const base = {
      ...(call.provider !== undefined ? { provider: call.provider } : {}),
      method: call.method,
      host: target.host,
      path: target.path,
      ...(target.query !== undefined ? { query: target.query } : {}),
    };

    if (outcome.ok) {
      publishPayments('gateway.request', {
        ...base,
        status: outcome.status,
        durationMs,
        ...requestBody,
        ...responseBody,
      });
      return;
    }
    publishPayments('gateway.request.failed', {
      ...base,
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      durationMs,
      outcome: outcome.outcome,
      error: outcome.error,
      ...requestBody,
      ...responseBody,
    });
  } catch {
    // never break a payment operation
  }
}

/**
 * Work out what authenticated one delivery, from what the shared verification helpers
 * reported into `frame` while the driver parsed it.
 *
 * - a report that PASSED → `verified`, named by its scheme.
 * - a report that FAILED, or a `failure` message from a thrown `parseWebhook` → `failed`.
 * - nothing reported and no failure → `unreported`. Note what this does NOT claim: it
 *   does not say the delivery was unverified. Stripe verifies inside its own SDK and
 *   reports nothing, and a driver whose webhook credential is unset skips the check and
 *   also reports nothing. Both land here, and the entry says so rather than guessing.
 */
export function webhookVerificationOutcome(
  frame: PaymentsTraceFrame | undefined,
  failure?: string,
): Pick<WebhookVerificationPayload, 'outcome' | 'scheme' | 'reason'> {
  const scheme = frame?.verification !== undefined ? { scheme: frame.verification.scheme } : {};
  if (failure !== undefined) return { outcome: 'failed', ...scheme, reason: failure };
  if (frame?.verification === undefined) return { outcome: 'unreported' };
  return { outcome: frame.verification.ok ? 'verified' : 'failed', ...scheme };
}

/**
 * Publish `webhook.verification` for one delivery: what authenticated it, or that
 * nothing did.
 *
 * `outcome` is derived rather than asserted — see {@link webhookVerificationOutcome}.
 */
export function publishWebhookVerification(payload: WebhookVerificationPayload): void {
  publishPayments('webhook.verification', payload);
}
