import { args } from '@adonisjs/core/ace';
import { PaymentsActionCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:subscriptions:resume <id>` — undo the scheduled cancellation of a MANAGED
 * subscription. Asks for confirmation unless `--force`; `--dry-run` changes nothing.
 */
export default class PaymentsSubscriptionsResume extends PaymentsActionCommand {
  static override commandName = 'payments:subscriptions:resume';
  static override description = 'Undo the scheduled cancellation of a managed subscription';

  @args.string({ description: 'Subscription id' })
  declare id: string;

  protected async handle(): Promise<void> {
    const req = { params: { id: this.id }, body: this.noteBody() };
    const preview = await this.preview(
      CONSOLE_ROUTES.resumeSubscription,
      req,
      () => `Put subscription ${this.id} back on renewal (its next charge happens as scheduled).`,
    );
    if (preview === null) return;

    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.resumeSubscription, req));
    if (this.json) return this.printJson(body);
    this.logger.success(`Subscription ${this.id} is back on renewal.`);
  }
}
