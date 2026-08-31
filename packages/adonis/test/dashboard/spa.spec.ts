import { describe, expect, it } from 'vitest';
import {
  BASE_PLACEHOLDER,
  CONFIG_ELEMENT_ID,
  contentTypeFor,
  type InjectedConfig,
  renderIndexHtml,
} from '../../src/dashboard/spa.js';

const BUILT_HTML = `<!doctype html>
<html><head>
<script type="module" crossorigin src="${BASE_PLACEHOLDER}assets/index-abc123.js"></script>
<link rel="stylesheet" href="${BASE_PLACEHOLDER}assets/index-def456.css">
</head><body><div id="root"></div></body></html>`;

/** Parse the injected data block back out, the way the client does. */
function injectedConfig(html: string): InjectedConfig {
  const match = new RegExp(`id="${CONFIG_ELEMENT_ID}">([^]*?)</script>`).exec(html);
  if (match === null) throw new Error('no config block injected');
  return JSON.parse(match[1] ?? '') as InjectedConfig;
}

describe('renderIndexHtml', () => {
  it('rewrites EVERY occurrence of the Vite placeholder base to the mount path', () => {
    // This is the whole point of the placeholder: one built bundle, any mount path, no rebuild.
    const html = renderIndexHtml(BUILT_HTML, '/ops/billing', '/ops/billing/api', 'BRL');
    expect(html).toContain('/ops/billing/assets/index-abc123.js');
    expect(html).toContain('/ops/billing/assets/index-def456.css');
    expect(html).not.toContain(BASE_PLACEHOLDER);
  });

  it('produces root-relative asset URLs for a root mount', () => {
    const html = renderIndexHtml(BUILT_HTML, '', '/api', 'BRL');
    expect(html).toContain('"/assets/index-abc123.js"');
    expect(html).not.toContain('//assets/');
  });

  it('hands the client its base, api and currency as a JSON data block', () => {
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'USD');
    expect(injectedConfig(html)).toEqual({
      base: '/pd',
      api: '/pd/api',
      currency: 'USD',
      auth: null,
    });
  });

  it('injects a DATA block, never an executable inline script', () => {
    // The whole reason for the data block: a host CSP of `script-src 'self' 'nonce-…'` drops an
    // inline script without a word, the client falls back to its default mount, and every API
    // request 404s from a page that rendered fine. `type="application/json"` is never executed,
    // so no policy can refuse it.
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'BRL');
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    const injected = scripts.filter((tag) => tag.includes(CONFIG_ELEMENT_ID));
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('type="application/json"');
    expect(html).not.toContain('window.__PAYMENTS_');
  });

  it('carries a null auth surface when dashboardAuth is unconfigured', () => {
    // `null`, explicitly — the SPA hides "Sign out" on it, because there is no `/logout` route
    // to point at.
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'BRL');
    expect(injectedConfig(html).auth).toBeNull();
  });

  it('carries the configured auth modes so the SPA can offer Sign out', () => {
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'BRL', {
      modes: ['session', 'login'],
    });
    expect(injectedConfig(html).auth).toEqual({ modes: ['session', 'login'] });
  });

  it('injects an EMPTY base for a root mount rather than omitting it', () => {
    // `''` is a valid base the client must honor; omitting it would make the client fall back
    // to the default mount and fetch from the wrong place.
    const html = renderIndexHtml(BUILT_HTML, '', '/api', 'BRL');
    expect(injectedConfig(html).base).toBe('');
  });

  it('injects before </head> when there is one', () => {
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'BRL');
    expect(html.indexOf(CONFIG_ELEMENT_ID)).toBeLessThan(html.indexOf('</head>'));
  });

  it('still injects when the document has no head', () => {
    const html = renderIndexHtml('<div id="root"></div>', '/pd', '/pd/api', 'BRL');
    expect(injectedConfig(html).api).toBe('/pd/api');
    expect(html).toContain('<div id="root">');
  });

  it('escapes a value that would otherwise close the data block early', () => {
    // A data block ends at the first `</script`; `<` goes in as `\\u003c`, which is still the
    // same string once parsed.
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'a</script><b>');
    expect(html.split('</script>')).toHaveLength(3); // Vite's own module script + ours.
    expect(injectedConfig(html).currency).toBe('a</script><b>');
  });
});

describe('contentTypeFor', () => {
  it('maps the extensions Vite emits', () => {
    expect(contentTypeFor('index-abc.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('index-abc.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('index-abc.js.map')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('font.woff2')).toBe('font/woff2');
  });

  it('falls back to octet-stream for anything else', () => {
    expect(contentTypeFor('mystery.bin')).toBe('application/octet-stream');
    expect(contentTypeFor('noextension')).toBe('application/octet-stream');
  });
});
