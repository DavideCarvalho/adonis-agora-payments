import { describe, expect, it, vi } from 'vitest';
import { configure } from '../configure.js';

/**
 * Everything `node ace add` is supposed to wire has to actually be wired. A
 * missing entry here is invisible: the app boots, and the feature it enables
 * just never happens.
 */
function fakeCommand(parsedFlags?: Record<string, unknown>) {
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
    defineEnvValidations: vi.fn(async () => {}),
  };

  return {
    rcFile,
    stubs,
    codemods,
    command: { createCodemods: vi.fn(async () => codemods), parsedFlags },
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
    // All three, in order: the two later files are the only way the columns and the table
    // added after `create_billing_tables` shipped ever reach an install that already ran it.
  });

  it('--topology=tenant publishes the one-line tenant config and no credential env vars', async () => {
    const { command, stubs, rcFile, codemods } = fakeCommand({ topology: 'tenant' });
    await configure(command as never);

    expect(stubs).toEqual([
      'config/payments_tenant.stub',
      'config/payments_dashboard.stub',
      'config/payments_client.stub',
      'database/migrations/create_billing_tables.stub',
      'database/migrations/add_billing_list_indexes.stub',
    ]);
    expect(rcFile.providers).toContain('@adonis-agora/payments/payments_provider');
    // The gateway credentials belong to the control plane.
    expect(codemods.defineEnvValidations).not.toHaveBeenCalled();
  });

  it('any other --topology value keeps the standalone config', async () => {
    const { command, stubs, codemods } = fakeCommand({ topology: 'standalone' });
    await configure(command as never);

    expect(stubs[0]).toBe('config/payments.stub');
    expect(stubs).not.toContain('config/payments_tenant.stub');
    expect(codemods.defineEnvValidations).toHaveBeenCalledOnce();
  });
});
