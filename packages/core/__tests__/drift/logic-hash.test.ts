import { describe, it, expect } from 'vitest';
import { computeLogicHash } from '../../src/drift/logic-hash.js';

describe('computeLogicHash', () => {
  it('is deterministic — identical inputs produce the same hash', () => {
    const inputs = [{ file: 'a.ts', content: 'export const a = 1;' }];
    expect(computeLogicHash(inputs)).toBe(computeLogicHash(inputs));
  });

  it('is order-independent — reordering anchors yields the same hash', () => {
    const a = { file: 'a.ts', content: 'A' };
    const b = { file: 'b.ts', content: 'B' };
    expect(computeLogicHash([a, b])).toBe(computeLogicHash([b, a]));
  });

  it('changes when a file content changes', () => {
    const before = computeLogicHash([{ file: 'a.ts', content: 'old' }]);
    const after = computeLogicHash([{ file: 'a.ts', content: 'new' }]);
    expect(after).not.toBe(before);
  });

  it('changes when a file path changes (rename, same content)', () => {
    const before = computeLogicHash([{ file: 'a.ts', content: 'X' }]);
    const after = computeLogicHash([{ file: 'b.ts', content: 'X' }]);
    expect(after).not.toBe(before);
  });

  it('returns empty string for no anchors (hash is meaningless without sources)', () => {
    expect(computeLogicHash([])).toBe('');
  });

  it('produces a 64-char hex sha256 digest', () => {
    expect(computeLogicHash([{ file: 'a.ts', content: 'X' }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not collide across a content/path swap (separator-safe)', () => {
    // Guards against naive concatenation: ("ab","c") must not equal ("a","bc").
    const h1 = computeLogicHash([{ file: 'ab', content: 'c' }]);
    const h2 = computeLogicHash([{ file: 'a', content: 'bc' }]);
    expect(h1).not.toBe(h2);
  });
});
