import type { LLMUsage } from '@doklo-beta/generator';
import { estimateGenerateTokens, type GenerateTokenEstimate } from './generate-gate.js';

export interface GenerateTokenUsage {
  attemptedCalls: number;
  measuredCalls: number;
  missingCalls: number;
  /** Estimates cover attempted calls only, including failures. */
  estimated: GenerateTokenEstimate;
  /** Sum of measured usage; partial when missingCalls is nonzero. */
  actual: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
}

export function createGenerateTokenUsage(): GenerateTokenUsage {
  return {
    attemptedCalls: 0, measuredCalls: 0, missingCalls: 0,
    estimated: estimateGenerateTokens([]),
    actual: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
}

export function recordGenerateUsage(summary: GenerateTokenUsage, prompt: string, usage: LLMUsage | null): void {
  summary.attemptedCalls++;
  const estimate = estimateGenerateTokens([{ prompt }]);
  summary.estimated.inputTokens += estimate.inputTokens;
  summary.estimated.outputTokens += estimate.outputTokens;
  summary.estimated.maxOutputTokens += estimate.maxOutputTokens;
  if (!usage) { summary.missingCalls++; return; }
  summary.measuredCalls++;
  summary.actual.inputTokens += usage.input_tokens;
  summary.actual.outputTokens += usage.output_tokens;
  summary.actual.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  summary.actual.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
}
