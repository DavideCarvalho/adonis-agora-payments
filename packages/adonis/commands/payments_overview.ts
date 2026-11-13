import { flags } from '@adonisjs/core/ace';
import { money, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';
import { PERIOD_PRESETS } from '../src/dashboard/period.js';

/** `node ace payments:overview` — the console's overview: revenue, active subscriptions, usage. */
export default class PaymentsOverview extends PaymentsConsoleCommand {
  static override commandName = 'payments:overview';
  static override description =
    'Billing metrics for a period: revenue, active subscriptions and usage per meter';

  @flags.string({ description: `A preset window: ${PERIOD_PRESETS.join(', ')}` })
  declare period?: string;

  @flags.string({ description: 'Custom window start (ISO date)' })
  declare from?: string;

  @flags.string({ description: 'Custom window end (ISO date)' })
  declare to?: string;

  protected async handle(): Promise<void> {
    const query: Record<string, string> = {};
    if (this.period !== undefined) query.period = this.period;
    if (this.from !== undefined) query.from = this.from;
    if (this.to !== undefined) query.to = this.to;
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.overview, { query }));
    if (this.json) return this.printJson(body);
    const period = body.period as { from: string; to: string; preset: string | null };
    const metrics = body.metrics as Array<{ key: string; label: string; value: number }>;
    this.printFields([
      ['period', `${period.from} → ${period.to}${period.preset ? ` (${period.preset})` : ''}`],
    ]);
    // Money lines are integer minor units ("(cents)" in the label); shown in the currency.
    const isMoney = (key: string) => key === 'revenue' || key === 'net_revenue' || key === 'mrr';
    this.printTable(metrics, [
      ['metric', (r) => String(r.label).replace(/ \(cents\)$/, '')],
      ['value', (r) => (isMoney(String(r.key)) ? money(r.value, body.currency) : r.value)],
    ]);
  }
}
