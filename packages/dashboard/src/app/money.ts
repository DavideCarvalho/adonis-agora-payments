/**
 * Money formatting — the ONLY place in this console that shifts a decimal point.
 *
 * Everything upstream (the store, `billingOverview`, the JSON API) speaks integer MINOR UNITS,
 * because that is the unit the gateways settle in and the unit that survives arithmetic. Dividing
 * early is how a rounding error gets into a revenue figure and stays there, so the shift happens
 * here, at render, once, against a value nothing will compute with afterwards.
 *
 * The exponent table below MIRRORS `packages/adonis/src/money.ts`'s `currencyExponent`, which is
 * what the drivers use to put an amount on the wire. The two disagreeing is not a cosmetic bug: if
 * the server sends ¥1990 as `1990` and this file renders it as `19,90`, the console under-reports
 * revenue by 100×, and for a three-decimal currency (KWD, BHD, JOD…) it over-reports it by 10×.
 * Change one, change both.
 */

/** ISO 4217 codes whose minor unit is NOT 1/100 — keyed exactly as `src/money.ts`'s `MINOR_UNITS`. */
const MINOR_UNITS: Record<string, number> = {
  // Zero-decimal — the amount IS the integer; there is nothing to shift.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** How many decimal places a currency has. 2 for everything not listed — BRL, USD, EUR included. */
export function currencyExponent(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

/** The minor units per major unit (100 for BRL/USD/EUR, 1 for JPY/KRW, 1000 for KWD/BHD). */
export function minorUnitsPer(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/**
 * Render integer minor units as a localized currency string — `123456` + `'BRL'` becomes
 * `R$ 1.234,56`, `1990` + `'JPY'` becomes `¥ 1.990`, `1990` + `'KWD'` becomes `KD 1,990`.
 *
 * Falls back to a plain `<code> <amount>` string when the runtime rejects the currency code, so an
 * app configured with something `Intl` does not know still shows a number instead of crashing the
 * whole panel.
 */
export function formatCents(cents: number, currency: string, locale = 'pt-BR'): string {
  const exponent = currencyExponent(currency);
  const value = cents / 10 ** exponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    return `${currency.toUpperCase()} ${value.toFixed(exponent)}`;
  }
}

/**
 * Parse what an operator typed into a partial-refund box (`19,90`, `19.90`, `1990` for JPY) into
 * integer minor units. `null` for anything unusable.
 *
 * Digit-shifting rather than multiplying a float: shifting the digits of an integer cannot round
 * anywhere, which is the same reason `src/money.ts`'s `formatDecimal` builds its string that way
 * instead of going through `toDecimal(x).toFixed(2)`.
 *
 * The fraction is padded/rejected against the currency's OWN exponent, which is the part that
 * silently bites: `19.9` is 1990, not 199, and `1.5` is 150 in BRL, 1500 in KWD, and refused
 * outright in JPY — which has no fractional part to refund at all.
 */
export function parseMajorToMinor(input: string, currency: string): number | null {
  const trimmed = input.trim().replace(',', '.');
  if (trimmed === '') return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const exponent = currencyExponent(currency);
  const [whole = '', fraction = ''] = trimmed.split('.');
  if (fraction.length > exponent) return null;
  const minor = Number(`${whole}${fraction.padEnd(exponent, '0')}`);
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}

/** Render a plain (non-money) integer with thousands separators — usage quantities, counts. */
export function formatCount(value: number, locale = 'pt-BR'): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Short absolute timestamp for a table cell; `—` for a null/absent one. */
export function formatWhen(iso: string | null, locale = 'pt-BR'): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

/**
 * A date with no clock — a trial end, a period end. Those are DAYS, and a second-precision
 * timestamp next to them reads as more certainty than the gateway actually gave.
 *
 * `relative` says how far away it is, which is the part an operator acts on: "ends in 2 days" is a
 * reason to email someone, `28/08/2026` is a date they have to subtract in their head.
 */
export function formatDay(iso: string | null, locale = 'pt-BR'): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date);
}

/**
 * How many whole days from `now` until `iso` — negative when it is already past, `null` when there
 * is no date. Pure, so the one thing worth getting right (an expiry that already happened must
 * never read as future) is testable without a clock.
 */
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

/** `daysUntil` as the phrase an operator reads: `in 3 days`, `today`, `4 days ago`. */
export function formatDaysUntil(iso: string | null, now: Date = new Date()): string | null {
  const days = daysUntil(iso, now);
  if (days === null) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
