import type { Money } from './types.js';

/**
 * ISO 4217 minor units, for the currencies where it is not 2.
 *
 * Dividing by 100 is right for most of the world and wrong in a way that succeeds for the
 * rest: a ¥1990 charge sent as `19.90` is accepted by the gateway and bills a hundredth of
 * what it should. Lowercase keys, because currencies travel lowercase through this package.
 */
const MINOR_UNITS: Record<string, number> = {
  // Zero-decimal — the amount IS the integer; there is nothing to shift.
  bif: 0,
  clp: 0,
  djf: 0,
  gnf: 0,
  isk: 0,
  jpy: 0,
  kmf: 0,
  krw: 0,
  pyg: 0,
  rwf: 0,
  ugx: 0,
  vnd: 0,
  vuv: 0,
  xaf: 0,
  xof: 0,
  xpf: 0,
  // Three-decimal.
  bhd: 3,
  iqd: 3,
  jod: 3,
  kwd: 3,
  lyd: 3,
  omr: 3,
  tnd: 3,
};

/**
 * How many decimal places a currency has. Defaults to 2 — the case for every currency not
 * listed above, including BRL, USD and EUR.
 */
export function currencyExponent(currency: string | undefined): number {
  if (currency === undefined) return 2;
  return MINOR_UNITS[currency.toLowerCase()] ?? 2;
}

/**
 * Money helpers shared by the fetch-based drivers.
 *
 * The billing layer and the `PaymentsDriver` contract work in the currency's smallest unit;
 * many gateway APIs (the Brazilian ones, Mollie, PayPal, Mercado Pago) want a decimal. This
 * is the only place that mapping lives.
 *
 * `currency` is optional so the BRL-only drivers can keep calling these with one argument —
 * but a **multi-currency** driver that omits it is asking for the ¥ bug above. Prefer
 * {@link formatDecimal} when the gateway wants a string.
 */
export function toDecimal(amount: Money, currency?: string): number {
  const exponent = currencyExponent(currency);
  return exponent === 0 ? amount : amount / 10 ** exponent;
}

export function fromDecimal(value: number, currency?: string): Money {
  const exponent = currencyExponent(currency);
  return exponent === 0 ? Math.round(value) : Math.round(value * 10 ** exponent);
}

/**
 * The decimal string a gateway's JSON wants — `"19.90"`, `"1990"`, `"19.900"` — built from
 * the integer without ever dividing.
 *
 * `toDecimal(x).toFixed(2)` goes through a binary float on the way to a decimal string,
 * which is the classic way to ship `"19.89"`. Shifting the digits of an integer cannot
 * round anywhere, so this is what drivers should use on the wire.
 */
export function formatDecimal(amount: Money, currency?: string): string {
  const exponent = currencyExponent(currency);
  const negative = amount < 0;
  const digits = String(Math.abs(Math.trunc(amount))).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
