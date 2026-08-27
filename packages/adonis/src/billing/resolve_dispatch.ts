import type { PaymentsConfig } from '../define_config.js';
import type { WebhookDispatchMode } from './webhook_dispatcher.js';

/** Which half of a split deployment a process is. */
export type BillingRole = 'all' | 'api' | 'worker';

/**
 * The dispatch backend for a config: `billing.dispatcher` when set, else the
 * legacy `billing.durable` alias, else `'auto'`.
 *
 * `dispatcher` is read FIRST because it is the only option able to name every
 * backend — the boolean alias cannot express `'queue'` at all.
 */
export function resolveDispatchMode(config: PaymentsConfig): WebhookDispatchMode {
  const dispatcher = config.billing?.dispatcher;
  if (dispatcher !== undefined) return dispatcher;

  const legacy = config.billing?.durable ?? 'auto';
  if (legacy === true) return 'durable';
  if (legacy === false) return 'in-process';
  return 'auto';
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
  if (mode === 'durable' || mode === 'queue') return;

  throw new Error(
    `[payments] billing.role is "${role}", which splits receiving from processing — but billing.dispatcher is "${mode}", which has no channel between the two halves. Set dispatcher to "durable" or "queue", or drop billing.role.`,
  );
}
