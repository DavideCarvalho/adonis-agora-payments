/**
 * Pure helpers for mounting/serving the `@adonis-agora/payments-dashboard` React SPA — split out so
 * they're unit-testable without booting AdonisJS. `providers/dashboard_provider.ts` is a thin HTTP
 * shell around these. Mirrors `@adonis-agora/durable`'s `src/dashboard/spa.ts` in shape, so the
 * "serve a Vite SPA from an AdonisJS provider" story stays ONE pattern across the Agora ecosystem.
 */

/** Placeholder base Vite bakes into asset URLs (`packages/dashboard/vite.config.ts`); rewritten to the
 *  configured dashboard `path` at serve time — the SAME built bundle mounts at any path with no rebuild. */
export const BASE_PLACEHOLDER = '/__PAYMENTS_DASHBOARD__/';

export const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Content type for a served asset filename, defaulting to octet-stream. */
export function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Rewrite the built `index.html` for serving: point Vite's placeholder base at the configured mount
 * path, and inject the globals `src/client/payments-client.ts` reads
 * (`window.__PAYMENTS_BASE__`/`window.__PAYMENTS_API__`) plus the display currency
 * (`window.__PAYMENTS_CURRENCY__`) the SPA formats cents with.
 *
 * The currency is the one addition over durable's two-global version: money is integer cents on the
 * wire and formatted only at render, so the renderer has to be told which currency to render in —
 * and the config file, not the bundle, is where that belongs.
 */
export function renderIndexHtml(
  html: string,
  basePath: string,
  apiBasePath: string,
  currency: string,
): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath}/`);
  // JSON.stringify, not concatenation: a config value containing `</script>` must not be able to
  // close the tag it is injected into.
  const globals = [
    `window.__PAYMENTS_BASE__=${JSON.stringify(basePath)};`,
    `window.__PAYMENTS_API__=${JSON.stringify(apiBasePath)};`,
    `window.__PAYMENTS_CURRENCY__=${JSON.stringify(currency)};`,
  ].join('');
  const inject = `<script>${globals}</script>`;
  return based.includes('</head>') ? based.replace('</head>', `${inject}</head>`) : inject + based;
}
