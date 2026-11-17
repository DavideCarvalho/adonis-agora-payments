import type { BillingStore } from '../billing/billing_store.js';
import type { CreateCustomerInput, PaymentsDriver } from '../driver.js';
import type { PaymentsManager } from '../payments_manager.js';
import type { WebhookEvent } from '../types.js';
import type { TenantLedger, TenantObjectKind } from './ledger.js';
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
  /** Only these apps may call. Default: any app the verifier accepts. */
  apps?: readonly string[];
  /**
   * Let an app take over a gateway object nobody claimed yet (a customer or subscription created
   * before the app became a tenant). Default `false`: claim them explicitly with `adopt()`.
   */
  adoptUnclaimed?: boolean;
  /** Refuse a message older than this. Default 5 min. */
  maxAgeMs?: number;
  /** Called after an event was queued for an app (the Redis transport wakes its pump). */
  notify?: (partition: string) => void | Promise<void>;
  logger?: { warn(message: string): void };
}

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

const reply = (id: string, result: unknown): HubReplyMessage => ({
  v: HUB_MESSAGE_VERSION,
  id,
  ok: true,
  result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
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
  const allowed = options.apps ? new Set(options.apps) : undefined;
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

  const ensureCustomer = async (
    tenant: VerifiedTenant,
    input: Record<string, unknown>,
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
      if (store) {
        await store.saveCustomer({
          gatewayId: customer.id,
          provider: driver.provider,
          ...(account !== undefined ? { ownerType: accountOwnerType, ownerId: account } : {}),
          ...(createInput.email !== undefined ? { email: createInput.email } : {}),
          ...(createInput.name !== undefined ? { name: createInput.name } : {}),
          ...(createInput.taxId !== undefined ? { taxId: createInput.taxId } : {}),
          ...(createInput.metadata !== undefined ? { metadata: createInput.metadata } : {}),
        });
      }
      await ledger.claim(tenant.partition, 'customer', customer.id, driver.provider);
      return { id: customer.id, created: true };
    };
    if (account === undefined) return create();
    const key = `${driver.provider}|${account}`;
    const previous = ensuring.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(create);
    ensuring.set(key, next);
    try {
      return await next;
    } finally {
      if (ensuring.get(key) === next) ensuring.delete(key);
    }
  };

  const runDriverCall = async (tenant: VerifiedTenant, input: Record<string, unknown>) => {
    const call = str(input.call) as HubDriverCall | undefined;
    if (call === undefined || !(call in HUB_DRIVER_CALLS)) {
      throw new PaymentsHubError('bad_request', `unknown driver call "${String(input.call)}"`);
    }
    if (!hasCapability(tenant.capabilities, HUB_DRIVER_CALLS[call])) {
      throw new PaymentsHubError('forbidden', `the token lacks ${HUB_DRIVER_CALLS[call]}`);
    }
    const driver = await driverFor(input.provider);
    const args = Array.isArray(input.args) ? [...input.args] : [];
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
      const ensured = await ensureCustomer(tenant, {
        provider: input.provider,
        account: createInput.account,
        input: createInput,
      });
      return ensured.created
        ? ((await driver.findCustomer(ensured.id)) ?? { id: ensured.id })
        : { id: ensured.id };
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
      const customerId = str(first.customerId);
      if (customerId !== undefined) {
        await assertOwns(tenant.partition, 'customer', customerId, driver.provider);
      }
      const subscriptionId = str(first.subscriptionId);
      if (subscriptionId !== undefined) {
        await assertOwns(tenant.partition, 'subscription', subscriptionId, driver.provider);
      }
    }

    let result: unknown;
    try {
      result = await (fn as (...a: unknown[]) => Promise<unknown>).apply(driver, args);
    } catch (error) {
      throw new PaymentsHubError('gateway', error instanceof Error ? error.message : String(error));
    }
    const creates = CREATES[call];
    if (creates !== undefined)
      await claim(tenant.partition, creates, gatewayIdOf(result), driver.provider);
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

  const run = async (tenant: VerifiedTenant, message: HubCallMessage): Promise<unknown> => {
    const input = isRecord(message.input) ? message.input : {};
    switch (message.operation as HubOperation) {
      case 'whoami':
        return { partition: tenant.partition, capabilities: tenant.capabilities };
      case 'describe':
        return describe();
      case 'driver':
        return runDriverCall(tenant, input);
      case 'customers.ensure':
        return ensureCustomer(tenant, input);
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

  const handle = async (raw: unknown): Promise<HubReplyMessage> => {
    const message = parse(raw);
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '';
    if (message === null) return failure(id, 'bad_request', 'malformed payments call');
    if (Date.now() - message.issuedAt > maxAgeMs) {
      return failure(id, 'bad_request', 'the call is too old');
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
    if (idempotent) {
      const state = await ledger.beginCall(tenant.partition, message.id);
      if (state.state === 'done') return state.reply;
      if (state.state === 'running') {
        return failure(id, 'conflict', 'this call is still running; retry it later');
      }
    }
    try {
      const answer = reply(message.id, await run(tenant, message));
      if (idempotent) await ledger.finishCall(tenant.partition, message.id, answer);
      return answer;
    } catch (error) {
      if (idempotent) await ledger.abandonCall(tenant.partition, message.id).catch(() => undefined);
      if (error instanceof PaymentsHubError) {
        return failure(id, error.code, error.message.replace(/^\[payments\] /, ''));
      }
      options.logger?.warn(`[payments] control plane call failed: ${(error as Error).message}`);
      return failure(id, 'unavailable', (error as Error).message ?? 'internal error');
    }
  };

  const forward = async (event: WebhookEvent): Promise<string[]> => {
    const data = isRecord(event.data) ? event.data : {};
    const gatewayId = str(data.gatewayId);
    const candidates: Array<[TenantObjectKind, string | undefined]> = [
      ['payment', str(data.paymentGatewayId)],
      ['subscription', str(data.subscriptionId)],
      ['payment', gatewayId],
      ['subscription', gatewayId],
      ['checkout', gatewayId],
      ['dispute', gatewayId],
      ['checkout', str(data.checkoutId) ?? str(data.sessionId)],
    ];
    let partitions: string[] = [];
    for (const [kind, id] of candidates) {
      if (id === undefined) continue;
      const owners = await ledger.owners(kind, id);
      if (owners.length > 0) {
        partitions = owners;
        break;
      }
    }
    const customerId = str(data.customerId);
    const hasObject = Boolean(gatewayId ?? str(data.paymentGatewayId) ?? str(data.subscriptionId));
    if (partitions.length === 0 && customerId !== undefined) {
      const owners = await ledger.owners('customer', customerId);
      // An event about a payment nobody claimed goes to the customer's app only when there is
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
      // Learn the objects this event introduced (a renewal payment of a claimed subscription, a
      // dispute on a claimed payment), so later events about them route directly.
      if (partitions.length === 1 && gatewayId !== undefined) {
        const kind: TenantObjectKind | undefined = str(data.paymentGatewayId)
          ? 'dispute'
          : str(data.subscriptionId)
            ? 'payment'
            : undefined;
        if (kind !== undefined) await ledger.claim(partition, kind, gatewayId, provider);
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
