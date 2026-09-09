import { describe, it, expect } from 'vitest';
import { memoryStore } from '../src/lib/credentials.js';

describe('memoryStore (CredentialStore contract)', () => {
  it('set then get round-trips', () => {
    const s = memoryStore();
    s.set('anthropic:default', 'sk-ant-123');
    expect(s.get('anthropic:default')).toBe('sk-ant-123');
  });
  it('get returns null for a missing profile (no throw)', () => {
    expect(memoryStore().get('openai:default')).toBeNull();
  });
  it('delete returns true when present, false when absent', () => {
    const s = memoryStore({ 'openai:default': 'sk-1' });
    expect(s.delete('openai:default')).toBe(true);
    expect(s.delete('openai:default')).toBe(false);
    expect(s.get('openai:default')).toBeNull();
  });
});
