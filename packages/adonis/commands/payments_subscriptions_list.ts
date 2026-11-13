import { flags } from '@adonisjs/core/ace';
import { money, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/** `node ace payments:subscriptions:list` — the console's subscriptions list, newest first. */
export default class PaymentsSubscriptionsList extends PaymentsConsoleCommand {
  static override commandName = 'payments:subscriptions:list';
  static override description =
    'List subscriptions, newest first, with the past_due and failing-renewal totals';

  @flags.string({ description: 'Subscription status (past_due, paused, active, canceled…)' })
  declare status?: string;

  @flags.string({ description: 'Gateway name, e.g. stripe, asaas' })
  declare provider?: string;

  @flags.string({ description: 'Gateway customer id (exact)' })
  declare customerId?: string;

  @flags.number({ description: 'Page number, 1-based' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 50, at most 200)' })
  declare size?: number;

  protected async handle(): Promise<void> {
    const query = this.listQuery(
      { status: this.status, provider: this.provider, customerId: this.customerId },
      { page: this.page, size: this.size },
    );
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.subscriptions, { query }));
    this.printList(body, [
      ['id', (r) => r.id],
      ['gateway id', (r) => r.gatewayId],
      ['provider', (r) => r.provider],
      ['status', (r) => (r.cancelAtPeriodEnd === true ? `${r.status} (cancels)` : r.status)],
      ['plan', (r) => r.planId],
      ['amount', (r) => money(r.amount, r.currency)],
      ['cycle', (r) => r.cycle],
      ['next charge', (r) => r.nextChargeAt ?? r.currentPeriodEnd],
      ['renewal failures', (r) => r.renewalFailureCount],
    ]);
    if (!this.json) {
      const counts = body.counts as { past_due: number; failing_renewals: number };
      this.logger.log(
        `past_due: ${counts.past_due} · failing renewals: ${counts.failing_renewals}`,
      );
    }
  }
}
