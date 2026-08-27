import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { billingHealth } from '../src/billing/billing_health.js';
import { resolveBillingStore } from '../src/billing/resolve_store.js';
import type { PaymentsConfig } from '../src/define_config.js';

/**
 * `node ace payments:health` — the scheduled check for the three silent failures of a
 * billing install: events claimed and never finished, events the dispatcher gave up on,
 * and charges created that never confirmed.
 *
 * Exits non-zero when anything is wrong, so a cron entry or a container healthcheck can
 * page on it without parsing the output. `--json` prints the machine-readable form for a
 * metrics shipper.
 */
export default class PaymentsHealth extends BaseCommand {
  static override commandName = 'payments:health';
  static override description = 'Report stuck webhooks, failed webhooks and unconfirmed charges';
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
    }

    // Non-zero so a scheduler notices without reading the output.
    if (!report.healthy) this.exitCode = 1;
  }
}
