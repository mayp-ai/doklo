import { describe, it, expect } from 'vitest';
import { buildFactoryOptions } from '../src/provider-runner.js';

describe('buildFactoryOptions', () => {
  it('returns only apiKey when only apiKey is provided', () => {
    const result = buildFactoryOptions({ apiKey: 'sk-test' }, 'sk-test');
    expect(result).toEqual({ apiKey: 'sk-test' });
    expect('baseURL' in result).toBe(false);
    expect('fetch' in result).toBe(false);
  });

  it('returns all three fields when all are provided', () => {
    const customFetch: typeof fetch = async (input, init) => new Response('ok');
    const result = buildFactoryOptions(
      { apiKey: 'sk-test', baseURL: 'https://chatgpt.com/backend-api/codex/responses', fetch: customFetch },
      'sk-test',
    );
    expect(result).toEqual({
      apiKey: 'sk-test',
      baseURL: 'https://chatgpt.com/backend-api/codex/responses',
      fetch: customFetch,
    });
  });

  it('omits apiKey when undefined (config has no apiKey and resolved key is undefined)', () => {
    const result = buildFactoryOptions({ baseURL: 'https://example.com' }, undefined);
    expect('apiKey' in result).toBe(false);
    expect(result.baseURL).toBe('https://example.com');
  });

  it('omits fetch when not set on config', () => {
    const result = buildFactoryOptions({ apiKey: 'sk-x', baseURL: 'https://x.com' }, 'sk-x');
    expect('fetch' in result).toBe(false);
  });

  it('omits baseURL when not set on config', () => {
    const customFetch: typeof fetch = async () => new Response('ok');
    const result = buildFactoryOptions({ fetch: customFetch }, 'sk-x');
    expect('baseURL' in result).toBe(false);
    expect(result.fetch).toBe(customFetch);
  });

  // OAuth placeholder tests
  it('buildFactoryOptions-oauth-placeholder: injects codex-oauth placeholder when fetch present and no apiKey', () => {
    const customFetch: typeof fetch = async () => new Response('ok');
    const result = buildFactoryOptions({ fetch: customFetch }, undefined);
    expect(result.apiKey).toBe('codex-oauth');
    expect(result.fetch).toBe(customFetch);
  });

  it('buildFactoryOptions-no-fetch-no-key: omits apiKey when no fetch and no apiKey (normal path unchanged)', () => {
    const result = buildFactoryOptions({ baseURL: 'https://example.com' }, undefined);
    expect('apiKey' in result).toBe(false);
    expect(result.baseURL).toBe('https://example.com');
  });

  it('buildFactoryOptions-real-key-plus-fetch: uses real apiKey (not placeholder) when both present', () => {
    const customFetch: typeof fetch = async () => new Response('ok');
    const result = buildFactoryOptions({ fetch: customFetch }, 'sk-real');
    expect(result.apiKey).toBe('sk-real');
    expect(result.fetch).toBe(customFetch);
  });
});
