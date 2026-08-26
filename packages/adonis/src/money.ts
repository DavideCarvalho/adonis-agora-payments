import type { Money } from './types.js';

/**
 * Money helpers shared by the fetch-based drivers.
 *
 * The billing layer and the `PaymentsDriver` contract work in the currency's smallest
 * unit (cents); the BR gateway APIs (Asaas, AbacatePay, Woovi) work in decimal reais.
 * These two conversions are the only place that mapping lives.
 */
export function toDecimal(amount: Money): number {
  return amount / 100;
}

export function fromDecimal(value: number): Money {
  return Math.round(value * 100);
}
