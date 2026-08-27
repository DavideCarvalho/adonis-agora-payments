import { describe, expect, it } from 'vitest';
import { BASE_PLACEHOLDER, contentTypeFor, renderIndexHtml } from '../../src/dashboard/spa.js';

const BUILT_HTML = `<!doctype html>
<html><head>
<script type="module" crossorigin src="${BASE_PLACEHOLDER}assets/index-abc123.js"></script>
<link rel="stylesheet" href="${BASE_PLACEHOLDER}assets/index-def456.css">
</head><body><div id="root"></div></body></html>`;

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

  it('injects the base, api and currency globals the client reads', () => {
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'USD');
    expect(html).toContain('window.__PAYMENTS_BASE__="/pd"');
    expect(html).toContain('window.__PAYMENTS_API__="/pd/api"');
    expect(html).toContain('window.__PAYMENTS_CURRENCY__="USD"');
  });

  it('injects an EMPTY base for a root mount rather than omitting it', () => {
    // `''` is a valid base the client must honor; omitting it would make the client fall back
    // to the default mount and fetch from the wrong place.
    const html = renderIndexHtml(BUILT_HTML, '', '/api', 'BRL');
    expect(html).toContain('window.__PAYMENTS_BASE__=""');
  });

  it('injects before </head> when there is one', () => {
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'BRL');
    expect(html.indexOf('__PAYMENTS_BASE__')).toBeLessThan(html.indexOf('</head>'));
  });

  it('still injects when the document has no head', () => {
    const html = renderIndexHtml('<div id="root"></div>', '/pd', '/pd/api', 'BRL');
    expect(html).toContain('window.__PAYMENTS_API__="/pd/api"');
    expect(html).toContain('<div id="root">');
  });

  it('escapes a path that would otherwise break out of the injected script', () => {
    // JSON.stringify, not string concatenation — a `</script>` in a config value must not be
    // able to close the tag.
    const html = renderIndexHtml(BUILT_HTML, '/pd', '/pd/api', 'a"b');
    expect(html).toContain('window.__PAYMENTS_CURRENCY__="a\\"b"');
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
