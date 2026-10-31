import { createHash } from 'node:crypto';
/**
 * Validation shared by every driver, so fourteen gateways cannot drift into fourteen
 * slightly different messages for the same mistake.
 */

/**
 * The API credential a driver cannot work without: the configured value, or the env
 * fallback, or a boot failure naming both places to set it.
 *
 * Every driver reads its credential the same way — config first, env second — and every
 * one of them must fail at boot rather than at the first charge, when the failure is a
 * customer waiting on a checkout page.
 */
export function requireCredential(options: {
  /** The driver's config key, e.g. `'stripe'` — used verbatim in the message. */
  driver: string;
  /** What the credential is called in the config, e.g. `'apiKey'`. */
  option: string;
  /** The env var checked as a fallback, e.g. `'STRIPE_KEY'`. */
  env: string;
  value: string | undefined;
}): string {
  const resolved = options.value ?? process.env[options.env];
  if (!resolved) {
    throw new Error(
      `[payments] Driver "${options.driver}" requires ${options.option}. ` +
        `Set \`${options.env}\` in the environment or pass \`${options.option}\` to \`payments.${options.driver}()\`.`,
    );
  }
  return resolved;
}

/**
 * The currency a multi-currency driver must be told, with no default.
 *
 * A default here is the worst kind of money bug, because it succeeds: the gateway accepts
 * whatever currency it is handed, so an app that never configured one bills in a currency
 * nobody chose and nothing in the flow says so. Boot is the last honest place to catch it.
 *
 * Single-currency gateways (the BRL-only Brazilian ones) must NOT call this — they take no
 * currency option at all, and inventing one would imply a choice that does not exist.
 */
export function requireCurrency(driver: string, currency: string | undefined): string {
  if (!currency) {
    throw new Error(
      `[payments] Driver "${driver}" has no currency configured. Set \`currency\` in config/payments.ts — a multi-currency gateway has no safe default.`,
    );
  }
  return currency;
}

const CYCLE_REFERENCE_SEPARATOR = '|k:';

/**
 * The reference for a charge that has BOTH an app reference and its own idempotency key.
 *
 * Asaas and Woovi have one field for the two jobs. The app reference repeats on purpose (each
 * cycle of `sub:<id>` routes to the same subscription), while a charge's identity must not:
 * with the bare reference, Asaas' lookup found the first cycle's charge and every renewal
 * returned it instead of charging. So the field carries both, and the driver gives the app its
 * reference back through {@link routingReference}. The key is hashed to stay inside the
 * gateways' length limits.
 */
export function cycleReference(reference: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16);
  return `${reference}${CYCLE_REFERENCE_SEPARATOR}${digest}`;
}

/** The app's reference out of what the gateway echoes. A plain reference passes through. */
export function routingReference(echoed: string): string {
  const separator = echoed.lastIndexOf(CYCLE_REFERENCE_SEPARATOR);
  return separator === -1 ? echoed : echoed.slice(0, separator);
}
