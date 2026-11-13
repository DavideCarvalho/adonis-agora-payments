import { flags } from '@adonisjs/core/ace';
import { money, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/** `node ace payments:audit:list` — the billing audit trail: who refunded, resolved, retried… */
export default class PaymentsAuditList extends PaymentsConsoleCommand {
  static override commandName = 'payments:audit:list';
  static override description =
    'List the billing audit trail: refunds, dispute resolutions, retries and refused deliveries';

  @flags.string({ description: 'Action, e.g. payment.refunded, webhook.rejected' })
  declare action?: string;

  @flags.string({ description: 'Who did it (exact), e.g. cli:deploy' })
  declare actor?: string;

  @flags.string({ description: 'Gateway name, e.g. stripe, asaas' })
  declare provider?: string;

  @flags.string({ description: 'Subject type: payment, dispute, subscription, webhook…' })
  declare subjectType?: string;

  @flags.string({ description: 'Subject id (exact)' })
  declare subjectId?: string;

  @flags.number({ description: 'Page number, 1-based' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 50, at most 200)' })
  declare size?: number;

  protected async handle(): Promise<void> {
    const query = this.listQuery(
      {
        action: this.action,
        actor: this.actor,
        provider: this.provider,
        subjectType: this.subjectType,
        subjectId: this.subjectId,
      },
      { page: this.page, size: this.size },
    );
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.audit, { query }));
    this.printList(body, [
      ['action', (r) => r.action],
      ['actor', (r) => r.actor ?? 'unattributed'],
      ['subject', (r) => (r.subjectType !== null ? `${r.subjectType}:${r.subjectId}` : null)],
      ['provider', (r) => r.provider],
      ['amount', (r) => money(r.amount, r.currency)],
      ['message', (r) => r.message],
      ['at', (r) => r.createdAt],
    ]);
  }
}
