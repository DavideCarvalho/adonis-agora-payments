import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Absolute path to the published stubs directory (`dist/stubs/`).
 *
 * Computed lazily on first call — NOT at module import — and memoized, so importing this
 * package never evaluates `fileURLToPath(new URL('./', import.meta.url))` at load time
 * (see the same hazard fix in `@adonis-agora/media`).
 */
export function stubsRoot(): string {
  if (cached === undefined) {
    cached = fileURLToPath(new URL('./', import.meta.url));
  }
  return cached;
}
