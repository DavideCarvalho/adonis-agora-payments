import type { PaymentsConfig } from '../define_config.js';
import type { WebhookDispatchMode } from './webhook_dispatcher.js';

/** Which half of a split deployment a process is. */
export type BillingRole = 'all' | 'api' | 'worker';

/**
 * The dispatch backend for a config: `billing.dispatcher` when set, else `'auto'`.
 */
export function resolveDispatchMode(config: PaymentsConfig): WebhookDispatchMode {
  const dispatcher = config.billing?.dispatcher;
  // `'queue'` was in the type, in the config docs and in the dispatcher's own comments, and
  // was implemented nowhere: `queueDispatch` was declared and never read, so the mode fell
  // through to the `'auto'` branch and silently ran durable-or-in-process. Worse, splitting
  // api/worker was ALLOWED on it, which produced an api process doing all the work and a
  // worker sitting idle. Refusing at boot is the only honest answer until it exists.
  if ((dispatcher as string) === 'queue') {
    throw new Error(
      '[payments] `billing.dispatcher: "queue"` is not implemented — it never was, and it silently ran the in-process or durable backend instead. Use "durable" (a real channel, and the only mode that can split billing.role) or "in-process". Track the queue backend in the roadmap.',
    );
  }
  // `billing.durable` was removed in 1.0. Without this check a leftover `durable: false` would
  // quietly become `'auto'` and start running webhooks on durable.
  if ((config.billing as { durable?: unknown } | undefined)?.durable !== undefined) {
    throw new Error(
      '[payments] `billing.durable` was removed in 1.0. Use `billing.dispatcher`: "auto", "durable" (was `durable: true`) or "in-process" (was `durable: false`).',
    );
  }
  return dispatcher ?? 'auto';
}

/** Which half this process is. Defaults to running both. */
export function resolveRole(config: PaymentsConfig): BillingRole {
  return config.billing?.role ?? 'all';
}

/**
 * Splitting api/worker only works when the dispatcher puts a channel between the
 * halves. `'in-process'` runs the processor inline — an `'api'` process would
 * process everything itself and a `'worker'` would sit idle — and `'auto'` can
 * silently resolve to it, so neither may be split on.
 */
export function assertRoleIsDispatchable(role: BillingRole, mode: WebhookDispatchMode): void {
  if (role === 'all') return;
  if (mode === 'durable') return;

  throw new Error(
    `[payments] billing.role is "${role}", which splits receiving from processing — but billing.dispatcher is "${mode}", which has no channel between the two halves. Set dispatcher to "durable", or drop billing.role.`,
  );
}
