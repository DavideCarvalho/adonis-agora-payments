import { createHash } from 'node:crypto';

/**
 * The owning app's record of the console actions it already ran, by the idempotency key the
 * console sent with each one. A command the console sends again (a retry after a timeout, a
 * second instance of the console, a double click that reached the server twice) with the same key
 * gets the first run's answer back instead of running again: one refund, however many commands.
 */

/** What the store knows about a key. */
export type IdempotencyState =
  /** First time: this caller now holds the key and runs the action. */
  | { state: 'new' }
  /** Another run holds it and has not answered yet (or crashed while running). */
  | { state: 'running' }
  /** Already answered: replay this. */
  | { state: 'done'; reply: unknown }
  /** The key was used for a different action or different arguments. */
  | { state: 'mismatch' };

/** Where the owning app keeps its idempotency records. */
export interface ConsoleIdempotencyStore {
  /** Take `key` for a run of `fingerprint`, or answer what is already known about it. */
  begin(key: string, fingerprint: string): Promise<IdempotencyState>;
  /** Record the answer of the run that took `key`. */
  finish(key: string, fingerprint: string, reply: unknown): Promise<void>;
}

/** How long a key is kept (and a crashed run blocks its key): 24 h, as gateways keep theirs. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** What an idempotency key may look like. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

/** The fingerprint of an action: its verb, target and arguments (never its key or `app`). */
export function actionFingerprint(verb: string, args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([verb, canonical(args)]))
    .digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

interface Stored {
  fingerprint: string;
  state: 'running' | 'done';
  reply?: unknown;
}

function stateOf(raw: string | null | undefined, fingerprint: string): IdempotencyState {
  if (raw === null || raw === undefined) return { state: 'running' };
  let stored: Stored;
  try {
    stored = JSON.parse(raw) as Stored;
  } catch {
    return { state: 'running' };
  }
  if (stored.fingerprint !== fingerprint) return { state: 'mismatch' };
  return stored.state === 'done' ? { state: 'done', reply: stored.reply } : { state: 'running' };
}

/** The slice of a Redis client the store needs (ioredis or an `@adonisjs/redis` connection). */
export interface IdempotencyRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ms: number, nx?: 'NX'): Promise<unknown>;
}

/**
 * Records on the owning app's Redis, under `<prefix>-payments-console-idem:<hash of the key>`:
 * `SET … NX` takes a key for exactly one run across every instance, the answer replaces it, and
 * both expire after {@link IDEMPOTENCY_TTL_MS}. A run that crashed keeps its key blocked until then:
 * whether its gateway call went out is unknown, so a retry with that key is refused, not re-run.
 */
export function redisIdempotencyStore(
  client: IdempotencyRedisLike,
  prefix: string,
  ttlMs = IDEMPOTENCY_TTL_MS,
): ConsoleIdempotencyStore {
  const keyOf = (key: string) =>
    `${prefix}-payments-console-idem:${createHash('sha256').update(key).digest('hex')}`;
  return {
    async begin(key, fingerprint) {
      const record: Stored = { fingerprint, state: 'running' };
      const taken = await client.set(keyOf(key), JSON.stringify(record), 'PX', ttlMs, 'NX');
      if (taken === 'OK') return { state: 'new' };
      return stateOf(await client.get(keyOf(key)), fingerprint);
    },
    async finish(key, fingerprint, reply) {
      const record: Stored = { fingerprint, state: 'done', reply };
      await client.set(keyOf(key), JSON.stringify(record), 'PX', ttlMs);
    },
  };
}

/** Records in this process only: for tests, and an app with one instance and no Redis to spare. */
export function memoryIdempotencyStore(): ConsoleIdempotencyStore {
  const records = new Map<string, string>();
  return {
    async begin(key, fingerprint) {
      const existing = records.get(key);
      if (existing === undefined) {
        records.set(key, JSON.stringify({ fingerprint, state: 'running' } satisfies Stored));
        return { state: 'new' };
      }
      return stateOf(existing, fingerprint);
    },
    async finish(key, fingerprint, reply) {
      records.set(key, JSON.stringify({ fingerprint, state: 'done', reply } satisfies Stored));
    },
  };
}

/** The `get`/`set` of a client, reached through `ioConnection` on an `@adonisjs/redis` connection. */
export function idempotencyClientOf(client: unknown): IdempotencyRedisLike | undefined {
  const direct = client as Partial<IdempotencyRedisLike> & { ioConnection?: unknown };
  const target =
    typeof direct.get === 'function' && typeof direct.set === 'function'
      ? direct
      : (direct.ioConnection as Partial<IdempotencyRedisLike> | undefined);
  if (typeof target?.get !== 'function' || typeof target.set !== 'function') return undefined;
  return {
    get: (key) => (target.get as IdempotencyRedisLike['get']).call(target, key),
    set: (...args) =>
      (target.set as (...a: unknown[]) => Promise<unknown>).call(target, ...(args as unknown[])),
  };
}
