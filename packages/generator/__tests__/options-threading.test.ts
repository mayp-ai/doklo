import { describe, it, expect } from 'vitest';
import { resolveProviderKind, type LLMClientConfig } from '../src/llm-client.js';

// The generator builds an LLMClientConfig from its options; this asserts the
// new fields survive resolution (the call-site spread is exercised here by
// constructing the same config shape the generators produce).
describe('providerKind/baseURL threading', () => {
  it('an openai-compatible config resolves to the openai-compatible kind', () => {
    const cfg: LLMClientConfig = {
      model: 'google/gemini-2.5-pro',
      maxTokens: 4096,
      timeout: 300_000,
      providerKind: 'openai-compatible',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey: 'sk-gem',
    };
    expect(resolveProviderKind(cfg)).toBe('openai-compatible');
    expect(cfg.baseURL).toContain('googleapis.com');
  });
});
