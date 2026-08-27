/**
 * Money formatting — the ONLY place in this console that divides by 100.
 *
 * Everything upstream (the store, `billingOverview`, the JSON API) speaks integer cents, because
 * that is the unit the gateways settle in and the unit that survives arithmetic. Dividing early is
 * how a rounding error gets into a revenue figure and stays there, so the division happens here,
 * at render, once, against a value nothing will compute with afterwards.
 */

/** ISO 4217 codes whose minor unit is NOT 1/100. Formatting these as cents would be wrong by 100x. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** The minor units per major unit for a currency (100 for BRL/USD/EUR, 1 for JPY/KRW/...). */
export function minorUnitsPer(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

/**
 * Render integer minor units (cents) as a localized currency string — `123456` + `'BRL'` becomes
 * `R$ 1.234,56`.
 *
 * Falls back to a plain `<code> <amount>` string when the runtime rejects the currency code, so an
 * app configured with something `Intl` does not know still shows a number instead of crashing the
 * whole panel.
 */
export function formatCents(cents: number, currency: string, locale = 'pt-BR'): string {
  const divisor = minorUnitsPer(currency);
  const value = cents / divisor;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: divisor === 1 ? 0 : 2,
      maximumFractionDigits: divisor === 1 ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency.toUpperCase()} ${value.toFixed(divisor === 1 ? 0 : 2)}`;
  }
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
