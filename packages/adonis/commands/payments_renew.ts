import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';

/** Subscriptions charged per pass unless `--limit` says otherwise. */
const DEFAULT_LIMIT = 100;

/**
 * `node ace payments:renew [--limit=100] [--dry-run]` — charge every library-managed
 * subscription whose cycle is due.
 *
 * Only `subscriptions.mode: 'managed'` rows are touched; gateway-owned subscriptions renew
 * themselves and are not this command's business.
 *
 * **Nothing calls this for you.** Managed subscriptions do not renew on their own: point a
 * cron, a durable schedule or a queue worker at this command. Run it more often than your
 * shortest cycle — an hourly tick is fine for monthly billing, and a subscription that
 * becomes due is simply charged on the next pass.
 *
 * Running it twice over the same window is safe. Each cycle's charge carries an idempotency
 * key built from the subscription and the period start (`cycleIdempotencyKey`), so an
 * overlapping run — a retried worker, an operator kicking it by hand after one looked stuck —
 * asks the gateway for the same charge instead of a second one.
 *
 * A charge that fails does not advance the period and does not stop the pass: that
 * subscription stays due and is retried next tick, while everyone else is still renewed. How
 * many failures should cancel someone is a dunning policy the application owns — this
 * command reports failures and cancels nobody.
 */
export default class PaymentsRenew extends BaseCommand {
  static override commandName = 'payments:renew';
  static override description = 'Charge library-managed subscriptions whose cycle is due';
  static override options: CommandOptions = { startApp: true };

  @flags.number({
    description: `Maximum subscriptions to charge in one pass (default ${DEFAULT_LIMIT})`,
  })
  declare limit?: number;

  @flags.boolean({ description: 'List what is due without charging anything' })
  declare dryRun?: boolean;

  override async run(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    if (config.billing?.enabled === false) {
      this.logger.error(
        'The billing layer is disabled (billing.enabled = false), and managed subscriptions live in it. Nothing to renew.',
      );
      return;
    }

    const manager = await this.app.container.make(PaymentsManager);
    const limit = this.limit ?? DEFAULT_LIMIT;

    if (this.dryRun === true) {
      // `due()` and not `renewDue()`: the latter CHARGES. Runs the same store query the real
      // pass does, so the preview cannot disagree with what would happen.
      const due = await manager.subscriptions().due({ limit });
      for (const subscription of due) this.logger.info(`due: ${subscription.id}`);
      this.logger.info(`${due.length} subscription(s) would be charged.`);
      return;
    }

    const outcomes = await manager.subscriptions().renewDue({ limit });

    const charged = outcomes.filter((o) => o.result === 'charged').length;
    const ended = outcomes.filter((o) => o.result === 'ended').length;
    const failed = outcomes.filter((o) => o.result === 'failed');

    for (const failure of failed) {
      // Named individually: a count cannot tell anyone which customer to look at.
      this.logger.error(`subscription ${failure.subscriptionId}: ${failure.error}`);
    }

    this.logger.info(`charged ${charged}, ended ${ended}, failed ${failed.length}`);
    // A non-zero exit so a cron wrapper notices. The pass itself already did everything it
    // could — this reports, it does not undo.
    if (failed.length > 0) this.exitCode = 1;
  }
}
