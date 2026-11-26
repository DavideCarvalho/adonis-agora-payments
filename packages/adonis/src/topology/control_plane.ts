import { createHash } from 'node:crypto';
import type { BillingStore } from '../billing/billing_store.js';
import type { CreateCustomerInput, PaymentsDriver } from '../driver.js';
import type { PaymentsManager } from '../payments_manager.js';
import type { WebhookEvent } from '../types.js';
import { DEFAULT_CALL_LEASE_MS, type TenantLedger, type TenantObjectKind } from './ledger.js';
import {
  HUB_DRIVER_CALLS,
  HUB_MESSAGE_VERSION,
  HUB_OPERATION_CAPABILITY,
  HUB_OPERATIONS,
  type HubCallMessage,
  type HubDriverCall,
  type HubErrorCode,
  type HubOperation,
  type HubProviderDescription,
  type HubReplyMessage,
  hasCapability,
  PaymentsHubError,
} from './protocol.js';
import { resolveTenantVerifier, type TenantVerifierInput, type VerifiedTenant } from './verify.js';

export interface PaymentsControlPlaneOptions {
  /** The control plane's manager: the real gateways, with the control plane's credentials. */
  manager: () => PaymentsManager | Promise<PaymentsManager>;
  /** Who owns which gateway object, the per-app event queue, and replayable answers. */
  ledger: TenantLedger;
  /** Verifies the tenant's token on EVERY call. `authkitTenantVerifier({ audience })` fits. */
  verifyTenant: TenantVerifierInput;
  /**
   * The billing store. Needed to keep ONE customer per account (`customers.ensure`) and to answer
   * `billing.account`. Without it every `createCustomer` creates a new gateway customer.
   */
  store?: () => BillingStore | undefined;
  /** `billing_customers.owner_type` of a customer that is a Hub account. Default `'account'`. */
  accountOwnerType?: string;
  /**
   * Only these apps may call. Default: any app the verifier accepts.
   *
   * As a map, each app also declares where the payer may be sent back to
   * ({@link PaymentsTenantAppOptions.returnOrigins}). Without it no return URL is accepted.
   */
  apps?: readonly string[] | Readonly<Record<string, PaymentsTenantAppOptions>>;
  /**
   * More return origins of an app, resolved per call (e.g. the authkit client's registered
   * redirect URIs). Added to `apps[app].returnOrigins`.
   */
  returnOrigins?: (
    partition: string,
  ) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  /**
   * Let an app take over a gateway object nobody claimed yet (a customer or subscription created
   * before the app became a tenant). Default `false`: claim them explicitly with `adopt()`.
   */
  adoptUnclaimed?: boolean;
  /** Refuse a message older than this. Default 5 min. */
  maxAgeMs?: number;
  /** Refuse a message dated more than this ahead of the control plane's clock. Default 30 s. */
  maxClockSkewMs?: number;
  /**
   * How long an in-flight mutating call holds its id before a retry of that id may take it over
   * and reconcile it (the process running it died). Longer than any gateway call. Default 2 min.
   */
  callLeaseMs?: number;
  /**
   * Which calls each gateway deduplicates on `idempotencyKey`, by the driver's `provider` name.
   * Merged over {@link GATEWAY_IDEMPOTENCY}. Decides whether a call whose run was interrupted can
   * be re-run safely, or answers `indeterminate`.
   */
  idempotency?: Readonly<Record<string, GatewayIdempotencyPolicy>>;
  /** Called after an event was queued for an app (the Redis transport wakes its pump). */
  notify?: (partition: string) => void | Promise<void>;
  logger?: { warn(message: string): void };
}

/** One tenant app, in `controlPlane.apps`. */
export interface PaymentsTenantAppOptions {
  /**
   * The origins (`https://www.app.example`) the payer may be sent back to after a checkout, a
   * payment link or a card/portal page this app opened: `successUrl`, `cancelUrl`, `returnUrl`,
   * and any `*url*`/`redirect`/`callback` field of the call. Anything else is refused (`400`), so
   * an app can neither open-redirect through the gateway nor point a payer at another app.
   */
  returnOrigins?: readonly string[];
}

/** What a gateway guarantees about `idempotencyKey`, per call. */
export interface GatewayIdempotencyPolicy {
  /**
   * The calls the gateway deduplicates: running one again with the same `idempotencyKey` returns
   * the first result instead of acting twice.
   */
  honours: readonly HubDriverCall[];
  /**
   * Fill an absent `idempotencyKey` from the call id, so a re-run of an interrupted call is safe
   * even when the app passed none. Only for gateways where the key has no other effect (Stripe:
   * a request header). Asaas folds the key into `externalReference`, so it is not injected there.
   */
  inject?: boolean;
}

/**
 * Per-gateway idempotency, as documented by each gateway:
 *
 * - **Stripe**: every POST takes an `Idempotency-Key` header (kept 24 h). Injected.
 * - **Asaas**: no idempotency mechanism; `charge` looks the payment up by `externalReference`
 *   before creating (the driver's documented workaround), so a `charge` WITH a key is safe to
 *   re-run. Every other Asaas call refuses a key: an interrupted one answers `indeterminate`.
 * - Others (Woovi included): nothing assumed; an interrupted call answers `indeterminate`.
 */
export const GATEWAY_IDEMPOTENCY: Readonly<Record<string, GatewayIdempotencyPolicy>> = {
  stripe: {
    honours: [
      'createCustomer',
      'charge',
      'refund',
      'createCheckout',
      'createSubscription',
      'updateSubscription',
    ],
    inject: true,
  },
  asaas: { honours: ['charge'] },
};

/** Where each call carries its `idempotencyKey` (index of the argument object). */
const KEY_SLOT: Partial<Record<HubDriverCall, number>> = {
  createCustomer: 0,
  charge: 0,
  createCheckout: 0,
  createSubscription: 0,
  updateSubscription: 1,
  refund: 2,
};

export interface PaymentsControlPlane {
  /** Handles one call. Never throws: a bad call becomes an error reply. */
  handle(message: unknown): Promise<HubReplyMessage>;
  /**
   * Route one processed webhook event to the app(s) that own its objects. Returns the apps it was
   * queued for (empty: nobody claimed it, it stays on the control plane only).
   */
  forward(event: WebhookEvent): Promise<string[]>;
  /** Record that an app owns a gateway object it created before it became a tenant. */
  adopt(
    partition: string,
    kind: TenantObjectKind,
    gatewayId: string,
    provider: string,
  ): Promise<boolean>;
  readonly ledger: TenantLedger;
}

/**
 * A plain-JSON copy of a gateway answer that never throws: cycles are cut, bigints become
 * strings, and a value whose `toJSON` throws is reduced to its ids. It runs AFTER the gateway
 * acted, where a throw would turn a done charge into a failed call.
 */
export function toPlainJson(value: unknown): unknown {
  if (value === undefined) return null;
  const ancestors: unknown[] = [];
  try {
    const text = JSON.stringify(value, function (this: unknown, _key, current: unknown) {
      if (typeof current === 'bigint') return current.toString();
      if (typeof current === 'object' && current !== null) {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(current)) return undefined;
        ancestors.push(current);
      }
      return current;
    });
    return text === undefined ? null : JSON.parse(text);
  } catch {
    if (!isRecord(value)) return null;
    const out: Record<string, unknown> = { unserializable: true };
    for (const key of ['id', 'gatewayId', 'provider', 'status', 'url', 'customerId']) {
      try {
        const field = value[key];
        if (typeof field === 'string' || typeof field === 'number') out[key] = field;
      } catch {
        /* a throwing getter: leave it out */
      }
    }
    return out;
  }
}

const reply = (id: string, result: unknown): HubReplyMessage => ({
  v: HUB_MESSAGE_VERSION,
  id,
  ok: true,
  result: toPlainJson(result),
});

const failure = (id: string, code: HubErrorCode, message: string): HubReplyMessage => ({
  v: HUB_MESSAGE_VERSION,
  id,
  ok: false,
  error: { code, message },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** The id a result is known by at the gateway (`gatewayId`, else `id`). */
const gatewayIdOf = (value: unknown): string | undefined =>
  isRecord(value) ? (str(value.gatewayId) ?? str(value.id)) : undefined;

/** Which argument of a driver call names an existing object, and of what kind. */
const TARGETS: Partial<Record<HubDriverCall, TenantObjectKind>> = {
  findCustomer: 'customer',
  updateCustomer: 'customer',
  listInvoices: 'customer',
  findPayment: 'payment',
  refund: 'payment',
  cancelSubscription: 'subscription',
  updateSubscription: 'subscription',
  findSubscription: 'subscription',
  findDispute: 'dispute',
  submitDisputeEvidence: 'dispute',
};

/** Whether the gateway already acted for this call (set right after it answered). */
interface CallProgress {
  executed: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The gateway idempotency key the control plane derives from a call id (stable per app + id). */
export function hubIdempotencyKey(partition: string, callId: string): string {
  return `agora-hub-${createHash('sha256').update(`${partition}\u0000${callId}`).digest('hex').slice(0, 48)}`;
}

/** `https://www.app.example` out of an origin or URL; throws on anything else. */
function normalizeOrigin(value: string): string {
  const origin = originOf(value);
  if (origin === undefined) {
    throw new Error(
      `[payments] "${value}" is not an http(s) origin (controlPlane.apps.*.returnOrigins)`,
    );
  }
  return origin;
}

/** The origin of an absolute http(s) URL, or `undefined`. */
function originOf(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return url.origin;
}

/** A field that sends the payer (or a gateway notification) somewhere. */
const REDIRECT_FIELD = /url|uri|redirect|callback/i;

/** Every string under a redirect-ish key of the call's arguments (metadata included). */
function collectReturnUrls(
  value: unknown,
  path: string,
  redirect: boolean,
  depth: number,
  out: Array<[string, unknown]>,
): void {
  if (depth > 8) return;
  if (typeof value === 'string') {
    if (redirect) out.push([path || 'a return URL', value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectReturnUrls(
        item,
        path === '' ? `args[${index}]` : `${path}[${index}]`,
        redirect,
        depth + 1,
        out,
      );
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    collectReturnUrls(item, `${path}.${key}`, redirect || REDIRECT_FIELD.test(key), depth + 1, out);
  }
}

/** What a call creates, claimed for the calling app. */
const CREATES: Partial<Record<HubDriverCall, TenantObjectKind>> = {
  createCustomer: 'customer',
  charge: 'payment',
  createCheckout: 'checkout',
  createSubscription: 'subscription',
};

/**
 * The control plane side of payments: runs gateway calls for tenants with its own credentials,
 * keeps one customer per Hub account, and routes processed webhooks back to the app that owns
 * each payment/subscription.
 *
 * The token is verified on every message, so a shared broker is not a trust boundary: the app a
 * call acts for comes from the verified token only, and an app only ever touches gateway objects
 * the ledger says are its own.
 */
export function createPaymentsControlPlane(
  options: PaymentsControlPlaneOptions,
): PaymentsControlPlane {
  const verifyTenant = resolveTenantVerifier(options.verifyTenant);
  const ledger = options.ledger;
  const accountOwnerType = options.accountOwnerType ?? 'account';
  const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  const maxSkewMs = options.maxClockSkewMs ?? 30 * 1000;
  const leaseMs = options.callLeaseMs ?? DEFAULT_CALL_LEASE_MS;
  const appList: readonly string[] | undefined =
    options.apps === undefined
      ? undefined
      : Array.isArray(options.apps)
        ? (options.apps as readonly string[])
        : Object.keys(options.apps);
  const allowed = appList ? new Set(appList) : undefined;
  /** `apps[app].returnOrigins`, normalized once (a bad origin fails construction, not a call). */
  const configuredOrigins = new Map<string, Set<string>>();
  if (options.apps !== undefined && !Array.isArray(options.apps)) {
    for (const [app, settings] of Object.entries(
      options.apps as Record<string, PaymentsTenantAppOptions>,
    )) {
      configuredOrigins.set(app, new Set((settings.returnOrigins ?? []).map(normalizeOrigin)));
    }
  }
  /** One customer creation per account and provider at a time (in this process). */
  const ensuring = new Map<string, Promise<unknown>>();

  const parse = (message: unknown): HubCallMessage | null => {
    if (!isRecord(message)) return null;
    if (
      message.v !== HUB_MESSAGE_VERSION ||
      typeof message.id !== 'string' ||
      message.id === '' ||
      message.id.length > 191 ||
      typeof message.operation !== 'string' ||
      !(HUB_OPERATIONS as readonly string[]).includes(message.operation) ||
      typeof message.token !== 'string' ||
      message.token === '' ||
      typeof message.issuedAt !== 'number'
    ) {
      return null;
    }
    return message as unknown as HubCallMessage;
  };

  const driverFor = async (name: unknown): Promise<PaymentsDriver> => {
    const manager = await options.manager();
    const key = str(name);
    const driver =
      key === undefined
        ? undefined
        : (manager.drivers.get(key) ??
          [...manager.drivers.values()].find((candidate) => candidate.provider === key));
    if (!driver) {
      throw new PaymentsHubError(
        'not_found',
        `provider "${String(name)}" is not configured on the control plane`,
      );
    }
    return driver;
  };

  /** The calling app must own `gatewayId` (or adopt it, when allowed and nobody owns it). */
  const assertOwns = async (
    partition: string,
    kind: TenantObjectKind,
    gatewayId: string,
    provider: string,
  ): Promise<void> => {
    const owners = await ledger.owners(kind, gatewayId);
    if (owners.includes(partition)) return;
    if (owners.length === 0 && options.adoptUnclaimed === true) {
      if (await ledger.claim(partition, kind, gatewayId, provider)) return;
    }
    // Not "forbidden": whether another app owns it is none of this app's business.
    throw new PaymentsHubError('not_found', `${kind} "${gatewayId}" not found for this app`);
  };

  const claim = async (
    partition: string,
    kind: TenantObjectKind,
    gatewayId: string | undefined,
    provider: string,
  ) => {
    if (gatewayId === undefined) return;
    if (!(await ledger.claim(partition, kind, gatewayId, provider))) {
      options.logger?.warn(
        `[payments] ${kind} "${gatewayId}" was created for "${partition}" but another app already owns it`,
      );
    }
  };

  /** A lock every control-plane process honours (the ledger's), waited on for a few seconds. */
  const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const deadline = Date.now() + 10_000;
    let holder = await ledger.lock(key, 60_000);
    while (holder === null) {
      if (Date.now() > deadline) {
        throw new PaymentsHubError(
          'conflict',
          'another control plane process is creating this customer; retry',
        );
      }
      await sleep(100 + Math.floor(Math.random() * 150));
      holder = await ledger.lock(key, 60_000);
    }
    try {
      return await fn();
    } finally {
      await ledger.unlock(key, holder).catch((error: Error) => {
        options.logger?.warn(`[payments] could not release lock "${key}": ${error.message}`);
      });
    }
  };

  const ensureCustomer = async (
    tenant: VerifiedTenant,
    input: Record<string, unknown>,
    progress: CallProgress,
  ): Promise<{ id: string; created: boolean }> => {
    const driver = await driverFor(input.provider);
    const existingId = str(input.existingId);
    if (existingId !== undefined) {
      await assertOwns(tenant.partition, 'customer', existingId, driver.provider);
      return { id: existingId, created: false };
    }
    const account = str(input.account);
    const createInput = (isRecord(input.input) ? input.input : {}) as CreateCustomerInput;
    const store = options.store?.();
    const create = async (): Promise<{ id: string; created: boolean }> => {
      if (account !== undefined && store) {
        const row = (await store.findCustomerByOwner(
          accountOwnerType,
          account,
          driver.provider,
        )) as { gatewayId?: unknown } | null;
        const known = str(row?.gatewayId);
        if (known !== undefined) {
          await ledger.claim(tenant.partition, 'customer', known, driver.provider);
          return { id: known, created: false };
        }
      }
      const { account: _account, ...gatewayInput } = createInput as CreateCustomerInput & {
        account?: string;
      };
      const customer = await driver.createCustomer(gatewayInput);
      // The gateway acted: from here on nothing may fail the call (see `handle`).
      progress.executed = true;
      if (store) {
        await store
          .saveCustomer({
            gatewayId: customer.id,
            provider: driver.provider,
            ...(account !== undefined ? { ownerType: accountOwnerType, ownerId: account } : {}),
            ...(createInput.email !== undefined ? { email: createInput.email } : {}),
            ...(createInput.name !== undefined ? { name: createInput.name } : {}),
            ...(createInput.taxId !== undefined ? { taxId: createInput.taxId } : {}),
            ...(createInput.metadata !== undefined ? { metadata: createInput.metadata } : {}),
          })
          .catch((error: Error) => {
            options.logger?.warn(
              `[payments] customer ${customer.id} was created at ${driver.provider} but not recorded: ${error.message}`,
            );
          });
      }
      await claim(tenant.partition, 'customer', customer.id, driver.provider).catch(
        (error: Error) => {
          options.logger?.warn(
            `[payments] customer ${customer.id} was created for "${tenant.partition}" but not claimed: ${error.message}`,
          );
        },
      );
      return { id: customer.id, created: true };
    };
    if (account === undefined) return create();
    const key = `${driver.provider}|${account}`;
    // One creation per account and provider: chained in this process, locked across processes
    // (two control planes behind a load balancer would otherwise both miss and both create).
    const previous = ensuring.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => withLock(`customer|${key}`, create));
    ensuring.set(key, next);
    try {
      return await next;
    } finally {
      if (ensuring.get(key) === next) ensuring.delete(key);
    }
  };

  /** Every return URL a call carries must be on the calling app's own origins. */
  const assertReturnUrls = async (partition: string, args: unknown[]): Promise<void> => {
    const urls: Array<[string, unknown]> = [];
    collectReturnUrls(args, '', false, 0, urls);
    if (urls.length === 0) return;
    const origins = new Set(configuredOrigins.get(partition) ?? []);
    const extra = options.returnOrigins ? await options.returnOrigins(partition) : undefined;
    for (const origin of extra ?? []) {
      try {
        origins.add(normalizeOrigin(origin));
      } catch {
        /* a bad resolved origin allows nothing */
      }
    }
    for (const [path, value] of urls) {
      const origin = typeof value === 'string' ? originOf(value) : undefined;
      if (origin === undefined || !origins.has(origin)) {
        throw new PaymentsHubError(
          'bad_request',
          `${path} must be a URL on one of the origins of app "${partition}" (controlPlane.apps.${partition}.returnOrigins)`,
        );
      }
    }
  };

  const runDriverCall = async (
    tenant: VerifiedTenant,
    input: Record<string, unknown>,
    progress: CallProgress,
  ) => {
    const call = str(input.call) as HubDriverCall | undefined;
    if (call === undefined || !(call in HUB_DRIVER_CALLS)) {
      throw new PaymentsHubError('bad_request', `unknown driver call "${String(input.call)}"`);
    }
    if (!hasCapability(tenant.capabilities, HUB_DRIVER_CALLS[call])) {
      throw new PaymentsHubError('forbidden', `the token lacks ${HUB_DRIVER_CALLS[call]}`);
    }
    const driver = await driverFor(input.provider);
    // JSON has no `undefined`: `refund(id, undefined, { idempotencyKey })` arrives as `null`.
    const args = (Array.isArray(input.args) ? [...input.args] : []).map((arg) =>
      arg === null ? undefined : arg,
    );
    await assertReturnUrls(tenant.partition, args);
    const fn = (driver as unknown as Record<string, unknown>)[call];
    if (typeof fn !== 'function') {
      throw new PaymentsHubError(
        'bad_request',
        `provider "${driver.provider}" does not support ${call}`,
      );
    }

    // Customers go through `ensure`: one per account, recorded and claimed.
    if (call === 'createCustomer') {
      const createInput = isRecord(args[0]) ? args[0] : {};
      const ensured = await ensureCustomer(
        tenant,
        { provider: input.provider, account: createInput.account, input: createInput },
        progress,
      );
      if (!ensured.created) return { id: ensured.id };
      // Only a read for a fuller answer: the customer exists either way.
      return (
        (await driver.findCustomer(ensured.id).catch(() => null)) ?? {
          id: ensured.id,
        }
      );
    }

    const target = TARGETS[call];
    if (target !== undefined) {
      const id = str(args[0]);
      if (id === undefined) throw new PaymentsHubError('bad_request', `${call} needs an id`);
      await assertOwns(tenant.partition, target, id, driver.provider);
    }
    // Any customer or subscription an input names must be this app's too.
    const first = args[0];
    if (isRecord(first)) {
      if (first.customerId !== undefined && first.customerId !== null) {
        const customerId = str(first.customerId);
        if (customerId === undefined) {
          throw new PaymentsHubError(
            'bad_request',
            `${call}: \`customerId\` must be a non-empty string`,
          );
        }
        await assertOwns(tenant.partition, 'customer', customerId, driver.provider);
      }
      // Every subscription it names, however it names it: the card calls carry them as
      // `subscriptionGatewayIds[]` (cardSetup, saveCard) or `subscriptionGatewayId`
      // (cardUpdateUrl), and the driver moves each one's card.
      const subscriptionIds: string[] = [];
      for (const key of ['subscriptionId', 'subscriptionGatewayId'] as const) {
        if (first[key] === undefined || first[key] === null) continue;
        const id = str(first[key]);
        if (id === undefined) {
          throw new PaymentsHubError(
            'bad_request',
            `${call}: \`${key}\` must be a non-empty string`,
          );
        }
        subscriptionIds.push(id);
      }
      const many = first.subscriptionGatewayIds;
      if (many !== undefined && many !== null) {
        if (!Array.isArray(many)) {
          throw new PaymentsHubError(
            'bad_request',
            `${call}: \`subscriptionGatewayIds\` must be a list of subscription ids`,
          );
        }
        for (const entry of many) {
          const id = str(entry);
          if (id === undefined) {
            throw new PaymentsHubError(
              'bad_request',
              `${call}: every \`subscriptionGatewayIds\` entry must be a non-empty string`,
            );
          }
          subscriptionIds.push(id);
        }
      }
      for (const id of new Set(subscriptionIds)) {
        await assertOwns(tenant.partition, 'subscription', id, driver.provider);
      }
    }

    let result: unknown;
    try {
      result = await (fn as (...a: unknown[]) => Promise<unknown>).apply(driver, args);
    } catch (error) {
      throw new PaymentsHubError('gateway', error instanceof Error ? error.message : String(error));
    }
    // The gateway acted: from here on nothing may fail the call (see `handle`).
    progress.executed = true;
    const creates = CREATES[call];
    if (creates !== undefined) {
      await claim(tenant.partition, creates, gatewayIdOf(result), driver.provider).catch(
        (error: Error) => {
          options.logger?.warn(
            `[payments] ${creates} ${String(gatewayIdOf(result))} was created for "${tenant.partition}" but not claimed: ${error.message}`,
          );
        },
      );
    }
    return result;
  };

  const describe = async (): Promise<HubProviderDescription[]> => {
    const manager = await options.manager();
    return [...manager.drivers.entries()].map(([name, driver]) => ({
      name,
      provider: driver.provider,
      supportedMethods: [...driver.supportedMethods],
      ...(driver.capabilities !== undefined
        ? { capabilities: JSON.parse(JSON.stringify(driver.capabilities)) }
        : {}),
    }));
  };

  /** Payments and subscriptions of one account that belong to the calling app. */
  const billingAccount = async (tenant: VerifiedTenant, input: Record<string, unknown>) => {
    const account = str(input.account);
    if (account === undefined)
      throw new PaymentsHubError('bad_request', 'billing.account needs an account');
    const store = options.store?.();
    if (!store) throw new PaymentsHubError('unavailable', 'the control plane has no billing store');
    const customers = await store.listCustomers({
      ownerType: accountOwnerType,
      ownerId: account,
      page: 1,
      size: 50,
    } as never);
    const payments: unknown[] = [];
    const subscriptions: unknown[] = [];
    for (const customer of customers) {
      const customerId = str((customer as unknown as Record<string, unknown>).gatewayId);
      if (customerId === undefined) continue;
      for (const row of await store.listSubscriptions({ customerId, page: 1, size: 50 } as never)) {
        const id = str((row as unknown as Record<string, unknown>).gatewayId);
        if (
          id !== undefined &&
          (await ledger.owners('subscription', id)).includes(tenant.partition)
        ) {
          subscriptions.push(row);
        }
      }
      for (const row of await store.listPayments({ customerId, page: 1, size: 50 } as never)) {
        const id = str((row as unknown as Record<string, unknown>).gatewayId);
        if (id !== undefined && (await ledger.owners('payment', id)).includes(tenant.partition)) {
          payments.push(row);
        }
      }
    }
    return {
      account,
      customers: customers.map((c) => (c as unknown as Record<string, unknown>).gatewayId),
      payments,
      subscriptions,
    };
  };

  const run = async (
    tenant: VerifiedTenant,
    message: HubCallMessage,
    progress: CallProgress,
  ): Promise<unknown> => {
    const input = isRecord(message.input) ? message.input : {};
    switch (message.operation as HubOperation) {
      case 'whoami':
        return { partition: tenant.partition, capabilities: tenant.capabilities };
      case 'describe':
        return describe();
      case 'driver':
        return runDriverCall(tenant, input, progress);
      case 'customers.ensure':
        return ensureCustomer(tenant, input, progress);
      case 'billing.account':
        return billingAccount(tenant, input);
      case 'events.pull': {
        const limit = typeof input.limit === 'number' ? input.limit : 50;
        return { events: await ledger.pull(tenant.partition, limit) };
      }
      case 'events.ack': {
        const seqs = Array.isArray(input.seqs) ? input.seqs.map(String) : [];
        return { acked: await ledger.ack(tenant.partition, seqs) };
      }
      default:
        throw new PaymentsHubError('bad_request', `unknown operation "${message.operation}"`);
    }
  };

  /** Calls whose replay must return the first answer instead of running twice. */
  const mutates = (message: HubCallMessage): boolean =>
    message.operation === 'customers.ensure' ||
    (message.operation === 'driver' &&
      isRecord(message.input) &&
      typeof message.input.call === 'string' &&
      !/^(find|list)/.test(message.input.call));

  /**
   * The gateway idempotency of a mutating call: fills the key from the call id where the gateway
   * honours it and the key is inert (Stripe), and says whether re-running this exact call is safe.
   */
  const prepare = async (
    tenant: VerifiedTenant,
    message: HubCallMessage,
  ): Promise<{ message: HubCallMessage; replaySafe: boolean }> => {
    const unchanged = { message, replaySafe: false };
    const input = message.input;
    if (!isRecord(input)) return unchanged;
    let call: HubDriverCall | undefined;
    let args: unknown[];
    let rebuild: (next: unknown[]) => Record<string, unknown>;
    if (message.operation === 'driver') {
      call = str(input.call) as HubDriverCall | undefined;
      args = Array.isArray(input.args) ? [...input.args] : [];
      rebuild = (next) => ({ ...input, args: next });
    } else if (message.operation === 'customers.ensure') {
      call = 'createCustomer';
      args = [isRecord(input.input) ? input.input : {}];
      rebuild = (next) => ({ ...input, input: next[0] });
    } else {
      return unchanged;
    }
    const slot = call === undefined ? undefined : KEY_SLOT[call];
    if (call === undefined || slot === undefined) return unchanged;
    let provider: string;
    try {
      provider = (await driverFor(input.provider)).provider;
    } catch {
      return unchanged;
    }
    const policy = options.idempotency?.[provider] ?? GATEWAY_IDEMPOTENCY[provider];
    if (!policy?.honours.includes(call)) return unchanged;
    const current = args[slot];
    if (current !== undefined && current !== null && !isRecord(current)) return unchanged;
    const holder: Record<string, unknown> = isRecord(current) ? { ...current } : {};
    if (str(holder.idempotencyKey) === undefined) {
      if (policy.inject !== true) return unchanged;
      holder.idempotencyKey = hubIdempotencyKey(tenant.partition, message.id);
    }
    while (args.length < slot) args.push(null);
    args[slot] = holder;
    return { message: { ...message, input: rebuild(args) }, replaySafe: true };
  };

  const handle = async (raw: unknown): Promise<HubReplyMessage> => {
    const message = parse(raw);
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '';
    if (message === null) return failure(id, 'bad_request', 'malformed payments call');
    const age = Date.now() - message.issuedAt;
    if (age > maxAgeMs) {
      return failure(id, 'bad_request', 'the call is too old');
    }
    // A message dated ahead would stay "fresh" for as long as it is ahead: a replay window.
    if (-age > maxSkewMs) {
      return failure(id, 'bad_request', 'the call is dated in the future');
    }
    let tenant: VerifiedTenant | null;
    try {
      tenant = await verifyTenant({
        token: message.token,
        ...(typeof message.partition === 'string'
          ? { partition: message.partition, app: message.partition }
          : {}),
      });
    } catch (error) {
      options.logger?.warn(`[payments] verifyTenant failed: ${(error as Error).message}`);
      tenant = null;
    }
    if (tenant === null) return failure(id, 'unauthorized', 'the token was refused');
    if (allowed !== undefined && !allowed.has(tenant.partition)) {
      return failure(id, 'forbidden', `app "${tenant.partition}" may not use this control plane`);
    }
    if (tenant.expiresAt !== undefined && tenant.expiresAt < Date.now()) {
      return failure(id, 'unauthorized', 'the token expired');
    }
    if (message.operation !== 'driver') {
      const needed = HUB_OPERATION_CAPABILITY[message.operation as Exclude<HubOperation, 'driver'>];
      if (!hasCapability(tenant.capabilities, needed)) {
        return failure(id, 'forbidden', `the token lacks ${needed}`);
      }
    }

    const idempotent = mutates(message);
    let toRun = message;
    let held: string | undefined;
    if (idempotent) {
      const prepared = await prepare(tenant, message);
      toRun = prepared.message;
      const state = await ledger.beginCall(tenant.partition, message.id, { leaseMs });
      if (state.state === 'done') return state.reply;
      if (state.state === 'running') {
        return failure(id, 'conflict', 'this call is still running; retry it later');
      }
      held = state.claim;
      if (state.state === 'stale') {
        if (!prepared.replaySafe) {
          // The earlier run may or may not have reached the gateway, and the gateway cannot
          // deduplicate a second one: record that, and never run it again under this id.
          const answer = failure(
            id,
            'indeterminate',
            'the control plane stopped while running this call and the gateway cannot deduplicate it; look the object up (externalReference) before charging again',
          );
          await ledger.finishCall(tenant.partition, message.id, answer, held);
          options.logger?.warn(
            `[payments] call ${tenant.partition}/${message.id} was interrupted; answered indeterminate`,
          );
          return answer;
        }
        options.logger?.warn(
          `[payments] call ${tenant.partition}/${message.id} was interrupted; re-running it with the same gateway idempotency key`,
        );
      }
    }

    const progress: CallProgress = { executed: false };
    let result: unknown;
    try {
      result = await run(tenant, toRun, progress);
    } catch (error) {
      const code = error instanceof PaymentsHubError ? error.code : 'unavailable';
      const text =
        error instanceof PaymentsHubError
          ? error.message.replace(/^\[payments\] /, '')
          : ((error as Error).message ?? 'internal error');
      if (!(error instanceof PaymentsHubError)) {
        options.logger?.warn(`[payments] control plane call failed: ${text}`);
      }
      if (idempotent && progress.executed) {
        // The gateway acted and something after it failed: never release the id (a retry would
        // act twice). Record that the outcome is unknown instead.
        const answer = failure(id, 'indeterminate', `the gateway ran this call, then: ${text}`);
        await ledger.finishCall(tenant.partition, message.id, answer, held).catch(() => undefined);
        return answer;
      }
      if (idempotent) {
        await ledger.abandonCall(tenant.partition, message.id, held).catch(() => undefined);
      }
      return failure(id, code, text);
    }
    // The gateway acted. Nothing below may release the id or turn this into a failure.
    const answer = reply(message.id, result);
    if (idempotent) {
      try {
        await ledger.finishCall(tenant.partition, message.id, answer, held);
      } catch (error) {
        // Still the right answer for THIS attempt. The id stays in flight; a retry of it after the
        // lease is reconciled (re-run with the same gateway key, or `indeterminate`).
        options.logger?.warn(
          `[payments] answer of ${tenant.partition}/${message.id} not recorded: ${(error as Error).message}`,
        );
      }
    }
    return answer;
  };

  const forward = async (event: WebhookEvent): Promise<string[]> => {
    const data = isRecord(event.data) ? event.data : {};
    const gatewayId = str(data.gatewayId);
    const disputeId = str(data.disputeId);
    const checkoutId = str(data.checkoutId) ?? str(data.sessionId);
    const candidates: Array<[TenantObjectKind, string | undefined]> = [
      ['dispute', disputeId],
      ['payment', str(data.paymentGatewayId)],
      ['subscription', str(data.subscriptionId)],
      ['checkout', checkoutId],
      ['payment', gatewayId],
      ['subscription', gatewayId],
      ['checkout', gatewayId],
      ['dispute', gatewayId],
    ];
    let partitions: string[] = [];
    let matched: [TenantObjectKind, string] | undefined;
    for (const [kind, id] of candidates) {
      if (id === undefined) continue;
      const owners = await ledger.owners(kind, id);
      if (owners.length > 0) {
        partitions = owners;
        matched = [kind, id];
        break;
      }
    }
    const customerId = str(data.customerId);
    // Any object id at all (payment, subscription, checkout/session, dispute) makes this an event
    // ABOUT that object, not about the customer.
    const hasObject = Boolean(
      gatewayId ??
        str(data.paymentGatewayId) ??
        str(data.subscriptionId) ??
        checkoutId ??
        disputeId,
    );
    if (partitions.length === 0 && customerId !== undefined) {
      const owners = await ledger.owners('customer', customerId);
      // An event about an object nobody claimed goes to the customer's app only when there is
      // exactly one: with two, either could be the payer's context, and guessing would grant a
      // feature in the wrong app. A customer-only event goes to every app of that customer.
      if (!hasObject || owners.length === 1) partitions = owners;
    }
    if (partitions.length === 0) {
      // Not an error (an event of the control plane's own, or of an object nobody claimed yet),
      // but the one line that tells an operator which events to replay after an adoption.
      options.logger?.warn(
        `[payments] webhook ${event.provider}/${event.id} (${event.type}) belongs to no app; kept on the control plane only`,
      );
      return [];
    }
    const provider = event.provider;
    for (const partition of partitions) {
      // Learn the objects this event introduced (a renewal payment of a claimed subscription, the
      // payment of a claimed checkout, a dispute on a claimed payment), so later events about
      // them route directly.
      if (partitions.length === 1) {
        if (disputeId !== undefined && matched?.[0] !== 'dispute') {
          await ledger.claim(partition, 'dispute', disputeId, provider);
        }
        if (gatewayId !== undefined && matched !== undefined && matched[1] !== gatewayId) {
          const kind: TenantObjectKind | undefined =
            str(data.paymentGatewayId) !== undefined
              ? 'dispute'
              : matched[0] === 'subscription' || matched[0] === 'checkout'
                ? 'payment'
                : undefined;
          if (kind !== undefined) await ledger.claim(partition, kind, gatewayId, provider);
        }
      }
      await ledger.enqueue(partition, event);
      try {
        await options.notify?.(partition);
      } catch (error) {
        options.logger?.warn(
          `[payments] could not wake "${partition}": ${(error as Error).message}`,
        );
      }
    }
    return partitions;
  };

  return {
    handle,
    forward,
    adopt: (partition, kind, gatewayId, provider) =>
      ledger.claim(partition, kind, gatewayId, provider),
    ledger,
  };
}
