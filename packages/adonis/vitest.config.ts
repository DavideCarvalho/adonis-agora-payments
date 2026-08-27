import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.{spec,test}.ts'],
    // The integration suite needs Docker; it has its own config and script.
    exclude: ['test/integration/**'],
    pool: 'forks',
  },
});
