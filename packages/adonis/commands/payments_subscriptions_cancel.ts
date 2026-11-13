import { args, flags } from '@adonisjs/core/ace';
import { PaymentsActionCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:subscriptions:cancel <id> [--now]` — cancel a running subscription at the end
 * of its paid period (default) or immediately, through the gateway that owns it or, for a managed
 * one, in this store. Asks for confirmation unless `--force`; `--dry-run` changes nothing.
 */
export default class PaymentsSubscriptionsCancel extends PaymentsActionCommand {
  static override commandName = 'payments:subscriptions:cancel';
  static override description =
    'Cancel a subscription at the period end (default) or --now, through its gateway or managed row';

  @args.string({ description: 'Subscription id or gateway subscription id' })
  declare id: string;

  @flags.boolean({ description: 'End it now instead of at the end of the paid period' })
  declare now?: boolean;

  protected async handle(): Promise<void> {
    const req = {
      params: { id: this.id },
      body: { atPeriodEnd: this.now !== true, ...this.noteBody() },
    };
    const preview = await this.preview(CONSOLE_ROUTES.cancelSubscription, req, (dry) => {
      const s = dry.subscription as { id: string; provider: string; managed: boolean };
      return `Cancel ${s.managed ? 'managed' : `${s.provider}`} subscription ${s.id} ${this.now === true ? 'NOW' : 'at the end of the paid period'}.`;
    });
    if (preview === null) return;

    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.cancelSubscription, req));
    if (this.json) return this.printJson(body);
    this.logger.success(
      `Subscription ${this.id} ${this.now === true ? 'canceled' : 'set to cancel at the period end'}.`,
    );
    this.logger.info(String(body.note));
  }
}
