/**
 * What payments runs on, for telescope's Architecture page: each gateway factory and the billing
 * store say which API or Lucid connection they use. Telescope reads the array under the global
 * symbol while it walks `config/payments.ts`; this package does not depend on telescope.
 */

/** The global symbol telescope reads a factory's uses from. */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

/** One thing a factory uses. Never put a key, a secret or a credentialed URL in `label`. */
export interface StackUse {
  tech: string;
  connection?: string;
  purpose?: string;
  label?: string;
  host?: string;
}

/** Attach `use` to `target` (non-enumerable, so it never shows in the config). Returns `target`. */
export function describeStackUse<T extends object>(target: T, use: StackUse | StackUse[]): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: Array.isArray(use) ? use : [use],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen object: nothing to describe.
  }
  return target;
}
