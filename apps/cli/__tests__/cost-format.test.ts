import { describe, it, expect } from 'vitest';
import { formatTokenEstimate } from '../src/lib/cost-format.js';

describe('formatTokenEstimate', () => {
  it('shows input and output counts without a pricing dependency', () => {
    expect(formatTokenEstimate(100_000, 20_000)).toBe(' ~100,000 input + 20,000 output tokens');
  });
  it('preserves measured zero counts', () => {
    expect(formatTokenEstimate(0, 0)).toBe(' ~0 input + 0 output tokens');
  });
});
