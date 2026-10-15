import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  computeLogicHash,
  computeNormalizedLogicHash,
  computeSourceFileSha256,
  normalizedHashMatchesVersion,
  type LogicHashNormalizer,
} from '../../src/drift/logic-hash.js';

// Core never parses source: the format-only layer's normaliser is injected.
// These fakes stand in for the real one (adapter-nextjs) — they only need to be
// deterministic so the hash shape and the version gate can be pinned here.
const dropLineComments: LogicHashNormalizer = {
  version: 'fake-v1',
  normalizeForHash: (file, content) =>
    file.endsWith('.ts') ? content.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim() : null,
};

describe('computeNormalizedLogicHash', () => {
  const files = [
    { file: 'lib/a.ts', content: 'export const a = 1;' },
    { file: 'prisma/schema.prisma', content: 'model A { id Int @id }' },
  ];

  it('is prefixed with the normaliser version, then a 64-char sha256', () => {
    expect(computeNormalizedLogicHash(files, dropLineComments)).toMatch(/^fake-v1:[0-9a-f]{64}$/);
  });

  it('is deterministic and order-independent', () => {
    const h = computeNormalizedLogicHash(files, dropLineComments);
    expect(computeNormalizedLogicHash(files, dropLineComments)).toBe(h);
    expect(computeNormalizedLogicHash([...files].reverse(), dropLineComments)).toBe(h);
  });

  it('ignores what the normaliser drops, and only that', () => {
    const h = computeNormalizedLogicHash(files, dropLineComments);
    const commented = [{ file: 'lib/a.ts', content: '// note\nexport const a = 1; // tail' }, files[1]!];
    expect(computeNormalizedLogicHash(commented, dropLineComments)).toBe(h);
    expect(computeLogicHash(commented)).not.toBe(computeLogicHash(files));
    const real = [{ file: 'lib/a.ts', content: 'export const a = 2;' }, files[1]!];
    expect(computeNormalizedLogicHash(real, dropLineComments)).not.toBe(h);
  });

  it('hashes a file the normaliser declines (null) by its raw content', () => {
    const h = computeNormalizedLogicHash(files, dropLineComments);
    const prismaComment = [files[0]!, { file: 'prisma/schema.prisma', content: '// c\nmodel A { id Int @id }' }];
    expect(computeNormalizedLogicHash(prismaComment, dropLineComments)).not.toBe(h);
  });

  it('is path-sensitive and empty for no input', () => {
    const moved = [{ file: 'lib/b.ts', content: files[0]!.content }, files[1]!];
    expect(computeNormalizedLogicHash(moved, dropLineComments)).not.toBe(computeNormalizedLogicHash(files, dropLineComments));
    expect(computeNormalizedLogicHash([], dropLineComments)).toBe('');
  });

  it('tags each entry so a raw file can never collide with a canonical form', () => {
    // Same text reaches the digest either as a canonical form (N) or raw (R).
    const canonical: LogicHashNormalizer = { version: 'v', normalizeForHash: () => 'same' };
    const raw: LogicHashNormalizer = { version: 'v', normalizeForHash: () => null };
    expect(computeNormalizedLogicHash([{ file: 'x.ts', content: 'same' }], canonical))
      .not.toBe(computeNormalizedLogicHash([{ file: 'x.ts', content: 'same' }], raw));
  });

  it('matches the benchmark harness shape: sorted, NUL-delimited, N/R tagged', () => {
    const h = createHash('sha256');
    for (const { file, content } of [...files].sort((a, b) => (a.file < b.file ? -1 : 1))) {
      const normalized = dropLineComments.normalizeForHash(file, content);
      h.update(file).update('\0').update(normalized === null ? 'R' : 'N').update('\0')
        .update(normalized ?? content).update('\0');
    }
    expect(computeNormalizedLogicHash(files, dropLineComments)).toBe(`fake-v1:${h.digest('hex')}`);
  });

  it('treats a normaliser that throws as declining the file (raw), never as format-only', () => {
    const throwing: LogicHashNormalizer = {
      version: 'v',
      normalizeForHash: () => { throw new Error('boom'); },
    };
    const declining: LogicHashNormalizer = { version: 'v', normalizeForHash: () => null };
    expect(computeNormalizedLogicHash(files, throwing)).toBe(computeNormalizedLogicHash(files, declining));
  });
});

describe('normalizedHashMatchesVersion', () => {
  it('accepts only a hash stamped by the same normaliser version', () => {
    const stored = computeNormalizedLogicHash([{ file: 'a.ts', content: 'x' }], dropLineComments);
    expect(normalizedHashMatchesVersion(stored, dropLineComments)).toBe(true);
    expect(normalizedHashMatchesVersion(stored, { ...dropLineComments, version: 'fake-v2' })).toBe(false);
    // A version that is a prefix of another must not match it.
    expect(normalizedHashMatchesVersion(stored, { ...dropLineComments, version: 'fake' })).toBe(false);
    expect(normalizedHashMatchesVersion(`fake-v1${'0'.repeat(64)}`, dropLineComments)).toBe(false);
  });
});

describe('computeSourceFileSha256', () => {
  it('is the sha256 hex of the text as the drift read returns it', () => {
    expect(computeSourceFileSha256('export const a = 1;')).toBe(
      createHash('sha256').update('export const a = 1;', 'utf8').digest('hex'),
    );
    expect(computeSourceFileSha256('한글')).toBe(createHash('sha256').update(Buffer.from('한글', 'utf8')).digest('hex'));
  });
});
