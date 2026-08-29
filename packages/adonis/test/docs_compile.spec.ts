import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@mdx-js/mdx';
import { describe, expect, it } from 'vitest';

/**
 * Every docs page must be parseable MDX.
 *
 * Nothing in this repo compiles the docs — they are rendered by the Agora site, in another
 * repo, from `master`. So an unparseable page passed CI, passed review, merged, and took the
 * documentation site's build down with it; the first sign was a red deploy on a repo that had
 * not changed. Both failures were ordinary prose: a code span broken across a newline, which
 * makes MDX read the `{ ... }` at the start of the next line as an expression, and a JSX
 * attribute holding unescaped double quotes.
 *
 * The compile here is parse-only — components are not resolved — which is exactly the layer
 * both bugs lived in.
 */
describe('docs compile as MDX', () => {
  const docsDir = fileURLToPath(new URL('../../../docs/', import.meta.url));

  const pages = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return pages(path);
        return entry.name.endsWith('.mdx') ? [path] : [];
      }),
    );
    return found.flat();
  };

  it('parses every page in docs/', async () => {
    const found = await pages(docsDir);
    expect(found.length, 'no .mdx pages found — is the path still right?').toBeGreaterThan(20);

    const broken: string[] = [];
    for (const path of found) {
      try {
        await compile(await readFile(path, 'utf-8'), { jsx: true });
      } catch (error) {
        const place = (error as { line?: number; column?: number }).line;
        broken.push(
          `${path.slice(docsDir.length)}:${place ?? '?'} — ${(error as Error).message.split('\n')[0]}`,
        );
      }
    }
    expect(broken, `pages that would break the docs site's build:\n${broken.join('\n')}`).toEqual(
      [],
    );
  });
});
