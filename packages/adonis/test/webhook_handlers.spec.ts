import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../src/types.js';
import {
  discoverWebhookHandlers,
  isWebhookHandlerService,
  normalizeWebhookHandlerModule,
  resolveWebhookHandler,
} from '../src/webhook_handlers.js';
import type { WebhookHandlerService } from '../src/webhook_handlers.js';

const event = { id: 'e1', type: 'payment.succeeded', data: {}, raw: {} } as WebhookEvent;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'payments-handlers-'));
  tempDirs.push(dir);
  return dir;
}

describe('webhook handler discovery', () => {
  it('detects a service class (has a handle method) vs a plain function', () => {
    class Handler {
      static readonly eventType = 'payment.succeeded';
      handle(_event: WebhookEvent): void {}
    }
    expect(isWebhookHandlerService(Handler)).toBe(true);
    expect(isWebhookHandlerService(() => {})).toBe(false);
  });

  it('normalizes an object-form module ({ type, handle })', () => {
    const handle = () => {};
    const normalized = normalizeWebhookHandlerModule({ type: 'payment.succeeded', handle });
    expect(normalized).toEqual({ type: 'payment.succeeded', entry: handle });
  });

  it('normalizes a service-class module (static eventType + handle)', () => {
    class Handler {
      static readonly eventType = 'payment.succeeded';
      handle(_event: WebhookEvent): void {}
    }
    const normalized = normalizeWebhookHandlerModule(Handler);
    expect(normalized?.type).toBe('payment.succeeded');
    expect(isWebhookHandlerService(normalized!.entry as WebhookHandlerService)).toBe(true);
  });

  it('rejects a module without a type', () => {
    expect(normalizeWebhookHandlerModule({ handle: () => {} })).toBeNull();
  });

  it('resolves a service class through the container and calls handle', async () => {
    class Handler {
      static readonly eventType = 'payment.succeeded';
      calls = 0;
      handle(_event: WebhookEvent): void {
        this.calls += 1;
      }
    }
    const container = { make: async () => new Handler() };
    const resolved = await resolveWebhookHandler(Handler, container);
    await resolved(event);
    await resolved(event);
    expect(((await container.make(Handler)) as Handler).calls).toBe(0); // container returned a fresh instance each make
    expect(typeof resolved).toBe('function');
  });

  it('passes plain functions through unchanged', async () => {
    const handle = () => {};
    const resolved = await resolveWebhookHandler(handle, { make: async () => ({}) });
    expect(resolved).toBe(handle);
  });

  it('discovers handler modules from a directory', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'payment_succeeded.ts'),
      `export default { type: 'payment.succeeded', handle: () => {} }`,
    );
    await writeFile(
      join(dir, 'subscription_canceled.ts'),
      `export default class H { static eventType = 'subscription.canceled'; handle() {} }`,
    );
    await writeFile(join(dir, 'not_a_handler.ts'), 'export const x = 1');
    const found = await discoverWebhookHandlers(dir);
    expect(found.map((f) => f.type).sort()).toEqual(['payment.succeeded', 'subscription.canceled']);
  });

  it('returns [] for a missing directory (convention is opt-in)', async () => {
    expect(await discoverWebhookHandlers('/nonexistent/definitely')).toEqual([]);
  });
});
