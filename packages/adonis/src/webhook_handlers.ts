import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WebhookHandler } from './billing/webhook_processor.js';
import type { WebhookEvent } from './types.js';

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
}

/** Shape each file in the conventions folder must default-export. */
export interface WebhookHandlerModule {
  /**
   * Normalized event type this handler listens to (e.g. `'payment.succeeded'`). A service
   * class declares it as `static eventType` instead.
   */
  type?: string;
  /** Event-type static on a service class form. */
  eventType?: string;
  /** The handler function (object form). */
  handle?: WebhookHandler;
}

/** Normalize a module's default export into a {@link DiscoveredWebhookHandler}, or null. */
export function normalizeWebhookHandlerModule(mod: unknown): DiscoveredWebhookHandler | null {
  if (typeof mod !== 'function' && (typeof mod !== 'object' || mod === null)) return null;
  const candidate = mod as WebhookHandlerModule;
  const type = candidate.type ?? candidate.eventType;
  if (typeof type !== 'string') return null;
  if (typeof mod === 'function') {
    // Service class form: `static eventType` + instance `handle`.
    if (isWebhookHandlerService(mod)) return { type, entry: mod };
    return null;
  }
  // Object form: `{ type, handle }`.
  if (typeof candidate.handle !== 'function') return null;
  return { type, entry: candidate.handle };
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
  for (const load of Object.values(barrel)) {
    const mod = await load();
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) continue;
      const normalized = normalizeWebhookHandlerModule(exported);
      if (!normalized) continue;
      seen.add(exported);
      found.push(normalized);
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
    found.push(normalized);
  }
  return found;
}
