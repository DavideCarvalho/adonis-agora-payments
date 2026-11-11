import { CONFIG_ELEMENT_ID } from './payments-client';

/**
 * Test helper: puts (or extends) the provider's JSON config block on the page, the way
 * `renderIndexHtml` does. Only specs import it, so it never reaches the SPA bundle.
 */
export function injectConfig(config: Record<string, unknown>): void {
  let el = document.getElementById(CONFIG_ELEMENT_ID);
  const current: Record<string, unknown> = el ? JSON.parse(el.textContent ?? '{}') : {};
  if (!el) {
    el = document.createElement('script');
    el.setAttribute('type', 'application/json');
    el.id = CONFIG_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify({ ...current, ...config });
}

/** Removes the config block, so the next test starts from a page the provider never injected. */
export function clearConfig(): void {
  document.getElementById(CONFIG_ELEMENT_ID)?.remove();
}
