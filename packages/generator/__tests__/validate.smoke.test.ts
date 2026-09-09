import { describe, it, expect } from 'vitest';
import {
  extractJsonFromResponse,
  describeJsonParseFailure,
  validateLLMResponse,
  validateDok,
  parseLLMResponseOrThrow,
} from '../src/validate.js';

describe('extractJsonFromResponse', () => {
  it('extracts JSON wrapped in ```json fences', () => {
    const raw = 'Here is the result:\n```json\n{"foo": 1}\n```\nDone.';
    expect(extractJsonFromResponse(raw)).toBe('{"foo": 1}');
  });

  it('extracts JSON wrapped in plain ``` fences', () => {
    expect(extractJsonFromResponse('```\n{"x": 2}\n```')).toBe('{"x": 2}');
  });

  it('returns the raw string if it is already valid JSON', () => {
    expect(extractJsonFromResponse('{"a": "b"}')).toBe('{"a": "b"}');
  });

  it('returns null when no JSON is recoverable', () => {
    expect(extractJsonFromResponse('I cannot help with that.')).toBe(null);
  });

  // Truncation regression (sonnet-5 large-project consolidation): a reasoning
  // model spent its whole output budget on hidden thinking, so the ```json
  // fence opened but was cut off before the closing fence. The complete JSON
  // that landed before the cutoff must still be recoverable.
  it('tolerates an UNCLOSED ```json fence when the JSON inside is complete', () => {
    const raw = '```json\n{"foo": 1, "bar": "baz"}';
    const extracted = extractJsonFromResponse(raw);
    expect(extracted).not.toBeNull();
    expect(JSON.parse(extracted!)).toEqual({ foo: 1, bar: 'baz' });
  });

  it('tolerates an UNCLOSED plain ``` fence when the JSON inside is complete', () => {
    const raw = '```\n{"x": 2}';
    const extracted = extractJsonFromResponse(raw);
    expect(extracted).not.toBeNull();
    expect(JSON.parse(extracted!)).toEqual({ x: 2 });
  });

  it('returns null for an unclosed fence whose JSON is truncated mid-string', () => {
    const raw = '```json\n{"foo": 1, "bar": "ba';
    expect(extractJsonFromResponse(raw)).toBe(null);
  });
});

describe('describeJsonParseFailure', () => {
  it('explains truncation and points at maxTokens when finishReason is "length"', () => {
    const msg = describeJsonParseFailure('Unexpected end of JSON input', 'length');
    expect(msg).toMatch(/truncated/i);
    expect(msg).toContain('maxTokens');
    expect(msg).toContain('Unexpected end of JSON input');
  });

  it('falls back to the plain parse-failure message when finishReason is undefined', () => {
    const msg = describeJsonParseFailure("Unexpected token '`'");
    expect(msg.startsWith('Failed to parse LLM JSON:')).toBe(true);
    expect(msg).toContain("Unexpected token '`'");
  });

  it('falls back to the plain parse-failure message for a normal "stop" finishReason', () => {
    const msg = describeJsonParseFailure('bad', 'stop');
    expect(msg.startsWith('Failed to parse LLM JSON:')).toBe(true);
  });
});

describe('validateLLMResponse', () => {
  it('accepts a minimal valid response', () => {
    const result = validateLLMResponse({
      doks: [
        {
          dok_id: 'AUTH',
          name: 'Email signup',
          description: 'Account creation flow.',
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.data?.doks.length).toBe(1);
    expect(result.errors).toEqual([]);
    // The validated envelope carries no retired IA topology field.
    expect(Object.keys(result.data ?? {}).sort()).toEqual([
      'doks',
      'proposed_code_mappings',
      'proposed_ia_trees',
      'proposed_lexicon_terms',
      'proposed_roles',
    ]);
  });

  it('returns issue paths for invalid input', () => {
    const result = validateLLMResponse({
      doks: [{ dok_id: 'invalid', name: 'x', description: 'short' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toContain('doks');
  });
});

describe('validateDok', () => {
  it('accepts a minimal valid dok', () => {
    const result = validateDok({
      dok_id: 'AUTH',
      name: 'Email signup',
      description: 'Account creation flow.',
    });
    expect(result.valid).toBe(true);
    expect(result.data?.dok_id).toBe('AUTH');
  });
});

describe('parseLLMResponseOrThrow', () => {
  it('throws an aggregated error message on failure', () => {
    expect(() =>
      parseLLMResponseOrThrow({ doks: [{ dok_id: 'bad' }] }),
    ).toThrow(/validation failed/i);
  });
});
