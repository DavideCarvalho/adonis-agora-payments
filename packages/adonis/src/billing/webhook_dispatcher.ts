import type { WebhookEvent } from '../types.js';
import type { WebhookProcessor } from './webhook_processor.js';

/**
 * Strategy used to run a webhook event through the {@link WebhookProcessor}.
 *
 * - `durable` — the event is dispatched as a fire-and-forget durable workflow run
 *   (`@adonis-agora/durable`), so processing survives crashes and retries deterministically.
 * - `queue` — the event is dispatched as an `@adonisjs/queue` job (`queueDispatch`).
 * - `in-process` — the event runs inline (awaited); on failure it is retried with
 *   exponential backoff in the background.
 * - `auto` — uses `durable` when its provider is registered, else `queue` when the queue
 *   provider is, else `in-process`.
 */
export type WebhookDispatchMode = 'durable' | 'queue' | 'in-process' | 'auto';

export interface WebhookDispatcherOptions {
  processor: WebhookProcessor;
  /**
   * How webhooks are processed. `'auto'` (default) lazily resolves
   * `@adonis-agora/durable` and uses it when installed AND available (the app has the
   * durable provider registered), else `@adonisjs/queue` when available, else
   * `in-process`. `'durable'`/`'queue'` require their backend (throw when missing).
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
   * Dispatch a webhook event as an `@adonisjs/queue` job. The provider wires this (it owns
   * the job class, its container binding and the queue-manager registration). Absent =
   * queue mode is unavailable.
   */
  queueDispatch?: (event: WebhookEvent) => Promise<{ jobId?: string }>;
}

/** The minimal durable surface we use: a workflow class with a static `dispatch`. */
export interface DurableWorkflowLike {
  dispatch(input: { event: WebhookEvent }): Promise<{ runId: string }>;
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
  #workflow: DurableWorkflowLike | undefined;
  #durableChecked = false;
  #durableAvailable: (() => Promise<boolean>) | undefined;

  constructor(options: WebhookDispatcherOptions) {
    this.#processor = options.processor;
    this.#mode = options.mode ?? 'auto';
    this.#maxAttempts = options.retries?.max ?? 5;
    this.#baseDelayMs = options.retries?.baseDelayMs ?? 500;
    this.#maxDelayMs = options.retries?.maxDelayMs ?? 30_000;
    this.#durableAvailable = options.durableAvailable;
  }

  /**
   * Dispatch a webhook event for processing. Resolves once the event is accepted (durable)
   * or fully processed (in-process).
   */
  async dispatch(event: WebhookEvent): Promise<{ runId?: string }> {
    if (await this.#useDurable()) {
      const workflow = await this.#resolveDurable();
      const { runId } = await workflow.dispatch({ event });
      return { runId };
    }

    return this.#processWithRetry(event);
  }

  /** Whether durable-backed processing is active. */
  get mode(): WebhookDispatchMode {
    return this.#mode;
  }

  /**
   * Decide whether durable handles this event. `auto` performs the lazy import once and
   * caches the answer; `durable` forces it (throwing when missing); `in-process` never.
   */
  async #useDurable(): Promise<boolean> {
    if (this.#mode === 'in-process') return false;
    if (this.#mode === 'durable') return true;
    // 'auto'
    if (this.#durableChecked) return this.#workflow !== undefined;
    this.#durableChecked = true;
    try {
      if (this.#durableAvailable && !(await this.#durableAvailable())) {
        this.#workflow = undefined;
        return false;
      }
      await import('@adonis-agora/durable');
      this.#workflow = await this.#buildWorkflow();
      return true;
    } catch {
      this.#workflow = undefined;
      return false;
    }
  }

  /**
   * Lazily build a durable workflow class that runs the event through the shared
   * processor hook. Only called when durable is actually installed.
   */
  async #buildWorkflow(): Promise<DurableWorkflowLike> {
    const durable = await import('@adonis-agora/durable');
    const { BaseWorkflow } = durable as typeof import('@adonis-agora/durable');
    const processor = this.#processor;
    // The workflow's `run(ctx, input)` is the durable body; `dispatch` (static, inherited)
    // enqueues it fire-and-forget. Input is the webhook event.
    const workflow = class PaymentsWebhookWorkflow extends BaseWorkflow {
      async run(_ctx: unknown, input: { event: WebhookEvent }): Promise<void> {
        await processor.process(input.event);
      }
    };
    return workflow as unknown as DurableWorkflowLike;
  }

  async #resolveDurable(): Promise<DurableWorkflowLike> {
    const workflow = this.#workflow ?? (await this.#buildWorkflow());
    if (!workflow) {
      throw new Error(
        '[payments] billing.durable is set to true/auto but @adonis-agora/durable is not installed. ' +
          'Install it (`node ace add @adonis-agora/durable`) or set billing.durable to false.',
      );
    }
    return workflow;
  }

  /**
   * In-process fallback: run through the processor, retrying with exponential backoff on
   * failure (up to `#maxAttempts`). Retries run in the background — the first attempt is
   * awaited so the webhook endpoint can respond.
   */
  async #processWithRetry(event: WebhookEvent): Promise<{ runId?: string }> {
    try {
      await this.#processor.process(event);
      return {};
    } catch (error) {
      // Retry in the background (don't block the webhook response). The processor itself
      // publishes `webhook.failed` on the diagnostics channel.
      void this.#retry(event, 2);
      return {};
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
