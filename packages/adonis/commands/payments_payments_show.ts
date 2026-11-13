import { args } from '@adonisjs/core/ace';
import { money, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/** `node ace payments:payments:show <gatewayId>` — one payment, as the console's detail shows it. */
export default class PaymentsPaymentsShow extends PaymentsConsoleCommand {
  static override commandName = 'payments:payments:show';
  static override description =
    'Show one payment: state, owner, disputes, webhook events and audit rows';

  @args.string({ description: 'Gateway payment id' })
  declare gatewayId: string;

  protected async handle(): Promise<void> {
    const body = this.bodyOf(
      await this.serve(CONSOLE_ROUTES.paymentDetail, { params: { gatewayId: this.gatewayId } }),
    );
    if (this.json) return this.printJson(body);
    const p = body.payment as Record<string, unknown>;
    this.printFields([
      ['gateway id', p.gatewayId],
      ['provider', p.provider],
      ['status', p.status],
      ['amount', money(p.amount, p.currency)],
      ['refunded', money(p.refundedAmount, p.currency)],
      ['refundable', p.refundable],
      ['reference', p.externalReference],
      ['customer', p.customerId],
      ['subscription', p.subscriptionId],
      ['paid at', p.paidAt],
      ['created', p.createdAt],
    ]);
    const disputes = body.disputes as Record<string, unknown>[];
    if (disputes.length > 0) {
      this.logger.log('\nDisputes');
      this.printTable(disputes, [
        ['gateway id', (r) => r.gatewayId],
        ['status', (r) => r.status],
        ['amount', (r) => money(r.amount, r.currency)],
        ['evidence due', (r) => r.evidenceDueBy],
      ]);
    }
    const events = (body.events as { rows: Record<string, unknown>[] }).rows;
    if (events.length > 0) {
      this.logger.log('\nWebhook events');
      this.printTable(events, [
        ['event id', (r) => r.gatewayEventId],
        ['type', (r) => r.type],
        ['status', (r) => r.status],
        ['created', (r) => r.createdAt],
      ]);
    }
    const audit = body.audit as Record<string, unknown>[];
    if (audit.length > 0) {
      this.logger.log('\nAudit');
      this.printTable(audit, [
        ['action', (r) => r.action],
        ['actor', (r) => r.actor],
        ['amount', (r) => money(r.amount, r.currency)],
        ['at', (r) => r.createdAt],
      ]);
    }
  }
}
