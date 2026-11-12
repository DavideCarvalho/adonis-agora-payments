import {
  type ResolvedPaymentsTenancy,
  runInOwnerTenant,
  type TenantOwner,
  type TenantRef,
  tenantOwner,
} from '../agora/tenancy.js';
import type {
  BillingStore,
  CustomerListItem,
  PaymentListItem,
  SubscriptionListItem,
} from '../billing/billing_store.js';
import {
  cancelManagedSubscription,
  resumeManagedSubscription,
  updateManagedPaymentMethod,
} from '../billing/managed_subscriptions.js';
import type { PaymentsDriver } from '../driver.js';
import type { Invoice } from '../types.js';
import { issueCardTicket, unsealCardToken } from './card_ticket.js';
import type {
  AccountAction,
  AccountActionResult,
  AccountExtension,
  AccountExtensionContext,
  AccountPage,
  Block,
  Text,
  Value,
} from './contract.js';
import { ACCOUNT_MESSAGES, cardLabels } from './messages.js';

/** A plan the account console can move a subscription to. */
export interface AccountConsolePlan {
  /** Your plan id: what `planId` holds on the subscriptions of this plan. */
  id: string;
  /** What the user sees (a literal, or `{ key }` from your authkit messages). */
  label: Text;
  /** Price per cycle, integer minor units. */
  amount: number;
  currency: string;
  /** Billing cycle (`'MONTHLY'`, `'YEARLY'`…). Default: the subscription's own. */
  cycle?: string;
  /** Description of the next charges. */
  description?: string;
  /**
   * The gateway's own price/plan id per provider, for subscriptions the gateway owns
   * (`{ stripe: 'price_123' }`). Stripe moves to this price; other gateways re-price to `amount`.
   */
  prices?: Readonly<Record<string, string>>;
}

/** Who pays, as `billing_customers` records it. */
export interface PaymentOwner {
  type: string;
  id: string;
}

/** `config/payments.ts` → `accountConsole`: the billing pages in the authkit account console. */
export interface PaymentsAccountConsoleOptions {
  /**
   * Who pays for this account. Default: the active organization (with tenancy on), else the app
   * user authkit maps the account to (`userOwnerType` and the subject's id).
   */
  owner?: (ctx: AccountExtensionContext) => PaymentOwner | null | Promise<PaymentOwner | null>;
  /**
   * Organization roles that see and manage the organization's billing. Default
   * `['owner', 'admin']`. Other members see a notice instead.
   */
  organizationRoles?: readonly string[];
  /** Turn single pages off. Both on by default. */
  pages?: { billing?: boolean; invoices?: boolean };
  /** Turn single actions off. All on by default. */
  actions?: {
    cancel?: boolean;
    resume?: boolean;
    changePlan?: boolean;
    updateMethod?: boolean;
    download?: boolean;
  };
  /** The plans users can switch between. "Change plan" shows only when there are two or more. */
  plans?: readonly AccountConsolePlan[];
  /**
   * Change the plan yourself (proration, entitlements…) instead of the built-in re-pricing.
   */
  changePlan?: (input: {
    subscription: SubscriptionListItem;
    plan: AccountConsolePlan;
    owner: PaymentOwner;
  }) => Promise<void>;
  /**
   * A download link for a payment's receipt or fiscal invoice (NFS-e): an https URL, or `null` for
   * none. Payments with a link get a "Download" button.
   */
  invoiceUrl?: (payment: PaymentListItem) => string | null | Promise<string | null>;
  /** Where the card form's script and endpoint are mounted. Default `/payments/account`. */
  path?: string;
  /**
   * This app's public https URL, when the pages are shown by an authkit IdP in another app
   * (authkit-client `accountConsole.remote`): the card form's script and endpoint are loaded from
   * there.
   */
  publicUrl?: string;
  /** Where gateway-hosted card pages send the user back to (an https URL). */
  returnUrl?: string;
}

/** The slice of `PaymentsManager` the pages use. */
export interface AccountPaymentsManager {
  readonly drivers: ReadonlyMap<string, PaymentsDriver>;
  tenancy(): ResolvedPaymentsTenancy;
  assertGatewaySubscriptionOperation(
    driver: PaymentsDriver,
    operation: 'create' | 'update' | 'cancel',
  ): void;
}

/** What the payments pages read and act through. */
export interface PaymentsAccountDeps {
  manager: () => Promise<AccountPaymentsManager>;
  /** The billing store, once the billing layer is built (`undefined` with billing off). */
  store: () => BillingStore | undefined;
  options?: PaymentsAccountConsoleOptions;
  /** `config.userOwnerType`, when set. */
  userOwnerType?: string;
  /** Signs the card form's tickets (the app key). */
  secret: string;
  now?: () => number;
}

/** Statuses of a subscription that is still running. */
const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
const PAGE_SIZE = 20;
const DEFAULT_ORG_ROLES = ['owner', 'admin'];
/** The browser SDK origins the card form may load (Stripe, Mercado Pago, Square, PayPal). */
export const CARD_SCRIPT_ORIGINS = [
  'https://js.stripe.com',
  'https://sdk.mercadopago.com',
  'https://web.squarecdn.com',
  'https://sandbox.web.squarecdn.com',
  'https://www.paypal.com',
] as const;
/** The `component` provider name of the card form. */
export const CARD_COMPONENT = 'payments-card';
/** How long a card form ticket lasts. */
const TICKET_TTL_MS = 15 * 60_000;

/** Mount path of the card form's script and endpoint (no trailing slash). */
export function accountPath(options: PaymentsAccountConsoleOptions | undefined): string {
  const path = (options?.path ?? '/payments/account').replace(/\/+$/, '');
  return path.startsWith('/') ? path : `/${path}`;
}

/** Audit actions recorded for what users do in the account console. */
export const ACCOUNT_AUDIT_ACTIONS = {
  canceled: 'account.subscription_canceled',
  resumed: 'account.subscription_resumed',
  planChanged: 'account.subscription_plan_changed',
  cardUpdated: 'account.card_updated',
} as const;

const fail = (key: string, status?: 400 | 403 | 404 | 409): AccountActionResult => ({
  ok: false,
  error: { key },
  ...(status !== undefined ? { status } : {}),
});

const statusBadge = (
  status: string,
  tone?: 'neutral' | 'success' | 'warning' | 'danger',
): Value => ({
  type: 'badge',
  text:
    ACCOUNT_MESSAGES.en![`payments.status.${status}`] !== undefined
      ? { key: `payments.status.${status}` }
      : status,
  tone: tone ?? toneOf(status),
});

function toneOf(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active' || status === 'paid' || status === 'issued') return 'success';
  if (status === 'trialing' || status === 'pending' || status === 'open') return 'neutral';
  if (status === 'past_due' || status === 'incomplete' || status === 'refunded') return 'warning';
  if (status === 'canceled' || status === 'void') return 'neutral';
  return 'danger';
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const toJSDate = (value as { toJSDate?: () => Date }).toJSDate;
  if (typeof toJSDate === 'function') return toJSDate.call(value);
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(at: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

function pageOf(cursor: string | undefined): number {
  const page = Number(cursor);
  return Number.isInteger(page) && page > 1 && page < 10_000 ? page : 1;
}

function isHttps(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The `{ t, ip }` the tokenize endpoint sealed. */
function openSealed(value: string | null, now: number): { t: string; ip?: string } | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as { t?: unknown; ip?: unknown; e?: unknown };
    if (typeof parsed.t !== 'string' || parsed.t === '') return null;
    // Only as long as the ticket it was sealed under.
    if (typeof parsed.e !== 'number' || parsed.e < now) return null;
    return { t: parsed.t, ...(typeof parsed.ip === 'string' ? { ip: parsed.ip } : {}) };
  } catch {
    return null;
  }
}

/** `<a>~<b>`: the two halves of a composite target. */
function splitTarget(target: string | null): [string, string] | null {
  if (target === null) return null;
  const at = target.indexOf('~');
  if (at <= 0 || at === target.length - 1) return null;
  return [target.slice(0, at), target.slice(at + 1)];
}

/**
 * The payments contribution to the authkit account console: billing (`/account/billing`), payment
 * method (`/account/payment-method`) and payments and invoices (`/account/invoices`), each for the
 * signed-in account's own customer only.
 */
export function paymentsAccountExtension(deps: PaymentsAccountDeps): AccountExtension {
  const options = deps.options ?? {};
  const pageOn = (page: 'billing' | 'invoices') => options.pages?.[page] !== false;
  const actionOn = (action: keyof NonNullable<PaymentsAccountConsoleOptions['actions']>) =>
    options.actions?.[action] !== false;
  const orgRoles = options.organizationRoles ?? DEFAULT_ORG_ROLES;
  const plans = options.plans ?? [];
  const publicUrl = options.publicUrl?.replace(/\/+$/, '');
  const absolute = (path: string) => (publicUrl ? `${publicUrl}${path}` : path);
  const base = accountPath(options);
  const now = deps.now ?? Date.now;

  /** The tenant of the request (the active organization), when payments honours its kind. */
  const tenantOf = (ctx: AccountExtensionContext, tenancy: ResolvedPaymentsTenancy) => {
    if (!tenancy.enabled) return null;
    const tenant: TenantRef | null = ctx.tenant
      ? {
          id: ctx.tenant.id,
          kind: ctx.tenant.kind,
          source: ctx.tenant.source,
          ...(ctx.tenant.slug !== undefined ? { slug: ctx.tenant.slug } : {}),
          ...(ctx.tenant.role !== undefined ? { role: ctx.tenant.role } : {}),
        }
      : ctx.activeOrg
        ? {
            id: ctx.activeOrg.id,
            kind: 'organization',
            source: 'authkit',
            slug: ctx.activeOrg.slug,
            role: ctx.activeOrg.role,
          }
        : null;
    if (tenant === null) return null;
    if (tenancy.kinds !== undefined && !tenancy.kinds.includes(tenant.kind)) return null;
    return tenant;
  };

  /**
   * Who pays for this account and whether the viewer may manage it. `owner: null` means nothing
   * to show; `allowed: false` means an organization member without a billing role.
   */
  const resolveOwner = async (
    ctx: AccountExtensionContext,
  ): Promise<{ owner: TenantOwner | null; allowed: boolean; tenancy: ResolvedPaymentsTenancy }> => {
    const manager = await deps.manager();
    const tenancy = manager.tenancy();
    if (options.owner) {
      const owner = await options.owner(ctx);
      return { owner: owner ?? null, allowed: true, tenancy };
    }
    const tenant = tenantOf(ctx, tenancy);
    if (tenant !== null) {
      const role = tenant.role ?? ctx.activeOrg?.role ?? '';
      return { owner: tenantOwner(tenancy, tenant), allowed: orgRoles.includes(role), tenancy };
    }
    const id = ctx.subject?.id ?? ctx.account.id;
    const type = deps.userOwnerType ?? ctx.subject?.type ?? 'User';
    return { owner: { type, id }, allowed: true, tenancy };
  };

  /** The owner's customers, at every configured gateway. */
  const customersOf = async (owner: TenantOwner): Promise<CustomerListItem[]> => {
    const store = deps.store();
    if (store === undefined) return [];
    return store.listCustomers({ ownerType: owner.type, ownerId: owner.id, size: 50 });
  };

  /** Memoized per request: one lookup serves `visible()` and `load()`. */
  const scopes = new WeakMap<
    AccountExtensionContext,
    Promise<{
      owner: TenantOwner | null;
      allowed: boolean;
      tenancy: ResolvedPaymentsTenancy;
      customers: CustomerListItem[];
    }>
  >();
  const scopeOf = (ctx: AccountExtensionContext) => {
    let scope = scopes.get(ctx);
    if (scope === undefined) {
      scope = (async () => {
        const resolved = await resolveOwner(ctx);
        const customers =
          resolved.owner !== null && resolved.allowed ? await customersOf(resolved.owner) : [];
        return { ...resolved, customers };
      })();
      scopes.set(ctx, scope);
    }
    return scope;
  };

  /** Shown when the account (or its organization) has a customer, or to a member without access. */
  const visible = async (ctx: AccountExtensionContext) => {
    if (deps.store() === undefined) return false;
    const scope = await scopeOf(ctx);
    if (scope.owner === null) return false;
    return !scope.allowed || scope.customers.length > 0;
  };

  const driverOf = async (provider: string): Promise<PaymentsDriver | undefined> => {
    const manager = await deps.manager();
    const named = manager.drivers.get(provider);
    if (named !== undefined) return named;
    for (const driver of manager.drivers.values()) if (driver.provider === provider) return driver;
    return undefined;
  };

  const gatewayCan = async (
    driver: PaymentsDriver | undefined,
    operation: 'update' | 'cancel',
  ): Promise<boolean> => {
    if (driver === undefined) return false;
    try {
      (await deps.manager()).assertGatewaySubscriptionOperation(driver, operation);
      return true;
    } catch {
      return false;
    }
  };

  /** Subscriptions of the owner's customers, newest first. */
  const subscriptionsOf = async (customers: readonly CustomerListItem[]) => {
    const store = deps.store();
    if (store === undefined) return [];
    const rows: SubscriptionListItem[] = [];
    for (const customer of customers) {
      rows.push(...(await store.listSubscriptions({ customerId: customer.gatewayId, size: 50 })));
    }
    return rows;
  };

  /** The owner's subscription with this id, or `null` (another account's id reads as missing). */
  const ownedSubscription = async (ctx: AccountExtensionContext, id: string | null) => {
    if (id === null) return null;
    const scope = await scopeOf(ctx);
    if (!scope.allowed) return null;
    const subscriptions = await subscriptionsOf(scope.customers);
    const row = subscriptions.find((s) => s.id === id) ?? null;
    return row === null ? null : { row, scope };
  };

  const ownedCustomer = async (ctx: AccountExtensionContext, id: string | null) => {
    if (id === null) return null;
    const scope = await scopeOf(ctx);
    if (!scope.allowed) return null;
    const customer = scope.customers.find((c) => c.id === id) ?? null;
    return customer === null ? null : { customer, scope };
  };

  const planOf = (row: SubscriptionListItem) =>
    plans.find(
      (plan) =>
        plan.id === row.planId ||
        (plan.prices !== undefined && Object.values(plan.prices).includes(row.planId)),
    );

  const audit = async (
    ctx: AccountExtensionContext,
    event: {
      action: string;
      provider: string;
      subjectType: string;
      subjectId: string | null;
      amount?: number | null;
      currency?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) => {
    await deps
      .store()
      ?.recordAuditEvent({ ...event, actor: `account:${ctx.account.id}` })
      .catch(() => null);
  };

  /** Runs a write inside the owner's tenant, so app handlers it triggers see the right one. */
  const inOwnerTenant = <T>(
    scope: { tenancy: ResolvedPaymentsTenancy; owner: TenantOwner | null },
    fn: () => Promise<T>,
  ) => runInOwnerTenant(scope.tenancy, scope.owner, fn);

  /** What a gateway error reads as: one translated sentence, never the gateway's text. */
  const guard = async (fn: () => Promise<AccountActionResult>): Promise<AccountActionResult> => {
    try {
      return await fn();
    } catch {
      return fail('payments.action.failed', 409);
    }
  };

  /** How this customer's card can be changed: in place, on the gateway's page, or not at all. */
  const cardModeOf = async (customer: CustomerListItem) => {
    const driver = await driverOf(customer.provider);
    if (driver === undefined) return { driver, mode: 'none' as const };
    if (typeof driver.cardSetup === 'function' && typeof driver.saveCard === 'function') {
      // Only when the gateway can move every running subscription of this customer: the user
      // must never type a card that `saveCard` is bound to refuse.
      const can = driver.capabilities?.cardUpdate;
      const live = (await subscriptionsOf([customer])).filter(
        (s) => LIVE.has(s.status) && !s.cancelAtPeriodEnd,
      );
      const fits = live.every((s) => (s.managed ? can?.managed !== false : can?.gateway !== false));
      const needsGateway = can?.managed === false && !live.some((s) => !s.managed);
      if (fits && !needsGateway) return { driver, mode: 'component' as const };
    }
    if (typeof driver.cardUpdateUrl === 'function') return { driver, mode: 'redirect' as const };
    return { driver, mode: 'none' as const };
  };

  const returnUrl = (ctx: AccountExtensionContext): string | undefined => {
    if (isHttps(options.returnUrl)) return options.returnUrl;
    const appUrl = process.env.APP_URL;
    if (!isHttps(appUrl)) return undefined;
    try {
      return new URL(ctx.url('payments.subscription'), appUrl).toString();
    } catch {
      return undefined;
    }
  };

  /** Sends the user to the gateway's own card page. */
  const toGatewayPage = async (
    ctx: AccountExtensionContext,
    customer: CustomerListItem,
    driver: PaymentsDriver,
  ): Promise<AccountActionResult> => {
    if (typeof driver.cardUpdateUrl !== 'function') return fail('payments.action.not_allowed', 409);
    const subscription = (await subscriptionsOf([customer])).find(
      (s) => LIVE.has(s.status) && s.gatewayId !== null,
    );
    return guard(async () => {
      const back = returnUrl(ctx);
      const url = await driver.cardUpdateUrl!({
        customerId: customer.gatewayId,
        ...(subscription?.gatewayId ? { subscriptionGatewayId: subscription.gatewayId } : {}),
        ...(back !== undefined ? { returnUrl: back } : {}),
      });
      if (!isHttps(url)) return fail('payments.action.failed', 409);
      return { ok: true, redirectTo: { external: url } };
    });
  };

  const pages: AccountPage[] = [];

  // ── Billing ────────────────────────────────────────────────────────────────────────────────

  const billingActions: Record<string, AccountAction> = {};

  if (actionOn('cancel')) {
    billingActions.cancel = {
      label: { key: 'payments.action.cancel' },
      tone: 'danger',
      confirm: { key: 'payments.action.cancel_confirm' },
      sudo: true,
      async handle(ctx, input) {
        const found = await ownedSubscription(ctx, input.target);
        if (found === null) return fail('payments.action.not_found', 404);
        const { row, scope } = found;
        if (!LIVE.has(row.status) || row.cancelAtPeriodEnd) {
          return fail('payments.action.not_allowed', 409);
        }
        const store = deps.store();
        if (store === undefined) return fail('payments.action.not_allowed', 409);
        return guard(() =>
          inOwnerTenant(scope, async () => {
            if (row.managed) {
              await cancelManagedSubscription(store, row.id, { atPeriodEnd: true });
            } else {
              const driver = await driverOf(row.provider);
              if (row.gatewayId === null || !(await gatewayCan(driver, 'cancel'))) {
                return fail('payments.action.not_allowed', 409);
              }
              await driver!.cancelSubscription(row.gatewayId, { atPeriodEnd: true });
            }
            await audit(ctx, {
              action: ACCOUNT_AUDIT_ACTIONS.canceled,
              provider: row.provider,
              subjectType: 'subscription',
              subjectId: row.gatewayId ?? row.id,
            });
            return { ok: true, flash: { key: 'payments.action.canceled' } };
          }),
        );
      },
    };
  }

  if (actionOn('resume')) {
    billingActions.resume = {
      label: { key: 'payments.action.resume' },
      confirm: { key: 'payments.action.resume_confirm' },
      sudo: true,
      async handle(ctx, input) {
        const found = await ownedSubscription(ctx, input.target);
        if (found === null) return fail('payments.action.not_found', 404);
        const { row, scope } = found;
        const store = deps.store();
        if (!row.managed || !row.cancelAtPeriodEnd || row.status !== 'active' || !store) {
          return fail('payments.action.not_allowed', 409);
        }
        return guard(() =>
          inOwnerTenant(scope, async () => {
            await resumeManagedSubscription(store, row.id);
            await audit(ctx, {
              action: ACCOUNT_AUDIT_ACTIONS.resumed,
              provider: row.provider,
              subjectType: 'subscription',
              subjectId: row.id,
            });
            return { ok: true, flash: { key: 'payments.action.resumed' } };
          }),
        );
      },
    };
  }

  if (actionOn('changePlan') && plans.length >= 2) {
    billingActions.changePlan = {
      label: { key: 'payments.action.change_plan' },
      confirm: { key: 'payments.action.change_plan_confirm' },
      sudo: true,
      fields: [
        {
          name: 'plan',
          label: { key: 'payments.action.plan' },
          kind: 'select',
          required: true,
          options: plans.map((plan) => ({ value: plan.id, label: plan.label })),
        },
      ],
      async handle(ctx, input) {
        const found = await ownedSubscription(ctx, input.target);
        if (found === null) return fail('payments.action.not_found', 404);
        const { row, scope } = found;
        const plan = plans.find((p) => p.id === input.fields.plan);
        if (plan === undefined) return fail('payments.action.unknown_plan', 400);
        if (planOf(row)?.id === plan.id) return fail('payments.action.same_plan', 409);
        if (row.currency !== null && row.currency.toLowerCase() !== plan.currency.toLowerCase()) {
          return fail('payments.action.unknown_plan', 400);
        }
        if (!LIVE.has(row.status) || row.cancelAtPeriodEnd) {
          return fail('payments.action.not_allowed', 409);
        }
        const store = deps.store();
        if (store === undefined || scope.owner === null) {
          return fail('payments.action.not_allowed', 409);
        }
        const owner = scope.owner;
        return guard(() =>
          inOwnerTenant(scope, async () => {
            if (options.changePlan) {
              await options.changePlan({ subscription: row, plan, owner });
            } else if (row.managed) {
              await store.updateManagedSubscription(row.id, {
                amount: plan.amount,
                planId: plan.id,
                ...(plan.cycle !== undefined ? { cycle: plan.cycle } : {}),
                ...(plan.description !== undefined ? { description: plan.description } : {}),
              });
            } else {
              const driver = await driverOf(row.provider);
              const price = plan.prices?.[row.provider];
              if (
                row.gatewayId === null ||
                !(await gatewayCan(driver, 'update')) ||
                (driver!.provider === 'stripe' && price === undefined)
              ) {
                return fail('payments.action.not_allowed', 409);
              }
              await driver!.updateSubscription(row.gatewayId, {
                amount: plan.amount,
                ...(price !== undefined ? { planId: price } : {}),
                ...(plan.description !== undefined ? { description: plan.description } : {}),
              });
            }
            await audit(ctx, {
              action: ACCOUNT_AUDIT_ACTIONS.planChanged,
              provider: row.provider,
              subjectType: 'subscription',
              subjectId: row.gatewayId ?? row.id,
              amount: plan.amount,
              currency: plan.currency,
              metadata: { from: row.planId, to: plan.id },
            });
            return { ok: true, flash: { key: 'payments.action.plan_changed' } };
          }),
        );
      },
    };
  }

  if (actionOn('updateMethod')) {
    billingActions.updateMethod = {
      label: { key: 'payments.action.update_method' },
      sudo: true,
      async handle(ctx, input) {
        const found = await ownedCustomer(ctx, input.target);
        if (found === null) return fail('payments.action.not_found', 404);
        const { driver, mode } = await cardModeOf(found.customer);
        if (mode === 'component') return { ok: true, redirectTo: { page: 'payments.card' } };
        if (mode !== 'redirect' || driver === undefined) {
          return fail('payments.action.not_allowed', 409);
        }
        return toGatewayPage(ctx, found.customer, driver);
      },
    };
  }

  if (pageOn('billing')) {
    pages.push({
      id: 'payments.subscription',
      segment: 'billing',
      title: { key: 'payments.billing.title' },
      nav: { label: { key: 'payments.billing.nav' }, group: 'billing', order: 100 },
      visible,
      async load(ctx) {
        const scope = await scopeOf(ctx);
        if (!scope.allowed) {
          return {
            blocks: [{ kind: 'notice', tone: 'info', text: { key: 'payments.billing.org_only' } }],
          };
        }
        const blocks: Block[] = [];
        const subscriptions = (await subscriptionsOf(scope.customers)).filter((s) =>
          LIVE.has(s.status),
        );
        if (subscriptions.length === 0) {
          blocks.push({ kind: 'notice', tone: 'info', text: { key: 'payments.billing.none' } });
        }
        const cardTargets = new Map<string, string>();
        for (const customer of scope.customers) {
          if ((await cardModeOf(customer)).mode !== 'none') {
            cardTargets.set(customer.gatewayId, customer.id);
          }
        }
        for (const row of subscriptions) {
          const driver = row.managed ? undefined : await driverOf(row.provider);
          const plan = planOf(row);
          const end = asDate(row.currentPeriodEnd ?? row.nextChargeAt ?? row.endsAt);
          if (row.cancelAtPeriodEnd && end !== null) {
            blocks.push({
              kind: 'notice',
              tone: 'warning',
              text: {
                key: 'payments.billing.cancel_scheduled',
                params: { date: formatDate(end, ctx.locale) },
              },
            });
          }
          if (row.renewalFailureCount > 0 || row.status === 'past_due' || row.status === 'unpaid') {
            blocks.push({
              kind: 'notice',
              tone: 'danger',
              text: { key: 'payments.billing.renewal_failed' },
            });
          }
          const rows: Array<{ label: Text; value: Value }> = [
            {
              label: { key: 'payments.billing.plan' },
              value: { type: 'text', text: plan?.label ?? row.planId },
            },
          ];
          const amount = row.amount ?? (plan !== undefined ? plan.amount : null);
          const currency = row.currency ?? plan?.currency ?? null;
          if (amount !== null && currency !== null) {
            rows.push({
              label: { key: 'payments.billing.amount' },
              value: { type: 'money', amount, currency: currency.toUpperCase() },
            });
          }
          rows.push({
            label: { key: 'payments.billing.status' },
            value: row.cancelAtPeriodEnd
              ? statusBadge('cancels', 'warning')
              : statusBadge(row.status),
          });
          const trialEnds = asDate(row.trialEndsAt);
          if (row.status === 'trialing' && trialEnds !== null) {
            rows.push({
              label: { key: 'payments.billing.trial_ends' },
              value: { type: 'date', at: trialEnds, style: 'date' },
            });
          }
          if (end !== null) {
            rows.push({
              label: {
                key: row.cancelAtPeriodEnd ? 'payments.billing.ends' : 'payments.billing.renews',
              },
              value: { type: 'date', at: end, style: 'date' },
            });
          }
          const actions: Array<{ action: string; target?: string }> = [];
          const cancellable =
            row.managed || (row.gatewayId !== null && (await gatewayCan(driver, 'cancel')));
          if (billingActions.cancel && !row.cancelAtPeriodEnd && cancellable) {
            actions.push({ action: 'cancel', target: row.id });
          }
          if (
            billingActions.resume &&
            row.managed &&
            row.cancelAtPeriodEnd &&
            row.status === 'active'
          ) {
            actions.push({ action: 'resume', target: row.id });
          }
          const repriceable =
            options.changePlan !== undefined ||
            row.managed ||
            (row.gatewayId !== null &&
              (await gatewayCan(driver, 'update')) &&
              (driver?.provider !== 'stripe' ||
                plans.some((p) => p.prices?.[row.provider] !== undefined)));
          if (billingActions.changePlan && !row.cancelAtPeriodEnd && repriceable) {
            actions.push({ action: 'changePlan', target: row.id });
          }
          const cardTarget = row.customerId !== null ? cardTargets.get(row.customerId) : undefined;
          if (billingActions.updateMethod && cardTarget !== undefined) {
            actions.push({ action: 'updateMethod', target: cardTarget });
          }
          blocks.push({
            kind: 'keyValue',
            title: { key: 'payments.billing.subscription' },
            rows,
            ...(actions.length > 0 ? { actions } : {}),
          });
        }
        if (pageOn('invoices')) {
          blocks.push({
            kind: 'link',
            label: { key: 'payments.billing.invoices_link' },
            href: ctx.url('payments.invoices'),
          });
        }
        return { blocks };
      },
      actions: billingActions,
    });

    // ── Payment method (in place) ──────────────────────────────────────────────────────────

    if (actionOn('updateMethod')) {
      pages.push({
        id: 'payments.card',
        segment: 'payment-method',
        title: { key: 'payments.card.title' },
        nav: false,
        async visible(ctx) {
          if (!(await visible(ctx))) return false;
          const scope = await scopeOf(ctx);
          if (!scope.allowed) return true;
          for (const customer of scope.customers) {
            if ((await cardModeOf(customer)).mode === 'component') return true;
          }
          return false;
        },
        async load(ctx) {
          const scope = await scopeOf(ctx);
          if (!scope.allowed) {
            return {
              blocks: [
                { kind: 'notice', tone: 'info', text: { key: 'payments.billing.org_only' } },
              ],
            };
          }
          const candidates: CustomerListItem[] = [];
          for (const customer of scope.customers) {
            if ((await cardModeOf(customer)).mode === 'component') candidates.push(customer);
          }
          const back = {
            kind: 'link' as const,
            label: { key: 'payments.card.back' },
            href: ctx.url('payments.subscription'),
          };
          const customer = candidates.find((c) => c.id === ctx.query.tab) ?? candidates[0];
          if (customer === undefined) {
            return {
              blocks: [
                { kind: 'notice', tone: 'info', text: { key: 'payments.card.unavailable' } },
                back,
              ],
            };
          }
          const tabs =
            candidates.length > 1
              ? candidates.map((c) => ({ id: c.id, label: c.provider }))
              : undefined;
          const { driver } = await cardModeOf(customer);
          const live = (await subscriptionsOf([customer])).filter(
            (s) => LIVE.has(s.status) && !s.cancelAtPeriodEnd,
          );
          const blocks: Block[] = [
            { kind: 'notice', tone: 'info', text: { key: 'payments.card.intro' } },
          ];
          if (live.length > 0) {
            blocks.push({
              kind: 'notice',
              tone: 'info',
              text: {
                key: 'payments.card.subscriptions',
                params: {
                  plans: live
                    .map((s) => {
                      const label = planOf(s)?.label ?? s.planId;
                      return typeof label === 'string' ? label : s.planId;
                    })
                    .join(', '),
                },
              },
            });
          }
          let session: Awaited<ReturnType<NonNullable<PaymentsDriver['cardSetup']>>>;
          try {
            const back = returnUrl(ctx);
            session = await driver!.cardSetup!({
              customerId: customer.gatewayId,
              ...(back !== undefined ? { returnUrl: back } : {}),
              subscriptionGatewayIds: live
                .filter((s) => !s.managed && s.gatewayId !== null)
                .map((s) => s.gatewayId as string),
            });
          } catch {
            // The component cannot be set up (a publishable key missing…): the gateway's own page,
            // when it has one.
            const portal: Block[] =
              typeof driver!.cardUpdateUrl === 'function'
                ? [{ kind: 'actions', items: [{ action: 'portal', target: customer.id }] }]
                : [{ kind: 'notice', tone: 'warning', text: { key: 'payments.card.unavailable' } }];
            return { blocks: [...portal, back], ...(tabs ? { tabs } : {}) };
          }
          const gateway = driver!.provider;
          const props: Record<string, unknown> = {
            ...session.props,
            gateway,
            target: customer.id,
            labels: cardLabels(ctx.locale),
          };
          if (gateway === 'asaas') {
            props.tokenizeUrl = absolute(`${base}/card/tokenize`);
            props.sameOrigin = publicUrl === undefined;
            props.ticket = issueCardTicket(deps.secret, {
              customerId: customer.gatewayId,
              provider: customer.provider,
              expiresAt: now() + TICKET_TTL_MS,
            });
            props.holder = { name: ctx.account.name ?? '', email: ctx.account.email ?? '' };
          }
          blocks.push({
            kind: 'component',
            provider: CARD_COMPONENT,
            scripts: [...session.scripts, { src: absolute(`${base}/card.js`) }],
            props,
            submit: { action: 'saveCard', target: customer.id },
            fallback: {
              label: { key: 'payments.card.back' },
              href: ctx.url('payments.subscription'),
            },
          });
          blocks.push(back);
          return { blocks, ...(tabs ? { tabs } : {}) };
        },
        actions: {
          portal: {
            label: { key: 'payments.card.portal' },
            sudo: true,
            async handle(ctx, input) {
              const found = await ownedCustomer(ctx, input.target);
              if (found === null) return fail('payments.action.not_found', 404);
              const driver = await driverOf(found.customer.provider);
              if (driver === undefined) return fail('payments.action.not_allowed', 409);
              return toGatewayPage(ctx, found.customer, driver);
            },
          },
          saveCard: {
            label: { key: 'payments.card.save' },
            sudo: true,
            async handle(ctx, input) {
              const parts = splitTarget(input.target);
              if (parts === null) return fail('payments.action.not_found', 404);
              const found = await ownedCustomer(ctx, parts[0]);
              if (found === null) return fail('payments.action.not_found', 404);
              const { customer, scope } = found;
              const { driver, mode } = await cardModeOf(customer);
              if (mode !== 'component' || driver === undefined) {
                return fail('payments.action.not_allowed', 409);
              }
              let token = parts[1];
              let remoteIp: string | undefined;
              if (driver.provider === 'asaas') {
                // Sealed by the tokenize endpoint, with the IP the card was typed from.
                const opened = openSealed(
                  unsealCardToken(deps.secret, token, customer.gatewayId),
                  now(),
                );
                if (opened === null) return fail('payments.card.failed', 400);
                token = opened.t;
                remoteIp = opened.ip;
              }
              const store = deps.store();
              const live = (await subscriptionsOf([customer])).filter(
                (s) => LIVE.has(s.status) && !s.cancelAtPeriodEnd,
              );
              return guard(() =>
                inOwnerTenant(scope, async () => {
                  const saved = await driver.saveCard!({
                    customerId: customer.gatewayId,
                    token,
                    ...(remoteIp !== undefined ? { remoteIp } : {}),
                    subscriptionGatewayIds: live
                      .filter((s) => !s.managed && s.gatewayId !== null)
                      .map((s) => s.gatewayId as string),
                  });
                  if (store !== undefined) {
                    for (const row of live.filter((s) => s.managed && s.status === 'active')) {
                      await updateManagedPaymentMethod(store, row.id, saved.paymentMethodId);
                    }
                  }
                  await audit(ctx, {
                    action: ACCOUNT_AUDIT_ACTIONS.cardUpdated,
                    provider: customer.provider,
                    subjectType: 'customer',
                    subjectId: customer.gatewayId,
                    metadata: {
                      ...(saved.brand !== undefined ? { brand: saved.brand } : {}),
                      ...(saved.last4 !== undefined ? { last4: saved.last4 } : {}),
                    },
                  });
                  return {
                    ok: true,
                    flash: { key: 'payments.card.saved' },
                    redirectTo: { page: 'payments.subscription' },
                  };
                }),
              );
            },
          },
        },
      });
    }
  }

  // ── Payments and invoices ──────────────────────────────────────────────────────────────────

  if (pageOn('invoices')) {
    const invoiceActions: Record<string, AccountAction> = {};
    if (actionOn('download')) {
      invoiceActions.download = {
        label: { key: 'payments.action.download' },
        async handle(ctx, input) {
          const parts = splitTarget(input.target);
          if (parts === null) return fail('payments.action.not_found', 404);
          const [kind, rest] = parts;
          const scope = await scopeOf(ctx);
          if (!scope.allowed) return fail('payments.action.not_found', 404);
          if (kind === 'payment') {
            if (!options.invoiceUrl || deps.store() === undefined) {
              return fail('payments.action.not_found', 404);
            }
            const owned = new Set(scope.customers.map((c) => c.gatewayId));
            let payment: PaymentListItem | undefined;
            for (const customer of scope.customers) {
              const [row] = await deps
                .store()!
                .listPayments({ customerId: customer.gatewayId, gatewayId: rest, size: 1 });
              if (row !== undefined && row.customerId !== null && owned.has(row.customerId)) {
                payment = row;
                break;
              }
            }
            if (payment === undefined) return fail('payments.action.not_found', 404);
            const url = await options.invoiceUrl(payment);
            if (!isHttps(url)) return fail('payments.action.not_found', 404);
            return { ok: true, redirectTo: { external: url } };
          }
          const split = splitTarget(rest);
          if (kind !== 'invoice' || split === null) return fail('payments.action.not_found', 404);
          const [customerRowId, invoiceId] = split;
          const customer = scope.customers.find((c) => c.id === customerRowId);
          const driver = customer ? await driverOf(customer.provider) : undefined;
          if (customer === undefined || driver === undefined) {
            return fail('payments.action.not_found', 404);
          }
          return guard(async () => {
            const invoice = (await driver.listInvoices(customer.gatewayId)).find(
              (i) => i.id === invoiceId || i.gatewayId === invoiceId,
            );
            if (invoice === undefined || !isHttps(invoice.hostedPdfUrl)) {
              return fail('payments.action.not_found', 404);
            }
            return { ok: true, redirectTo: { external: invoice.hostedPdfUrl } };
          });
        },
      };
    }

    pages.push({
      id: 'payments.invoices',
      segment: 'invoices',
      title: { key: 'payments.invoices.title' },
      nav: { label: { key: 'payments.invoices.nav' }, group: 'billing', order: 101 },
      visible,
      async load(ctx) {
        const scope = await scopeOf(ctx);
        if (!scope.allowed) {
          return {
            blocks: [{ kind: 'notice', tone: 'info', text: { key: 'payments.billing.org_only' } }],
          };
        }
        const store = deps.store();
        // One "Payments" tab per customer, plus an "Invoices" tab where the gateway lists them.
        const tabs: Array<{
          id: string;
          label: Text;
          customer: CustomerListItem;
          kind: 'payments' | 'invoices';
        }> = [];
        const several = scope.customers.length > 1;
        for (const customer of scope.customers) {
          const suffix = several ? ` · ${customer.provider}` : '';
          tabs.push({
            id: `payments-${customer.id}`,
            label: several
              ? `${ACCOUNT_MESSAGES[ctx.locale]?.['payments.invoices.payments_tab'] ?? 'Payments'}${suffix}`
              : { key: 'payments.invoices.payments_tab' },
            customer,
            kind: 'payments',
          });
          const driver = await driverOf(customer.provider);
          if (driver !== undefined && driver.capabilities?.invoices !== false) {
            tabs.push({
              id: `invoices-${customer.id}`,
              label: several
                ? `${ACCOUNT_MESSAGES[ctx.locale]?.['payments.invoices.invoices_tab'] ?? 'Invoices'}${suffix}`
                : { key: 'payments.invoices.invoices_tab' },
              customer,
              kind: 'invoices',
            });
          }
        }
        const tab = tabs.find((t) => t.id === ctx.query.tab) ?? tabs[0];
        const tabList =
          tabs.length > 1 ? tabs.map((t) => ({ id: t.id, label: t.label })) : undefined;
        if (tab === undefined || store === undefined) {
          return {
            blocks: [
              { kind: 'notice', tone: 'info', text: { key: 'payments.invoices.payments_empty' } },
            ],
          };
        }
        const page = pageOf(ctx.query.cursor);
        const columns = [
          { id: 'date', label: { key: 'payments.invoices.date' } },
          { id: 'amount', label: { key: 'payments.invoices.amount' } },
          { id: 'status', label: { key: 'payments.invoices.status' } },
        ];
        if (tab.kind === 'payments') {
          const rows = await store.listPayments({
            customerId: tab.customer.gatewayId,
            page,
            size: PAGE_SIZE + 1,
          });
          // `size + 1` asks for one row of the next page; a store that caps the size still pages.
          const shown = rows.slice(0, PAGE_SIZE);
          const hook = invoiceActions.download ? options.invoiceUrl : undefined;
          const links = await Promise.all(
            shown.map((payment) =>
              hook ? Promise.resolve(hook(payment)).catch(() => null) : Promise.resolve(null),
            ),
          );
          const tableRows = shown.map((payment, index) => {
            const at = asDate(payment.paidAt ?? payment.createdAt);
            const link = links[index];
            return {
              cells: {
                date:
                  at !== null
                    ? ({ type: 'date', at, style: 'date' } as Value)
                    : ({ type: 'text', text: '—' } as Value),
                amount: {
                  type: 'money',
                  amount: payment.amount,
                  currency: payment.currency.toUpperCase(),
                } as Value,
                status: statusBadge(payment.status),
              },
              ...(isHttps(link)
                ? { actions: [{ action: 'download', target: `payment~${payment.gatewayId}` }] }
                : {}),
            };
          });
          return {
            blocks: [
              {
                kind: 'table',
                empty: { key: 'payments.invoices.payments_empty' },
                columns,
                rows: tableRows,
                nextCursor: rows.length > PAGE_SIZE ? String(page + 1) : null,
              },
            ],
            ...(tabList ? { tabs: tabList } : {}),
          };
        }
        const driver = await driverOf(tab.customer.provider);
        let invoices: Invoice[];
        try {
          invoices = (await driver?.listInvoices(tab.customer.gatewayId)) ?? [];
        } catch {
          return {
            blocks: [
              { kind: 'notice', tone: 'warning', text: { key: 'payments.invoices.unavailable' } },
            ],
            ...(tabList ? { tabs: tabList } : {}),
          };
        }
        invoices.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const offset = (page - 1) * PAGE_SIZE;
        const shown = invoices.slice(offset, offset + PAGE_SIZE);
        return {
          blocks: [
            {
              kind: 'table',
              empty: { key: 'payments.invoices.invoices_empty' },
              columns: [{ id: 'number', label: { key: 'payments.invoices.number' } }, ...columns],
              rows: shown.map((invoice) => ({
                cells: {
                  number: { type: 'text', text: invoice.number ?? invoice.gatewayId } as Value,
                  date: {
                    type: 'date',
                    at: invoice.issuedAt ?? invoice.createdAt,
                    style: 'date',
                  } as Value,
                  amount: {
                    type: 'money',
                    amount: invoice.amount.amount,
                    currency: invoice.amount.currency.toUpperCase(),
                  } as Value,
                  status: statusBadge(invoice.status),
                },
                ...(invoiceActions.download && isHttps(invoice.hostedPdfUrl)
                  ? {
                      actions: [
                        {
                          action: 'download',
                          target: `invoice~${tab.customer.id}~${invoice.gatewayId}`,
                        },
                      ],
                    }
                  : {}),
              })),
              nextCursor: invoices.length > offset + PAGE_SIZE ? String(page + 1) : null,
            },
          ],
          ...(tabList ? { tabs: tabList } : {}),
        };
      },
      actions: invoiceActions,
    });
  }

  return {
    id: 'payments',
    contract: 1,
    messages: ACCOUNT_MESSAGES,
    scriptOrigins: [
      ...CARD_SCRIPT_ORIGINS,
      ...(publicUrl !== undefined && isHttps(publicUrl) ? [new URL(publicUrl).origin] : []),
    ],
    pages,
  };
}
