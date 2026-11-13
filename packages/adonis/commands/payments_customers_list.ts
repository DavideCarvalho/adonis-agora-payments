import { flags } from '@adonisjs/core/ace';
import { PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/** `node ace payments:customers:list` — the gateway-customer → app-owner mapping. */
export default class PaymentsCustomersList extends PaymentsConsoleCommand {
  static override commandName = 'payments:customers:list';
  static override description =
    'List billing customers: which app owner each gateway customer belongs to';

  @flags.string({ description: 'Gateway name, e.g. stripe, asaas' })
  declare provider?: string;

  @flags.string({ description: 'Owner type, e.g. user, organization' })
  declare ownerType?: string;

  @flags.string({ description: 'Owner id (pair it with --owner-type)' })
  declare ownerId?: string;

  @flags.string({ description: 'Gateway customer id (exact)' })
  declare gatewayId?: string;

  @flags.number({ description: 'Page number, 1-based' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 50, at most 200)' })
  declare size?: number;

  protected async handle(): Promise<void> {
    const query = this.listQuery(
      {
        provider: this.provider,
        ownerType: this.ownerType,
        ownerId: this.ownerId,
        gatewayId: this.gatewayId,
      },
      { page: this.page, size: this.size },
    );
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.customers, { query }));
    this.printList(body, [
      ['gateway id', (r) => r.gatewayId],
      ['provider', (r) => r.provider],
      ['owner', (r) => (r.ownerType !== null ? `${r.ownerType}:${r.ownerId}` : null)],
      ['email', (r) => r.email],
      ['name', (r) => r.name],
      ['created', (r) => r.createdAt],
    ]);
  }
}
