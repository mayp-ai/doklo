// LLM response validation against v5 schemas.
//
// Pipeline:
//   raw string → extractJsonFromResponse → normalize → Zod parse → typed result
//
// `normalize` is intentionally minimal. We only patch divergence we have
// actually observed in LLM output. Speculative defensive coding here adds
// dead code; we add a normalization rule when (and only when) a real
// failure proves we need it.

import {
  LLMResponseSchema,
  DokSchema,
  type LLMResponse,
  type Dok,
} from '@doklo-beta/core';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors: ValidationIssue[];
}

// Extract a JSON object from raw LLM text. Handles markdown code fences
// (most common LLM mistake) and falls back to the whole string.
//
// Returns null if no JSON could be extracted.
export function extractJsonFromResponse(response: string): string | null {
  // 1. Closed fence (```json ... ```), or the raw string if there is no fence.
  const fenced = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const candidate = fenced ? fenced[1]!.trim() : response.trim();

  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // fall through to unclosed-fence tolerance
  }

  // 2. Unclosed fence. A truncated response (e.g. a reasoning model that spent
  //    its whole output budget on hidden thinking, then hit maxTokens) can open
  //    a ```json fence but never emit the closing ```. Step 1 requires a closing
  //    fence, so it fails. If the JSON that landed before the cutoff is complete,
  //    strip the opening fence line (and a trailing ``` if one is present) and
  //    retry. Genuinely truncated JSON still fails to parse → null.
  const trimmed = response.trim();
  const openFence = trimmed.match(/^```(?:json)?[ \t]*\r?\n/);
  if (openFence) {
    const inner = trimmed
      .slice(openFence[0].length)
      .replace(/\r?\n```[\s\S]*$/, '')
      .trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      return null;
    }
  }

  return null;
}

// Build a human-actionable message for a JSON parse failure. When the model
// stopped because it hit the token limit (`finishReason === 'length'`), the
// JSON is almost certainly truncated — say so and point at the fix, instead of
// leaking a cryptic `Unexpected token` from JSON.parse. Reasoning models are
// especially prone to this: hidden thinking eats most of the output budget.
export function describeJsonParseFailure(parseError: string, finishReason?: string): string {
  if (finishReason === 'length') {
    return `LLM output was truncated at the maxTokens limit before the JSON completed (reasoning models can spend most of the budget on hidden thinking). Raise maxTokens or use a different model. Parse error: ${parseError}`;
  }
  return `Failed to parse LLM JSON: ${parseError}`;
}

// Best-effort normalization for known LLM divergence patterns.
// Keep this small — only add a rule when we observe a real failure mode.
export function normalizeLLMResponse(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  // Currently a pass-through. Add rules here only when production output
  // demonstrably needs them.
  return raw;
}

export function validateLLMResponse(raw: unknown): ValidationResult<LLMResponse> {
  const normalized = normalizeLLMResponse(raw);
  const result = LLMResponseSchema.safeParse(normalized);
  if (result.success) {
    return { valid: true, data: result.data, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

export function validateDok(raw: unknown): ValidationResult<Dok> {
  const result = DokSchema.safeParse(raw);
  if (result.success) {
    return { valid: true, data: result.data, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

// Convenience: parse-or-throw variant for code paths that prefer exceptions.
export function parseLLMResponseOrThrow(raw: unknown): LLMResponse {
  const result = validateLLMResponse(raw);
  if (!result.valid || !result.data) {
    throw new Error(
      `LLM response validation failed:\n${result.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}
