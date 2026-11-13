import { args, flags } from '@adonisjs/core/ace';
import { money, PaymentsActionCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:subscriptions:reprice <id> --amount=<minor units>` — change what a running
 * subscription charges per cycle (managed: from the next cycle; gateway-owned: at the gateway).
 * Changes future charges: asks for confirmation unless `--force`; `--dry-run` changes nothing.
 */
export default class PaymentsSubscriptionsReprice extends PaymentsActionCommand {
  static override commandName = 'payments:subscriptions:reprice';
  static override description =
    'Change what a subscription charges per cycle (--amount in minor units)';

  @args.string({ description: 'Subscription id or gateway subscription id' })
  declare id: string;

  @flags.number({
    description: 'New price per cycle in integer minor units (e.g. 4990 = 49.90)',
    required: true,
  })
  declare amount: number;

  @flags.string({ description: 'New billing cycle (managed subscriptions only), e.g. MONTHLY' })
  declare cycle?: string;

  @flags.string({ description: 'New description of the charges' })
  declare description?: string;

  protected async handle(): Promise<void> {
    const req = {
      params: { id: this.id },
      body: {
        amount: this.amount,
        ...(this.cycle !== undefined ? { cycle: this.cycle } : {}),
        ...(this.description !== undefined ? { description: this.description } : {}),
        ...this.noteBody(),
      },
    };
    const preview = await this.preview(CONSOLE_ROUTES.repriceSubscription, req, (dry) => {
      const r = dry.reprice as {
        from: number | null;
        to: number;
        currency: string | null;
        mode: string;
      };
      return `Re-price subscription ${this.id} from ${money(r.from, r.currency)} to ${money(r.to, r.currency)} per cycle (${r.mode === 'managed' ? 'from the next cycle' : 'at the gateway'}).`;
    });
    if (preview === null) return;

    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.repriceSubscription, req));
    if (this.json) return this.printJson(body);
    this.logger.success(`Subscription ${this.id} re-priced.`);
    this.logger.info(String(body.note));
  }
}
