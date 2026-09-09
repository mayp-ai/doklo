// Provider-independent token estimate for CLI summaries.
export function formatTokenEstimate(inputTokens: number, outputTokens: number): string {
  return ` ~${inputTokens.toLocaleString('en-US')} input + ${outputTokens.toLocaleString('en-US')} output tokens`;
}
