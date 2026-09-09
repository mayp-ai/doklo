import { describe, it, expect } from 'vitest';
import { calculateCostWithPricing, calculateCost } from '../src/estimator.js';

describe('calculateCostWithPricing', () => {
  it('uses provided per-model pricing', () => {
    // 1M in + 1M out at {input:5, output:25} = $30
    expect(calculateCostWithPricing(1_000_000, 1_000_000, { input: 5, output: 25 })).toBeCloseTo(30, 4);
  });
  it('falls back to the Sonnet constant when no pricing is given', () => {
    expect(calculateCostWithPricing(1_000_000, 1_000_000)).toBe(calculateCost(1_000_000, 1_000_000));
  });
});
