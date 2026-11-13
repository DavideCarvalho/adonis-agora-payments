import { args, flags } from '@adonisjs/core/ace';
import { PaymentsActionCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';
import { DISPUTE_RESOLUTION_STATUSES } from '../src/dashboard/handlers.js';

/**
 * `node ace payments:disputes:resolve <gatewayId> --status=<lost|won|…>` — record how a dispute
 * ENDED at the gateway (for gateways that never send a closing event). Sends nothing to the
 * gateway. Asks for confirmation unless `--force`; `--dry-run` records nothing.
 */
export default class PaymentsDisputesResolve extends PaymentsActionCommand {
  static override commandName = 'payments:disputes:resolve';
  static override description =
    'Record how a dispute ended at the gateway (sends nothing to the gateway)';

  @args.string({ description: 'Gateway dispute id' })
  declare gatewayId: string;

  @flags.string({
    description: `How it ended: ${DISPUTE_RESOLUTION_STATUSES.join(', ')}`,
    required: true,
  })
  declare status: string;

  @flags.string({ description: 'Outcome label (default: the status)' })
  declare outcome?: string;

  protected async handle(): Promise<void> {
    const req = {
      params: { gatewayId: this.gatewayId },
      body: {
        status: this.status,
        ...(this.outcome !== undefined ? { outcome: this.outcome } : {}),
        ...this.noteBody(),
      },
    };
    const preview = await this.preview(CONSOLE_ROUTES.resolve, req, (dry) => {
      const d = dry.dispute as { previousStatus: string; status: string; outcome: string };
      return `Close dispute ${this.gatewayId} locally: ${d.previousStatus} → ${d.status} (outcome ${d.outcome}).`;
    });
    if (preview === null) return;

    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.resolve, req));
    if (this.json) return this.printJson(body);
    this.logger.success(`Dispute ${this.gatewayId} recorded as ${this.status}.`);
    this.logger.info(String(body.note));
  }
}
