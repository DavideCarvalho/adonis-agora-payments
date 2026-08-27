import { describe, expect, it } from 'vitest';
import { formatCents, formatCount, formatWhen, minorUnitsPer } from './money';

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

  it('falls back to a readable string for a currency Intl rejects', () => {
    expect(formatCents(123456, 'NOTACURRENCY')).toBe('NOTACURRENCY 1234.56');
  });
});

describe('minorUnitsPer', () => {
  it('is 100 for the usual currencies and 1 for the zero-decimal ones', () => {
    expect(minorUnitsPer('BRL')).toBe(100);
    expect(minorUnitsPer('usd')).toBe(100);
    expect(minorUnitsPer('JPY')).toBe(1);
    expect(minorUnitsPer('jpy')).toBe(1);
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
