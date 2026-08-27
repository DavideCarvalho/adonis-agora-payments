import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the dashboard SPA into `dist/spa`. `base` is a placeholder (`/__PAYMENTS_DASHBOARD__/`) the
 * AdonisJS provider (`packages/adonis/src/dashboard/spa.ts`) rewrites at serve time to the configured
 * mount path, so the same built bundle works mounted anywhere (`/payments-dashboard`, `/ops/billing`,
 * ...) with no rebuild — the same pattern `@adonis-agora/durable-dashboard` uses for the identical
 * problem.
 */
export default defineConfig({
  base: '/__PAYMENTS_DASHBOARD__/',
  plugins: [react()],
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    sourcemap: true,
  },
});
