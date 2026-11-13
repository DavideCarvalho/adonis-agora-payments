import {
  applyCustomFilter,
  BaseFilter,
  InvalidColumnFilterError,
  parsePageParams,
  resolveSort,
} from '@adonis-agora/filter';
import type {
  AuditEventCountQuery,
  CustomerCountQuery,
  DisputeCountQuery,
  PaymentCountQuery,
  SubscriptionCountQuery,
  WebhookEventCountQuery,
} from '../billing/billing_store.js';
import { BILLING_LIST_DEFAULT_SIZE, BILLING_LIST_MAX_SIZE } from '../billing/list_query.js';

/**
 * The console's list filters: one {@link BaseFilter} class per listing, one method per
 * `filter[field]`, each narrowing a {@link ListDraft} that ends as the store's list/count query.
 *
 * Every field is an EXACT match on one value. `filter[status]=failed` and
 * `filter[status][equals]=failed` are the same request; a list (`filter[status][]=a&…`,
 * `filter[status]=a,b`) or any other operator answers `400`, and so does a field the listing does
 * not have — a typo must fail loudly instead of silently widening the list.
 */

/** The query a filter class fills in. */
export class ListDraft<Q extends object> {
  readonly query: Partial<Q> = {};

  set<K extends keyof Q>(key: K, value: Q[K] | undefined): void {
    if (value !== undefined) this.query[key] = value;
  }
}

/** The single value of an exact-match filter, or `undefined` when it is blank. */
function exact(value: unknown, operator: string, field: string): string | undefined {
  if (operator !== 'equals' && operator !== 'in' && operator !== 'isAnyOf') {
    throw new InvalidColumnFilterError(`"${field}" does not support the "${operator}" operator.`);
  }
  const values = (Array.isArray(value) ? value : [value])
    .filter((v) => (typeof v === 'string' && v !== '') || typeof v === 'number')
    .map(String);
  if (values.length > 1) throw new InvalidColumnFilterError(`"${field}" takes one value.`);
  return values[0];
}

/** `filter[dueWithin]` with no value: the horizon `payments:health` alerts on. */
export const DISPUTE_DEFAULT_DUE_WITHIN_HOURS = 72;

export class PaymentFilter extends BaseFilter<ListDraft<PaymentCountQuery>> {
  declare $query: ListDraft<PaymentCountQuery>;
  status(value: unknown, operator: string, field: string) {
    this.$query.set('status', exact(value, operator, field));
  }
  provider(value: unknown, operator: string, field: string) {
    this.$query.set('provider', exact(value, operator, field));
  }
  /** The app's own reference for the charge (`ChargeInput.externalReference`). */
  externalReference(value: unknown, operator: string, field: string) {
    this.$query.set('externalReference', exact(value, operator, field));
  }
  gatewayId(value: unknown, operator: string, field: string) {
    this.$query.set('gatewayId', exact(value, operator, field));
  }
  customerId(value: unknown, operator: string, field: string) {
    this.$query.set('customerId', exact(value, operator, field));
  }
}

export class SubscriptionFilter extends BaseFilter<ListDraft<SubscriptionCountQuery>> {
  declare $query: ListDraft<SubscriptionCountQuery>;
  status(value: unknown, operator: string, field: string) {
    this.$query.set('status', exact(value, operator, field));
  }
  provider(value: unknown, operator: string, field: string) {
    this.$query.set('provider', exact(value, operator, field));
  }
  customerId(value: unknown, operator: string, field: string) {
    this.$query.set('customerId', exact(value, operator, field));
  }
}

/** What the disputes listing narrows: the store's filters plus the deadline horizon. */
export type DisputeDraftQuery = DisputeCountQuery & { dueWithin?: number };

export class DisputeFilter extends BaseFilter<ListDraft<DisputeDraftQuery>> {
  declare $query: ListDraft<DisputeDraftQuery>;
  status(value: unknown, operator: string, field: string) {
    this.$query.set('status', exact(value, operator, field));
  }
  provider(value: unknown, operator: string, field: string) {
    this.$query.set('provider', exact(value, operator, field));
  }
  /**
   * Only OPEN disputes whose evidence window closes within this many hours (already past
   * included), soonest first. Blank means {@link DISPUTE_DEFAULT_DUE_WITHIN_HOURS}.
   */
  dueWithin(value: unknown, operator: string, field: string) {
    const raw = exact(value, operator, field);
    const hours = raw === undefined ? DISPUTE_DEFAULT_DUE_WITHIN_HOURS : Number(raw);
    if (!Number.isInteger(hours) || hours < 0) {
      throw new InvalidColumnFilterError(
        'dueWithin must be a whole number of hours, not negative.',
      );
    }
    this.$query.set('dueWithin', hours);
  }
}

export class WebhookEventFilter extends BaseFilter<ListDraft<WebhookEventCountQuery>> {
  declare $query: ListDraft<WebhookEventCountQuery>;
  status(value: unknown, operator: string, field: string) {
    this.$query.set('status', exact(value, operator, field));
  }
  provider(value: unknown, operator: string, field: string) {
    this.$query.set('provider', exact(value, operator, field));
  }
  /** The normalized event type (`payment.refunded`, …). */
  type(value: unknown, operator: string, field: string) {
    this.$query.set('type', exact(value, operator, field));
  }
}

export class CustomerFilter extends BaseFilter<ListDraft<CustomerCountQuery>> {
  declare $query: ListDraft<CustomerCountQuery>;
  provider(value: unknown, operator: string, field: string) {
    this.$query.set('provider', exact(value, operator, field));
  }
  ownerType(value: unknown, operator: string, field: string) {
    this.$query.set('ownerType', exact(value, operator, field));
  }
  ownerId(value: unknown, operator: string, field: string) {
    this.$query.set('ownerId', exact(value, operator, field));
  }
  gatewayId(value: unknown, operator: string, field: string) {
    this.$query.set('gatewayId', exact(value, operator, field));
  }
}

export class AuditFilter extends BaseFilter<ListDraft<AuditEventCountQuery>> {
  declare $query: ListDraft<AuditEventCountQuery>;
  action(value: unknown, operator: string, field: string) {
    this.$query.set('action', exact(value, operator, field));
  }
  actor(value: unknown, operator: string, field: string) {
    this.$query.set('actor', exact(value, operator, field));
  }
  provider(value: unknown, operator: string, field: string) {
    this.$query.set('provider', exact(value, operator, field));
  }
  subjectType(value: unknown, operator: string, field: string) {
    this.$query.set('subjectType', exact(value, operator, field));
  }
  subjectId(value: unknown, operator: string, field: string) {
    this.$query.set('subjectId', exact(value, operator, field));
  }
}

/** Run `Filter` over a request's query string. Throws {@link InvalidColumnFilterError}. */
export async function readFilters<Q extends object>(
  query: Record<string, unknown>,
  Filter: new () => BaseFilter<ListDraft<Q>>,
): Promise<Partial<Q>> {
  const draft = new ListDraft<Q>();
  await applyCustomFilter(draft, Filter, { request: { qs: () => ({ ...query }) } });
  return draft.query;
}

/** `?page=` (1-based) and `?size=` (default 50, at most 200). */
export function readPage(query: Record<string, unknown>): { page: number; size: number } {
  return parsePageParams(query, {
    defaultSize: BILLING_LIST_DEFAULT_SIZE,
    maxSize: BILLING_LIST_MAX_SIZE,
  });
}

/**
 * Check `?sort=` against a listing's one order. Every listing here has a single order the store
 * applies (`-createdAt`, or `evidenceDueBy` for the dispute deadlines), so that order is the only
 * accepted `sort`; any other field or direction throws {@link InvalidColumnFilterError}.
 */
export function assertSort(raw: unknown, order: string): void {
  const field = order.startsWith('-') ? order.slice(1) : order;
  const direction = order.startsWith('-') ? 'desc' : 'asc';
  const sort = resolveSort(raw as string | string[] | undefined, { sortable: [field] });
  if (sort.some((item) => item.direction !== direction) || sort.length > 1) {
    throw new InvalidColumnFilterError(`This list is sorted by "${order}" only.`);
  }
}
