import { PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';
import type { ProviderCapabilities } from '../src/dashboard/handlers.js';

/**
 * `node ace payments:providers:list` — the gateways this install has data for or configures, and
 * what each can do (refunds, disputes, subscription cancel/re-price at the gateway).
 */
export default class PaymentsProvidersList extends PaymentsConsoleCommand {
  static override commandName = 'payments:providers:list';
  static override description =
    'List the gateways in use and what each can do (refunds, disputes, subscription operations)';

  protected async handle(): Promise<void> {
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.providers, {}));
    if (this.json) return this.printJson(body);
    const capabilities = body.capabilities as Record<string, ProviderCapabilities>;
    const names = [
      ...new Set([...(body.providers as string[]), ...Object.keys(capabilities)]),
    ].sort();
    if (names.length === 0) {
      this.logger.info('No gateways configured and no billing data yet.');
      return;
    }
    const flag = (value: boolean | undefined) =>
      value === undefined ? 'not configured' : value ? 'yes' : 'no';
    this.printTable(
      names.map((name) => ({ name, ...(capabilities[name] ?? {}) })),
      [
        ['provider', (r) => r.name],
        ['refunds', (r) => flag(r.refunds as boolean | undefined)],
        ['disputes', (r) => flag(r.disputes as boolean | undefined)],
        ['gateway cancel', (r) => flag(r.cancelSubscription as boolean | undefined)],
        ['gateway re-price', (r) => flag(r.updateSubscription as boolean | undefined)],
      ],
    );
    const types = body.eventTypes as string[];
    if (types.length > 0) this.logger.log(`event types seen: ${types.join(', ')}`);
  }
}
