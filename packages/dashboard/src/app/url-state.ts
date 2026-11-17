import { createParser } from 'nuqs';

/**
 * The console's view state in the URL (`#/<screen>?<query>`, through the kit's `NuqsHashAdapter`):
 * the parsers the list screens share. Every param drops out of the URL at its default, so a screen
 * opened from a plain `#/<screen>` link looks exactly as before. Each pick is an explicit choice,
 * so the screens write with `history: 'push'`: back steps through filters and pages.
 */

/**
 * A whole number at least `min`; anything else in a hand-edited link (`?page=0`, `?page=-3`,
 * `?page=x`) reads as absent, so the default applies instead of a nonsensical request to the API.
 */
export const parseAsIntegerAtLeast = (min: number) =>
  createParser({
    parse: (raw) => {
      const value = Number(raw);
      return Number.isInteger(value) && value >= min ? value : null;
    },
    serialize: (value: number) => String(value),
  });

/** `?page=<n>` (1 or more); page 1 has no param. */
export const pageParam = parseAsIntegerAtLeast(1).withDefault(1);

/** An optional pick (`?provider=asaas`); absent or empty (`?provider=`) = every value. */
export const optionalParam = createParser({
  parse: (raw) => (raw.trim() === '' ? null : raw),
  serialize: (value: string) => value,
});

/**
 * How "every status" is spelled on a screen whose default is ONE status (Webhook events opens on
 * `failed`, Subscriptions on `past_due`): `?status=all`. On a screen whose default is already every
 * status, it never reaches the URL.
 */
export const ALL = 'all';

/**
 * The status a screen shows, from its `?status=`: absent = the screen's default, `all` = every
 * status (`undefined`, what the API and the `Segmented` "All" pill use).
 *
 * `status` doubles as the seed a health check sends (`#/webhooks?status=failed`): following one
 * opens the screen with that filter already picked, as before.
 */
export function readStatus(raw: string | null, fallback: string | undefined): string | undefined {
  if (raw === null || raw === '') return fallback;
  return raw === ALL ? undefined : raw;
}

/** The `?status=` to write for a pick: `null` (out of the URL) when it is the screen's default. */
export function writeStatus(
  value: string | undefined,
  fallback: string | undefined,
): string | null {
  if (value === fallback) return null;
  return value ?? ALL;
}
