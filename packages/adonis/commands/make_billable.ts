import { BaseCommand, args } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { stubsRoot } from '../stubs/main.js';

/**
 * `node ace make:billable <model>` — scaffold a Lucid model composed with the billing
 * mixins (`withBillable`, `withSubscription`, `withPayment`) under `app/models/`. The
 * generated model is the app-facing entry point to the billing layer: charge, subscribe,
 * and manage payment methods straight off the model.
 */
export default class MakeBillable extends BaseCommand {
  static override commandName = 'make:billable';
  static override description = 'Create a new billable Lucid model with the billing mixins';
  static override options: CommandOptions = { allowUnknownFlags: true };

  @args.string({ description: 'Name of the model (e.g. user, customer)' })
  declare name: string;

  override async run(): Promise<void> {
    const codemods = await this.createCodemods();
    await codemods.makeUsingStub(stubsRoot(), 'make/billable/main.stub', {
      flags: this.parsed.flags,
      entity: this.app.generators.createEntity(this.name),
    });
  }
}
