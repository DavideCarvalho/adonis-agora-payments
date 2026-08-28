import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DisputeWebhookData,
  PaymentWebhookData,
  SubscriptionWebhookData,
  WebhookEventType,
} from './billing/webhook_events.js';
import { WEBHOOK_EVENT_TYPES } from './billing/webhook_events.js';
import type { WebhookHandler } from './billing/webhook_processor.js';
import type { WebhookEvent } from './types.js';

/**
 * Which normalized payload each canonical event type carries.
 *
 * The map exists because `WebhookEvent<T = unknown>` made every handler open with a cast —
 * `const data = event.data as PaymentWebhookData` — and a cast is a claim nothing checks.
 * `payment.disputed` carries a {@link DisputeWebhookData}, not a payment payload, so the
 * copy-pasted cast was simply WRONG on that one handler: it read `amount`/`currency` as
 * required off a shape where a Stripe early fraud warning has neither.
 *
 * Pair a type with its payload here once and {@link defineWebhookHandler} infers it, so the
 * wrong pairing is a compile error instead of a runtime `undefined`.
 */
export interface WebhookEventDataMap {
  'payment.succeeded': PaymentWebhookData;
  'payment.failed': PaymentWebhookData;
  'payment.refunded': PaymentWebhookData;
  'payment.updated': PaymentWebhookData;
  'payment.disputed': DisputeWebhookData;
  'payment.dispute_warning': DisputeWebhookData;
  'payment.dispute_closed': DisputeWebhookData;
  'subscription.created': SubscriptionWebhookData;
  'subscription.updated': SubscriptionWebhookData;
  'subscription.canceled': SubscriptionWebhookData;
}

/**
 * The payload a handler for `T` receives. Canonical types resolve through
 * {@link WebhookEventDataMap}; anything else is a driver passthrough (drivers lowercase the
 * gateway events they cannot map) whose shape this library cannot know, so it stays
 * `unknown` — which is honest, and forces a narrowing the app can see.
 */
export type WebhookEventDataFor<T extends string> = T extends WebhookEventType
  ? WebhookEventDataMap[T]
  : unknown;

/** A {@link WebhookEvent} narrowed to one event type, payload included. */
export type WebhookEventFor<T extends string> = WebhookEvent<WebhookEventDataFor<T>> & {
  type: T;
};

/** A handler that knows which event it is for — and therefore what `event.data` is. */
export type TypedWebhookHandler<T extends string> = (
  event: WebhookEventFor<T>,
) => void | Promise<void>;

/**
 * What {@link defineWebhookHandler} returns: callable as a plain {@link WebhookHandler} (so
 * it drops straight into `billing.handlers`) AND carrying `type`/`handle` (so it is a valid
 * default export for the `app/payment_handlers/` convention). One value, both wiring styles.
 */
export interface WebhookHandlerDefinition<T extends string = string> {
  (event: WebhookEvent): void | Promise<void>;
  readonly type: T;
  readonly handle: WebhookHandler;
}

/**
 * Declare a webhook handler for ONE event type, with `event.data` inferred from the type.
 *
 * ```ts
 * export default defineWebhookHandler('payment.disputed', async (event) => {
 *   event.data.actionableUntil // DisputeWebhookData — no cast
 *   event.data.paidAt          // compile error: that is a payment payload
 * })
 * ```
 *
 * A passthrough type the driver did not map is accepted (it is a real thing a gateway
 * sends), and its `data` is `unknown` because nothing normalized it.
 */
export function defineWebhookHandler<T extends WebhookEventType | (string & {})>(
  type: T,
  handle: TypedWebhookHandler<T>,
): WebhookHandlerDefinition<T> {
  // The ONE cast, here, instead of one in every application handler. It is sound in exactly
  // the way the app-side cast was not: the type is checked against the same map the payload
  // came from, and validated at boot by `assertWebhookHandlerTypes`.
  const wrapped = (event: WebhookEvent) => handle(event as WebhookEventFor<T>);
  return Object.assign(wrapped, {
    type,
    handle: wrapped as WebhookHandler,
  }) as WebhookHandlerDefinition<T>;
}

/**
 * A webhook-handler service constructor: the lib resolves it from the Adonis container
 * (DI works) and calls `handle(event)` for each event of the registered type. A class
 * with no dependencies is unaffected — the container simply does `new Ctor()`.
 */
export interface WebhookHandlerService {
  new (...args: never[]): { handle(event: WebhookEvent): void | Promise<void> };
}

/** The container surface handler resolution needs. */
export interface HandlerContainer {
  make<T>(token: unknown): Promise<T>;
}

/**
 * Detect a {@link WebhookHandlerService} (a class with a `handle` method) vs a plain
 * handler function. Arrow functions have no prototype; named functions have one without
 * a `handle` member — only a class declaring `handle` matches, so plain handlers are
 * never misrouted.
 */
export function isWebhookHandlerService(entry: unknown): entry is WebhookHandlerService {
  return (
    typeof entry === 'function' &&
    Object.getOwnPropertyNames((entry as { prototype?: object }).prototype ?? {}).includes('handle')
  );
}

/**
 * Resolve one `billing.handlers` entry (or a folder-discovered handler) into a concrete
 * {@link WebhookHandler}: plain functions pass through; service classes are instantiated
 * through the container and bound to their `handle` method.
 */
export async function resolveWebhookHandler(
  entry: WebhookHandler | WebhookHandlerService,
  container: HandlerContainer,
): Promise<WebhookHandler> {
  if (isWebhookHandlerService(entry)) {
    const service = await container.make<InstanceType<WebhookHandlerService>>(entry);
    return (event) => service.handle(event);
  }
  return entry;
}

/**
 * A folder-discovered handler: the normalized event type plus the raw entry (function or
 * service class) to resolve through the container at wiring time.
 */
export interface DiscoveredWebhookHandler {
  type: string;
  entry: WebhookHandler | WebhookHandlerService;
  /**
   * Where it came from — the module path for a scan, the barrel key for a build-time
   * barrel, `config.billing.handlers` for a configured one. Only ever used in messages, and
   * that is the point: "two handlers claim payment.succeeded" is not actionable without the
   * two file names.
   */
  source?: string;
}

/** Shape each file in the conventions folder must default-export. */
export interface WebhookHandlerModule {
  /**
   * Normalized event type this handler listens to (e.g. `'payment.succeeded'`). A service
   * class declares it as `static eventType` instead.
   */
  type?: WebhookEventType | (string & {});
  /** Event-type static on a service class form. */
  eventType?: WebhookEventType | (string & {});
  /** The handler function (object form). */
  handle?: WebhookHandler;
}

/** Normalize a module's default export into a {@link DiscoveredWebhookHandler}, or null. */
export function normalizeWebhookHandlerModule(mod: unknown): DiscoveredWebhookHandler | null {
  if (typeof mod !== 'function' && (typeof mod !== 'object' || mod === null)) return null;
  const candidate = mod as WebhookHandlerModule;
  const type = candidate.type ?? candidate.eventType;
  if (typeof type !== 'string') return null;
  // Service class form: `static eventType` + instance `handle` (on the prototype, so the
  // class itself has no own `handle` and never reaches the branch below).
  if (typeof mod === 'function' && isWebhookHandlerService(mod)) return { type, entry: mod };
  // Object form `{ type, handle }` — and the function form {@link defineWebhookHandler}
  // returns, which is a callable carrying the same two members.
  if (typeof candidate.handle !== 'function') return null;
  return { type, entry: candidate.handle };
}

/**
 * One handler registration, as the boot-time check sees it: which type it claims and where
 * it came from.
 */
export interface WebhookHandlerRegistration {
  type: string;
  source: string;
}

/**
 * A type that LOOKS canonical: same namespace as the library's own types, so a typo lands
 * here rather than being waved through as a gateway passthrough.
 *
 * This is the whole honest rule. A driver that cannot map a gateway event passes it through
 * lowercased — Asaas turns `PAYMENT_ANTICIPATED` into `payment_anticipated`, Adyen turns
 * `REPORT_AVAILABLE` into `report_available` — and a library cannot enumerate every event
 * eighteen gateways can send. What it CAN say is that `payment.` and `subscription.`
 * followed by a dot are ITS namespace: every member of {@link WEBHOOK_EVENT_TYPES} is in it,
 * a passthrough of an unmapped event is not (`payment_anticipated` has no dot), and
 * `payment.suceeded` is a misspelling of something the library owns.
 */
function isCanonicalNamespace(type: string): boolean {
  return /^(payment|subscription)\.[a-z_]+$/.test(type);
}

/**
 * Refuse, at boot, a handler registered for an event type nothing will ever deliver.
 *
 * The failure this closes is silent end to end: `normalizeWebhookHandlerModule` accepted any
 * string, the provider did `handlers[type] = ...`, and the processor looked up
 * `#handlers[event.type]` and skipped a miss. So `'payment.suceeded'` registered a handler
 * nothing called, the ledger still marked the delivery `processed`, and the grant simply
 * never happened — with a 200 to the gateway promising it never has to send that event
 * again.
 *
 * Two registrations of the SAME type are refused for the same reason: `handlers[type] = ...`
 * overwrites, so the second file silently replaced the first and one of the two handlers
 * never ran again.
 */
export function assertWebhookHandlerTypes(
  registrations: readonly WebhookHandlerRegistration[],
  options: { passthroughEvents?: readonly string[] } = {},
): void {
  const allowed = new Set<string>(options.passthroughEvents ?? []);
  const seen = new Map<string, string>();
  for (const { type, source } of registrations) {
    const known = (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
    if (!known && !allowed.has(type) && isCanonicalNamespace(type)) {
      throw new Error(
        [
          `[payments] Webhook handler (${source}) is registered for "${type}", which is not a`,
          'normalized event type — nothing will ever call it, and the delivery will still be',
          `recorded as processed. Normalized types: ${WEBHOOK_EVENT_TYPES.join(', ')}.`,
          'A type in the `payment.*`/`subscription.*` namespace must be one of those, because',
          "that namespace is the library's own. A gateway type the driver could not map arrives",
          'lowercased as the gateway spells it (Asaas `PAYMENT_ANTICIPATED` →',
          '"payment_anticipated"), which is accepted as-is; if your gateway really does spell one',
          'with a dot in this namespace, list it in `billing.passthroughEvents`.',
        ].join(' '),
      );
    }
    const previous = seen.get(type);
    if (previous !== undefined) {
      throw new Error(
        [
          `[payments] Two webhook handlers claim "${type}": ${previous} and ${source}.`,
          'Registration is a map keyed by event type, so the second silently replaced the first',
          'and one of them would never run. Keep one handler per type (call the other from it)',
          'or give them different types.',
        ].join(' '),
      );
    }
    seen.set(type, source);
  }
}

/** The build-time barrel the Assembler `init` hook generates — a map of key → lazy import. */
export type WebhookHandlersBarrel = Record<string, () => Promise<Record<string, unknown>>>;

/**
 * Load the generated barrel (`.adonisjs/payments/webhook_handlers.js`) — the build-time
 * equivalent of a directory scan, with no runtime `readdir`. Each module's default export
 * is normalized via {@link normalizeWebhookHandlerModule}.
 */
export async function loadWebhookHandlersFromBarrel(
  barrel: WebhookHandlersBarrel,
): Promise<DiscoveredWebhookHandler[]> {
  const found: DiscoveredWebhookHandler[] = [];
  const seen = new Set<unknown>();
  for (const [key, load] of Object.entries(barrel)) {
    const mod = await load();
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) continue;
      const normalized = normalizeWebhookHandlerModule(exported);
      if (!normalized) continue;
      seen.add(exported);
      found.push({ ...normalized, source: key });
    }
  }
  return found;
}

/**
 * Pick the module extension a directory scan should import, from the `readdir` entries
 * already in hand — NOT from this library's own compiled file. A consuming app resolves
 * this library as built `.js`, but its own `app/payment_handlers` are `.ts` in dev;
 * deriving the extension from `import.meta.url` would always pick `.js` and discover
 * nothing. `.d.ts` entries are never importable. `.ts` wins over `.js` when both exist
 * (same module never registered twice). Mirrors durable's `pickModuleExt`.
 */
export function pickModuleExt(entries: readonly string[]): '.ts' | '.js' | null {
  let hasTs = false;
  let hasJs = false;
  for (const entry of entries) {
    if (entry.endsWith('.d.ts')) continue;
    const ext = extname(entry);
    if (ext === '.ts') hasTs = true;
    else if (ext === '.js') hasJs = true;
  }
  if (hasTs) return '.ts';
  if (hasJs) return '.js';
  return null;
}

/**
 * Scan the conventions folder RECURSIVELY for handler modules (default export is a
 * `{ type, handle }` object or a service class with `static eventType`). Missing
 * directory → empty list (the convention is opt-in: no `app/payment_handlers`, nothing
 * to register). Mirrors durable's `discoverWorkflows`.
 */
export async function discoverWebhookHandlers(dir: string): Promise<DiscoveredWebhookHandler[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const moduleExt = pickModuleExt(entries);
  const found: DiscoveredWebhookHandler[] = [];
  if (moduleExt === null) return found;
  const seen = new Set<unknown>();
  for (const entry of entries.sort()) {
    if (extname(entry) !== moduleExt || entry.endsWith(`.d${moduleExt}`)) continue;
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as {
      default?: unknown;
    };
    const normalized = normalizeWebhookHandlerModule(mod.default);
    if (!normalized) continue;
    if (seen.has(normalized.entry)) continue;
    seen.add(normalized.entry);
    found.push({ ...normalized, source: join(dir, entry) });
  }
  return found;
}
