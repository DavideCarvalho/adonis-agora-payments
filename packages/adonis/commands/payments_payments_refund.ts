import { args, flags } from '@adonisjs/core/ace';
import { money, PaymentsActionCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:payments:refund <gatewayId> [--amount=<minor units>]` — refund a paid payment
 * through the gateway that took it, exactly as the console's Refund button does. MOVES MONEY: asks
 * for confirmation unless `--force`; `--dry-run` shows what would be refunded and sends nothing.
 */
export default class PaymentsPaymentsRefund extends PaymentsActionCommand {
  static override commandName = 'payments:payments:refund';
  static override description =
    'Refund a paid payment through its gateway (whole, or --amount in minor units)';

  @args.string({ description: 'Gateway payment id' })
  declare gatewayId: string;

  @flags.number({
    description:
      'Partial refund in integer minor units (e.g. 1990 = 19.90). Omit for the full amount',
  })
  declare amount?: number;

  protected async handle(): Promise<void> {
    const req = {
      params: { gatewayId: this.gatewayId },
      body: { ...(this.amount !== undefined ? { amount: this.amount } : {}), ...this.noteBody() },
    };
    const preview = await this.preview(CONSOLE_ROUTES.refund, req, (dry) => {
      const refund = dry.refund as { amount: number; currency: string; partial: boolean };
      const payment = dry.payment as { provider: string };
      return `Refund ${money(refund.amount, refund.currency)}${refund.partial ? ' (partial)' : ''} of payment ${this.gatewayId} through ${payment.provider}.`;
    });
    if (preview === null) return;

    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.refund, req));
    if (this.json) return this.printJson(body);
    const refund = body.refund as {
      gatewayId: string;
      amount: number;
      currency: string;
      status: string;
    };
    this.logger.success(
      `Refund ${refund.gatewayId} (${refund.status}): ${money(refund.amount, refund.currency)}`,
    );
    this.logger.info(String(body.note));
  }
}
