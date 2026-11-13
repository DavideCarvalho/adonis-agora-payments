import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the dashboard SPA into `dist/spa`. `base` is a placeholder (`/__PAYMENTS_DASHBOARD__/`) the
 * AdonisJS provider (`packages/adonis/src/dashboard/spa.ts`) rewrites at serve time to the configured
 * mount path, so the same built bundle works mounted anywhere (`/payments`, `/ops/billing`,
 * ...) with no rebuild — the same pattern `@adonis-agora/durable-dashboard` uses for the identical
 * problem.
 */
export default defineConfig({
  base: '/__PAYMENTS_DASHBOARD__/',
  plugins: [react(), tailwindcss()],
  // CSS-referenced assets (the bundled woff2 fonts) as RELATIVE urls: the provider rewrites the
  // base placeholder only in `index.html`, never inside the CSS, so an absolute
  // `/__PAYMENTS_DASHBOARD__/assets/…` font url would 404 under the real mount path.
  experimental: {
    renderBuiltUrl: (_filename, { hostType }) =>
      hostType === 'css' ? { relative: true } : undefined,
  },
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    sourcemap: true,
  },
});
