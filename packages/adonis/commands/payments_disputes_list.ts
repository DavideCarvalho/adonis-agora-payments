import { flags } from '@adonisjs/core/ace';
import { money, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:disputes:list` — chargebacks, newest first; `--due-within=<hours>` lists only
 * the OPEN ones whose evidence window closes within that many hours, soonest first.
 */
export default class PaymentsDisputesList extends PaymentsConsoleCommand {
  static override commandName = 'payments:disputes:list';
  static override description =
    'List disputes; --due-within=<hours> for the open evidence windows closing soonest';

  @flags.string({ description: 'Dispute status (warning, open, under_review, lost, won…)' })
  declare status?: string;

  @flags.string({ description: 'Gateway name, e.g. stripe, asaas' })
  declare provider?: string;

  @flags.number({ description: 'Only open disputes whose evidence is due within these hours' })
  declare dueWithin?: number;

  @flags.number({ description: 'Page number, 1-based' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 50, at most 200)' })
  declare size?: number;

  protected async handle(): Promise<void> {
    const query = this.listQuery(
      { status: this.status, provider: this.provider, dueWithin: this.dueWithin },
      { page: this.page, size: this.size },
    );
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.disputes, { query }));
    this.printList(body, [
      ['gateway id', (r) => r.gatewayId],
      ['payment', (r) => r.paymentGatewayId],
      ['provider', (r) => r.provider],
      ['status', (r) => r.status],
      ['amount', (r) => money(r.amount, r.currency)],
      ['reason', (r) => r.reason],
      // `null` is "the gateway sent no deadline", never "no hurry".
      ['evidence due', (r) => r.evidenceDueBy ?? 'no deadline given'],
      ['opened', (r) => r.openedAt],
    ]);
  }
}
