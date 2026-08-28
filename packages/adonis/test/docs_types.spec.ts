import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The API reference restates the domain unions as prose-adjacent TypeScript, which drifts
 * silently: `authorized` and `paused` were added to the types — each because the old
 * mapping granted or withheld access wrongly — and the page went on listing the six-member
 * unions for weeks. A reader checking whether a status exists reads the docs, not the
 * `.d.ts`, so a stale union here is a wrong answer with a citation.
 *
 * This compares members, not formatting: the page may wrap however it reads best.
 */
describe('api-reference domain unions', () => {
  const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

  const members = (source: string, name: string): string[] => {
    const body = source.split(new RegExp(`\\btype ${name}\\s*=`))[1];
    if (body === undefined) throw new Error(`union ${name} not found`);
    // Stop at the first line that starts a new declaration or leaves the code block.
    const block = body.split(/\n(?=(?:\/\/|type |interface |```|export ))/)[0] ?? '';
    return [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string).sort();
  };

  const UNIONS = ['BillingStatus', 'SubscriptionStatus', 'PaymentMethodType', 'PaymentMethodName'];

  it.each(UNIONS)('documents every member of %s', async (name) => {
    const [types, docs] = await Promise.all([
      read('../src/types.ts'),
      read('../../../docs/api-reference.mdx'),
    ]);

    const inCode = members(types, name);
    const inDocs = members(docs, name);
    expect(inCode.length, `${name} parsed as empty — did the declaration move?`).toBeGreaterThan(1);

    expect(
      inDocs,
      `docs/api-reference.mdx lists ${name} as [${inDocs}] but src/types.ts says [${inCode}]`,
    ).toEqual(inCode);
  });
});
