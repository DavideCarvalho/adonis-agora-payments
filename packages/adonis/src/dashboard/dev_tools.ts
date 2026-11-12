import type { HttpContext } from '@adonisjs/core/http';
import { AUDIT_ACTIONS } from '../billing/billing_store.js';
import {
  type ApiRequest,
  type ApiResponse,
  auditEvents,
  customers,
  type Deps,
  DISPUTE_RESOLUTION_STATUSES,
  DISPUTE_STATUSES,
  disputes,
  health,
  overview,
  PAYMENT_STATUSES,
  paymentDetail,
  payments,
  refundPayment,
  resolveDispute,
  retryWebhookEvent,
  SUBSCRIPTION_STATUSES,
  subscriptions,
  WEBHOOK_EVENT_STATUSES,
  webhookEvents,
} from './handlers.js';
import { PERIOD_PRESETS } from './period.js';

/*
 * The dev-tools registration contract, version 1, declared here STRUCTURALLY: the hub is bound at
 * `'agora.devTools'` by `@adonis-agora/agent/mcp_provider` when the app has it, and this package
 * never imports the agent (it stays an optional, undeclared peer). Same shapes as
 * `@adonis-agora/agent/dev-tools`.
 */

/** The container binding the dev-tools hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

/** The hub a lib registers its developer tools into. */
export interface DevToolsHub {
  readonly version: 1;
  register(lib: DevToolsLib): void;
}

/** One lib's tools and the gate that decides who may use them. */
export interface DevToolsLib {
  lib: string;
  title: string;
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

/** What a lib's `authorize` answers: the console decision. */
export type DevToolsDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden';
      redirectTo?: string;
      error?: unknown;
    };

/** One developer tool. */
export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  ctx: HttpContext;
  caller: DevToolsCaller;
  limits: { maxRows: number; maxBytes: number };
}

/** Who is calling. Never a token value. */
export interface DevToolsCaller {
  id: string;
  via: 'token' | 'session' | 'open';
}

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/** How a console API handler is served: the same switches its route is registered with. */
export interface PaymentsApiRoute {
  handler: (deps: Deps, req: ApiRequest) => Promise<ApiResponse>;
  /** Needs the refund / retry ports (the payments manager). */
  needsActions?: boolean;
  /** Needs what each gateway can do (refunds, disputes…). */
  needsCapabilities?: boolean;
  /** A view over every organization: refused to a viewer scoped to some. */
  everyOrganization?: boolean;
}

/** What {@link paymentsDevTools} needs from the console. */
export interface PaymentsDevToolsOptions {
  /**
   * Serve one console API handler for `ctx`, exactly as the console's JSON API does: the viewer's
   * organization scope (narrowed to `tenant` when given), the same deps, the same errors. `actor`
   * is who the audit trail records for an action.
   */
  serve(
    ctx: HttpContext,
    route: PaymentsApiRoute,
    req: ApiRequest,
    options: { actor: string; tenant?: string | undefined },
  ): Promise<ApiResponse>;
  /** Whether some configured gateway can refund (hides the refund tool otherwise). */
  canRefund(): Promise<boolean>;
  /** Whether organizations (tenancy) are on. */
  tenancyEnabled(): boolean;
  /** What the console's Organization control shows this viewer. */
  organizations(ctx: HttpContext): Promise<{
    mode: string;
    all: boolean;
    tenants: Array<{ id: string; label: string }>;
  }>;
  /** Append a row to the billing audit trail (best effort). */
  recordAudit(event: {
    action: string;
    actor: string;
    provider: string | null;
    subjectType: string;
    subjectId: string;
    message?: string | null;
  }): Promise<void>;
}

/** List tools default to this many rows. */
const DEFAULT_LIMIT = 20;
/** List tools return at most this many rows. */
const MAX_LIMIT = 100;

/** Thrown from a tool to answer an MCP error result (the agent turns it into `isError`). */
class DevToolError extends Error {}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) throw new DevToolError(`${key} is required`);
  return value;
}

function paging(input: Record<string, unknown>, call: DevToolCall): { page: number; size: number } {
  const rawLimit = input.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.trunc(rawLimit)
      : DEFAULT_LIMIT;
  const cap = Math.min(MAX_LIMIT, call.limits.maxRows > 0 ? call.limits.maxRows : MAX_LIMIT);
  const rawPage = input.page;
  const page = typeof rawPage === 'number' && Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1;
  return { page: Math.max(1, page), size: Math.min(Math.max(limit, 1), cap) };
}

/** The query a console list route reads: the filters given plus `page`/`size`. */
function listQuery(
  input: Record<string, unknown>,
  call: DevToolCall,
  filters: readonly string[],
): { query: Record<string, string>; page: number; size: number } {
  const { page, size } = paging(input, call);
  const query: Record<string, string> = { page: String(page), size: String(size) };
  for (const key of filters) {
    const value = str(input, key);
    if (value !== undefined) query[key] = value;
  }
  return { query, page, size };
}

/** The console's answer, or the tool error carrying its message (`404: No payment "x"…`). */
function body(response: ApiResponse): Record<string, unknown> {
  if (response.status >= 200 && response.status < 300) {
    return (response.body ?? {}) as Record<string, unknown>;
  }
  const error = (response.body as { error?: unknown } | null)?.error;
  throw new DevToolError(
    `${response.status}: ${typeof error === 'string' ? error : 'the console refused the request'}`,
  );
}

/** `{ items, next }` over one console list page: `next` is the next page while this one is full. */
function page(
  out: Record<string, unknown>,
  key: string,
  at: { page: number; size: number },
  extra: readonly string[] = [],
): Record<string, unknown> {
  const items = Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
  const result: Record<string, unknown> = {
    items,
    next: items.length >= at.size ? at.page + 1 : null,
  };
  for (const name of extra) if (out[name] !== undefined) result[name] = out[name];
  return result;
}

const TENANT_PROPERTY: DevToolInputProperty = {
  type: 'string',
  description:
    'With organizations on: narrow to this organization id (see payments_list_organizations). Default: every organization you may see.',
};
const PAGE_PROPERTY: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  description: 'Page number, 1-based. Pass `next` back here.',
};
const LIMIT_PROPERTY: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Rows per page (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
};
const PROVIDER_PROPERTY: DevToolInputProperty = {
  type: 'string',
  description: 'Gateway name, e.g. "stripe", "asaas".',
};

const ROUTES = {
  overview: { handler: overview },
  health: { handler: health, everyOrganization: true },
  payments: { handler: payments, needsCapabilities: true },
  paymentDetail: { handler: paymentDetail, needsCapabilities: true },
  customers: { handler: customers },
  audit: { handler: auditEvents, everyOrganization: true },
  disputes: { handler: disputes },
  subscriptions: { handler: subscriptions },
  webhookEvents: { handler: webhookEvents, everyOrganization: true },
  refund: { handler: refundPayment, needsActions: true },
  retry: { handler: retryWebhookEvent, needsActions: true, everyOrganization: true },
  resolve: { handler: resolveDispute },
} satisfies Record<string, PaymentsApiRoute>;

/**
 * The payments console's developer tools: the same handlers, organization scope and audit trail
 * as the console's JSON API, under `payments_*` names. Reads are listed by default; the three
 * actions (refund, retry a webhook event, record a dispute's outcome) only when the app opts in on
 * the dev endpoint. Gateway payloads never leave (the handlers omit them).
 */
export function paymentsDevTools(options: PaymentsDevToolsOptions): DevTool[] {
  const actor = (call: DevToolCall) => `mcp:${call.caller.id}`;
  const serve = (
    call: DevToolCall,
    route: PaymentsApiRoute,
    req: Partial<ApiRequest>,
    input: Record<string, unknown>,
  ) =>
    options
      .serve(
        call.ctx,
        route,
        {
          params: req.params ?? {},
          query: req.query ?? {},
          ...(req.body ? { body: req.body } : {}),
        },
        { actor: actor(call), tenant: str(input, 'tenant') },
      )
      .then(body);

  return [
    {
      name: 'payments_get_overview',
      kind: 'read',
      description:
        'Billing metrics for a period: revenue (integer minor units), active subscriptions (trialing included), usage per meter. Returns { period, currency, metrics }.',
      input: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: PERIOD_PRESETS,
            description: 'A preset window (default: the console default).',
          },
          from: { type: 'string', description: 'Custom window start, ISO date.' },
          to: { type: 'string', description: 'Custom window end, ISO date.' },
          tenant: TENANT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const query: Record<string, string> = {};
        for (const key of ['period', 'from', 'to']) {
          const value = str(input, key);
          if (value !== undefined) query[key] = value;
        }
        return serve(call, ROUTES.overview, { query }, input);
      },
    },
    {
      name: 'payments_get_health',
      kind: 'read',
      description:
        'What needs attention in billing: failed webhook events, payments stuck pending, dispute windows closing, renewals failing. Returns the console health checks. Spans every organization, so it is refused to a viewer scoped to some.',
      input: { type: 'object', properties: {} },
      run: async (input, call) => serve(call, ROUTES.health, {}, input),
    },
    {
      name: 'payments_list_payments',
      kind: 'read',
      description:
        'Payments, newest first: gateway id, provider, status, amount (integer minor units), currency, customer, app reference, refunded amount and owner. Lookups by reference, gatewayId and customerId are exact. Returns { items, next, currency }.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: PAYMENT_STATUSES, description: 'Payment status.' },
          provider: PROVIDER_PROPERTY,
          reference: { type: 'string', description: "The app's own reference (exact)." },
          gatewayId: { type: 'string', description: 'Gateway payment id (exact).' },
          customerId: { type: 'string', description: 'Gateway customer id (exact).' },
          tenant: TENANT_PROPERTY,
          page: PAGE_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const list = listQuery(input, call, [
          'status',
          'provider',
          'reference',
          'gatewayId',
          'customerId',
        ]);
        const out = await serve(call, ROUTES.payments, { query: list.query }, input);
        return page(out, 'payments', list, ['currency']);
      },
    },
    {
      name: 'payments_get_payment',
      kind: 'read',
      description:
        'One payment in full: current state, owner, its disputes, the webhook events naming it and its audit rows (who refunded it). Never the gateway payload. Returns { payment, disputes, events, audit, currency }.',
      input: {
        type: 'object',
        properties: {
          gatewayId: { type: 'string', description: 'Gateway payment id.' },
          tenant: TENANT_PROPERTY,
        },
        required: ['gatewayId'],
      },
      run: async (input, call) =>
        serve(
          call,
          ROUTES.paymentDetail,
          { params: { gatewayId: required(input, 'gatewayId') } },
          input,
        ),
    },
    {
      name: 'payments_list_subscriptions',
      kind: 'read',
      description:
        'Subscriptions, newest first: status, plan, customer, amount and cycle, next charge, renewal failures. Returns { items, next, counts } where counts has the whole-table past_due and failing_renewals totals.',
      input: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: SUBSCRIPTION_STATUSES,
            description: 'Subscription status.',
          },
          provider: PROVIDER_PROPERTY,
          tenant: TENANT_PROPERTY,
          page: PAGE_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const list = listQuery(input, call, ['status', 'provider']);
        const out = await serve(call, ROUTES.subscriptions, { query: list.query }, input);
        return page(out, 'subscriptions', list, ['counts']);
      },
    },
    {
      name: 'payments_list_disputes',
      kind: 'read',
      description:
        'Disputes (chargebacks), newest first. With dueWithin (hours): only OPEN disputes whose evidence window closes inside it, soonest first, plus the full total. Returns { items, next, dueWithin? }.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: DISPUTE_STATUSES, description: 'Dispute status.' },
          provider: PROVIDER_PROPERTY,
          dueWithin: {
            type: 'integer',
            minimum: 0,
            description: 'Only open windows closing within this many hours.',
          },
          tenant: TENANT_PROPERTY,
          page: PAGE_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const list = listQuery(input, call, ['status', 'provider', 'dueWithin']);
        const out = await serve(call, ROUTES.disputes, { query: list.query }, input);
        return page(out, 'disputes', list, ['dueWithin']);
      },
    },
    {
      name: 'payments_list_webhook_events',
      kind: 'read',
      description:
        'The webhook ledger, newest first: gateway event id, provider, type, status and the error a failed handler threw. Never the payload. Spans every organization, so it is refused to a viewer scoped to some. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: WEBHOOK_EVENT_STATUSES, description: 'Event status.' },
          provider: PROVIDER_PROPERTY,
          type: { type: 'string', description: 'Normalized event type, e.g. "payment.paid".' },
          page: PAGE_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const list = listQuery(input, call, ['status', 'provider', 'type']);
        return page(
          await serve(call, ROUTES.webhookEvents, { query: list.query }, input),
          'events',
          list,
        );
      },
    },
    {
      name: 'payments_list_customers',
      kind: 'read',
      description:
        'Billing customers, newest first: the mapping from a gateway customer id to the app owner (ownerType, ownerId), with email and name. Filters are exact. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          provider: PROVIDER_PROPERTY,
          ownerType: { type: 'string', description: 'Owner type, e.g. "user", "organization".' },
          ownerId: { type: 'string', description: 'Owner id (pair it with ownerType).' },
          gatewayId: { type: 'string', description: 'Gateway customer id.' },
          tenant: TENANT_PROPERTY,
          page: PAGE_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const list = listQuery(input, call, ['provider', 'ownerType', 'ownerId', 'gatewayId']);
        const out = await serve(call, ROUTES.customers, { query: list.query }, input);
        return page(out, 'customers', list);
      },
    },
    {
      name: 'payments_list_audit',
      kind: 'read',
      description:
        'The billing audit trail, newest first: refunds and dispute resolutions (and who did them), webhook deliveries the endpoint refused, organization switches. Spans every organization, so it is refused to a viewer scoped to some. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'e.g. "payment.refunded", "webhook.rejected".' },
          actor: { type: 'string', description: 'Who did it, exact.' },
          provider: PROVIDER_PROPERTY,
          subjectType: { type: 'string', description: '"payment", "dispute", "webhook"…' },
          subjectId: { type: 'string', description: 'The subject gateway id.' },
          page: PAGE_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const list = listQuery(input, call, [
          'action',
          'actor',
          'provider',
          'subjectType',
          'subjectId',
        ]);
        return page(await serve(call, ROUTES.audit, { query: list.query }, input), 'audit', list);
      },
    },
    {
      name: 'payments_list_organizations',
      kind: 'read',
      description:
        'The organizations you may see in billing (organizations on): ids and labels, and whether you see all of them. Pass an id as `tenant` to the other tools to narrow to it. Returns { items, all }.',
      input: { type: 'object', properties: {} },
      available: () => options.tenancyEnabled(),
      run: async (_input, call) => {
        const picker = await options.organizations(call.ctx);
        return { items: picker.tenants, all: picker.all };
      },
    },
    {
      name: 'payments_refund_payment',
      kind: 'action',
      destructive: true,
      description:
        'Refund a paid payment through the gateway that took it: the whole amount, or `amount` in integer minor units for a partial refund. Moves money. The payment row updates when the gateway webhook arrives. Recorded in the billing audit trail. Returns { refund, payment, audit, note }.',
      input: {
        type: 'object',
        properties: {
          gatewayId: { type: 'string', description: 'Gateway payment id.' },
          amount: {
            type: 'integer',
            minimum: 1,
            description: 'Partial refund in integer minor units (omit for the full amount).',
          },
          tenant: TENANT_PROPERTY,
        },
        required: ['gatewayId'],
      },
      available: () => options.canRefund(),
      run: async (input, call) => {
        const amount = input.amount;
        return serve(
          call,
          ROUTES.refund,
          {
            params: { gatewayId: required(input, 'gatewayId') },
            body: typeof amount === 'number' ? { amount } : {},
          },
          input,
        );
      },
    },
    {
      name: 'payments_retry_webhook_event',
      kind: 'action',
      description:
        "Re-run a FAILED webhook event through the app's handlers, from the stored event (the ledger refuses an in-flight or processed one, so it never applies twice). Recorded in the billing audit trail. Returns { gatewayEventId, status }.",
      input: {
        type: 'object',
        properties: {
          gatewayEventId: { type: 'string', description: 'Gateway event id of a failed event.' },
        },
        required: ['gatewayEventId'],
      },
      run: async (input, call) => {
        const gatewayEventId = required(input, 'gatewayEventId');
        const out = await serve(call, ROUTES.retry, { params: { gatewayEventId } }, input);
        await options
          .recordAudit({
            action: AUDIT_ACTIONS.webhookRetried,
            actor: actor(call),
            provider: null,
            subjectType: 'webhook',
            subjectId: gatewayEventId,
          })
          .catch(() => {});
        return out;
      },
    },
    {
      name: 'payments_resolve_dispute',
      kind: 'action',
      description:
        'Record how a dispute ENDED at the gateway (for gateways that never send a closing event). Sends nothing to the gateway. Recorded in the billing audit trail. Returns { dispute, audit, note }.',
      input: {
        type: 'object',
        properties: {
          gatewayId: { type: 'string', description: 'Gateway dispute id.' },
          status: {
            type: 'string',
            enum: DISPUTE_RESOLUTION_STATUSES,
            description: 'How it ended.',
          },
          outcome: { type: 'string', description: 'Outcome label (default: the status).' },
          note: { type: 'string', description: 'A note for the audit trail.' },
          tenant: TENANT_PROPERTY,
        },
        required: ['gatewayId', 'status'],
      },
      run: async (input, call) => {
        const resolution: Record<string, string> = { status: required(input, 'status') };
        for (const key of ['outcome', 'note']) {
          const value = str(input, key);
          if (value !== undefined) resolution[key] = value;
        }
        return serve(
          call,
          ROUTES.resolve,
          { params: { gatewayId: required(input, 'gatewayId') }, body: resolution },
          input,
        );
      },
    },
  ];
}

/**
 * Register the payments console's tools into the app's dev-tools hub, when one is bound (the app
 * registered `@adonis-agora/agent/mcp_provider`). Returns whether it registered.
 */
export async function registerPaymentsDevTools(
  container: { hasBinding?(binding: string): boolean; make(binding: string): Promise<unknown> },
  options: PaymentsDevToolsOptions & {
    authorize: (ctx: HttpContext) => Promise<DevToolsDecision>;
  },
): Promise<boolean> {
  if (typeof container.hasBinding !== 'function' || !container.hasBinding(DEV_TOOLS_BINDING)) {
    return false;
  }
  const hub = (await container.make(DEV_TOOLS_BINDING)) as Partial<DevToolsHub> | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register({
    lib: 'payments',
    title: 'Payments and billing',
    authorize: options.authorize,
    tools: paymentsDevTools(options),
  });
  return true;
}
