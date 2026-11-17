import { createParser, parseAsArrayOf, parseAsString } from 'nuqs';

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

/** `?page=<n>` (1 or more); page 1 has no param. The disputes work list pages this way. */
export const pageParam = parseAsIntegerAtLeast(1).withDefault(1);

/**
 * `?after=<c1>,<c2>`: the `after` cursor of every page walked so far (page N carries N-1), so a
 * shared link opens on the same page and back/forward step through pages. Page 1 has no param.
 */
export const afterParam = parseAsArrayOf(parseAsString).withDefault([]);

/** What a list screen needs from its {@link afterParam}: the cursor to send, and the moves. */
export interface CursorPaging {
  /** 1-based: how many pages deep the operator walked. */
  page: number;
  /** The `after` to send; absent on page 1. */
  after: string | undefined;
  next: (nextCursor: string | null) => void;
  previous: () => void;
}

/** {@link CursorPaging} over the screen's `after` param and its setter. */
export function cursorPaging(
  cursors: readonly string[],
  set: (next: string[] | null) => void,
): CursorPaging {
  return {
    page: cursors.length + 1,
    after: cursors.at(-1),
    next: (nextCursor) => {
      if (nextCursor) set([...cursors, nextCursor]);
    },
    previous: () => set(cursors.length <= 1 ? null : cursors.slice(0, -1)),
  };
}

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
