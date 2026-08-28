import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { billingHealth } from '../src/billing/billing_health.js';
import { resolveBillingStore } from '../src/billing/resolve_store.js';
import type { PaymentsConfig } from '../src/define_config.js';

/**
 * `node ace payments:health` — the scheduled check for the four silent failures of a
 * billing install: events claimed and never finished, events the dispatcher gave up on,
 * charges created that never confirmed, and a chargeback whose evidence window is about to
 * close. The last one is the reason to run this on a cron rather than when something looks
 * wrong: nothing is broken, and the money goes anyway if nobody answers in time.
 *
 * Exits non-zero when anything is wrong, so a cron entry or a container healthcheck can
 * page on it without parsing the output. `--json` prints the machine-readable form for a
 * metrics shipper.
 */
export default class PaymentsHealth extends BaseCommand {
  static override commandName = 'payments:health';
  static override description =
    'Report stuck webhooks, failed webhooks, unconfirmed charges and closing dispute windows';
  static override options: CommandOptions = { startApp: true };

  @flags.number({
    description: 'Minutes an event may sit unfinished before it counts as stuck (default 15)',
  })
  declare stuckAfter?: number;

  @flags.number({
    description: 'Minutes a charge may stay pending before it counts as unconfirmed (default 120)',
  })
  declare unconfirmedAfter?: number;

  @flags.number({ description: 'Window in hours that failures are counted over (default 24)' })
  declare window?: number;

  @flags.number({
    description:
      'Hours ahead to look for a dispute whose evidence window closes (default 72). Windows already past are always counted',
  })
  declare disputeWindow?: number;

  @flags.boolean({ description: 'Print the report as JSON' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    if (config.billing?.enabled === false) {
      this.logger.error(
        'The billing layer is disabled (billing.enabled = false). Nothing to check.',
      );
      this.exitCode = 1;
      return;
    }

    const store = await resolveBillingStore(config);
    const report = await billingHealth(store, {
      ...(this.stuckAfter !== undefined ? { stuckAfter: this.stuckAfter * 60_000 } : {}),
      ...(this.unconfirmedAfter !== undefined
        ? { unconfirmedAfter: this.unconfirmedAfter * 60_000 }
        : {}),
      ...(this.window !== undefined ? { failedWithin: this.window * 3_600_000 } : {}),
      ...(this.disputeWindow !== undefined
        ? { disputeDueWithin: this.disputeWindow * 3_600_000 }
        : {}),
    });

    if (this.json) {
      this.logger.log(JSON.stringify(report, null, 2));
    } else {
      for (const check of report.checks) {
        const line = `${check.count}  ${check.label}`;
        if (check.healthy) this.logger.success(line);
        else this.logger.error(`${line}\n     ${check.hint}`);
      }
      for (const failure of report.failures) {
        this.logger.info(`  ${failure.provider} ${failure.type}: ${failure.count} failed`);
      }
      // WHICH windows are closing, soonest first — a count names nobody to email and no
      // gateway dashboard to open. The list is capped; the check's count is not, so a
      // report can name twenty of fifty without pretending it named all of them.
      for (const dispute of report.deadlines) {
        const due = dispute.evidenceDueBy?.toISOString() ?? 'unknown';
        this.logger.info(
          `  ${dispute.provider} ${dispute.gatewayId} (payment ${dispute.paymentGatewayId}): evidence due ${due}`,
        );
      }
    }

    // Non-zero so a scheduler notices without reading the output.
    if (!report.healthy) this.exitCode = 1;
  }
}
