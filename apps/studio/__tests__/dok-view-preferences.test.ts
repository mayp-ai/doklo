import { describe, expect, it, vi } from 'vitest';
import { readDokViewPreference, writeDokViewPreference } from '../lib/dok-view-preferences';

describe('Dok view preferences', () => {
  it('defaults to hidden and remembers explicit choices', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    expect(readDokViewPreference(storage, 'system')).toBe(false);
    writeDokViewPreference(storage, 'system', true);
    expect(readDokViewPreference(storage, 'system')).toBe(true);
  });

  it('does not crash when storage is inaccessible', () => {
    const storage = { getItem: vi.fn(() => { throw new Error('blocked'); }), setItem: vi.fn(() => { throw new Error('blocked'); }) };
    expect(readDokViewPreference(storage, 'evidence')).toBe(false);
    expect(() => writeDokViewPreference(storage, 'evidence', true)).not.toThrow();
  });
});
