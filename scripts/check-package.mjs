// Runs publint and arethetypeswrong against every published (non-private) package in
// packages/*, after `pnpm build`. Every package here is ESM-only, so attw uses that profile.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const packagesDir = join(root, 'packages');
let failed = false;

for (const dir of readdirSync(packagesDir)) {
  const cwd = join(packagesDir, dir);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (manifest.private) continue;

  const esmOnly = manifest.type === 'module';
  const checks = [
    ['publint', ['--strict']],
    ['attw', ['--pack', '.', ...(esmOnly ? ['--profile', 'esm-only'] : [])]],
  ];
  for (const [bin, args] of checks) {
    console.log(`\n> ${manifest.name}: ${bin} ${args.join(' ')}`);
    try {
      execFileSync('pnpm', ['exec', bin, ...args], { cwd, stdio: 'inherit' });
    } catch {
      failed = true;
    }
  }
}

if (failed) {
  console.error('\ncheck:package failed');
  process.exit(1);
}
