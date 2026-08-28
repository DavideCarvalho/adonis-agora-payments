import { isPaymentsDiagnosticClaimed } from '../diagnostics.js';
import type { PaymentsWatcher } from './payments_watcher.js';

const TELESCOPE_PACKAGE = '@adonis-agora/telescope';

/**
 * Wiring the typed `payments` Telescope watcher, extracted from the provider so it can be
 * tested for what it promises without standing up an application — and without installing
 * `@adonis-agora/telescope`, which is an optional peer this package deliberately does not
 * depend on.
 *
 * This was six lines every app copied into `start/telescope.ts`, and until someone did, a
 * payments timeline showed generic `diagnostic` entries with the payload buried rather than
 * typed `payments` ones. The wiring never varied, so it moved here.
 *
 * **There is no configuration for this, on purpose.** Every option that was drafted turned
 * out to describe a situation the code can just detect:
 *
 * - "off, because I wire my own" — the channel claims say so. An app that registered its own
 *   watcher has already claimed the payments channels, and this skips.
 * - "off, because I do not want telescope" — then telescope is not in the app, and this
 *   skips.
 * - "on, and fail if telescope is missing" — a missing telescope means an empty timeline,
 *   which is not a reason to refuse to take payments.
 */

/** The slice of a telescope store the watcher records through. */
export interface TelescopeRecorder {
  record(entry: { type: string; content: unknown }): Promise<unknown>;
}

/** The slice of the AdonisJS application container this needs. */
export interface WatcherHost {
  container: { make(token: never): Promise<unknown> };
}

/** A disposable registration — the provider holds it so `shutdown()` can release it. */
export interface RegisteredWatcher {
  dispose(): void;
}

export interface RegisterWatcherOptions {
  /**
   * Seams, for tests only. The import is a seam because telescope is not installed here and
   * a test must be able to describe both worlds — present and absent — without it.
   */
  importTelescope?: () => Promise<{ TelescopeService: unknown }>;
  makeWatcher?: () => PaymentsWatcher;
  alreadyClaimed?: () => boolean;
}

/**
 * Register the watcher against the app's telescope store, unless there is nothing to do.
 *
 * Returns `undefined` when it did not register, which is a normal outcome and not an error:
 * telescope may be absent, or the app may already have wired its own watcher.
 *
 * The provider calls this in `ready()`, not `boot()`, and the order is the whole reason the
 * claim check works: `start/` files run before `ready`, so an app that wires its own watcher
 * has already claimed the channels by the time this looks. Registering in `boot()` would
 * race that and double-record for every app that followed the old documentation.
 */
export async function registerPaymentsWatcher(
  app: WatcherHost,
  options: RegisterWatcherOptions = {},
): Promise<RegisteredWatcher | undefined> {
  // Somebody already owns these channels — an app that wired `PaymentsWatcher` by hand, the
  // way the docs used to say to. Registering a second one would record every payment event
  // twice, and the app that followed the instructions would be the one it happened to.
  const claimed = options.alreadyClaimed ?? (() => isPaymentsDiagnosticClaimed('charge.created'));
  if (claimed()) return undefined;

  try {
    const telescope =
      options.importTelescope !== undefined
        ? await options.importTelescope()
        : // A non-literal specifier on purpose: `@adonis-agora/telescope` is an OPTIONAL peer
          // and is not installed here, so a literal import would fail `tsc` in this repo even
          // though it resolves fine in an app that has it.
          ((await import(TELESCOPE_PACKAGE)) as unknown as { TelescopeService: unknown });

    const service = (await app.container.make(telescope.TelescopeService as never)) as {
      telescopeStore: TelescopeRecorder;
    };
    const store = service.telescopeStore;

    const watcher =
      options.makeWatcher !== undefined
        ? options.makeWatcher()
        : new (await import('./payments_watcher.js')).PaymentsWatcher();

    watcher.register({
      // Recording is observability. A telescope store that is full, locked or briefly
      // unreachable must not take a payment webhook down with it — so the promise is
      // swallowed here rather than surfacing inside a diagnostics publish, which runs
      // synchronously inside the charge that triggered it.
      record: (entry) => void store.record(entry).catch(() => {}),
    });
    return watcher;
  } catch {
    // Telescope is not in this app. Nothing to do, and nothing to say about it — an app
    // without observability is a normal app, not a misconfigured one.
    return undefined;
  }
}
