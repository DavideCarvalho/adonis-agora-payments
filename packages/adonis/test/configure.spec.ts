import { describe, expect, it, vi } from 'vitest';
import { configure } from '../configure.js';

/**
 * Everything `node ace add` is supposed to wire has to actually be wired. A
 * missing entry here is invisible: the app boots, and the feature it enables
 * just never happens.
 */
function fakeCommand() {
  const rcFile = {
    providers: [] as string[],
    commands: [] as string[],
    hooks: [] as Array<{ event: string; path: string }>,
    addProvider(path: string) {
      this.providers.push(path);
    },
    addCommand(path: string) {
      this.commands.push(path);
    },
    addAssemblerHook(event: string, path: string) {
      this.hooks.push({ event, path });
    },
  };

  const stubs: string[] = [];
  const codemods = {
    async updateRcFile(callback: (file: typeof rcFile) => void) {
      callback(rcFile);
    },
    async makeUsingStub(_root: string, stub: string) {
      stubs.push(stub);
    },
    async defineEnvValidations() {},
  };

  return {
    rcFile,
    stubs,
    command: { createCodemods: vi.fn(async () => codemods) },
  };
}

describe('configure', () => {
  it('registers the provider and the commands', async () => {
    const { command, rcFile } = fakeCommand();
    await configure(command as never);

    expect(rcFile.providers).toContain('@adonis-agora/payments/payments_provider');
    expect(rcFile.commands).toContain('@adonis-agora/payments/commands');
  });

  it('registers the webhook-handlers Assembler hook, so nobody edits adonisrc by hand', async () => {
    const { command, rcFile } = fakeCommand();
    await configure(command as never);

    expect(rcFile.hooks).toContainEqual({
      event: 'init',
      path: '@adonis-agora/payments/hooks/webhook_handlers',
    });
  });

  it('publishes the config and the billing migration', async () => {
    const { command, stubs } = fakeCommand();
    await configure(command as never);

    expect(stubs).toContain('config/payments.stub');
    expect(stubs).toContain('database/migrations/create_billing_tables.stub');
  });
});
