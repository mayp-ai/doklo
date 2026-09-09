import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBackend, type LLMClientConfig } from '../src/llm-client.js';
import { mapModelToClaudeCodeAlias } from '../src/claude-code-client.js';

const baseConfig: LLMClientConfig = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 1024,
  timeout: 60_000,
};

describe('resolveBackend', () => {
  const originalEnv = process.env['DOKLO_LLM_BACKEND'];

  beforeEach(() => {
    delete process.env['DOKLO_LLM_BACKEND'];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['DOKLO_LLM_BACKEND'];
    else process.env['DOKLO_LLM_BACKEND'] = originalEnv;
  });

  it('defaults to claude-code', () => {
    expect(resolveBackend(baseConfig)).toBe('claude-code');
  });

  it('honors config.backend over env', () => {
    process.env['DOKLO_LLM_BACKEND'] = 'claude-code';
    expect(resolveBackend({ ...baseConfig, backend: 'anthropic-api' })).toBe('anthropic-api');
  });

  it('honors DOKLO_LLM_BACKEND env when config.backend is unset', () => {
    process.env['DOKLO_LLM_BACKEND'] = 'anthropic-api';
    expect(resolveBackend(baseConfig)).toBe('anthropic-api');
  });

  it('ignores invalid env values (falls back to default claude-code)', () => {
    process.env['DOKLO_LLM_BACKEND'] = 'gpt-5';
    expect(resolveBackend(baseConfig)).toBe('claude-code');
  });
});

describe('mapModelToClaudeCodeAlias', () => {
  it('maps Anthropic SDK ids to claude-code aliases', () => {
    expect(mapModelToClaudeCodeAlias('claude-haiku-4-5')).toBe('haiku');
    expect(mapModelToClaudeCodeAlias('claude-sonnet-4-20250514')).toBe('sonnet');
    expect(mapModelToClaudeCodeAlias('claude-opus-4-7')).toBe('opus');
  });

  it('passes through non-anthropic ids unchanged', () => {
    expect(mapModelToClaudeCodeAlias('haiku')).toBe('haiku');
    expect(mapModelToClaudeCodeAlias('sonnet')).toBe('sonnet');
    expect(mapModelToClaudeCodeAlias('some-custom')).toBe('some-custom');
  });
});
