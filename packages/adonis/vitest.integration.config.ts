import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The integration suite: real Postgres in a throwaway container, real migration, real
 * Lucid store. Split from `vitest.config.ts` so `pnpm test` stays fast and runs without
 * Docker, while `pnpm test:integration` proves the half that unit tests structurally
 * cannot — that the SQL the store emits is valid and means what the aggregates claim.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: true,
    include: ['test/integration/**/*.{spec,test}.ts'],
    globalSetup: ['test/integration/global_setup.ts'],
    pool: 'forks',
    // The published migration stub reads `billing.schema` through `@adonisjs/core/services/app`,
    // whose default export is a live binding that `setApp` fills in. Vitest's default-export
    // interop snapshots it (as `undefined`), so the harness's `setApp` would never be seen.
    deps: { interopDefault: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
