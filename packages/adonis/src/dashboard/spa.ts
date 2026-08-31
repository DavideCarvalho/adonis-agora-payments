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
 * Which `dashboardAuth` surface(s) this deployment has — `null` when it has none. Carried to the
 * SPA so it can tell "there is a session to end" from "there is no `/logout` route at all": on a
 * deployment without `dashboardAuth` the provider registers no auth routes, and a Sign out link
 * there was a 404 waiting to be clicked.
 */
export type InjectedAuth = { modes: readonly string[] } | null;

/** `id` of the JSON data block `renderIndexHtml` injects; `src/client/payments-client.ts` reads it. */
export const CONFIG_ELEMENT_ID = 'payments-dashboard-config';

/** What the page tells the SPA about the deployment it is mounted in. */
export interface InjectedConfig {
  /** UI mount base (`/payments`; `''` for a root mount). */
  base: string;
  /** JSON API base (`/payments/api`). */
  api: string;
  /** ISO 4217 display currency. */
  currency: string;
  auth: InjectedAuth;
}

/**
 * Rewrite the built `index.html` for serving: point Vite's placeholder base at the configured mount
 * path, and hand the SPA its deployment config — the mount base and API base
 * `src/client/payments-client.ts` builds URLs from, the display currency it formats cents with, and
 * the auth surface (see {@link InjectedAuth}).
 *
 * The config goes in as a JSON DATA BLOCK (`<script type="application/json">`), not as an inline
 * script assigning `window.__PAYMENTS_*__` globals. A data block is never executed, so no
 * Content-Security-Policy can refuse it; an inline script IS, and a host with
 * `script-src 'self' 'nonce-…'` — `@adonisjs/shield`'s `@nonce`, which is the recommended setup —
 * silently dropped ours. The globals were then undefined, the SPA fell back to its default mount
 * (`/payments-dashboard/api`), and EVERY request from a console that had rendered perfectly well
 * answered 404. The module script Vite emits is a same-origin file, which is why the page itself
 * kept loading and made the failure look like a routing bug rather than a policy one.
 *
 * The currency is the one addition over durable's version: money is integer cents on the wire
 * and formatted only at render, so the renderer has to be told which currency to render in — and
 * the config file, not the bundle, is where that belongs.
 */
export function renderIndexHtml(
  html: string,
  basePath: string,
  apiBasePath: string,
  currency: string,
  auth: InjectedAuth = null,
): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath}/`);
  const config: InjectedConfig = {
    base: basePath,
    api: apiBasePath,
    currency,
    auth: auth === null ? null : { modes: [...auth.modes] },
  };
  // `<` escaped as `\u003c` inside the JSON: a data block ends at the first `</script`, and a
  // config value must not be able to close it early. Valid JSON either way.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const inject = `<script type="application/json" id="${CONFIG_ELEMENT_ID}">${json}</script>`;
  return based.includes('</head>') ? based.replace('</head>', `${inject}</head>`) : inject + based;
}
