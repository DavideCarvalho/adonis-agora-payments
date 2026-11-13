import { flags } from '@adonisjs/core/ace';
import { PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/** `node ace payments:webhook-events:list` — the webhook ledger, newest first (never payloads). */
export default class PaymentsWebhookEventsList extends PaymentsConsoleCommand {
  static override commandName = 'payments:webhook-events:list';
  static override description =
    'List the webhook ledger: event type, status and the error a failed handler threw';

  @flags.string({ description: 'Event status: received, processed, failed' })
  declare status?: string;

  @flags.string({ description: 'Gateway name, e.g. stripe, asaas' })
  declare provider?: string;

  @flags.string({ description: 'Normalized event type, e.g. payment.paid' })
  declare type?: string;

  @flags.number({ description: 'Page number, 1-based' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 50, at most 200)' })
  declare size?: number;

  protected async handle(): Promise<void> {
    const query = this.listQuery(
      { status: this.status, provider: this.provider, type: this.type },
      { page: this.page, size: this.size },
    );
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.webhookEvents, { query }));
    this.printList(body, [
      ['event id', (r) => r.gatewayEventId],
      ['provider', (r) => r.provider],
      ['type', (r) => r.type],
      ['status', (r) => r.status],
      ['error', (r) => r.error],
      ['created', (r) => r.createdAt],
    ]);
  }
}
