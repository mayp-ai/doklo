import { describe, expect, it } from 'vitest';
import { createGenerateTokenUsage, recordGenerateUsage } from '../src/lib/generate-usage.js';

describe('generate usage', () => {
  it('keeps unknown usage distinct from measured zero and preserves cache totals', () => {
    const summary = createGenerateTokenUsage();
    recordGenerateUsage(summary, 'aaaa', null);
    recordGenerateUsage(summary, 'aaaa', { input_tokens: 0, output_tokens: 0 });
    recordGenerateUsage(summary, 'aaaa', { input_tokens: 12, output_tokens: 34,
      cache_read_input_tokens: 56, cache_creation_input_tokens: 78 });
    expect(summary).toEqual({
      attemptedCalls: 3, measuredCalls: 2, missingCalls: 1,
      estimated: { inputTokens: 3, outputTokens: 4500, maxOutputTokens: 24576 },
      actual: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 56, cacheCreationTokens: 78 },
    });
  });
});
