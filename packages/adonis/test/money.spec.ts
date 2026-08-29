import { describe, expect, it } from 'vitest';
import { currencyExponent, formatDecimal, fromDecimal, toDecimal } from '../src/money.js';

/**
 * The library works in the currency's smallest unit and converts at the gateway boundary.
 * Hardcoding two decimals there is right for most of the world and wrong in a way that
 * SUCCEEDS for the rest — a ¥1990 charge sent as `19.90` is accepted, and bills a
 * hundredth of what it should.
 */
describe('money', () => {
  describe('currencyExponent', () => {
    it('defaults to 2, including for an unknown or absent currency', () => {
      expect(currencyExponent('brl')).toBe(2);
      expect(currencyExponent('usd')).toBe(2);
      expect(currencyExponent(undefined)).toBe(2);
      expect(currencyExponent('zzz')).toBe(2);
    });

    it('knows the zero-decimal and three-decimal currencies', () => {
      expect(currencyExponent('jpy')).toBe(0);
      expect(currencyExponent('krw')).toBe(0);
      expect(currencyExponent('clp')).toBe(0);
      expect(currencyExponent('kwd')).toBe(3);
      expect(currencyExponent('bhd')).toBe(3);
    });

    it('is case-insensitive — currencies travel lowercase but callers may not', () => {
      expect(currencyExponent('JPY')).toBe(0);
    });
  });

  describe('toDecimal / fromDecimal', () => {
    it('shifts by two places by default', () => {
      expect(toDecimal(1990)).toBe(19.9);
      expect(fromDecimal(19.9)).toBe(1990);
    });

    it('leaves a zero-decimal currency alone in both directions', () => {
      expect(toDecimal(1990, 'jpy')).toBe(1990);
      expect(fromDecimal(1990, 'jpy')).toBe(1990);
    });

    it('shifts three places for a three-decimal currency', () => {
      expect(toDecimal(1990, 'kwd')).toBe(1.99);
      expect(fromDecimal(1.99, 'kwd')).toBe(1990);
    });

    it('round-trips every exponent', () => {
      for (const currency of ['brl', 'jpy', 'kwd']) {
        expect(fromDecimal(toDecimal(123456, currency), currency)).toBe(123456);
      }
    });
  });

  describe('formatDecimal', () => {
    it('writes the string a gateway JSON body wants', () => {
      expect(formatDecimal(1990, 'brl')).toBe('19.90');
      expect(formatDecimal(1990, 'jpy')).toBe('1990');
      expect(formatDecimal(1990, 'kwd')).toBe('1.990');
    });

    it('pads amounts smaller than one unit', () => {
      expect(formatDecimal(5, 'usd')).toBe('0.05');
      expect(formatDecimal(0, 'usd')).toBe('0.00');
      expect(formatDecimal(7, 'kwd')).toBe('0.007');
    });

    it('never loses a cent to binary floating point', () => {
      // The reason this exists: `(x / 100).toFixed(2)` goes through a binary float on the
      // way to a decimal string. Shifting the digits of an integer cannot round anywhere.
      for (const cents of [1, 5, 70, 815, 1005, 2_147_483_647]) {
        const [whole, fraction] = formatDecimal(cents, 'usd').split('.');
        expect(Number(whole) * 100 + Number(fraction)).toBe(cents);
      }
    });

    it('keeps the sign on a negative amount', () => {
      expect(formatDecimal(-1990, 'brl')).toBe('-19.90');
    });
  });
});
