import { args } from '@adonisjs/core/ace';
import { money, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/** `node ace payments:subscriptions:show <id>` — one subscription, by its id or gateway id. */
export default class PaymentsSubscriptionsShow extends PaymentsConsoleCommand {
  static override commandName = 'payments:subscriptions:show';
  static override description =
    'Show one subscription (by id or gateway id): state, customer, payments and audit rows';

  @args.string({ description: 'Subscription id or gateway subscription id' })
  declare id: string;

  protected async handle(): Promise<void> {
    const body = this.bodyOf(
      await this.serve(CONSOLE_ROUTES.subscriptionDetail, { params: { id: this.id } }),
    );
    if (this.json) return this.printJson(body);
    const s = body.subscription as Record<string, unknown>;
    const customer = body.customer as Record<string, unknown> | null;
    this.printFields([
      ['id', s.id],
      ['gateway id', s.gatewayId],
      ['provider', s.provider],
      ['mode', s.managed === true ? 'managed' : 'gateway'],
      ['status', s.status],
      ['plan', s.planId],
      ['amount', money(s.amount, s.currency)],
      ['cycle', s.cycle],
      ['current period end', s.currentPeriodEnd],
      ['next charge', s.nextChargeAt],
      ['cancels at period end', s.cancelAtPeriodEnd],
      ['renewal failures', s.renewalFailureCount],
      ['last renewal error', s.lastRenewalError],
      [
        'customer',
        customer === null
          ? s.customerId
          : `${customer.gatewayId} (${customer.email ?? customer.ownerId ?? '—'})`,
      ],
    ]);
    const payments = body.payments as Record<string, unknown>[];
    if (payments.length > 0) {
      this.logger.log('\nPayments');
      this.printTable(payments, [
        ['gateway id', (r) => r.gatewayId],
        ['status', (r) => r.status],
        ['amount', (r) => money(r.amount, r.currency)],
        ['created', (r) => r.createdAt],
      ]);
    }
    const audit = body.audit as Record<string, unknown>[];
    if (audit.length > 0) {
      this.logger.log('\nAudit');
      this.printTable(audit, [
        ['action', (r) => r.action],
        ['actor', (r) => r.actor],
        ['message', (r) => r.message],
        ['at', (r) => r.createdAt],
      ]);
    }
  }
}
