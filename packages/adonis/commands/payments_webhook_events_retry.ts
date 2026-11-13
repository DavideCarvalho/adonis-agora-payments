import { args } from '@adonisjs/core/ace';
import { PaymentsActionCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:webhook-events:retry <gatewayEventId>` — re-run a FAILED webhook event through
 * the app's handlers, from the stored event (the ledger refuses an in-flight or processed one, so
 * it never applies twice). Asks for confirmation unless `--force`; `--dry-run` runs nothing.
 */
export default class PaymentsWebhookEventsRetry extends PaymentsActionCommand {
  static override commandName = 'payments:webhook-events:retry';
  static override description = "Re-run a failed webhook event through the app's handlers";

  @args.string({ description: 'Gateway event id of a failed event' })
  declare gatewayEventId: string;

  protected async handle(): Promise<void> {
    const req = { params: { gatewayEventId: this.gatewayEventId }, body: {} };
    const preview = await this.preview(CONSOLE_ROUTES.retry, req, (dry) => {
      return `Re-run ${dry.provider} ${dry.type} event ${this.gatewayEventId} (failed with: ${dry.previousError ?? 'no error recorded'}).`;
    });
    if (preview === null) return;

    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.retry, req));
    if (this.json) return this.printJson(body);
    this.logger.success(`Event ${this.gatewayEventId} processed.`);
  }
}
