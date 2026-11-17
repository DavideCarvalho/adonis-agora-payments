import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import { afterAll, describe, expect, it } from 'vitest';
import { stubsRoot } from '../stubs/main.js';

/**
 * Every stub through the REAL stub engine (`node ace configure` / `make:*` use it). The
 * integration harness strips a stub's header and imports the rest, so it never sees what the
 * template compiler does to the body — a backtick there ends the template literal it compiles to.
 */
function stubFiles(dir = stubsRoot()): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stubFiles(path);
    return name.endsWith('.stub') ? [relative(stubsRoot(), path)] : [];
  });
}

describe('stubs', () => {
  const root = mkdtempSync(join(tmpdir(), 'payments-stubs-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('render, every one of them', async () => {
    const app = new AppFactory().create(pathToFileURL(`${root}/`), () => {});
    await app.init();
    const manager = await app.stubs.create();
    const files = stubFiles();
    expect(files).toContain('database/migrations/add_billing_list_indexes.stub');
    for (const file of files) {
      const stub = await manager.build(file, { source: stubsRoot() });
      const prepared = await stub.prepare({ entity: { name: 'Example', path: '' } } as never);
      expect(prepared.contents, file).not.toBe('');
    }
  });
});
