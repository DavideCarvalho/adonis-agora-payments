import type { PaymentsDriver } from '../driver.js';
import type { PaymentMethodName, WebhookEvent } from '../types.js';
import {
  HUB_MESSAGE_VERSION,
  type HubEventEnvelope,
  type HubOperation,
  type HubProviderDescription,
  isHubUnavailable,
  newHubMessageId,
  PaymentsHubError,
} from './protocol.js';
import type { HubTransport } from './transports.js';

/**
 * Where the tenant gets the bearer token it presents: a fixed shared secret, a function
 * (`authkitTenantToken(...)` from `@adonis-agora/authkit-client`), or an object with `get()`.
 */
export type HubTokenSource =
  | string
  | (() => Promise<string>)
  | { get(): Promise<string>; reset?(): void; invalidate?(): void };

interface ResolvedToken {
  get(): Promise<string>;
  reset?(): void;
}

function resolveToken(source: HubTokenSource): ResolvedToken {
  if (typeof source === 'string') {
    if (source === '') throw new Error('[payments] the tenant token is empty');
    return { get: async () => source };
  }
  if (typeof source === 'function') {
    const reset = (source as { reset?: unknown }).reset;
    return {
      get: () => source(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  const reset = source.reset ?? source.invalidate;
  return {
    get: () => source.get(),
    ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
  };
}

export interface HubClientOptions {
  transport: HubTransport;
  token: HubTokenSource;
  /** This app's name, sent along for verifiers that need it (shared secrets). */
  partition?: string;
  /** Per-call budget. Default 15 s (a gateway call is behind it). */
  timeoutMs?: number;
  /** Transport-level retries of the SAME call id (the control plane replays, never re-runs). Default 2. */
  retries?: number;
}

/** A tenant's handle on the payments control plane. */
export interface HubClient {
  call<T = unknown>(operation: HubOperation, input?: unknown): Promise<T>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createHubClient(options: HubClientOptions): HubClient {
  const token = resolveToken(options.token);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 2;

  return {
    async call<T>(operation: HubOperation, input?: unknown): Promise<T> {
      const id = newHubMessageId();
      let refreshed = false;
      for (let attempt = 0; ; attempt += 1) {
        const message = {
          v: HUB_MESSAGE_VERSION,
          id,
          operation,
          ...(input !== undefined ? { input } : {}),
          token: await token.get().catch((error: Error) => {
            throw new PaymentsHubError(
              'unavailable',
              `could not get a tenant token: ${error.message}`,
            );
          }),
          issuedAt: Date.now(),
          ...(options.partition !== undefined ? { partition: options.partition } : {}),
        };
        try {
          const reply = await options.transport.request(message, timeoutMs);
          if (reply.ok) return reply.result as T;
          const code = reply.error?.code ?? 'unavailable';
          // A cached token the control plane no longer accepts: fetch a fresh one, once.
          if (code === 'unauthorized' && !refreshed && token.reset) {
            refreshed = true;
            token.reset();
            continue;
          }
          // Still running on the control plane (an earlier attempt of this same id).
          if (code === 'conflict' && attempt < retries) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw new PaymentsHubError(
            code,
            reply.error?.message ?? 'the control plane refused the call',
          );
        } catch (error) {
          if (isHubUnavailable(error) && attempt < retries) {
            await sleep(250 * 2 ** attempt);
            continue;
          }
          throw error;
        }
      }
    },
  };
}

/** One provider of the control plane, as a tenant declares it in `tenant.providers`. */
export interface HubProviderDeclaration {
  /** The driver's provider name, when it differs from the key (`'asaas'`). */
  provider?: string;
  /** The methods it takes, before `describe` answered. Default: the methods routed to it. */
  methods?: readonly PaymentMethodName[];
  /** What it can do, before `describe` answered. Default: nothing optional. */
  capabilities?: NonNullable<PaymentsDriver['capabilities']>;
}

const unsupportedWebhook = (provider: string) =>
  new Error(
    `[payments] "${provider}" is a control plane provider: its webhooks go to the control plane, which forwards them to this app.`,
  );

/**
 * A driver whose every call runs on the control plane, with the control plane's credentials. Its
 * provider, methods and capabilities are the control plane's (`describe`); until that answered
 * once, the declaration stands in for them.
 */
export class RemoteDriver implements PaymentsDriver {
  readonly name: string;
  readonly #client: HubClient;
  readonly #declared: HubProviderDeclaration;
  readonly #routed: readonly PaymentMethodName[];
  #description: HubProviderDescription | undefined;
  /** Webhooks never reach a tenant, so it verifies none. */
  readonly webhookVerification = 'unsupported' as const;

  constructor(
    name: string,
    client: HubClient,
    declared: HubProviderDeclaration = {},
    routed: readonly PaymentMethodName[] = [],
  ) {
    this.name = name;
    this.#client = client;
    this.#declared = declared;
    this.#routed = routed;
  }

  /** Install what the control plane said this provider is. */
  describeAs(description: HubProviderDescription | undefined): void {
    if (description !== undefined) this.#description = description;
  }

  get described(): boolean {
    return this.#description !== undefined;
  }

  get provider(): string {
    return this.#description?.provider ?? this.#declared.provider ?? this.name;
  }

  get supportedMethods(): readonly PaymentMethodName[] {
    return (this.#description?.supportedMethods ??
      this.#declared.methods ??
      this.#routed) as readonly PaymentMethodName[];
  }

  get capabilities(): NonNullable<PaymentsDriver['capabilities']> {
    return (this.#description?.capabilities ?? this.#declared.capabilities ?? {}) as NonNullable<
      PaymentsDriver['capabilities']
    >;
  }

  #call<T>(call: string, args: unknown[]): Promise<T> {
    return this.#client.call<T>('driver', { provider: this.name, call, args });
  }

  createCustomer: PaymentsDriver['createCustomer'] = (input) =>
    this.#call('createCustomer', [input]);
  findCustomer: PaymentsDriver['findCustomer'] = (id) => this.#call('findCustomer', [id]);
  updateCustomer: PaymentsDriver['updateCustomer'] = (id, input) =>
    this.#call('updateCustomer', [id, input]);
  charge: PaymentsDriver['charge'] = (input) => this.#call('charge', [input]);
  findPayment: PaymentsDriver['findPayment'] = (id) => this.#call('findPayment', [id]);
  refund: PaymentsDriver['refund'] = (id, ...rest) => this.#call('refund', [id, ...rest]);
  tokenizeCard: NonNullable<PaymentsDriver['tokenizeCard']> = (input) =>
    this.#call('tokenizeCard', [input]);
  createCheckout: PaymentsDriver['createCheckout'] = (input) =>
    this.#call('createCheckout', [input]);
  createSubscription: PaymentsDriver['createSubscription'] = (input) =>
    this.#call('createSubscription', [input]);
  cancelSubscription: PaymentsDriver['cancelSubscription'] = (id, ...rest) =>
    this.#call('cancelSubscription', [id, ...rest]);
  updateSubscription: PaymentsDriver['updateSubscription'] = (id, ...rest) =>
    this.#call('updateSubscription', [id, ...rest]);
  findSubscription: PaymentsDriver['findSubscription'] = (id) =>
    this.#call('findSubscription', [id]);
  listInvoices: PaymentsDriver['listInvoices'] = (customerId) =>
    this.#call('listInvoices', [customerId]);
  findDispute: NonNullable<PaymentsDriver['findDispute']> = (id) => this.#call('findDispute', [id]);
  submitDisputeEvidence: NonNullable<PaymentsDriver['submitDisputeEvidence']> = (id, evidence) =>
    this.#call('submitDisputeEvidence', [id, evidence]);
  cardSetup: NonNullable<PaymentsDriver['cardSetup']> = (input) => this.#call('cardSetup', [input]);
  saveCard: NonNullable<PaymentsDriver['saveCard']> = (input) => this.#call('saveCard', [input]);
  cardUpdateUrl: NonNullable<PaymentsDriver['cardUpdateUrl']> = (input) =>
    this.#call('cardUpdateUrl', [input]);

  parseWebhook: PaymentsDriver['parseWebhook'] = async () => {
    throw unsupportedWebhook(this.provider);
  };
}

/**
 * Ask the control plane what its providers are and install the answer on the remote drivers.
 * Never throws: a control plane that is down at boot leaves the declarations in place and is
 * asked again by the next `refresh`.
 */
export async function describeRemoteDrivers(
  client: HubClient,
  drivers: Iterable<RemoteDriver>,
): Promise<boolean> {
  try {
    const described = await client.call<HubProviderDescription[]>('describe');
    const byName = new Map(described.map((entry) => [entry.name, entry]));
    for (const driver of drivers) driver.describeAs(byName.get(driver.name));
    return true;
  } catch {
    return false;
  }
}

export interface HubEventPumpOptions {
  client: HubClient;
  transport: HubTransport;
  partition: string;
  /** Hands one forwarded event to the app (the local webhook dispatcher). */
  deliver: (event: WebhookEvent) => Promise<unknown>;
  /** Events per pull. Default 50. */
  batch?: number;
  /** Seconds between pulls when idle (or the longest wait for a wake-up). Default 30. */
  idleSeconds?: number;
  logger?: { warn(message: string): void };
}

/**
 * Pulls the events the control plane forwarded to this app, hands each to the app's own webhook
 * pipeline (the same handlers as before, deduplicated by event id), and acknowledges them.
 *
 * At-least-once: an event is acknowledged only after `deliver` resolved, so a crash between the
 * two delivers it again, and the local ledger skips it.
 */
export class HubEventPump {
  #options: HubEventPumpOptions;
  #running = false;
  #loop: Promise<void> | undefined;
  #sleeper: { timer: NodeJS.Timeout; resolve: () => void } | undefined;

  constructor(options: HubEventPumpOptions) {
    this.#options = options;
  }

  /** Pull and deliver until the queue is empty. Returns how many events were delivered. */
  async drain(): Promise<number> {
    const batch = this.#options.batch ?? 50;
    let delivered = 0;
    for (;;) {
      const { events } = await this.#options.client.call<{ events: HubEventEnvelope[] }>(
        'events.pull',
        { limit: batch },
      );
      if (events.length === 0) return delivered;
      const done: string[] = [];
      try {
        for (const envelope of events) {
          await this.#options.deliver(envelope.event as WebhookEvent);
          done.push(envelope.seq);
        }
      } finally {
        if (done.length > 0) await this.#options.client.call('events.ack', { seqs: done });
      }
      delivered += done.length;
      if (events.length < batch) return delivered;
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const idle = this.#options.idleSeconds ?? 30;
    this.#loop = (async () => {
      let failures = 0;
      while (this.#running) {
        try {
          await this.drain();
          failures = 0;
        } catch (error) {
          failures += 1;
          if (failures === 1 || failures % 20 === 0) {
            this.#options.logger?.warn(
              `[payments] could not take the control plane's events: ${(error as Error).message}`,
            );
          }
          await this.#sleep(Math.min(idle, 2 ** Math.min(failures, 5)) * 1000);
          continue;
        }
        if (!this.#running) break;
        const wait = this.#options.transport.wait;
        if (wait) {
          try {
            await wait.call(this.#options.transport, this.#options.partition, idle);
            continue;
          } catch {
            /* fall back to sleeping */
          }
        }
        await this.#sleep(idle * 1000);
      }
    })();
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#sleeper = undefined;
        resolve();
      }, ms);
      timer.unref?.();
      this.#sleeper = { timer, resolve };
    });
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#sleeper) {
      clearTimeout(this.#sleeper.timer);
      this.#sleeper.resolve();
    }
    // A pump blocked on a Redis wake-up answers within its wait; shutdown does not wait for it.
    await Promise.race([this.#loop, new Promise((resolve) => setTimeout(resolve, 1000).unref?.())]);
  }
}

/** One account's billing in this app, as the control plane knows it. */
export interface HubAccountBilling {
  account: string;
  /** The gateway customer ids of this account (one per provider). */
  customers: string[];
  /** This app's subscriptions of the account (billing_subscriptions rows on the control plane). */
  subscriptions: Record<string, unknown>[];
  /** This app's payments of the account. */
  payments: Record<string, unknown>[];
}

/** `getPayments().hub()`: what a tenant asks the control plane beyond gateway calls. */
export interface PaymentsHubApi {
  /** This app's name and capabilities, as the control plane verified them. */
  whoami(): Promise<{ partition: string; capabilities: string[] }>;
  /**
   * The gateway customer of an account (authkit subject) at a control plane provider, created on
   * first use and shared by every app of that person.
   */
  customer(
    account: string,
    provider: string,
    input?: Omit<import('../driver.js').CreateCustomerInput, 'account'>,
  ): Promise<{ id: string; created: boolean }>;
  /** This app's subscriptions and payments of an account. */
  account(account: string): Promise<HubAccountBilling>;
  /** Take the forwarded events now (tests, a cron in a process without the pump). */
  drain(): Promise<number>;
}

export function createPaymentsHubApi(
  client: HubClient,
  pump: () => HubEventPump | undefined,
): PaymentsHubApi {
  return {
    whoami: () => client.call('whoami'),
    customer: (account, provider, input = {}) =>
      client.call('customers.ensure', { account, provider, input: { ...input, account } }),
    account: (account) => client.call('billing.account', { account }),
    async drain() {
      const current = pump();
      if (!current)
        throw new Error(
          '[payments] no event pump in this process (tenant.events is false, or billing is off)',
        );
      return current.drain();
    },
  };
}
