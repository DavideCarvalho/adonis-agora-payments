import type {
  AuditRow,
  CustomerRow,
  DisputeRow,
  Health,
  PaymentRow,
  SubscriptionRow,
  WebhookEventRow,
} from '../client/payments-client';

/**
 * A hand-built snapshot of a live billing install, served to the SPA by stubbing `fetch`. Used only
 * by `preview.html` — the standalone visual-verification entry — so the WHOLE console can be
 * screenshotted with its real components and styling, with no server and no database. Mixed on
 * purpose: failing webhooks, a past-due subscription, a dispute whose window shuts tonight, an
 * unmapped customer, so every status hue and attention state is on screen.
 */

const NOW = Date.now();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;
const D = 24 * H;

const owner = (id: string, name: string) => ({ type: 'user', id, name, email: null });

const payments: PaymentRow[] = [
  ['pi_3Q8fA2', 'stripe', 'paid', 24_900, 'order-4102', owner('42', 'Ana Souza'), -2 * H, true],
  ['pay_8f2c91', 'asaas', 'pending', 9_900, 'order-4101', owner('17', 'Bruno Lima'), -3 * H, false],
  ['pi_3Q8e7Z', 'stripe', 'failed', 129_000, 'order-4100', owner('8', 'Carla Dias'), -5 * H, false],
  ['pi_3Q8d1K', 'stripe', 'refunded', 4_990, 'order-4099', owner('42', 'Ana Souza'), -9 * H, false],
  ['wo_71ac02', 'woovi', 'paid', 15_000, 'order-4098', null, -11 * H, true],
  ['pi_3Q8c4M', 'stripe', 'disputed', 59_900, 'order-4097', owner('23', 'Diego Rocha'), -D, false],
  [
    'pay_77ab30',
    'asaas',
    'authorized',
    31_500,
    'order-4096',
    owner('5', 'Eva Nunes'),
    -2 * D,
    false,
  ],
  ['pi_3Q8b9P', 'stripe', 'paid', 8_900, null, owner('31', 'Fábio Reis'), -3 * D, true],
].map(([gatewayId, provider, status, amount, ref, own, at, refundable], i) => ({
  id: String(i + 1),
  gatewayId: gatewayId as string,
  provider: provider as string,
  status: status as string,
  amount: amount as number,
  currency: 'BRL',
  customerId: `cus_${i + 100}`,
  subscriptionId: null,
  externalReference: ref as string | null,
  refundedAmount: status === 'refunded' ? 4_990 : i === 0 ? 2_490 : null,
  owner: own as PaymentRow['owner'],
  paidAt: status === 'paid' ? iso(at as number) : null,
  createdAt: iso(at as number),
  refundable: refundable as boolean,
}));

const subscriptions: SubscriptionRow[] = [
  ['sub_1PqA', 'stripe', 'past_due', 'pro-monthly', 4_900, 'MONTHLY', -40 * D, 'card_declined'],
  ['sub_1PqB', 'asaas', 'active', 'team-yearly', 99_000, 'YEARLY', -200 * D, null],
  ['sub_1PqC', 'stripe', 'trialing', 'pro-monthly', 4_900, 'MONTHLY', -4 * D, null],
  ['sub_1PqD', 'stripe', 'paused', 'starter', 1_900, 'MONTHLY', -90 * D, null],
  ['sub_1PqE', 'managed', 'active', 'pro-monthly', 4_900, 'MONTHLY', -12 * D, null],
].map(([gatewayId, provider, status, planId, amount, cycle, at, error], i) => ({
  id: `local-${i + 1}`,
  gatewayId: gatewayId as string,
  provider: provider === 'managed' ? 'asaas' : (provider as string),
  status: status as string,
  planId: planId as string,
  customerId: `cus_${i + 100}`,
  trialEndsAt: status === 'trialing' ? iso(10 * D) : null,
  endsAt: null,
  createdAt: iso(at as number),
  managed: provider === 'managed',
  amount: amount as number,
  currency: 'BRL',
  cycle: cycle as string,
  currentPeriodEnd: iso(12 * D),
  nextChargeAt: status === 'paused' ? null : iso(12 * D),
  cancelAtPeriodEnd: i === 1,
  lastRenewalError: error as string | null,
  lastRenewalAttemptAt: error ? iso(-6 * H) : null,
  renewalFailureCount: error ? 3 : 0,
}));

const customers: CustomerRow[] = [
  ['cus_100', 'stripe', '42', 'Ana Souza', 'ana@example.com'],
  ['cus_101', 'asaas', '17', 'Bruno Lima', 'bruno@example.com'],
  ['cus_102', 'stripe', '8', 'Carla Dias', 'carla@example.com'],
  ['cus_103', 'woovi', null, null, 'guest-7f1@example.com'],
  ['cus_104', 'stripe', '23', 'Diego Rocha', 'diego@example.com'],
].map(([gatewayId, provider, ownerId, name, email], i) => ({
  id: String(i + 1),
  gatewayId: gatewayId as string,
  provider: provider as string,
  ownerType: ownerId === null ? null : 'user',
  ownerId: ownerId as string | null,
  email: email as string,
  name: name as string | null,
  taxId: null,
  createdAt: iso(-(i + 1) * 9 * D),
}));

const disputes: DisputeRow[] = [
  ['dp_1OaX', 'pi_3Q8c4M', 'stripe', 'open', 'fraudulent', 59_900, iso(6 * H)],
  ['dp_1OaY', 'pi_3Q7z2L', 'stripe', 'warning', 'early_fraud_warning', null, iso(40 * H)],
  ['chb_99a1', 'pay_55c2aa', 'asaas', 'open', 'not_received', 12_000, null],
  ['dp_1OaZ', 'pi_3Q6y8T', 'stripe', 'under_review', 'product_unacceptable', 21_000, iso(-30 * H)],
  ['dp_1OaW', 'pi_3Q5x1R', 'stripe', 'lost', 'fraudulent', 8_900, null],
  ['dp_1OaV', 'pi_3Q4w0Q', 'stripe', 'won', 'duplicate', 15_500, null],
].map(([gatewayId, payment, provider, status, reason, amount, due], i) => ({
  id: String(i + 1),
  gatewayId: gatewayId as string,
  paymentGatewayId: payment as string,
  provider: provider as string,
  status: status as string,
  reason: reason as string,
  amount: amount as number | null,
  currency: 'BRL',
  evidenceDueBy: due as string | null,
  outcome: status === 'won' || status === 'lost' ? (status as string) : null,
  openedAt: iso(-(i + 2) * D),
  closedAt: status === 'won' || status === 'lost' ? iso(-D) : null,
  createdAt: iso(-(i + 2) * D),
}));

const events: WebhookEventRow[] = [
  [
    'evt_1Qa',
    'stripe',
    'invoice.payment_failed',
    'failed',
    'TypeError: cannot read "plan" of undefined\n    at SubscriptionHandler.handle (app/billing/handlers.ts:42:18)',
  ],
  [
    'evt_1Qb',
    'asaas',
    'PAYMENT_RECEIVED',
    'failed',
    'Lucid: duplicate key value violates unique constraint "billing_payments_gateway_id_unique"',
  ],
  ['evt_1Qc', 'stripe', 'payment_intent.succeeded', 'received', null],
  ['evt_1Qd', 'stripe', 'charge.refunded', 'processed', null],
  ['evt_1Qe', 'woovi', 'OPENPIX:CHARGE_COMPLETED', 'processed', null],
].map(([gatewayEventId, provider, type, status, error], i) => ({
  id: String(i + 1),
  gatewayEventId: gatewayEventId as string,
  provider: provider as string,
  type: type as string,
  status: status as string,
  error: error as string | null,
  createdAt: iso(-(i + 1) * 47 * 60_000),
  updatedAt: iso(-(i + 1) * 45 * 60_000),
  retryable: status === 'failed',
}));

const audit: AuditRow[] = [
  ['webhook.rejected', null, 'asaas', null, null, 'invalid signature — check ASAAS_WEBHOOK_TOKEN'],
  ['payment.refunded', 'ops@example.test', 'stripe', 'pi_3Q8d1K', 4_990, null],
  ['dispute.resolved', 'ops@example.test', 'stripe', 'dp_1OaW', null, 'outcome: lost'],
  ['webhook.retried', 'ana.ops@example.test', 'stripe', 'evt_0Zz', null, null],
].map(([action, actor, provider, subjectId, amount, message], i) => ({
  id: String(i + 1),
  action: action as string,
  actor: actor as string | null,
  provider: provider as string,
  subjectType: null,
  subjectId: subjectId as string | null,
  amount: amount as number | null,
  currency: amount === null ? null : 'BRL',
  message: message as string | null,
  metadata: null,
  createdAt: iso(-(i + 1) * 5 * H),
}));

const health: Health = {
  healthy: false,
  checkedAt: iso(-20_000),
  checks: [
    {
      key: 'failed_webhooks',
      label: 'Webhook events the dispatcher gave up on',
      count: 2,
      healthy: false,
      hint: 'A handler threw and nothing will retry it. Fix the handler, then retry the event.',
    },
    {
      key: 'disputes_due',
      label: 'Dispute windows closing within 72h',
      count: 2,
      healthy: false,
      hint: 'Missing the window loses the money by default. Answer at the gateway.',
    },
    {
      key: 'failing_renewals',
      label: 'Renewals failing',
      count: 1,
      healthy: false,
      hint: 'A managed subscription could not charge its card on the last attempts.',
    },
  ],
  failures: [
    { provider: 'stripe', type: 'invoice.payment_failed', count: 1 },
    { provider: 'asaas', type: 'PAYMENT_RECEIVED', count: 1 },
  ],
  deadlines: disputes.filter((d) => d.status === 'open' && d.evidenceDueBy !== null),
  openDisputes: disputes.filter((d) => d.status === 'open'),
};

function page<T>(rows: T[], extra: Record<string, unknown> = {}) {
  return {
    data: rows,
    meta: { total: rows.length * 9, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
    ...extra,
  };
}

function route(url: URL): unknown {
  const path = url.pathname.replace(/^.*\/api/, '');
  const status = url.searchParams.get('filter[status]') ?? url.searchParams.get('status');
  const byStatus = <T extends { status: string }>(rows: T[]) =>
    status ? rows.filter((r) => r.status === status) : rows;
  if (path === '/tenants')
    return {
      mode: 'pick',
      all: true,
      selected: null,
      ownerTypes: ['organization'],
      tenants: [
        { id: 'acme', label: 'Acme Ltda' },
        { id: 'globex', label: 'Globex' },
      ],
    };
  if (path === '/health') return health;
  if (path === '/providers')
    return {
      providers: ['stripe', 'asaas', 'woovi'],
      eventTypes: [...new Set(events.map((e) => e.type))],
      capabilities: {},
    };
  if (path === '/overview')
    return {
      period: { from: iso(-30 * D), to: iso(0), preset: '30d' },
      currency: 'BRL',
      metrics: [
        { key: 'revenue', label: 'Revenue', value: 4_820_350 },
        { key: 'net_revenue', label: 'Net', value: 4_611_870 },
        { key: 'mrr', label: 'MRR', value: 1_284_000 },
        { key: 'active_subscriptions', label: 'Active subscriptions', value: 312 },
        { key: 'meter:api_calls', label: 'Usage · api_calls', value: 1_284_220 },
        { key: 'meter:seats', label: 'Usage · seats', value: 1_140 },
        { key: 'meter:storage_gb', label: 'Usage · storage_gb', value: 382 },
      ],
    };
  if (path === '/payments') return page(byStatus(payments), { statuses: [], currency: 'BRL' });
  if (path.startsWith('/payments/')) {
    const id = decodeURIComponent(path.slice('/payments/'.length));
    const payment = payments.find((p) => p.gatewayId === id) ?? payments[0];
    return {
      payment,
      disputes: disputes.filter((d) => d.paymentGatewayId === id),
      events: { rows: events.slice(2, 4), matchedBy: 'payment-gateway-id' },
      audit: audit.slice(1, 2),
      currency: 'BRL',
    };
  }
  if (path === '/subscriptions')
    return page(byStatus(subscriptions), {
      statuses: [],
      counts: { past_due: 1, failing_renewals: 1 },
    });
  if (path.startsWith('/subscriptions/')) {
    const id = decodeURIComponent(path.slice('/subscriptions/'.length));
    const subscription = subscriptions.find((s) => s.id === id) ?? subscriptions[0];
    return {
      subscription: { ...subscription, externalReference: 'acct-42' },
      customer: customers[0],
      payments: payments.slice(0, 3),
      events: { rows: events.slice(0, 2), matchedBy: 'payment-gateway-id' },
      audit: audit.slice(1, 2),
      currency: 'BRL',
    };
  }
  if (path === '/customers') return page(customers);
  if (path === '/disputes') {
    if (url.searchParams.get('filter[dueWithin]'))
      return page(
        disputes.filter((d) => d.evidenceDueBy !== null && d.status !== 'won'),
        { statuses: [] },
      );
    return page(byStatus(disputes), { statuses: [] });
  }
  if (path === '/webhook-events') return page(byStatus(events), { statuses: [] });
  if (path === '/audit') return page(audit, { actions: [] });
  if (path === '/consoles')
    return {
      version: 1,
      current: 'payments',
      consoles: [
        {
          id: 'durable',
          title: 'Workflows',
          package: '@adonis-agora/durable',
          href: '/durable',
          icon: 'workflow',
        },
        {
          id: 'telescope',
          title: 'Telescope',
          package: '@adonis-agora/telescope',
          href: '/telescope',
          icon: 'telescope',
        },
        {
          id: 'authkit',
          title: 'Identity',
          package: '@adonis-agora/authkit',
          href: '/admin',
          icon: 'identity',
        },
      ],
    };
  if (path === '/consoles/search')
    return {
      results: [
        {
          id: 'payments',
          title: 'Payments',
          icon: 'payments',
          hits: [
            {
              title: 'order-4102',
              subtitle: 'paid · R$ 249,00',
              href: '/payments#/payments/pi_3Q8fA2',
            },
          ],
        },
      ],
    };
  return {};
}

/** Put a data block on the page (as the provider would) and answer every API call from the mock. */
export function installMockConsoleApi(): void {
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = 'payments-dashboard-config';
  block.textContent = JSON.stringify({
    base: '/payments',
    api: '/payments/api',
    currency: 'BRL',
    switcher: { endpoint: '/payments/api/consoles', others: 3 },
    search: { endpoint: '/payments/api/consoles/search' },
    viewer: { label: 'ops@example.test', email: 'ops@example.test', role: 'admin' },
    signOut: { action: '/account/logout', csrfToken: 'preview' },
  });
  document.head.appendChild(block);
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), window.location.href);
    if (!url.pathname.includes('/api/')) return real(input, init);
    return new Response(JSON.stringify(route(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
