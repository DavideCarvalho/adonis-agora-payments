import { tenantLabels, tenantOwnerTypes } from '../src/agora/tenancy.js';
import { CliError, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { everyTenantId } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:organizations:list` — with organizations (tenancy) on, the organizations that
 * own billing customers: the ids `--tenant` takes on the other `payments:*` commands.
 */
export default class PaymentsOrganizationsList extends PaymentsConsoleCommand {
  static override commandName = 'payments:organizations:list';
  static override description =
    'List the organizations that own billing customers (the ids --tenant takes)';

  protected async handle(): Promise<void> {
    const tenancy = this.tenancy();
    if (!tenancy.enabled) {
      throw new CliError('Organizations (tenancy) are off in config/payments.ts.');
    }
    const ids = await everyTenantId(await this.store(), tenantOwnerTypes(tenancy));
    const labels = await tenantLabels(ids);
    const items = ids
      .map((id) => ({ id, label: labels[id] ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (this.json) return this.printJson({ data: items });
    if (items.length === 0) {
      this.logger.info('No organization owns a billing customer yet.');
      return;
    }
    this.printTable(items, [
      ['id', (r) => r.id],
      ['label', (r) => r.label],
    ]);
  }
}
