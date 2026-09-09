import { describe, it, expect } from 'vitest';
import { detectConfiguredProviders } from '../src/commands/init.js';

describe('detectConfiguredProviders', () => {
  it('detects providers whose env key is set', () => {
    expect(detectConfiguredProviders({ ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv)).toEqual(['anthropic']);
  });
  it('returns multiple and ignores empty values', () => {
    const env = { OPENAI_API_KEY: 'y', OPENROUTER_API_KEY: '' } as unknown as NodeJS.ProcessEnv;
    expect(detectConfiguredProviders(env)).toEqual(['openai']);
  });
  it('returns [] when nothing is set', () => {
    expect(detectConfiguredProviders({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
