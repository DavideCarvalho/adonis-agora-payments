import { describe, expect, it, vi } from 'vitest';
import { claimPaymentsDiagnostics } from '../src/diagnostics.js';
import { registerPaymentsWatcher } from '../src/telescope/register.js';

/** A telescope service on the container, or a container that has never heard of one. */
function host(service?: unknown) {
  return {
    container: {
      make: async () => {
        if (service === undefined) throw new Error('IoC container: token is not bound');
        return service;
      },
    },
  } as Parameters<typeof registerPaymentsWatcher>[0];
}

function fakeWatcher() {
  return {
    type: 'payments' as const,
    register: vi.fn(),
    dispose: vi.fn(),
  };
}

const present = () => Promise.resolve({ TelescopeService: class {} });
const absent = () => Promise.reject(new Error("Cannot find package '@adonis-agora/telescope'"));

describe('registerPaymentsWatcher', () => {
  it('wires the watcher to the telescope store when telescope is there', async () => {
    // The six lines every app used to copy into `start/telescope.ts`. Until someone did, a
    // payments timeline showed generic `diagnostic` entries with the payload buried.
    const record = vi.fn().mockResolvedValue(undefined);
    const watcher = fakeWatcher();

    const registered = await registerPaymentsWatcher(host({ telescopeStore: { record } }), {
      importTelescope: present,
      makeWatcher: () => watcher as never,
      alreadyClaimed: () => false,
    });

    expect(watcher.register).toHaveBeenCalledOnce();
    expect(registered).toBe(watcher);

    // And what it handed over actually reaches the store.
    const ctx = watcher.register.mock.calls[0]![0] as { record: (e: unknown) => void };
    ctx.record({ type: 'payments', content: { event: 'charge.created' } });
    expect(record).toHaveBeenCalledWith({ type: 'payments', content: { event: 'charge.created' } });
  });

  it('does not let a failing telescope store break the payment that published', async () => {
    // Recording is observability. `record` is called synchronously inside the charge that
    // triggered the diagnostics publish, so a rejected write must not escape — under Node's
    // default an unhandled rejection takes the process down.
    //
    // Two ways to write this measure nothing, and both were tried first: `not.toThrow()`
    // passes either way, because `void promise` never throws synchronously; and listening
    // for `unhandledRejection` never fires, because vitest installs its own handler. The one
    // observable difference is whether a rejection handler is ATTACHED, so the store hands
    // back a thenable that says.
    const watcher = fakeWatcher();
    const attached = vi.fn();
    // A stand-in for a promise is the point: the assertion is about whether a rejection
    // handler gets attached to what `record` returns, which is only observable from the
    // object itself.
    const thenable = {
      catch: (handler: (reason: unknown) => unknown) => {
        attached(handler);
        return thenable;
      },
      // biome-ignore lint/suspicious/noThenProperty: see above — this is a fake promise.
      then: () => thenable,
    };

    await registerPaymentsWatcher(
      host({ telescopeStore: { record: () => thenable as unknown as Promise<unknown> } }),
      {
        importTelescope: present,
        makeWatcher: () => watcher as never,
        alreadyClaimed: () => false,
      },
    );

    const ctx = watcher.register.mock.calls[0]![0] as { record: (e: unknown) => void };
    ctx.record({ type: 'payments', content: {} });

    expect(
      attached,
      'the rejected telescope write has no handler and will escape',
    ).toHaveBeenCalled();
  });

  it('uses the real claims registry when nothing overrides it', async () => {
    // The default `alreadyClaimed` reads the shared claims registry, and every other test
    // here overrides it. Without this one, the production path — the one the provider takes
    // — would be the only path with no coverage at all.
    const watcher = fakeWatcher();
    const release = claimPaymentsDiagnostics(['charge.created']);
    try {
      const registered = await registerPaymentsWatcher(
        host({ telescopeStore: { record: vi.fn() } }),
        {
          importTelescope: present,
          makeWatcher: () => watcher as never,
        },
      );
      expect(registered, 'registered a second watcher over a live claim').toBeUndefined();
    } finally {
      release();
    }

    // And with the claim released, the same call registers.
    const after = await registerPaymentsWatcher(host({ telescopeStore: { record: vi.fn() } }), {
      importTelescope: present,
      makeWatcher: () => watcher as never,
    });
    expect(after).toBe(watcher);
  });

  it('says nothing when telescope is absent', async () => {
    // An app without observability is a normal app, not a misconfigured one. It must not
    // fail to boot, and it must not be told about it on every start.
    const watcher = fakeWatcher();
    const registered = await registerPaymentsWatcher(host(), {
      importTelescope: absent,
      makeWatcher: () => watcher as never,
      alreadyClaimed: () => false,
    });

    expect(registered).toBeUndefined();
    expect(watcher.register).not.toHaveBeenCalled();
  });

  it('stands down when the app already wired its own watcher', async () => {
    // The docs used to say to wire `PaymentsWatcher` by hand in `start/telescope.ts`. Those
    // apps have already claimed the payments channels, and registering a second watcher
    // would record every payment event twice — to the app that followed the instructions.
    //
    // This is why there is no `telescope: false` option: the claims registry already knows.
    const watcher = fakeWatcher();
    const importTelescope = vi.fn(present);

    const registered = await registerPaymentsWatcher(
      host({ telescopeStore: { record: vi.fn() } }),
      {
        importTelescope,
        makeWatcher: () => watcher as never,
        alreadyClaimed: () => true,
      },
    );

    expect(registered).toBeUndefined();
    expect(watcher.register).not.toHaveBeenCalled();
    // Not even asked for — the claim check comes first, so no import cost on an app that
    // does its own wiring.
    expect(importTelescope).not.toHaveBeenCalled();
  });
});
