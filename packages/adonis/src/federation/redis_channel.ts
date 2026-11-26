import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type HubTokenSource, resolveToken } from '../topology/tenant.js';
import {
  resolveTenantVerifier,
  type TenantVerifierInput,
  type VerifiedTenant,
} from '../topology/verify.js';
import { type OkpJwk, openWith, sealTo } from './console_key.js';

/**
 * The Redis channel a federated console talks to another app over: the console publishes a command
 * on `<prefix>-<topic>-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-<topic>-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-<topic>-console-reply`. The same design as `@adonis-agora/durable`'s and
 * `@adonis-agora/media`'s console commands, on channels of its own, so all of them can share an
 * app's prefix. This file is copied between `@adonis-agora/config`, `@adonis-agora/crypto` and
 * `@adonis-agora/payments` (only {@link CONSOLE_TOPIC}, {@link CONSOLE_CRYPTO_KEY}, the imports and
 * where the token-mode verifier's app hint comes from differ).
 */

/** This package's part of the channel names. */
export const CONSOLE_TOPIC = 'payments';
const PACKAGE = `@adonis-agora/${CONSOLE_TOPIC}`;

/** One command sent to the owning app. Arguments and answer are plain JSON. */
export interface ConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who acted in the console, recorded by the owning app as the actor. */
  actor?: string;
  /** The capabilities the console's `authorize` granted that viewer, when it said. */
  capabilities?: string[];
  /** The console that sent it (its `appLabel`), for the owning app's log and audit. */
  via?: string;
  /** When it was sent (ms since the epoch): a signed command older than a minute is refused. */
  ts?: number;
  /** HMAC of every field above under the pair's shared secret (set by {@link RedisConsoleChannel}). */
  mac?: string;
  /**
   * Token mode: who the owning app verified the console as (its token's partition and
   * capabilities). Set by the channel after verification, never taken from the wire.
   */
  verified?: Pick<VerifiedTenant, 'partition' | 'capabilities' | 'clientId'> & {
    /** The console app an authkit app-call token names (audience-bound to this app). */
    app?: string;
  };
}

/** The owning app's answer to a {@link ConsoleCommand}. */
export type ConsoleReply = (
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } }
) & { mac?: string };

/** How far a command's `ts` may be from this clock (and so how long a replay could live). */
const MAX_COMMAND_SKEW_MS = 60_000;

/** JSON with object keys sorted, so both sides MAC the same bytes for the same value. */
function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.keys(input as Record<string, unknown>)
        .sort()
        .filter((key) => (input as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
    );
  };
  return JSON.stringify(sort(value)) ?? 'null';
}

/** A shared secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type ChannelSecret = string | { release(): string };

/**
 * Signs and checks the messages of one channel. Anyone who can publish on the Redis channel can
 * otherwise send a command (with any actor and capabilities: a refund through the app's gateway) or
 * answer one (a forged answer would tell the console a refund happened): both sides share `secret`, and every
 * command and reply carries an HMAC over its fields, bound to this channel's prefix.
 */
class ChannelSigner {
  readonly #key: Buffer;
  constructor(secret: ChannelSecret, prefix: string) {
    const raw = typeof secret === 'string' ? secret : secret.release();
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        `[${PACKAGE}] console channel: the shared secret must be at least 16 characters`,
      );
    }
    this.#key = createHmac('sha256', raw)
      .update(`agora:console-commands:${CONSOLE_TOPIC}:${prefix}`)
      .digest();
  }

  #mac(kind: 'command' | 'reply', fields: unknown): string {
    return createHmac('sha256', this.#key)
      .update(`${kind}\n${canonicalJson(fields)}`)
      .digest('base64url');
  }

  #equal(a: string, b: unknown): boolean {
    if (typeof b !== 'string') return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  #commandFields(command: ConsoleCommand) {
    return [
      command.id,
      command.verb,
      command.args ?? [],
      command.actor ?? null,
      command.capabilities ?? null,
      command.via ?? null,
      command.ts ?? null,
    ];
  }

  #replyFields(reply: ConsoleReply) {
    return [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
  }

  signCommand(command: ConsoleCommand): ConsoleCommand {
    const stamped = { ...command, ts: Date.now() };
    delete stamped.mac;
    return { ...stamped, mac: this.#mac('command', this.#commandFields(stamped)) };
  }

  verifyCommand(command: ConsoleCommand): boolean {
    if (typeof command.ts !== 'number' || Math.abs(Date.now() - command.ts) > MAX_COMMAND_SKEW_MS) {
      return false;
    }
    return this.#equal(this.#mac('command', this.#commandFields(command)), command.mac);
  }

  signReply(reply: ConsoleReply): ConsoleReply {
    const { mac: _mac, ...rest } = reply;
    return {
      ...rest,
      mac: this.#mac('reply', this.#replyFields(rest as ConsoleReply)),
    } as ConsoleReply;
  }

  verifyReply(reply: ConsoleReply): boolean {
    return this.#equal(this.#mac('reply', this.#replyFields(reply)), reply.mac);
  }
}

/** The owning app refused the console's token (the console drops its cached token). */
export const UNAUTHORIZED_CONSOLE = 'federated-console-unauthorized';

/** What one sent command needs from the channel's authentication. */
interface OutgoingMessage {
  wire: unknown;
  verifyReply(reply: ConsoleReply): boolean;
}

/** A command that arrived, once its authentication is checked. */
interface IncomingMessage {
  /** The command to run, or `undefined` when it must be refused with `error`. */
  command?: ConsoleCommand;
  error?: { message: string; code: string; status: number };
  id: string;
  signReply(reply: ConsoleReply): ConsoleReply;
}

interface ChannelAuth {
  /** The mode it accepts, for the refusal reason (`secret`, `crypto`, `token (sealed to key)`). */
  readonly label?: string;
  wrap?(command: ConsoleCommand): Promise<OutgoingMessage>;
  unwrap?(wire: Record<string, unknown>): Promise<IncomingMessage | null>;
  unauthorized?(): void;
}

function sameMac(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fresh(ts: unknown): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= MAX_COMMAND_SKEW_MS;
}

/** Shared-secret mode: both sides hold the same secret and HMAC every command and reply. */
class SecretAuth implements ChannelAuth {
  readonly label = 'secret';
  readonly #signer: ChannelSigner;
  constructor(secret: ChannelSecret, prefix: string) {
    this.#signer = new ChannelSigner(secret, prefix);
  }

  async wrap(command: ConsoleCommand): Promise<OutgoingMessage> {
    return {
      wire: this.#signer.signCommand(command),
      verifyReply: (reply) => this.#signer.verifyReply(reply),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.mac !== 'string') return null;
    const command = wire as unknown as ConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return null;
    // Unsigned, stale (over a minute) or tampered: not from the console that holds the secret. A
    // replay inside the window reuses the id, and the claim (kept 2 minutes) refuses it.
    if (!this.#signer.verifyCommand(command)) {
      throw new ConsoleCommandRefused(fresh(command.ts) ? 'bad signature' : 'stale');
    }
    const { mac: _mac, ts: _ts, verified: _verified, ...fields } = command;
    return {
      id: command.id,
      command: fields,
      signReply: (reply) => this.#signer.signReply(reply),
    };
  }
}

/**
 * How a sealed command is encrypted: to the app's command key derived from its `APP_KEY` (the
 * default), or with a key of `@adonis-agora/crypto` (the Hub's, or the app's own). Either way only
 * the owning app opens it, and the AAD binds it to this channel and this command id.
 */
export interface ConsoleSealer {
  /** Whether `sealed` is this sealer's ciphertext (so the app knows which one opens it). */
  owns(sealed: string): boolean;
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (`crypto.client`, `serviceCipher`). */
export interface ConsoleCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/**
 * A cipher, or a function returning one: `config/payments.ts` is read before `@adonis-agora/crypto`
 * is ready, so `() => crypto.client!` (or `() => serviceCipher(crypto.service, 'app')`) defers it
 * to the first command.
 */
export type ConsoleCipherSource = ConsoleCipher | (() => ConsoleCipher | Promise<ConsoleCipher>);

/**
 * `crypto` on either side: the cipher, the key (default {@link CONSOLE_CRYPTO_KEY}) and, for a cipher
 * that is not `@adonis-agora/crypto` (a KMS, Vault transit, an HSM), how to recognise its
 * ciphertext (default: `agora:ct1:<key>:`).
 */
export interface ConsoleCryptoOption {
  cipher: ConsoleCipherSource;
  key?: string | undefined;
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** The `@adonis-agora/crypto` key console commands are sealed with, unless another is named. */
export const CONSOLE_CRYPTO_KEY = 'console-payments';

/** Seals with an `@adonis-agora/crypto` key: whoever may `encrypt` with it sends, the app opens. */
export function cryptoConsoleSealer(options: ConsoleCryptoOption): ConsoleSealer {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const source = options.cipher;
  const cipher = async (): Promise<ConsoleCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        `[${PACKAGE}] console channel: \`crypto.cipher\` is not ready (is @adonis-agora/crypto booted?)`,
      );
    }
    return resolved;
  };
  return {
    // `agora:ct1:<key>:<version>:…`: only this key's ciphertext is taken as a crypto command. A
    // cipher of another KMS (Vault transit, AWS KMS, an HSM) says what its ciphertext looks like.
    owns: (sealed) =>
      options.owns ? options.owns(sealed) === true : sealed.startsWith(`agora:ct1:${key}:`),
    async seal(plaintext, aad) {
      const { ciphertext } = await (await cipher()).encrypt({ key, plaintext, aad, context: aad });
      return ciphertext;
    },
    async open(sealed, aad) {
      const { plaintext } = await (await cipher()).decrypt({
        key,
        ciphertext: sealed,
        aad,
        context: aad,
      });
      return plaintext;
    },
  };
}

/** Seals to the app's X25519 command key: the console side (its `controlPlane.publicKey`). */
export function appKeySealerTo(recipient: () => Promise<OkpJwk>): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(await recipient(), plaintext, { aad }),
    open: async () => {
      throw new Error('the console side cannot open commands');
    },
  };
}

/** Opens with the app's X25519 command key pair (derived from its `APP_KEY`): the app side. */
export function appKeySealer(keys: { publicKey: OkpJwk; privateKey: OkpJwk }): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(keys.publicKey, plaintext, { aad }),
    open: async (sealed, aad) => openWith(keys.privateKey, sealed, { aad }),
  };
}

/** The key that MACs the replies to one command: a secret only the console and the app know. */
function replyKey(secret: string, prefix: string, id: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`agora:console-reply:${CONSOLE_TOPIC}:${prefix}:${id}`)
    .digest();
}

function replyMac(key: Buffer, reply: ConsoleReply): string {
  const fields = [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
  return createHmac('sha256', key)
    .update(`reply\n${canonicalJson(fields)}`)
    .digest('base64url');
}

const commandAad = (prefix: string, id: string) =>
  JSON.stringify(['agora:console-command', CONSOLE_TOPIC, prefix, id]);

/**
 * Sealed mode (console side): the whole command, with the console's token when it has one, travels
 * sealed so only the owning app opens it. A Redis reader sees an id and ciphertext: no token to
 * lift and replay, no command to alter. The sealed payload also carries a one-off secret the app
 * MACs its answer with, so a forged answer (from someone who cannot open the command) is ignored.
 */
class SealedSenderAuth implements ChannelAuth {
  readonly #token: ReturnType<typeof resolveToken> | undefined;
  constructor(
    readonly sealer: ConsoleSealer,
    token: HubTokenSource | undefined,
    readonly prefix: string,
  ) {
    this.#token = token === undefined ? undefined : resolveToken(token);
  }

  async wrap(command: ConsoleCommand): Promise<OutgoingMessage> {
    const token = this.#token ? await this.#token.get() : undefined;
    const secret = randomBytes(32).toString('base64url');
    const { mac: _mac, verified: _verified, ...fields } = command;
    const sealed = await this.sealer.seal(
      JSON.stringify({
        command: { ...fields, ts: Date.now() },
        // An empty token is "none" (an optional app-call token that could not be minted, §13b).
        ...(token ? { token } : {}),
        replySecret: secret,
      }),
      commandAad(this.prefix, command.id),
    );
    const key = replyKey(secret, this.prefix, command.id);
    return {
      wire: { id: command.id, sealed },
      verifyReply: (reply) => sameMac(replyMac(key, reply), reply.mac),
    };
  }

  unauthorized(): void {
    this.#token?.reset?.();
  }
}

/**
 * Sealed mode (owning app side): open, check freshness, and — when `verifyTenant` is set — verify
 * the token the command carries. With a token the command's app and capabilities come from it; a
 * command without one is accepted only when no `verifyTenant` is set (crypto mode: whoever may
 * encrypt with the key is the console, like a shared secret).
 */
class SealedReceiverAuth implements ChannelAuth {
  readonly label: string;
  readonly #verify: ReturnType<typeof resolveTenantVerifier> | undefined;
  constructor(
    readonly sealer: ConsoleSealer,
    verifyTenant: TenantVerifierInput | undefined,
    readonly prefix: string,
    /** The app this channel answers for: the hint the verifier gets (only the token is trusted). */
    readonly partition: string | undefined,
    /** A command without a token is accepted (the seal authenticates it); one with a token is checked. */
    readonly tokenOptional = false,
  ) {
    this.#verify = verifyTenant === undefined ? undefined : resolveTenantVerifier(verifyTenant);
    this.label = sealer.owns('agora:pk1:') ? 'token (sealed to key)' : 'crypto';
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.sealed !== 'string' || typeof wire.id !== 'string') return null;
    if (!this.sealer.owns(wire.sealed)) return null;
    const id = wire.id;
    let payload: { command?: ConsoleCommand; token?: unknown; replySecret?: unknown };
    try {
      payload = JSON.parse(
        await this.sealer.open(wire.sealed, commandAad(this.prefix, id)),
      ) as typeof payload;
    } catch {
      throw new ConsoleCommandRefused("did not open with this app's key");
    }
    const command = payload.command;
    if (
      !command ||
      command.id !== id ||
      typeof command.verb !== 'string' ||
      typeof payload.replySecret !== 'string' ||
      !fresh(command.ts)
    ) {
      throw new ConsoleCommandRefused(command && !fresh(command.ts) ? 'stale' : 'bad signature');
    }
    const key = replyKey(payload.replySecret, this.prefix, id);
    const signReply = (reply: ConsoleReply): ConsoleReply => {
      const { mac: _mac, ...rest } = reply;
      return { ...rest, mac: replyMac(key, rest as ConsoleReply) } as ConsoleReply;
    };
    const { mac: _mac, ts: _ts, verified: _claimed, ...fields } = command;
    if (!this.#verify) return { id, signReply, command: fields };
    const hasToken = typeof payload.token === 'string' && payload.token !== '';
    if (!hasToken && this.tokenOptional) return { id, signReply, command: fields };

    const claimed = this.partition;
    let verified: VerifiedTenant | null = null;
    try {
      verified =
        typeof payload.token === 'string' && payload.token !== ''
          ? await this.#verify({
              token: payload.token,
              app: claimed,
              partition: claimed,
              tenant: claimed,
              headers: {},
            })
          : null;
    } catch {
      verified = null;
    }
    if (!verified) {
      return {
        id,
        signReply,
        error: {
          message: `the console's token was refused by the "${this.prefix}" app`,
          code: UNAUTHORIZED_CONSOLE,
          status: 401,
        },
      };
    }
    return {
      id,
      signReply,
      command: {
        ...fields,
        verified: {
          partition: verified.partition,
          capabilities: verified.capabilities,
          ...(verified.clientId !== undefined ? { clientId: verified.clientId } : {}),
          ...(typeof verified.app === 'string' ? { app: verified.app } : {}),
        },
      },
    };
  }
}

/** How one channel authenticates: what it sends with, and every way it accepts commands. */
export interface ConsoleChannelAuthOptions {
  /** Shared-secret mode: the same value on the console and on the app (16+ characters). */
  secret?: ChannelSecret | undefined;
  /**
   * Sealed mode with `@adonis-agora/crypto`, both sides: the cipher (`crypto.client`, or
   * `serviceCipher(crypto.service, partition)` where crypto is embedded) and the key
   * (`console-payments` by default). The console needs `encrypt` on it, the app `decrypt`.
   */
  crypto?: ConsoleCryptoOption | undefined;
  /** Console side: the token each command carries (`authkitTenantToken(...)`). */
  token?: HubTokenSource | undefined;
  /**
   * Console side, without `crypto`: the app's command public key (its `controlPlane.publicKey`,
   * printed by `node ace payments:console-key` in that app). Never taken from Redis.
   */
  recipient?: (() => Promise<OkpJwk>) | undefined;
  /** App side, without `crypto`: this app's command key pair (derived from its `APP_KEY`). */
  keys?: { publicKey: OkpJwk; privateKey: OkpJwk } | undefined;
  /** App side: verifies the console's token (`authkitTenantVerifier(...)`). */
  verifyTenant?: TenantVerifierInput | undefined;
  /**
   * App side, with `crypto` and `verifyTenant`: a crypto-sealed command may come without a token
   * (the key authenticates it) and a token it carries is still checked. For a verifier found
   * automatically (authkit, the control plane's); an explicit `verifyTenant` requires the token.
   */
  cryptoTokenOptional?: boolean | undefined;
  /**
   * App side: the partition this app answers for, handed to `verifyTenant` as the claimed app (a
   * `sharedSecretVerifier` picks the secret by it). Advisory only: the handler checks the verified
   * token's own partition.
   */
  partition?: string | undefined;
}

/** An `ioredis` client: pub/sub needs a dedicated connection, made with `duplicate()`. */
export interface IoredisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  duplicate(): IoredisSubscriberLike;
}

export interface IoredisSubscriberLike {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect?(): void;
}

/** An `@adonisjs/redis` connection: it keeps its own subscriber and hands each payload over. */
export interface AdonisRedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): unknown;
  unsubscribe?(channel: string): unknown;
}

export type RedisLike = IoredisLike | AdonisRedisLike;

/** How long a command waits for its answer by default. */
export const CONSOLE_COMMAND_TIMEOUT_MS = 15_000;
/** How long the claim on a command lives (longer than any answer is waited for). */
const CLAIM_TTL_MS = 120_000;

function isIoredis(client: RedisLike): client is IoredisLike {
  return typeof (client as IoredisLike).duplicate === 'function';
}

/** `SET key value PX ttl NX` on either client: `'OK'` for the one caller that wins the key. */
function claimOf(
  client: RedisLike,
): ((key: string, value: string) => Promise<unknown>) | undefined {
  const target =
    typeof client.set === 'function'
      ? client
      : (client as { ioConnection?: { set?: IoredisLike['set'] } }).ioConnection;
  const set = target?.set;
  if (typeof set !== 'function') return undefined;
  return (key, value) => set.call(target, key, value, 'PX', CLAIM_TTL_MS, 'NX');
}

/** `GET key` on either client, best effort (`undefined` when the client cannot). */
async function readClaim(client: RedisLike, key: string): Promise<unknown> {
  const target =
    typeof (client as { get?: unknown }).get === 'function'
      ? (client as unknown as { get(key: string): Promise<unknown> })
      : (client as unknown as { ioConnection?: { get?(key: string): Promise<unknown> } })
          .ioConnection;
  try {
    return typeof target?.get === 'function' ? await target.get(key) : undefined;
  } catch {
    return undefined;
  }
}

/** A command the owning app refused or failed, or that nobody answered. */
export class ConsoleChannelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConsoleChannelError';
    this.code = code;
  }
}

/**
 * A command this app refused, with one of the reasons every Agora lib logs (§11b): `not JSON`,
 * `no command id`, `did not open with this app's key`, `bad signature`, `stale`, `replayed`,
 * `token refused`, `capabilities-required`, `mode not accepted here (…)`.
 */
export class ConsoleCommandRefused extends ConsoleChannelError {
  constructor(readonly reason: string) {
    super(reason, UNSIGNED_CHANNEL);
    this.name = 'ConsoleCommandRefused';
  }
}

/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';
/** The channel has no shared secret, so it neither sends nor answers commands. */
export const UNSIGNED_CHANNEL = 'federated-channel-unsigned';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  /** `trusted`: settled locally (the channel closing), so no MAC to check. */
  readonly #pending = new Map<string, (reply: ConsoleReply, trusted?: boolean) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  #answering = false;
  #closed = false;
  /** How commands are sent (one mode). */
  readonly #sender: ChannelAuth | undefined;
  /** How commands are accepted (each configured mode; an app may accept both while migrating). */
  readonly #receivers: ChannelAuth[];

  /**
   * Redis is not a trust boundary, so a channel neither sends nor answers commands without one of:
   *
   * - `crypto` — commands sealed with an `@adonis-agora/crypto` key (the console may encrypt with it,
   *   the app decrypt), optionally with a `token` the app checks with `verifyTenant`;
   * - a `token` sealed to the app's command key (`recipient` / `keys`, from its `APP_KEY`), checked
   *   with `verifyTenant` (authkit, typically);
   * - `secret` — shared by the console and the app (the same value on both sides).
   */
  constructor(options: { client: RedisLike; prefix: string } & ConsoleChannelAuthOptions) {
    if (!options.prefix) throw new Error(`[${PACKAGE}] console channel: prefix is required`);
    this.#client = options.client;
    this.prefix = options.prefix;
    const secret =
      options.secret === undefined ? undefined : new SecretAuth(options.secret, options.prefix);
    const crypto = options.crypto ? cryptoConsoleSealer(options.crypto) : undefined;

    // Sending: crypto when configured, else a token sealed to the app's key, else the secret.
    if (options.token !== undefined && !crypto && !options.recipient) {
      throw new Error(
        `[${PACKAGE}] console channel: a \`token\` needs \`crypto\` or the app's \`recipient\` key`,
      );
    }
    const sendSealer =
      crypto ?? (options.recipient ? appKeySealerTo(options.recipient) : undefined);
    const sealedSender =
      sendSealer && (crypto || options.token !== undefined)
        ? new SealedSenderAuth(sendSealer, options.token, options.prefix)
        : undefined;
    this.#sender = sealedSender ?? secret;

    // Answering: every configured way. Without crypto, sealed commands need a token check.
    const receivers: ChannelAuth[] = [];
    if (crypto)
      receivers.push(
        new SealedReceiverAuth(
          crypto,
          options.verifyTenant,
          options.prefix,
          options.partition,
          options.cryptoTokenOptional === true,
        ),
      );
    if (options.keys && options.verifyTenant !== undefined) {
      receivers.push(
        new SealedReceiverAuth(
          appKeySealer(options.keys),
          options.verifyTenant,
          options.prefix,
          options.partition,
        ),
      );
    }
    if (secret) receivers.push(secret);
    this.#receivers = receivers;
  }

  /** Whether this channel can send commands (a secret, or a token and the app's key). */
  get signed(): boolean {
    return this.#sender !== undefined;
  }

  #unsigned(): ConsoleChannelError {
    return new ConsoleChannelError(
      `the "${this.prefix}" ${CONSOLE_TOPIC} console channel has no authentication; use @adonis-agora/crypto (\`crypto\` on both sides), authkit (a \`token\` on the console, \`verifyTenant\` on the app) or the same \`secret\` on both`,
      UNSIGNED_CHANNEL,
    );
  }

  get commandChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console`;
  }

  get replyChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console-reply`;
  }

  /** Subscribe `handler` to `channel`; resolves once the subscription is in place. */
  async #subscribe(channel: string, handler: (payload: string) => void): Promise<void> {
    const client = this.#client;
    if (isIoredis(client)) {
      if (!this.#subscriber) {
        const sub = client.duplicate();
        this.#subscriber = sub;
        sub.on('message', (ch, payload) => this.#handlers.get(ch)?.(payload));
      }
      this.#handlers.set(channel, handler);
      await this.#subscriber.subscribe(channel);
      return;
    }
    await client.subscribe(channel, handler);
    this.#subscriptions.push(() => void client.unsubscribe?.(channel));
  }

  /**
   * Send `command` to the owning app and wait for its answer. Rejects at once when no instance
   * listens (`PUBLISH` reached nobody) and after `timeoutMs` when nobody answers.
   */
  async send(
    command: ConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<ConsoleReply> {
    if (this.#closed) throw new ConsoleChannelError('console channel closed', APP_UNREACHABLE);
    if (!this.#sender?.wrap) throw this.#unsigned();
    const sender = this.#sender;
    let outgoing: OutgoingMessage;
    try {
      outgoing = await sender.wrap!(command);
    } catch (error) {
      if (error instanceof ConsoleChannelError) throw error;
      throw new ConsoleChannelError(
        `could not prepare the ${CONSOLE_TOPIC} console command for "${this.prefix}": ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        let reply: ConsoleReply;
        try {
          reply = JSON.parse(payload) as ConsoleReply;
        } catch {
          return;
        }
        if (typeof reply?.id !== 'string') return;
        this.#pending.get(reply.id)?.(reply);
      });
      this.#replies = replies;
      // A failed subscribe (a Redis blip) is retried by the next send, not kept for good.
      replies.catch(() => {
        if (this.#replies === replies) this.#replies = undefined;
      });
    }
    try {
      await this.#replies;
    } catch (error) {
      throw new ConsoleChannelError(
        `could not subscribe to the "${this.prefix}" app's console replies: ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    const timeoutMs = options.timeoutMs ?? CONSOLE_COMMAND_TIMEOUT_MS;
    return new Promise<ConsoleReply>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        reject(new ConsoleChannelError(message, APP_UNREACHABLE));
      };
      const timer = setTimeout(
        () =>
          fail(
            `no instance of "${this.prefix}" answered within ${Math.round(timeoutMs / 1000)}s — the app may have refused the command (check its logs, or run \`node ace agora:doctor\` there)`,
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(command.id, (reply, trusted = false) => {
        // A reply without this command's MAC is someone else's (or forged): wait for the real one.
        if (!trusted && !outgoing.verifyReply(reply)) return;
        clearTimeout(timer);
        this.#pending.delete(command.id);
        if (!reply.ok && reply.error.code === UNAUTHORIZED_CONSOLE) sender.unauthorized?.();
        resolve(reply);
      });
      this.#client.publish(this.commandChannel, JSON.stringify(outgoing.wire)).then(
        (receivers) => {
          // Redis says how many subscribers got it: none means no instance answers commands.
          if (receivers === 0) {
            fail(
              `no instance of the "${this.prefix}" app listens for ${CONSOLE_TOPIC} console commands (is it up, with \`consoleCommands\` in config/${CONSOLE_TOPIC}.ts?)`,
            );
          }
        },
        (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Answer the commands other apps' consoles send this app. Every instance subscribes; the one that
   * wins `SET <prefix>-<topic>-console-claim:<id> NX` runs the command and publishes the answer, so
   * a command runs once however many processes the app has. Throws when the client cannot run that
   * `SET`: a command never runs without the claim.
   */
  async answer(
    handler: (command: ConsoleCommand) => Promise<unknown>,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    if (this.#answering) return;
    if (this.#receivers.length === 0) throw this.#unsigned();
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so ${CONSOLE_TOPIC} console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      // Never crash on a bad message: whatever it is, it is reported and dropped.
      const report = (error: unknown) => {
        try {
          options.onError?.(error);
        } catch {
          /* a failing reporter must not take the process down */
        }
      };
      try {
        void this.#run(payload, instance, claim, handler).catch(report);
      } catch (error) {
        report(error);
      }
    });
  }

  async #run(
    payload: string,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: ConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new ConsoleCommandRefused('not JSON');
    }
    if (!wire || typeof wire !== 'object' || Array.isArray(wire) || typeof wire.id !== 'string') {
      throw new ConsoleCommandRefused('no command id');
    }
    let incoming: IncomingMessage | null = null;
    for (const receiver of this.#receivers) {
      incoming = (await receiver.unwrap?.(wire)) ?? null;
      if (incoming) break;
    }
    if (!incoming) {
      const came =
        typeof wire.sealed === 'string'
          ? wire.sealed.startsWith('agora:pk1:')
            ? 'token (sealed to key)'
            : 'crypto'
          : typeof wire.mac === 'string'
            ? 'secret'
            : 'unsigned';
      const accepts = this.#receivers.map((receiver) => receiver.label ?? 'unknown');
      // Sealed with a key, and this app accepts crypto: just not this app's key.
      if (came === 'crypto' && accepts.includes('crypto')) {
        throw new ConsoleCommandRefused("did not open with this app's key");
      }
      throw new ConsoleCommandRefused(
        `mode not accepted here (this app accepts: ${accepts.join(' + ')}; the command came as ${came})`,
      );
    }
    // One instance runs (or refuses) it; a replay inside the freshness window reuses the id, and
    // the claim (kept 2 minutes) refuses it.
    const claimKey = `${this.prefix}-${CONSOLE_TOPIC}-console-claim:${incoming.id}`;
    const claimed = await claim(claimKey, instance);
    if (claimed !== 'OK') {
      // Every other instance loses the claim too; only the instance that ran the command reads
      // its own mark back, so a replay is reported once.
      const owner = await readClaim(this.#client, claimKey);
      if (owner === instance) throw new ConsoleCommandRefused('replayed');
      return;
    }
    if (!incoming.command) {
      await this.#client.publish(
        this.replyChannel,
        JSON.stringify(
          incoming.signReply(
            JSON.parse(JSON.stringify({ id: incoming.id, ok: false, error: incoming.error! })),
          ),
        ),
      );
      if (incoming.error?.code === UNAUTHORIZED_CONSOLE)
        throw new ConsoleCommandRefused('token refused');
      return;
    }
    const command = incoming.command;
    let reply: ConsoleReply;
    try {
      const data = await handler({
        ...command,
        args: Array.isArray(command.args) ? command.args : [],
        ...(Array.isArray(command.capabilities)
          ? { capabilities: command.capabilities.filter((c) => typeof c === 'string') }
          : {}),
      });
      // `undefined` (an action with no answer) travels as `null`.
      reply = { id: command.id, ok: true, data: data === undefined ? null : data };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof status === 'number' ? { status } : {}),
        },
      };
    }
    // MAC'd in its wire form (a `Date` becomes a string, `undefined` fields vanish), or the
    // console would compute another MAC and drop a genuine answer.
    await this.#client.publish(
      this.replyChannel,
      JSON.stringify(incoming.signReply(JSON.parse(JSON.stringify(reply)))),
    );
    if (!reply.ok && reply.error.code === 'capabilities-required') {
      throw new ConsoleCommandRefused('capabilities-required');
    }
  }

  /** Stop listening and fail the commands still waiting for an answer. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, settle] of this.#pending) {
      settle(
        {
          id,
          ok: false,
          error: { message: 'console channel closed', code: APP_UNREACHABLE },
        },
        true,
      );
    }
    this.#pending.clear();
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#subscriber?.disconnect?.();
    this.#subscriber = undefined;
  }
}

/**
 * The Redis client for `connection` (an `@adonisjs/redis` connection name; omit for its default),
 * resolved through the container's `redis` binding.
 */
export async function resolveRedisConnection(
  container: { make(binding: string): Promise<unknown> },
  connection: string | undefined,
): Promise<RedisLike> {
  let redis: { connection(name?: string): unknown };
  try {
    redis = (await container.make('redis')) as typeof redis;
  } catch (error) {
    throw new Error(
      `[${PACKAGE}] the federated console needs @adonisjs/redis (no "redis" binding: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return redis.connection(connection) as RedisLike;
}

/** The connection names of `config/redis.ts`, or `undefined` without one. */
export function redisConnectionsOf(config: {
  get<T>(key: string, fallback?: T): T;
}): { names: string[]; default: string | undefined } | undefined {
  const redis = config.get<
    { connection?: unknown; connections?: Record<string, unknown> } | undefined
  >('redis', undefined);
  if (!redis || typeof redis !== 'object' || !redis.connections) return undefined;
  return {
    names: Object.keys(redis.connections),
    default: typeof redis.connection === 'string' ? redis.connection : undefined,
  };
}
