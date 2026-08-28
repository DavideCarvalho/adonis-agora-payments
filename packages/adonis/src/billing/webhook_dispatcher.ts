import { randomUUID } from 'node:crypto';
import type { WebhookEvent } from '../types.js';
import type { WebhookProcessor } from './webhook_processor.js';

/**
 * Strategy used to run a webhook event through the {@link WebhookProcessor}.
 *
 * - `durable` — the event is dispatched as a fire-and-forget durable workflow run
 *   (`@adonis-agora/durable`), so processing survives crashes and retries deterministically.
 * - `in-process` — the event runs inline (awaited); on failure it is retried with
 *   exponential backoff in the background.
 * - `auto` — uses `durable` when its provider is registered, else `queue` when the queue
 *   provider is, else `in-process`.
 */
export type WebhookDispatchMode = 'durable' | 'in-process' | 'auto';

export interface WebhookDispatcherOptions {
  processor: WebhookProcessor;
  /**
   * How webhooks are processed. `'auto'` (default) lazily resolves
   * `@adonis-agora/durable` and uses it when installed AND available (the app has the
   * durable provider registered), else `@adonisjs/queue` when available, else
   * `in-process`. `'durable'` requires its backend (throws when missing).
   * `'in-process'` never touches either.
   */
  mode?: WebhookDispatchMode;
  /**
   * In-process retry settings (exponential backoff). Ignored when durable/queue processes
   * the event, which rely on their own retries.
   */
  retries?: {
    /** Max attempts including the first. Default 5. */
    max?: number;
    /** Base delay in ms. Default 500. */
    baseDelayMs?: number;
    /** Max delay in ms. Default 30_000. */
    maxDelayMs?: number;
  };
  /**
   * Optional availability check used in `auto` mode: resolves to `true` only when durable
   * is installed AND its engine is resolvable in the app (provider registered). Defaults
   * to "installed" only. The provider injects the real check.
   */
  durableAvailable?: () => Promise<boolean>;
  /**
   * Resolve the app's durable {@link DurableEngineLike}. The provider wires this from the
   * container; without it there is no engine to register the workflow ON, and durable mode
   * cannot work — see {@link DurableEngineLike} for why registration is not optional.
   */
  durableEngine?: () => Promise<DurableEngineLike>;
}

/**
 * The slice of `@adonis-agora/durable`'s `WorkflowEngine` this needs.
 *
 * Both halves are load-bearing. `start` alone is not enough: the engine looks the workflow
 * up by NAME in its registry and throws `workflow … is not registered` for anything it has
 * not been told about, so the webhook workflow has to be REGISTERED before the first
 * dispatch. This class used to build an anonymous `class extends BaseWorkflow` and call its
 * static `dispatch`, which registers nothing and has no `static workflow = { name }` — so
 * every delivery threw `workflow class PaymentsWebhookWorkflow has no registered name`, was
 * collected as a failed event, and the route answered 500. In an app with durable installed
 * — which is exactly what `'auto'` selects — that was every webhook, forever.
 */
export interface DurableEngineLike {
  register(name: string, version: string, fn: (ctx: unknown, input: never) => Promise<void>): void;
  start(name: string, input: unknown, runId: string): Promise<unknown>;
}

/**
 * The durable workflow's identity. Stable and explicit: the engine registry is keyed by
 * name, an in-flight run records the name+version it started on, and a name that changed
 * between deploys would strand runs mid-flight.
 */
export const WEBHOOK_WORKFLOW_NAME = 'payments-webhook';
export const WEBHOOK_WORKFLOW_VERSION = '1';

/** One event of a delivery that did not get through, and why. */
export interface WebhookDeliveryFailure {
  event: WebhookEvent;
  error: Error;
}

/**
 * What became of one webhook DELIVERY — which may carry several events (Adyen's
 * `notificationItems`, Efí's `pix` array).
 *
 * The route turns this into the HTTP status: any failure at all means a non-2xx, because
 * a 2xx is a promise to the gateway that it never has to send this again.
 */
export interface WebhookDeliveryResult {
  /** How many events the delivery carried. */
  total: number;
  /** How many were processed (in-process) or accepted by durable/queue. */
  dispatched: number;
  /** The ones that threw, in delivery order. Empty on a clean delivery. */
  failures: WebhookDeliveryFailure[];
}

/**
 * Runs webhook events through the {@link WebhookProcessor}. In `auto` mode (the default)
 * it tries to import `@adonis-agora/durable` lazily — only when the app has it installed
 * do webhooks run as durable workflows; otherwise they fall back to an in-process
 * dispatcher with exponential-backoff retries.
 */
export class WebhookDispatcher {
  #processor: WebhookProcessor;
  #mode: WebhookDispatchMode;
  #maxAttempts: number;
  #baseDelayMs: number;
  #maxDelayMs: number;
  #engine: DurableEngineLike | undefined;
  #registered = false;
  #durableChecked = false;
  #durableAvailable: (() => Promise<boolean>) | undefined;
  #durableEngine: (() => Promise<DurableEngineLike>) | undefined;

  constructor(options: WebhookDispatcherOptions) {
    this.#processor = options.processor;
    this.#mode = options.mode ?? 'auto';
    this.#maxAttempts = options.retries?.max ?? 5;
    this.#baseDelayMs = options.retries?.baseDelayMs ?? 500;
    this.#maxDelayMs = options.retries?.maxDelayMs ?? 30_000;
    this.#durableAvailable = options.durableAvailable;
    this.#durableEngine = options.durableEngine;
  }

  /**
   * Dispatch a webhook event for processing. Resolves once the event is accepted (durable)
   * or fully processed (in-process).
   */
  async dispatch(event: WebhookEvent): Promise<{ runId?: string }> {
    const { runId } = await this.#dispatchOne(event);
    return runId !== undefined ? { runId } : {};
  }

  /**
   * Dispatch a whole DELIVERY: one event, or the several a batched envelope carried.
   *
   * **The loop lives here, not in the route.** Everything it has to get right — the ledger
   * claim, the retry policy, which backend runs the work — is already this class's job; the
   * route's job is to turn the outcome into a status code. It also makes the batch testable
   * without standing up an HTTP context.
   *
   * **Sequential, deliberately.** Two events in one envelope routinely touch the same row
   * (an Adyen AUTHORISATION and its CAPTURE; a Pix and its devolução), and running them
   * concurrently would race the ledger claim and the payment upsert against each other,
   * which is how you get a `paid` row overwritten by the `pending` that preceded it. The
   * gateway's order is the order the money moved in, so it is the order they run in.
   *
   * **One failure does not cancel its siblings.** Event 2 of 4 throwing says nothing about
   * events 3 and 4 — they are different payments, and refusing to process them because a
   * neighbour failed loses money for a reason unrelated to them. So every event is attempted
   * and the failures are COLLECTED. The caller is then responsible for the other half:
   * reporting a non-2xx so the gateway redelivers, since a 200 tells it the failed one is
   * done and it is never sent again. The redelivery re-runs only the failed event — the
   * ledger claims a `failed` row again, while the ones that succeeded answer `null` and skip.
   */
  async dispatchAll(events: WebhookEvent | WebhookEvent[]): Promise<WebhookDeliveryResult> {
    const list = Array.isArray(events) ? events : [events];
    const failures: WebhookDeliveryFailure[] = [];
    let dispatched = 0;
    for (const event of list) {
      try {
        const { error } = await this.#dispatchOne(event);
        if (error !== undefined) failures.push({ event, error });
        else dispatched += 1;
      } catch (thrown) {
        // The durable/queue path throws rather than reporting (an unreachable engine, a
        // workflow that will not build). Caught here for the same reason as above: the
        // remaining events still deserve their attempt.
        failures.push({ event, error: asError(thrown) });
      }
    }
    return { total: list.length, dispatched, failures };
  }

  /** One event through the active backend. Durable/queue may throw; in-process reports. */
  async #dispatchOne(event: WebhookEvent): Promise<{ runId?: string; error?: Error }> {
    if (await this.#useDurable()) {
      const engine = await this.#resolveEngine();
      this.#registerWorkflow(engine);
      // A FRESH run id per delivery, deliberately. `engine.start` is idempotent by run id
      // and returns the prior run's state for a repeat — so a deterministic id derived from
      // the event would make the gateway's redelivery of a FAILED event a silent no-op,
      // which is the one case redelivery exists for. Deduplication of an already-processed
      // event is the ledger's job (the claim answers `null` and the run skips), and it
      // makes that decision from the row's state rather than from the id alone.
      const runId = randomUUID();
      await engine.start(WEBHOOK_WORKFLOW_NAME, { event }, runId);
      return { runId };
    }

    return this.#processWithRetry(event);
  }

  /** Whether durable-backed processing is active. */
  get mode(): WebhookDispatchMode {
    return this.#mode;
  }

  /**
   * Decide whether durable handles this event. `auto` resolves the engine once and caches
   * the answer; `durable` forces it (throwing when missing); `in-process` never.
   */
  async #useDurable(): Promise<boolean> {
    if (this.#mode === 'in-process') return false;
    if (this.#mode === 'durable') return true;
    // 'auto'
    if (this.#durableChecked) return this.#engine !== undefined;
    this.#durableChecked = true;
    try {
      if (this.#durableAvailable && !(await this.#durableAvailable())) {
        this.#engine = undefined;
        return false;
      }
      this.#engine = await this.#resolveEngine();
      return true;
    } catch {
      this.#engine = undefined;
      return false;
    }
  }

  /**
   * The app's durable engine, from the seam the provider wires.
   *
   * There is no fallback that imports `@adonis-agora/durable` and builds its own: an engine
   * is bound to a store and a transport that only the app has configured, and a second one
   * would persist runs nothing ever executes.
   */
  async #resolveEngine(): Promise<DurableEngineLike> {
    if (this.#engine) return this.#engine;
    if (!this.#durableEngine) {
      throw new Error(
        '[payments] billing.dispatcher is durable but no durable engine was provided. ' +
          'The payments provider wires this from the container — install @adonis-agora/durable ' +
          'and register its provider, or set billing.dispatcher to "in-process".',
      );
    }
    this.#engine = await this.#durableEngine();
    return this.#engine;
  }

  /**
   * Register the webhook workflow on the engine. Idempotent, and it has to happen before
   * the first `start`: the engine resolves a run by looking its NAME up in the registry and
   * throws `workflow payments-webhook is not registered` otherwise.
   */
  #registerWorkflow(engine: DurableEngineLike): void {
    if (this.#registered) return;
    const processor = this.#processor;
    engine.register(
      WEBHOOK_WORKFLOW_NAME,
      WEBHOOK_WORKFLOW_VERSION,
      async (_ctx: unknown, input: never) => {
        await processor.process((input as { event: WebhookEvent }).event);
      },
    );
    this.#registered = true;
  }

  /**
   * In-process fallback: run through the processor, retrying with exponential backoff on
   * failure (up to `#maxAttempts`). Retries run in the background — the first attempt is
   * awaited so the webhook endpoint can respond.
   *
   * The failure is REPORTED as well as retried. The background retry lives and dies with
   * this process, so a crash between the failure and the retry loses the event outright;
   * the gateway's own redelivery is the only durable retry there is, and it only happens if
   * the route answers non-2xx. Both run, and the ledger keeps that safe: whichever attempt
   * claims the `failed` row first does the work, and the other short-circuits on the claim.
   */
  async #processWithRetry(event: WebhookEvent): Promise<{ runId?: string; error?: Error }> {
    try {
      await this.#processor.process(event);
      return {};
    } catch (error) {
      // Retry in the background (don't block the webhook response). The processor itself
      // publishes `webhook.failed` on the diagnostics channel.
      void this.#retry(event, 2);
      return { error: asError(error) };
    }
  }

  async #retry(event: WebhookEvent, attempt: number): Promise<void> {
    if (attempt > this.#maxAttempts) return;
    const delay = Math.min(this.#baseDelayMs * 2 ** (attempt - 2), this.#maxDelayMs);
    await sleep(delay);
    try {
      await this.#processor.process(event);
    } catch {
      await this.#retry(event, attempt + 1);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A thrown value as an `Error` — a handler may throw a string, and the message is the point. */
function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}
