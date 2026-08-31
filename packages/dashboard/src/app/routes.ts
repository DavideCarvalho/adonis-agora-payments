/**
 * The console's URL scheme — a hash route, parsed and formatted in one place.
 *
 * `#/<screen>[/<payment id>][?status=…&customer=…]`, for example:
 *
 * - `#/subscriptions`                 — the subscriptions screen, its own default filter
 * - `#/webhooks?status=failed`        — the ledger, narrowed to what a health check counted
 * - `#/payments?customer=cus_9f2`     — every charge recorded for one gateway customer
 * - `#/payments/pay_8f2…`             — the payments screen with ONE payment's detail open
 *
 * A hash rather than a path, on purpose: the provider registers `GET <path>` as an EXACT route
 * (no SPA catch-all — the prefix is shared with the package's own webhook endpoints, see
 * `providers/dashboard_provider.ts`), so `<path>/payments` would be a 404 on reload. The
 * fragment never reaches the server, which also means it works at any mount path with no
 * `basename` to configure. `@adonis-agora/durable`'s console uses the same scheme for `#/run/<id>`.
 *
 * Anything unrecognised parses to the overview, never to an error — a stale bookmark should land
 * somewhere useful rather than on a blank page.
 */

export type Screen =
  | 'overview'
  | 'payments'
  | 'customers'
  | 'subscriptions'
  | 'disputes'
  | 'webhooks'
  | 'activity';

export const SCREENS: ReadonlyArray<{ value: Screen; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'payments', label: 'Payments' },
  { value: 'customers', label: 'Customers' },
  { value: 'subscriptions', label: 'Subscriptions' },
  { value: 'disputes', label: 'Disputes' },
  { value: 'webhooks', label: 'Webhook events' },
  { value: 'activity', label: 'Activity' },
];

const SCREEN_VALUES = new Set<string>(SCREENS.map((screen) => screen.value));

export function isScreen(value: string): value is Screen {
  return SCREEN_VALUES.has(value);
}

export interface Route {
  screen: Screen;
  /**
   * The filter a health check seeded — a status on the row screens, an ACTION on the activity
   * screen (whose rows have no status). Absent when the operator opened the screen by hand, so it
   * comes up on its own sensible default.
   */
  status?: string | undefined;
  /** The gateway customer id a "Payments" jump from the customers screen carries across. */
  customerId?: string | undefined;
  /** The payment open in the detail dialog — `#/payments/<gatewayId>`. Payments screen only. */
  paymentId?: string | undefined;
}

/** Parse `window.location.hash` (with or without the leading `#`) into a {@link Route}. */
export function parseRoute(hash: string): Route {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmed.startsWith('/')) return { screen: 'overview' };

  const queryAt = trimmed.indexOf('?');
  const path = queryAt === -1 ? trimmed : trimmed.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? '' : trimmed.slice(queryAt + 1));

  const [screen = '', id = ''] = path.slice(1).split('/', 2);
  if (!isScreen(screen)) return { screen: 'overview' };

  const route: Route = { screen };
  const status = query.get('status');
  if (status !== null && status !== '') route.status = status;
  const customer = query.get('customer');
  if (customer !== null && customer !== '') route.customerId = customer;
  if (screen === 'payments' && id !== '') route.paymentId = safeDecode(id);
  return route;
}

/** Format a {@link Route} as the hash to assign to `window.location.hash` (leading `#` included). */
export function formatRoute(route: Route): string {
  let hash = `#/${route.screen}`;
  if (route.screen === 'payments' && route.paymentId !== undefined && route.paymentId !== '') {
    hash += `/${encodeURIComponent(route.paymentId)}`;
  }
  const query = new URLSearchParams();
  if (route.status !== undefined && route.status !== '') query.set('status', route.status);
  if (route.customerId !== undefined && route.customerId !== '') {
    query.set('customer', route.customerId);
  }
  const qs = query.toString();
  return qs === '' ? hash : `${hash}?${qs}`;
}

/**
 * What makes two routes "the same screen showing the same seeded rows" — the React `key` a screen
 * is mounted under, so a NEW seed remounts it (a screen already showing `paid` must not keep
 * showing it when the operator was sent to `pending`) while opening a detail dialog on top of the
 * same list does not throw away its page and filters.
 */
export function screenKey(route: Route): string {
  return `${route.screen}:${route.status ?? ''}:${route.customerId ?? ''}`;
}

/** A hand-edited hash may carry a `%` that is not an escape; that is not worth a blank page. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
