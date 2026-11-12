import type { BillingStore } from './billing_store.js';
import { type BillingOwnerScope, ownerInScope } from './owner_scope.js';

/** Thrown by a scoped read over a store that cannot apply the scope (no `ownerScoping`). */
export class OwnerScopingUnsupportedError extends Error {
  readonly status = 501;
  constructor() {
    super(
      '[payments] This billing store cannot scope reads by organization (it does not set ' +
        '`ownerScoping`). Use the built-in Lucid store, or implement `owners` on its reads.',
    );
  }
}

type AnyStore = BillingStore<unknown, unknown, unknown, unknown, unknown, unknown>;

/** `customerId` / `ownerType` / `ownerId` read structurally off any store's row. */
function field(row: unknown, key: string): string | null {
  if (row === null || typeof row !== 'object') return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A view of `store` whose reads only see the rows of the tenants in `scope` (the matching rule every
 * Agora lib applies): lists and aggregates are filtered in the store, lookups of a row outside the
 * scope answer `null` (not found). Writes and the webhook ledger pass through untouched.
 *
 * `undefined` scope returns `store` itself.
 */
export function scopedBillingStore<S extends AnyStore>(
  store: S,
  scope: BillingOwnerScope | undefined,
): S {
  if (scope === undefined) return store;
  const unsupported = store.ownerScoping !== true;
  const guard = () => {
    if (unsupported) throw new OwnerScopingUnsupportedError();
  };
  const customerVisible = async (customerId: string | null): Promise<boolean> => {
    if (customerId === null) return ownerInScope(scope, null);
    const customer = await store.findCustomerByGatewayId(customerId);
    return ownerInScope(scope, {
      ownerType: field(customer, 'ownerType'),
      ownerId: field(customer, 'ownerId'),
    });
  };
  const rowVisible = async <R>(row: R | null): Promise<R | null> =>
    row !== null && (await customerVisible(field(row, 'customerId'))) ? row : null;
  const disputeVisible = async (paymentGatewayId: string): Promise<boolean> => {
    const payment = await store.findPaymentByGatewayId(paymentGatewayId);
    return customerVisible(field(payment, 'customerId'));
  };

  const overrides: Partial<AnyStore> = {
    listCustomers: async (query) => {
      guard();
      return store.listCustomers({ ...query, owners: scope });
    },
    listPayments: async (query) => {
      guard();
      return store.listPayments({ ...query, owners: scope });
    },
    listSubscriptions: async (query) => {
      guard();
      return store.listSubscriptions({ ...query, owners: scope });
    },
    listDisputes: async (query) => {
      guard();
      return store.listDisputes({ ...query, owners: scope });
    },
    countPayments: async (query) => {
      guard();
      return store.countPayments({ ...query, owners: scope });
    },
    countSubscriptions: async (query) => {
      guard();
      return store.countSubscriptions({ ...query, owners: scope });
    },
    countDisputes: async (query) => {
      guard();
      return store.countDisputes({ ...query, owners: scope });
    },
    subscriptionAmountByCycle: async (query) => {
      guard();
      return store.subscriptionAmountByCycle({ ...query, owners: scope });
    },
    revenue: async (query) => {
      guard();
      return store.revenue({ ...query, owners: scope });
    },
    netRevenue: async (query) => {
      guard();
      return store.netRevenue({ ...query, owners: scope });
    },
    usageReport: async (query) => {
      guard();
      return store.usageReport({ ...query, owners: scope });
    },
    countActiveSubscriptions: async () => {
      guard();
      return store.countActiveSubscriptions({ owners: scope });
    },
    listCustomersByGatewayIds: async (ids) =>
      (await store.listCustomersByGatewayIds(ids)).filter((row) => ownerInScope(scope, row)),
    findCustomerByGatewayId: async (gatewayId) => {
      const row = await store.findCustomerByGatewayId(gatewayId);
      return row !== null &&
        ownerInScope(scope, { ownerType: field(row, 'ownerType'), ownerId: field(row, 'ownerId') })
        ? row
        : null;
    },
    findCustomerByOwner: async (type, id, provider) => {
      const row = await store.findCustomerByOwner(type, id, provider);
      return row !== null && ownerInScope(scope, { ownerType: type, ownerId: id }) ? row : null;
    },
    findPaymentByGatewayId: async (id) => rowVisible(await store.findPaymentByGatewayId(id)),
    findPaymentByExternalReference: async (reference) =>
      rowVisible(await store.findPaymentByExternalReference(reference)),
    findSubscriptionByGatewayId: async (id) =>
      rowVisible(await store.findSubscriptionByGatewayId(id)),
    findSubscriptionById: async (id) => rowVisible(await store.findSubscriptionById(id)),
    findDisputeByGatewayId: async (id) => {
      const row = await store.findDisputeByGatewayId(id);
      const payment = field(row, 'paymentGatewayId');
      return row !== null && payment !== null && (await disputeVisible(payment)) ? row : null;
    },
    findOpenDisputeByPayment: async (paymentGatewayId) =>
      (await disputeVisible(paymentGatewayId))
        ? store.findOpenDisputeByPayment(paymentGatewayId)
        : null,
    // The webhook ledger and the audit trail are not owned by any organization: a scoped view
    // sees none of them, except the audit rows of a payment it can see.
    listWebhookEvents: async () => [],
    countWebhookEvents: async () => 0,
    webhookEventBreakdown: async () => [],
    listAuditEvents: async (query) => {
      if (query.subjectType !== 'payment' || query.subjectId === undefined) return [];
      if ((await rowVisible(await store.findPaymentByGatewayId(query.subjectId))) === null) {
        return [];
      }
      return store.listAuditEvents(query);
    },
    countAuditEvents: async (query) => {
      if (query.subjectType !== 'payment' || query.subjectId === undefined) return 0;
      if ((await rowVisible(await store.findPaymentByGatewayId(query.subjectId))) === null) {
        return 0;
      }
      return store.countAuditEvents(query);
    },
    listWebhookEventsForPayment: async (paymentGatewayId, query) =>
      (await rowVisible(await store.findPaymentByGatewayId(paymentGatewayId))) === null
        ? []
        : store.listWebhookEventsForPayment(paymentGatewayId, query),
    listDisputesDueWithin: async (query) => {
      guard();
      return store.listDisputesDueWithin({ ...query, owners: scope });
    },
    listOpenDisputes: async (query) => {
      guard();
      return store.listOpenDisputes({ ...query, owners: scope });
    },
    countDisputesDueWithin: async (query) => {
      guard();
      return store.countDisputesDueWithin({ ...query, owners: scope });
    },
    countOpenDisputes: async (query) => {
      guard();
      return store.countOpenDisputes({ ...query, owners: scope });
    },
  };

  return new Proxy(store, {
    get(target, property, receiver) {
      if (typeof property === 'string' && Object.hasOwn(overrides, property)) {
        return (overrides as Record<string, unknown>)[property];
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
