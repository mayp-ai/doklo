import { describe, it, expect } from 'vitest';
import { runAuth } from '../src/commands/auth.js';
import { memoryStore } from '../src/lib/credentials.js';

describe('runAuth', () => {
  it('stores the key under provider:default and returns the profile id', async () => {
    const store = memoryStore();
    const res = await runAuth({ provider: 'anthropic', apiKey: 'sk-ant-9' }, { store });
    expect(res.profileId).toBe('anthropic:default');
    expect(store.get('anthropic:default')).toBe('sk-ant-9');
  });
  it('honors a custom profile label', async () => {
    const store = memoryStore();
    const res = await runAuth({ provider: 'openai', apiKey: 'sk-o', profile: 'work' }, { store });
    expect(res.profileId).toBe('openai:work');
    expect(store.get('openai:work')).toBe('sk-o');
  });
});
