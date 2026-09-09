// Token + cost estimation utilities for Anthropic Claude calls.
//
// Feature-aware estimators (per-feature, project total) are *not* here —
// they live in @doklo-beta/generator next to the consolidator that owns
// the Feature shape.

const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKEN_RATIO = 0.3;

// Claude Sonnet pricing (per million tokens). Update when Anthropic changes
// pricing or when adding model-tier selection (Haiku for L1-L2 work).
export const PRICING = {
  inputPerMillion: 3,
  outputPerMillion: 15,
} as const;

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CostEstimate extends TokenEstimate {
  estimatedCost: number;
}

export function bytesToTokens(bytes: number): number {
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

export function estimateTokensFromBytes(bytes: number): TokenEstimate {
  const inputTokens = bytesToTokens(bytes);
  const outputTokens = Math.ceil(inputTokens * OUTPUT_TOKEN_RATIO);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function calculateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * PRICING.inputPerMillion + outputTokens * PRICING.outputPerMillion) /
    1_000_000
  );
}

export interface ModelPricing {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/** Cost in USD. `pricing` is USD per 1M tokens (models.dev `cost`). Falls back
 * to the Sonnet PRICING constant when unknown. */
export function calculateCostWithPricing(
  inputTokens: number,
  outputTokens: number,
  pricing?: ModelPricing,
): number {
  const inPer = pricing?.input ?? PRICING.inputPerMillion;
  const outPer = pricing?.output ?? PRICING.outputPerMillion;
  return (inputTokens * inPer + outputTokens * outPer) / 1_000_000;
}

export function estimateFromBytes(totalBytes: number): CostEstimate {
  const tokens = estimateTokensFromBytes(totalBytes);
  return {
    ...tokens,
    estimatedCost: calculateCost(tokens.inputTokens, tokens.outputTokens),
  };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export function formatCost(cost: number): string {
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}
