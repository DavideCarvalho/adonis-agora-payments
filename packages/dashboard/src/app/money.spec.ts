import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  daysUntil,
  formatCents,
  formatCount,
  formatDay,
  formatDaysUntil,
  formatWhen,
  minorUnitsPer,
  parseMajorToMinor,
} from './money';

describe('formatCents', () => {
  it('renders BRL cents as reais without ever dividing upstream', () => {
    // 123456 cents is R$ 1.234,56 — the division happens here and nowhere else.
    expect(formatCents(123456, 'BRL').replace(/ /g, ' ')).toBe('R$ 1.234,56');
  });

  it('keeps sub-real precision (a value that would round away if divided early)', () => {
    expect(formatCents(1, 'BRL').replace(/ /g, ' ')).toBe('R$ 0,01');
  });

  it('renders zero as zero, not as an empty cell', () => {
    expect(formatCents(0, 'BRL').replace(/ /g, ' ')).toBe('R$ 0,00');
  });

  it('renders a refund (negative cents) with its sign', () => {
    expect(formatCents(-500, 'BRL')).toContain('5,00');
    expect(formatCents(-500, 'BRL')).toContain('-');
  });

  it('does NOT divide a zero-decimal currency by 100', () => {
    // JPY has no minor unit: 1000 is one thousand yen, not ten.
    expect(formatCents(1000, 'JPY')).toContain('1.000');
  });

  it('shifts THREE places for a three-decimal currency', () => {
    // 1990 KWD-fils is 1.990 dinar, not 19.90.
    expect(formatCents(1990, 'KWD')).toContain('1,990');
  });

  it('falls back to a readable string for a currency Intl rejects', () => {
    expect(formatCents(123456, 'NOTACURRENCY')).toBe('NOTACURRENCY 1234.56');
  });
});

describe('parseMajorToMinor', () => {
  it('shifts the digits, padding the fraction to the currency’s own exponent', () => {
    // `19.9` is nineteen reais ninety, not one real ninety-nine. A short fraction that is read
    // literally refunds a hundredth of what the operator typed.
    expect(parseMajorToMinor('19.9', 'BRL')).toBe(1990);
    expect(parseMajorToMinor('19,90', 'BRL')).toBe(1990);
    expect(parseMajorToMinor('8.35', 'BRL')).toBe(835);
    expect(parseMajorToMinor('7', 'BRL')).toBe(700);
  });

  it('uses the currency’s own exponent', () => {
    expect(parseMajorToMinor('1.5', 'KWD')).toBe(1500);
    expect(parseMajorToMinor('1990', 'JPY')).toBe(1990);
  });

  it('refuses more decimals than the currency has', () => {
    expect(parseMajorToMinor('1.234', 'BRL')).toBeNull();
    expect(parseMajorToMinor('1.5', 'JPY')).toBeNull();
  });

  it('refuses anything that is not a positive amount', () => {
    for (const input of ['', '  ', 'abc', '-5', '0', '0.00', '1.2.3', '1e3']) {
      expect([input, parseMajorToMinor(input, 'BRL')]).toEqual([input, null]);
    }
  });
});

describe('formatDay / daysUntil', () => {
  const NOW = new Date('2026-08-27T12:00:00.000Z');

  it('renders a date with no clock, and an em-dash for nothing', () => {
    expect(formatDay(null)).toBe('—');
    expect(formatDay('nope')).toBe('—');
    expect(formatDay('2026-08-27T12:00:00.000Z')).not.toContain(':');
  });

  it('counts whole days forward and backward', () => {
    expect(daysUntil('2026-08-30T12:00:00.000Z', NOW)).toBe(3);
    expect(daysUntil('2026-08-24T12:00:00.000Z', NOW)).toBe(-3);
    expect(daysUntil(null, NOW)).toBeNull();
  });

  it('never renders an expiry that already passed as if it were ahead', () => {
    expect(formatDaysUntil('2026-08-24T12:00:00.000Z', NOW)).toBe('3 days ago');
    expect(formatDaysUntil('2026-08-30T12:00:00.000Z', NOW)).toBe('in 3 days');
    expect(formatDaysUntil('2026-08-27T18:00:00.000Z', NOW)).toBe('today');
    expect(formatDaysUntil('2026-08-28T18:00:00.000Z', NOW)).toBe('tomorrow');
  });
});

describe('minorUnitsPer', () => {
  it('is 100 for the usual currencies and 1 for the zero-decimal ones', () => {
    expect(minorUnitsPer('BRL')).toBe(100);
    expect(minorUnitsPer('usd')).toBe(100);
    expect(minorUnitsPer('JPY')).toBe(1);
    expect(minorUnitsPer('jpy')).toBe(1);
  });

  it('is 1000 for the three-decimal currencies', () => {
    // KWD/BHD/JOD have THREE minor digits. Treating one as cents renders it 10x too large.
    expect(minorUnitsPer('KWD')).toBe(1000);
    expect(minorUnitsPer('bhd')).toBe(1000);
  });
});

/**
 * The exponent table has to agree with `packages/adonis/src/money.ts`'s `currencyExponent`, which
 * is what puts amounts on the wire. Disagreement is not cosmetic: it is a figure wrong by 10x or
 * 100x, shown confidently.
 */
describe('currencyExponent (agrees with the server’s money.ts)', () => {
  it('is 2 by default, including for currencies nobody listed', () => {
    expect(currencyExponent('BRL')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('ZZZ')).toBe(2);
  });

  it('is 0 for every zero-decimal currency the server knows, ISK included', () => {
    for (const code of [
      'BIF',
      'CLP',
      'DJF',
      'GNF',
      'ISK',
      'JPY',
      'KMF',
      'KRW',
      'PYG',
      'RWF',
      'UGX',
      'VND',
      'VUV',
      'XAF',
      'XOF',
      'XPF',
    ]) {
      expect([code, currencyExponent(code)]).toEqual([code, 0]);
    }
  });

  it('is 3 for every three-decimal currency the server knows', () => {
    for (const code of ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']) {
      expect([code, currencyExponent(code)]).toEqual([code, 3]);
    }
  });

  it('does NOT invent a zero-decimal currency the server treats as 2', () => {
    // MGA is not in the server's table. Rendering it with 0 decimals here would print a hundredth
    // of the amount the drivers actually send.
    expect(currencyExponent('MGA')).toBe(2);
  });
});

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1234567).replace(/ /g, '.')).toBe('1.234.567');
  });
});

describe('formatWhen', () => {
  it('renders an em-dash for an absent timestamp instead of "Invalid Date"', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen('not a date')).toBe('—');
  });

  it('renders a real timestamp', () => {
    expect(formatWhen('2026-08-27T12:34:56.000Z')).not.toBe('—');
  });
});
