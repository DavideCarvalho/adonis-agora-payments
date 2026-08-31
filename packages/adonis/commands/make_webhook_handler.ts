import { args, BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { stubsRoot } from '../stubs/main.js';

/**
 * `node ace make:webhook-handler <event>` — scaffold a webhook handler under
 * `app/payment_handlers/`, the parallel to durable's `make:workflow` (which scaffolds
 * `app/workflows/`). The generated class declares `static eventType` (the normalized
 * event it listens to, e.g. `payment.succeeded`) and a `handle(event)` method, and is
 * auto-registered on the payments provider's webhook route at boot — no manual wiring.
 *
 * Register the Assembler `init` hook first so the folder is codegen'd:
 * `hooks: { init: [() => import('@adonis-agora/payments/hooks/webhook_handlers')] }`.
 */
export default class MakeWebhookHandler extends BaseCommand {
  static override commandName = 'make:webhook-handler';
  static override description = 'Create a new webhook handler in app/payment_handlers/';
  static override options: CommandOptions = { allowUnknownFlags: true };

  @args.string({ description: 'Normalized event name (e.g. payment.succeeded)' })
  declare name: string;

  override async run(): Promise<void> {
    const codemods = await this.createCodemods();
    await codemods.makeUsingStub(stubsRoot(), 'make/webhook_handler/main.stub', {
      flags: this.parsed.flags,
      entity: this.app.generators.createEntity(this.name),
    });
  }
}
