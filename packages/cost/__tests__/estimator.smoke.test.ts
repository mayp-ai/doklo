import { describe, it, expect } from 'vitest';
import {
  bytesToTokens,
  estimateTokensFromBytes,
  calculateCost,
  estimateFromBytes,
  formatTokenCount,
  formatCost,
  PRICING,
} from '../src/estimator.js';

describe('bytesToTokens', () => {
  it('uses CHARS_PER_TOKEN ≈ 4', () => {
    expect(bytesToTokens(4)).toBe(1);
    expect(bytesToTokens(40)).toBe(10);
    expect(bytesToTokens(0)).toBe(0);
  });
  it('rounds up partial tokens', () => {
    expect(bytesToTokens(5)).toBe(2);
  });
});

describe('estimateTokensFromBytes', () => {
  it('computes input + output (≈30%)', () => {
    const result = estimateTokensFromBytes(4000);
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(300);
    expect(result.totalTokens).toBe(1300);
  });
});

describe('calculateCost', () => {
  it('matches Sonnet pricing', () => {
    // 1M input + 1M output = $3 + $15 = $18
    expect(calculateCost(1_000_000, 1_000_000)).toBeCloseTo(18, 4);
  });
  it('returns 0 for zero tokens', () => {
    expect(calculateCost(0, 0)).toBe(0);
  });
});

describe('estimateFromBytes', () => {
  it('combines token estimate with cost', () => {
    const result = estimateFromBytes(40_000);
    expect(result.inputTokens).toBe(10_000);
    expect(result.outputTokens).toBe(3_000);
    expect(result.estimatedCost).toBeCloseTo(
      (10_000 * PRICING.inputPerMillion + 3_000 * PRICING.outputPerMillion) / 1_000_000,
      6,
    );
  });
});

describe('formatters', () => {
  it('formats token counts with K/M suffix', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(1_500)).toBe('1.5K');
    expect(formatTokenCount(2_500_000)).toBe('2.50M');
  });
  it('formats cost with adaptive precision', () => {
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(1.23)).toBe('$1.23');
    expect(formatCost(123)).toBe('$123');
  });
});
