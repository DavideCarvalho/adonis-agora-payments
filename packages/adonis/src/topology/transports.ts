import {
  HUB_MESSAGE_VERSION,
  type HubCallMessage,
  type HubReplyMessage,
  PaymentsHubError,
} from './protocol.js';

/**
 * How a tenant reaches the payments control plane. Every transport carries the same envelope to
 * the same handler; only the substrate changes.
 */
export interface HubTransport {
  readonly name: string;
  request(message: HubCallMessage, timeoutMs: number): Promise<HubReplyMessage>;
  /**
   * Wait until the control plane says there are events for `partition`, or `seconds` pass.
   * Answers whether it was woken. A transport without a wake channel omits it (the pump polls).
   */
  wait?(partition: string, seconds: number): Promise<boolean>;
}

/** A URL now, or one resolved on demand (`controlPlaneUrl` discovery from authkit-client). */
export type HubUrlSource = string | (() => string | Promise<string>);

export interface HttpHubTransportOptions {
  /** The control plane's mount, e.g. `https://hub.example.com/_payments`. */
  url: HubUrlSource;
  fetch?: typeof fetch;
}

const trimSlash = (value: string) => value.replace(/\/+$/, '');

/** Calls over HTTP: `POST <url>/rpc`. The default, and always available on the control plane. */
export function httpHubTransport(options: HttpHubTransportOptions): HubTransport {
  if (typeof options.url === 'string' && !/^https?:\/\//.test(options.url)) {
    throw new Error('[payments] the tenant url must be an absolute http(s) url');
  }
  const inner = options.fetch ?? fetch;
  const resolve = async () =>
    trimSlash(typeof options.url === 'function' ? await options.url() : options.url);
  return {
    name: 'http',
    async request(message, timeoutMs) {
      let base: string;
      try {
        base = await resolve();
      } catch (error) {
        throw new PaymentsHubError(
          'unavailable',
          `could not resolve the payments control plane url: ${(error as Error).message}`,
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await inner(`${base}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => null)) as HubReplyMessage | null;
        if (body === null || body.v !== HUB_MESSAGE_VERSION) {
          throw new PaymentsHubError(
            'unavailable',
            `the payments control plane answered ${response.status} without a payments reply`,
          );
        }
        return body;
      } catch (error) {
        if (error instanceof PaymentsHubError) throw error;
        if ((error as { name?: string }).name === 'AbortError') {
          throw new PaymentsHubError(
            'timeout',
            `no answer from the payments control plane within ${timeoutMs}ms`,
          );
        }
        throw new PaymentsHubError('unavailable', (error as Error).message);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The two Redis commands the transport needs (an ioredis/`@adonisjs/redis` connection fits). */
export interface HubRedisLike {
  lpush(key: string, value: string): Promise<unknown>;
  brpop(keys: string[], timeoutSeconds: number): Promise<[string, string] | null>;
  del?(key: string): Promise<unknown>;
}

/** A connection now, or one resolved on use (config files load before Redis is up). */
export type HubRedisSource = HubRedisLike | (() => HubRedisLike);

export interface RedisHubTransportOptions {
  /**
   * The bus connection: the SAME Redis and key prefix on the tenant and the control plane. Give
   * payments a connection of its own: `BRPOP` blocks the connection while it waits.
   */
  connection: HubRedisSource;
  /** Key prefix inside the connection's own prefix. Default `'payments'`. */
  prefix?: string;
  /**
   * A second connection (same Redis, same prefix) for the tenant's event pump to block on while
   * it waits for a wake-up. Without it the pump polls over `connection`'s calls instead.
   */
  wakeConnection?: HubRedisSource;
}

const keysFor = (prefix: string) => ({
  requests: `${prefix}:requests`,
  reply: (id: string) => `${prefix}:reply:${id}`,
  wake: (partition: string) => `${prefix}:wake:${partition}`,
  dead: `${prefix}:dead`,
});

const resolveRedis = (source: HubRedisSource): HubRedisLike =>
  typeof source === 'function' ? source() : source;

/**
 * Calls over Redis lists: `LPUSH <prefix>:requests`, answer on `<prefix>:reply:<id>`. Forwarded
 * events wake the tenant's pump through `<prefix>:wake:<app>` instead of polling.
 */
export function redisHubTransport(options: RedisHubTransportOptions): HubTransport {
  const keys = keysFor(options.prefix ?? 'payments');
  const transport: HubTransport = {
    name: 'redis',
    async request(message, timeoutMs) {
      const redis = resolveRedis(options.connection);
      const replyKey = keys.reply(message.id);
      try {
        await redis.lpush(keys.requests, JSON.stringify(message));
      } catch (error) {
        throw new PaymentsHubError(
          'unavailable',
          `the payments bus refused the call: ${(error as Error).message}`,
        );
      }
      const cutoff = Date.now() + timeoutMs;
      while (Date.now() < cutoff) {
        const seconds = Math.max(1, Math.ceil((cutoff - Date.now()) / 1000));
        let popped: [string, string] | null;
        try {
          popped = await redis.brpop([replyKey], seconds);
        } catch (error) {
          throw new PaymentsHubError('unavailable', (error as Error).message);
        }
        if (popped === null) continue;
        await redis.del?.(replyKey);
        try {
          return JSON.parse(popped[1]) as HubReplyMessage;
        } catch {
          throw new PaymentsHubError(
            'unavailable',
            'the payments control plane sent a malformed reply',
          );
        }
      }
      throw new PaymentsHubError(
        'timeout',
        `no answer from the payments control plane within ${timeoutMs}ms`,
      );
    },
  };
  if (options.wakeConnection === undefined) return transport;
  const wakeConnection = options.wakeConnection;
  return {
    ...transport,
    async wait(partition, seconds) {
      const redis = resolveRedis(wakeConnection);
      const popped = await redis.brpop([keys.wake(partition)], Math.max(1, Math.trunc(seconds)));
      if (popped === null) return false;
      // One wake is enough however many events arrived: the pump drains the queue.
      await redis.del?.(keys.wake(partition));
      return true;
    },
  };
}

export interface ServeRedisOptions {
  /** The connection the server blocks on (`BRPOP`). Same Redis and prefix as the tenants'. */
  connection: HubRedisSource;
  /**
   * A non-blocking connection (same Redis, same prefix) for replies and wake-ups. With it, calls
   * are answered concurrently; without it, one at a time between two `BRPOP`s.
   */
  writer?: HubRedisSource;
  prefix?: string;
  /** How long each `BRPOP` blocks. Default 5 s (one command per 5 s per idle process). */
  blockSeconds?: number;
  logger?: { warn(message: string): void };
}

/**
 * The control plane side of {@link redisHubTransport}: pops calls, answers them, and wakes
 * tenant pumps. Returns `stop` and `notify` (pass `notify` to the control plane).
 */
export function serveRedisHub(
  handler: (message: unknown) => Promise<HubReplyMessage>,
  options: ServeRedisOptions,
): { stop(): Promise<void>; notify(partition: string): Promise<void> } {
  const keys = keysFor(options.prefix ?? 'payments');
  const block = options.blockSeconds ?? 5;
  const writer = options.writer ?? options.connection;
  let running = true;
  const loop = (async () => {
    while (running) {
      let popped: [string, string] | null;
      try {
        popped = await resolveRedis(options.connection).brpop([keys.requests], block);
      } catch (error) {
        options.logger?.warn(`[payments] bus read failed: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      if (popped === null) continue;
      const raw = popped[1];
      const work = (async () => {
        let message: unknown;
        try {
          message = JSON.parse(raw);
        } catch {
          await resolveRedis(writer)
            .lpush(keys.dead, JSON.stringify({ reason: 'not-json', at: Date.now(), raw }))
            .catch(() => undefined);
          return;
        }
        const answer = await handler(message);
        if (answer.id === '') return;
        await resolveRedis(writer).lpush(keys.reply(answer.id), JSON.stringify(answer));
      })().catch((error) =>
        options.logger?.warn(`[payments] bus call failed: ${(error as Error).message}`),
      );
      // On a single connection the reply must go out before the next BRPOP blocks it.
      if (options.writer === undefined) await work;
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
    async notify(partition) {
      await resolveRedis(writer).lpush(keys.wake(partition), '1');
    },
  };
}

export const hubTransports = {
  http: httpHubTransport,
  redis: redisHubTransport,
} as const;
