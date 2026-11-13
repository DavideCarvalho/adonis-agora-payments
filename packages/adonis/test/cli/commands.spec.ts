import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '@adonisjs/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PaymentsAuditList from '../../commands/payments_audit_list.js';
import PaymentsCustomersList from '../../commands/payments_customers_list.js';
import PaymentsDisputesEvidence from '../../commands/payments_disputes_evidence.js';
import PaymentsDisputesList from '../../commands/payments_disputes_list.js';
import PaymentsDisputesResolve from '../../commands/payments_disputes_resolve.js';
import PaymentsOrganizationsList from '../../commands/payments_organizations_list.js';
import PaymentsOverview from '../../commands/payments_overview.js';
import PaymentsPaymentsList from '../../commands/payments_payments_list.js';
import PaymentsPaymentsRefund from '../../commands/payments_payments_refund.js';
import PaymentsPaymentsShow from '../../commands/payments_payments_show.js';
import PaymentsProvidersList from '../../commands/payments_providers_list.js';
import PaymentsSubscriptionsCancel from '../../commands/payments_subscriptions_cancel.js';
import PaymentsSubscriptionsList from '../../commands/payments_subscriptions_list.js';
import PaymentsSubscriptionsReprice from '../../commands/payments_subscriptions_reprice.js';
import PaymentsSubscriptionsResume from '../../commands/payments_subscriptions_resume.js';
import PaymentsSubscriptionsShow from '../../commands/payments_subscriptions_show.js';
import PaymentsWebhookEventsList from '../../commands/payments_webhook_events_list.js';
import PaymentsWebhookEventsRetry from '../../commands/payments_webhook_events_retry.js';
import type { PaymentsDriver } from '../../src/driver.js';
import { PaymentsManager } from '../../src/payments_manager.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';

/**
 * The `payments:<noun>:<verb>` operator commands: each one serves the console's own handler, so
 * these tests check the command's part — the flags reach the handler, `--json` prints its body,
 * a refusal exits 1, `--dry-run` changes nothing and a money-moving action asks first — and that
 * the write lands in the audit trail as `cli:<user>`.
 */

interface Calls {
  refunds: Array<{ gatewayId: string; amount: number | undefined }>;
  canceled: Array<{ id: string; atPeriodEnd: boolean | undefined }>;
  updated: Array<{ id: string; amount: number | undefined }>;
  evidence: Array<{ id: string; evidence: unknown }>;
}

function fakeDriver(provider: string, calls: Calls, caps: Record<string, unknown> = {}) {
  return {
    provider,
    capabilities: { refunds: true, disputes: true, subscriptions: true, ...caps },
    async refund(gatewayId: string, amount?: number) {
      calls.refunds.push({ gatewayId, amount });
      return {
        gatewayId: `re_${gatewayId}`,
        provider,
        amount: { amount: amount ?? 5000, currency: 'BRL' },
        status: 'succeeded',
        createdAt: '2026-11-13T00:00:00.000Z',
      };
    },
    async cancelSubscription(id: string, options?: { atPeriodEnd?: boolean }) {
      calls.canceled.push({ id, atPeriodEnd: options?.atPeriodEnd });
      return { gatewayId: id, status: 'canceled' };
    },
    async updateSubscription(id: string, patch: { amount?: number }) {
      calls.updated.push({ id, amount: patch.amount });
      return { gatewayId: id, status: 'active' };
    },
    async submitDisputeEvidence(id: string, evidence: unknown) {
      calls.evidence.push({ id, evidence });
      return { id, provider, paymentGatewayId: 'pi_1', status: 'under_review', payload: {} };
    },
  };
}

let store: InMemoryBillingStore;
let calls: Calls;
let manager: PaymentsManager;
let paymentsConfig: Record<string, unknown>;

beforeEach(async () => {
  store = new InMemoryBillingStore();
  calls = { refunds: [], canceled: [], updated: [], evidence: [] };
  const drivers = new Map<string, PaymentsDriver>([
    ['stripe', fakeDriver('stripe', calls) as unknown as PaymentsDriver],
    [
      'woovi',
      fakeDriver('woovi', calls, {
        refunds: false,
        disputes: false,
        subscriptions: false,
      }) as unknown as PaymentsDriver,
    ],
  ]);
  manager = new PaymentsManager({
    drivers,
    defaultName: 'stripe',
    store: () => store,
    tenancy: false,
  });
  paymentsConfig = { tenancy: false };

  await store.savePayment({
    gatewayId: 'pi_1',
    provider: 'stripe',
    status: 'paid',
    amount: 5000,
    currency: 'BRL',
    customerId: 'cus_1',
    externalReference: 'order-1',
  });
  await store.savePayment({
    gatewayId: 'pix_1',
    provider: 'woovi',
    status: 'paid',
    amount: 1000,
    currency: 'BRL',
  });
  await store.savePayment({
    gatewayId: 'pi_pending',
    provider: 'stripe',
    status: 'pending',
    amount: 700,
    currency: 'BRL',
  });
  await store.saveSubscription({
    gatewayId: 'sub_1',
    provider: 'stripe',
    customerId: 'cus_1',
    status: 'active',
    planId: 'pro',
    amount: 2990,
    currency: 'BRL',
  });
  await store.saveDispute({
    gatewayId: 'dp_1',
    paymentGatewayId: 'pi_1',
    provider: 'stripe',
    status: 'open',
    amount: 5000,
    currency: 'BRL',
  });
  const failed = await store.recordWebhookEvent({
    gatewayEventId: 'evt_bad',
    provider: 'stripe',
    type: 'payment.paid',
    payload: {},
  });
  await store.markWebhookFailed(failed?.id ?? '', 'handler threw');
});

async function managedSubscription(cancelAtPeriodEnd = false): Promise<string> {
  const row = await store.createManagedSubscription({
    provider: 'stripe',
    customerId: 'cus_1',
    status: 'active',
    planId: 'basic',
    amount: 990,
    currency: 'BRL',
    cycle: 'MONTHLY',
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    nextChargeAt: new Date('2026-12-01T00:00:00Z'),
  });
  if (cancelAtPeriodEnd) {
    await store.updateManagedSubscription(String(row.id), { cancelAtPeriodEnd: true });
  }
  return String(row.id);
}

const savedIsTTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = savedIsTTY;
});

/** Run a command through a real ace kernel over a fake app; answers its logs and exit code. */
async function run(
  Command: Parameters<Kernel['create']>[0],
  argv: string[],
  options: { confirm?: boolean } = {},
) {
  // A non-interactive shell unless a prompt is trapped (vitest's stdin may be a TTY).
  process.stdin.isTTY = false as never;
  const app = {
    config: {
      get: (key: string, fallback?: unknown) =>
        key === 'payments' ? paymentsConfig : (fallback ?? {}),
    },
    container: {
      // The kernel runs the command's `run()` through the container.
      call: async (target: Record<string, (...a: unknown[]) => unknown>, method: string) =>
        target[method]!(),
      make: async (token: unknown, args?: unknown[]) => {
        if (token === 'payments.billingStore') return store;
        if (token === PaymentsManager) return manager;
        // The kernel builds the command itself through the container.
        if (typeof token === 'function') {
          return new (token as new (...a: unknown[]) => unknown)(...(args ?? []));
        }
        throw new Error(`no binding ${String(token)}`);
      },
    },
    makePath: (...paths: string[]) => join(tmpdir(), 'payments-cli-no-app', ...paths),
  };
  const kernel = new Kernel(app as never);
  kernel.ui.switchMode('raw');
  const command = await kernel.create(Command, argv);
  if (options.confirm !== undefined) {
    const trap = command.prompt.trap('confirm');
    if (options.confirm) trap.accept();
    else trap.reject();
  }
  await command.exec();
  const logs = kernel.ui.logger.getLogs().map((log) => log.message);
  return { logs, output: logs.join('\n'), exitCode: command.exitCode };
}

function json(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe('read commands', () => {
  it('payments:payments:list --json prints the console list envelope, filters applied', async () => {
    const { output, exitCode } = await run(PaymentsPaymentsList, [
      '--status=paid',
      '--provider=stripe',
      '--json',
    ]);
    expect(exitCode).toBe(0);
    const body = json(output) as {
      data: Array<{ gatewayId: string; refundable: boolean }>;
      meta: Record<string, number>;
    };
    expect(body.data.map((p) => p.gatewayId)).toEqual(['pi_1']);
    expect(body.data[0]?.refundable).toBe(true);
    expect(body.meta).toMatchObject({ total: 1, currentPage: 1, lastPage: 1 });
  });

  it('payments:payments:list prints a table with money in the currency', async () => {
    const { output, exitCode } = await run(PaymentsPaymentsList, ['--reference=order-1']);
    expect(exitCode).toBe(0);
    expect(output).toContain('pi_1');
    expect(output).toContain('50.00 BRL');
    expect(output).not.toContain('pix_1');
    expect(output).toContain('page 1 of 1 · 1 total');
  });

  it('paging flags reach the handler', async () => {
    const { output } = await run(PaymentsPaymentsList, ['--size=1', '--page=2', '--json']);
    expect((json(output).meta as Record<string, number>).currentPage).toBe(2);
    expect((json(output).data as unknown[]).length).toBe(1);
  });

  it('a handler refusal exits 1 with its message and status', async () => {
    const missing = await run(PaymentsPaymentsShow, ['pi_nope']);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('No payment "pi_nope" is recorded locally. (404)');
  });

  it('payments:payments:show prints the detail; --json the console body', async () => {
    const human = await run(PaymentsPaymentsShow, ['pi_1']);
    expect(human.output).toContain('gateway id: pi_1');
    expect(human.output).toContain('Disputes');
    const body = json((await run(PaymentsPaymentsShow, ['pi_1', '--json'])).output);
    expect(Object.keys(body).sort()).toEqual([
      'audit',
      'currency',
      'disputes',
      'events',
      'payment',
    ]);
  });

  it('payments:subscriptions:list and :show', async () => {
    const list = json((await run(PaymentsSubscriptionsList, ['--json'])).output);
    expect((list.data as Array<{ gatewayId: string }>).map((s) => s.gatewayId)).toEqual(['sub_1']);
    expect(list.counts).toEqual({ past_due: 0, failing_renewals: 0 });
    const show = await run(PaymentsSubscriptionsShow, ['sub_1']);
    expect(show.output).toContain('mode: gateway');
  });

  it('payments:disputes:list --due-within lists only open windows (none carry a deadline here)', async () => {
    const all = json((await run(PaymentsDisputesList, ['--json'])).output);
    expect((all.data as unknown[]).length).toBe(1);
    const due = json((await run(PaymentsDisputesList, ['--due-within=24', '--json'])).output);
    expect(due.data).toEqual([]);
    expect(due.dueWithin).toEqual({ hours: 24 });
  });

  it('payments:webhook-events:list, :customers:list, :audit:list, :overview, :providers:list', async () => {
    const events = json(
      (await run(PaymentsWebhookEventsList, ['--status=failed', '--json'])).output,
    );
    expect((events.data as Array<{ gatewayEventId: string }>)[0]?.gatewayEventId).toBe('evt_bad');
    expect((await run(PaymentsCustomersList, ['--json'])).exitCode).toBe(0);
    expect((await run(PaymentsAuditList, ['--json'])).exitCode).toBe(0);
    const overview = await run(PaymentsOverview, ['--period=30d']);
    expect(overview.exitCode).toBe(0);
    expect(overview.output).toContain('Revenue, gross');
    const providers = await run(PaymentsProvidersList, []);
    expect(providers.output).toMatch(/woovi.*no/);
  });

  it('payments:organizations:list refuses with tenancy off', async () => {
    const { output, exitCode } = await run(PaymentsOrganizationsList, []);
    expect(exitCode).toBe(1);
    expect(output).toContain('Organizations (tenancy) are off');
  });

  it('--tenant with tenancy off is refused', async () => {
    const { output, exitCode } = await run(PaymentsPaymentsList, ['--tenant=org_1']);
    expect(exitCode).toBe(1);
    expect(output).toContain('needs organizations (tenancy) on');
  });
});

describe('payments:payments:refund', () => {
  it('--dry-run checks everything and sends nothing', async () => {
    const { output, exitCode } = await run(PaymentsPaymentsRefund, [
      'pi_1',
      '--amount=1000',
      '--dry-run',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toContain(
      '[dry run] Refund 10.00 BRL (partial) of payment pi_1 through stripe.',
    );
    expect(calls.refunds).toEqual([]);
    expect(await store.listAuditEvents({})).toEqual([]);
  });

  it('--dry-run --json prints what would be refunded', async () => {
    const body = json((await run(PaymentsPaymentsRefund, ['pi_1', '--dry-run', '--json'])).output);
    expect(body).toMatchObject({
      dryRun: true,
      refund: { amount: 5000, currency: 'BRL', partial: false },
    });
  });

  it('refuses without --force in a non-interactive shell, before touching the gateway', async () => {
    const { output, exitCode } = await run(PaymentsPaymentsRefund, ['pi_1']);
    expect(exitCode).toBe(1);
    expect(output).toContain('Pass --force');
    expect(calls.refunds).toEqual([]);
  });

  it('asks for confirmation, and a "no" changes nothing', async () => {
    const { output, exitCode } = await run(PaymentsPaymentsRefund, ['pi_1'], { confirm: false });
    expect(exitCode).toBe(1);
    expect(output).toContain('Aborted. Nothing was changed.');
    expect(calls.refunds).toEqual([]);
  });

  it('refunds after a "yes", and the audit row names cli:<user> and the note', async () => {
    const { exitCode } = await run(PaymentsPaymentsRefund, ['pi_1', '--note=customer asked'], {
      confirm: true,
    });
    expect(exitCode).toBe(0);
    expect(calls.refunds).toEqual([{ gatewayId: 'pi_1', amount: undefined }]);
    const [audit] = await store.listAuditEvents({ action: 'payment.refunded' });
    expect(audit?.actor).toMatch(/^cli(:.+)?$/);
    expect(audit?.message).toBe('customer asked');
  });

  it('--force refunds without asking; --json prints the console body', async () => {
    const body = json(
      (await run(PaymentsPaymentsRefund, ['pi_1', '--amount=1500', '--force', '--json'])).output,
    );
    expect(body.refund).toMatchObject({ gatewayId: 're_pi_1', amount: 1500 });
    expect(calls.refunds).toEqual([{ gatewayId: 'pi_1', amount: 1500 }]);
  });

  it('a refusal (not paid, no refund API, too large) exits 1 and never prompts', async () => {
    const pending = await run(PaymentsPaymentsRefund, ['pi_pending', '--force']);
    expect(pending.exitCode).toBe(1);
    expect(pending.output).toContain('is "pending", not "paid"');
    const woovi = await run(PaymentsPaymentsRefund, ['pix_1', '--force']);
    expect(woovi.exitCode).toBe(1);
    expect(woovi.output).toContain('has no refund API');
    const tooMuch = await run(PaymentsPaymentsRefund, ['pi_1', '--amount=99999', '--dry-run']);
    expect(tooMuch.exitCode).toBe(1);
    expect(calls.refunds).toEqual([]);
  });
});

describe('payments:subscriptions:*', () => {
  it('cancel --dry-run changes nothing', async () => {
    const { output, exitCode } = await run(PaymentsSubscriptionsCancel, ['sub_1', '--dry-run']);
    expect(exitCode).toBe(0);
    expect(output).toContain('[dry run] Cancel stripe subscription');
    expect(calls.canceled).toEqual([]);
  });

  it('cancel --force cancels a gateway subscription at the period end, audited', async () => {
    const { exitCode } = await run(PaymentsSubscriptionsCancel, ['sub_1', '--force']);
    expect(exitCode).toBe(0);
    expect(calls.canceled).toEqual([{ id: 'sub_1', atPeriodEnd: true }]);
    const [audit] = await store.listAuditEvents({ action: 'subscription.canceled' });
    expect(audit).toMatchObject({ subjectId: 'sub_1', metadata: { atPeriodEnd: true } });
  });

  it('cancel --now ends a managed subscription in the store, never at the gateway', async () => {
    const id = await managedSubscription();
    const { exitCode } = await run(PaymentsSubscriptionsCancel, [id, '--now', '--force']);
    expect(exitCode).toBe(0);
    expect(calls.canceled).toEqual([]);
    const [row] = await store.listSubscriptions({ id, size: 1 });
    expect(row?.status).toBe('canceled');
  });

  it('cancel refuses without --force non-interactively, and a gone subscription', async () => {
    expect((await run(PaymentsSubscriptionsCancel, ['sub_1'])).exitCode).toBe(1);
    expect(calls.canceled).toEqual([]);
    const missing = await run(PaymentsSubscriptionsCancel, ['sub_nope', '--force']);
    expect(missing.output).toContain('No subscription "sub_nope"');
  });

  it('resume undoes a scheduled cancellation of a managed subscription', async () => {
    const id = await managedSubscription(true);
    const { exitCode } = await run(PaymentsSubscriptionsResume, [id, '--force']);
    expect(exitCode).toBe(0);
    const [row] = await store.listSubscriptions({ id, size: 1 });
    expect(row?.cancelAtPeriodEnd).toBe(false);
    const gateway = await run(PaymentsSubscriptionsResume, ['sub_1', '--force']);
    expect(gateway.exitCode).toBe(1);
    expect(gateway.output).toContain('no gateway has a portable un-cancel');
  });

  it('reprice a managed subscription from the next cycle; --dry-run shows from → to', async () => {
    const id = await managedSubscription();
    const dry = await run(PaymentsSubscriptionsReprice, [id, '--amount=1490', '--dry-run']);
    expect(dry.output).toContain('from 9.90 BRL to 14.90 BRL per cycle (from the next cycle)');
    expect((await store.listSubscriptions({ id, size: 1 }))[0]?.amount).toBe(990);

    const { exitCode } = await run(PaymentsSubscriptionsReprice, [id, '--amount=1490', '--force']);
    expect(exitCode).toBe(0);
    expect((await store.listSubscriptions({ id, size: 1 }))[0]?.amount).toBe(1490);
    const [audit] = await store.listAuditEvents({ action: 'subscription.repriced' });
    expect(audit).toMatchObject({ amount: 1490, metadata: { from: 990, to: 1490 } });
  });

  it('reprice a gateway subscription goes through the gateway; a bad amount is refused', async () => {
    await run(PaymentsSubscriptionsReprice, ['sub_1', '--amount=3990', '--force']);
    expect(calls.updated).toEqual([{ id: 'sub_1', amount: 3990 }]);
    const bad = await run(PaymentsSubscriptionsReprice, ['sub_1', '--amount=0', '--force']);
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain('`amount` must be a positive integer');
  });
});

describe('payments:disputes:*', () => {
  it('resolve --dry-run records nothing; --force closes it with the actor', async () => {
    const dry = await run(PaymentsDisputesResolve, ['dp_1', '--status=lost', '--dry-run']);
    expect(dry.output).toContain('open → lost');
    expect((await store.findDisputeByGatewayId('dp_1'))?.status).toBe('open');

    const { exitCode } = await run(PaymentsDisputesResolve, ['dp_1', '--status=lost', '--force']);
    expect(exitCode).toBe(0);
    expect((await store.findDisputeByGatewayId('dp_1'))?.status).toBe('lost');
    const [audit] = await store.listAuditEvents({ action: 'dispute.resolved' });
    expect(audit?.actor).toMatch(/^cli/);
  });

  it('resolve refuses a status that is not an ending', async () => {
    const { output, exitCode } = await run(PaymentsDisputesResolve, [
      'dp_1',
      '--status=open',
      '--force',
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain('a dispute is only resolved by ending');
  });

  it('evidence from a file: --dry-run sends nothing, --force submits once and audits the fields', async () => {
    const file = join(tmpdir(), `evidence-${process.pid}.json`);
    await writeFile(
      file,
      JSON.stringify({ documents: [{ kind: 'receipt', id: 'file_1' }], customerName: 'Ana' }),
    );
    const dry = await run(PaymentsDisputesEvidence, ['dp_1', `--file=${file}`, '--dry-run']);
    expect(dry.output).toContain('customerName, documents');
    expect(calls.evidence).toEqual([]);

    const { exitCode } = await run(PaymentsDisputesEvidence, [
      'dp_1',
      `--file=${file}`,
      '--explanation=Delivered on time',
      '--force',
    ]);
    expect(exitCode).toBe(0);
    expect(calls.evidence).toHaveLength(1);
    expect(calls.evidence[0]?.evidence).toMatchObject({ explanation: 'Delivered on time' });
    const [audit] = await store.listAuditEvents({ action: 'dispute.evidence_submitted' });
    expect(audit?.metadata).toMatchObject({
      fields: ['customerName', 'documents', 'explanation'],
    });
  });

  it('evidence refuses an empty submission and an unknown field', async () => {
    expect((await run(PaymentsDisputesEvidence, ['dp_1', '--force'])).exitCode).toBe(1);
    const file = join(tmpdir(), `evidence-bad-${process.pid}.json`);
    await writeFile(file, JSON.stringify({ secretSauce: 1 }));
    const bad = await run(PaymentsDisputesEvidence, ['dp_1', `--file=${file}`, '--force']);
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain('Unknown evidence field(s): secretSauce');
    expect(calls.evidence).toEqual([]);
  });
});

describe('payments:webhook-events:retry', () => {
  it('--dry-run names the event and runs nothing; a processed one is refused', async () => {
    const dry = await run(PaymentsWebhookEventsRetry, ['evt_bad', '--dry-run']);
    expect(dry.exitCode).toBe(0);
    expect(dry.output).toContain('failed with: handler threw');
    expect((await store.findWebhookEventByGatewayEventId('evt_bad'))?.status).toBe('failed');
  });

  it('--force replays through the processor (a row without a normalized event is 422)', async () => {
    const { output, exitCode } = await run(PaymentsWebhookEventsRetry, ['evt_bad', '--force']);
    // The seeded row predates `normalized`, so the replay is refused and the row untouched.
    expect(exitCode).toBe(1);
    expect(output).toContain('(422)');
    expect((await store.findWebhookEventByGatewayEventId('evt_bad'))?.error).toBe('handler threw');
  });
});

describe('registration', () => {
  it('registers every operator command, actions with --force/--dry-run/--note', async () => {
    const { default: loader } = await import('../../commands/main.js');
    const meta = await loader.getMetaData();
    const byName = new Map(meta.map((m) => [m.commandName, m]));
    const actions = [
      'payments:payments:refund',
      'payments:subscriptions:cancel',
      'payments:subscriptions:resume',
      'payments:subscriptions:reprice',
      'payments:disputes:resolve',
      'payments:disputes:evidence',
      'payments:webhook-events:retry',
    ];
    const reads = [
      'payments:overview',
      'payments:payments:list',
      'payments:payments:show',
      'payments:subscriptions:list',
      'payments:subscriptions:show',
      'payments:customers:list',
      'payments:disputes:list',
      'payments:webhook-events:list',
      'payments:audit:list',
      'payments:providers:list',
      'payments:organizations:list',
    ];
    for (const name of [...actions, ...reads]) {
      const flags = (byName.get(name)?.flags ?? []).map((f) => f.flagName);
      expect(flags, name).toEqual(expect.arrayContaining(['json', 'tenant']));
      // Every command boots the app (to reach the store) and none of them starts a server.
      expect(byName.get(name)?.options.startApp, name).toBe(true);
    }
    for (const name of actions) {
      const flags = (byName.get(name)?.flags ?? []).map((f) => f.flagName);
      expect(flags, name).toEqual(expect.arrayContaining(['dry-run', 'force', 'note']));
    }
    for (const name of reads) {
      const flags = (byName.get(name)?.flags ?? []).map((f) => f.flagName);
      expect(flags, name).not.toContain('force');
    }
  });
});
