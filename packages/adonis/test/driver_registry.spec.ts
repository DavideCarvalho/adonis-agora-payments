import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { payments } from '../src/define_config.js';

/**
 * Every driver on disk must be reachable, documented and navigable.
 *
 * This is the recurring bug class in this codebase: something exists, is correct, is
 * tested — and is wired to nothing. A driver with no factory in `payments` cannot be named
 * in `config/payments.ts` at all, so it is not a limited feature, it is an absent one; and
 * its unit tests pass either way, because they construct the class directly.
 */
describe('driver registry', () => {
  const driversDir = fileURLToPath(new URL('../src/drivers/', import.meta.url));
  const docsDir = fileURLToPath(new URL('../../../docs/providers/', import.meta.url));

  /** Driver slugs = the files in src/drivers, minus the shared helpers. */
  const slugs = async (): Promise<string[]> =>
    (await readdir(driversDir))
      .filter((file) => file.endsWith('.ts') && file !== 'shared.ts')
      .map((file) => file.replace(/\.ts$/, ''))
      .sort();

  it('exposes a factory in `payments` for every driver', async () => {
    const factories = new Set(Object.keys(payments));
    const missing = (await slugs()).filter((slug) => !factories.has(slug));
    expect(
      missing,
      `drivers with no payments.<name>() factory — unreachable from config: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has a docs page for every driver', async () => {
    const pages = new Set(
      (await readdir(docsDir))
        .filter((file) => file.endsWith('.mdx'))
        .map((file) => file.replace(/\.mdx$/, '')),
    );
    const missing = (await slugs()).filter((slug) => !pages.has(slug));
    expect(missing, `drivers with no docs/providers page: ${missing.join(', ')}`).toEqual([]);
  });

  it('lists every docs page in the sidebar', async () => {
    const meta = JSON.parse(await readFile(`${docsDir}meta.json`, 'utf-8')) as { pages: string[] };
    const listed = new Set(meta.pages);
    const missing = (await slugs()).filter((slug) => !listed.has(slug));
    expect(
      missing,
      `pages that exist but are not in providers/meta.json — invisible in the sidebar: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
