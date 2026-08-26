/**
 * A local, structural mirror of the `@adonis-agora/telescope` watcher contract.
 *
 * We deliberately do NOT import `@adonis-agora/telescope` — it lives in a separate repo,
 * and is only an OPTIONAL peer (a host may run `@adonis-agora/payments` without any
 * observability at all). Same cross-repo decoupling as the payments diagnostics slot
 * itself and `@adonis-agora/media`'s `src/telescope/telescope-sdk.ts`. Keep these in
 * lockstep with `@adonis-agora/telescope`'s watcher types.
 */

/**
 * The recording surface a {@link PaymentsWatcher} is handed on `register`. Mirror of
 * telescope's `WatcherContext` — a host wires the watcher to a real telescope store's
 * `record`.
 */
export interface WatcherContext {
  record(entry: { type: string; content: unknown }): void;
}
