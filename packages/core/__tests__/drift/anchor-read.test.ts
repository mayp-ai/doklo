import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readAnchorContents,
  readAnchorContentsSync,
} from '../../src/drift/stale.js';

// Anchor reading is the *input* to the drift hash, and it is consumed from two
// sides: generate hashes what it reads, verify re-hashes what it reads. These
// tests pin the properties that make those two sides agree — one rule, one set
// of admitted files — because when the rule lived in two places they diverged.

describe('anchor reads', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    // `base` is the escape target: `root` is the project root under test, and
    // `base/escape.ts` is a real, readable file that sits just outside it.
    base = mkdtempSync(join(tmpdir(), 'doklo-anchor-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'A');
    writeFileSync(join(root, 'lib/b.ts'), 'B');
    writeFileSync(join(base, 'escape.ts'), 'ESCAPED');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // Two readable files, one deleted file, one path escaping the root, and a
  // repeated entry — every class the rule has to decide, in one call.
  const mixedFiles = [
    'a.ts',
    'lib/b.ts',
    'gone.ts',
    '../escape.ts',
    'a.ts',
  ];

  it('reads contained anchors and reports unreadable ones as missing', () => {
    expect(readAnchorContentsSync(['a.ts', 'lib/b.ts', 'gone.ts'], root)).toEqual({
      contents: [
        { file: 'a.ts', content: 'A' },
        { file: 'lib/b.ts', content: 'B' },
      ],
      missing: ['gone.ts'],
    });
  });

  it('excludes an anchor path that escapes the project root, even though the file exists', async () => {
    // The hazard is specifically an escaping path whose target is present and
    // readable: a plain join+read would happily hash it. Generate refuses it, so
    // verify has to refuse it too or the hashes can never line up.
    expect(existsSync(join(root, '../escape.ts'))).toBe(true);

    const sync = readAnchorContentsSync(['a.ts', '../escape.ts'], root);
    expect(sync.contents).toEqual([{ file: 'a.ts', content: 'A' }]);
    expect(sync.missing).toEqual(['../escape.ts']);

    const async_ = await readAnchorContents(['a.ts', '../escape.ts'], root);
    expect(async_.contents).toEqual([{ file: 'a.ts', content: 'A' }]);
    expect(async_.missing).toEqual(['../escape.ts']);
  });

  it.each([false, true])('excludes a source ignored after it was anchored (tracked=%s)', async tracked => {
    if (tracked) {
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'add', 'a.ts', 'lib/b.ts']);
    }
    writeFileSync(join(root, '.gitignore'), 'a.ts\n');
    writeFileSync(join(root, 'a.ts'), 'SYNTHETIC_PRIVATE_SOURCE');
    const expected = { contents: [{ file: 'lib/b.ts', content: 'B' }], missing: ['a.ts'] };
    expect(readAnchorContentsSync(['a.ts', 'lib/b.ts'], root)).toEqual(expected);
    expect(await readAnchorContents(['a.ts', 'lib/b.ts'], root)).toEqual(expected);
  });

  it('excludes credential files referenced by legacy anchors', () => {
    writeFileSync(join(root, '.env'), 'SYNTHETIC_PRIVATE_SOURCE');
    expect(readAnchorContentsSync(['.env'], root)).toEqual({ contents: [], missing: ['.env'] });
  });

  it('resolves the sync and async readers to identical results (compute ≡ verify)', async () => {
    // The equivalence generate and verify are built on. If the async facade ever
    // grows a rule of its own, this is what catches it.
    const sync = readAnchorContentsSync(mixedFiles, root);
    const async_ = await readAnchorContents(mixedFiles, root);

    expect(async_).toEqual(sync);
    expect(async_.contents).toEqual(sync.contents);
    expect(async_.missing).toEqual(sync.missing);
  });

  it('keeps duplicate entries instead of de-duplicating them', async () => {
    // De-duplication would change the hash of every Dok whose file set repeats a
    // path, so it stays out of this layer (tracked separately as B6).
    const sync = readAnchorContentsSync(['a.ts', 'a.ts'], root);
    expect(sync.contents).toEqual([
      { file: 'a.ts', content: 'A' },
      { file: 'a.ts', content: 'A' },
    ]);

    const repeatedMissing = readAnchorContentsSync(['gone.ts', 'gone.ts'], root);
    expect(repeatedMissing.missing).toEqual(['gone.ts', 'gone.ts']);

    expect(await readAnchorContents(mixedFiles, root)).toEqual(
      readAnchorContentsSync(mixedFiles, root),
    );
  });

  it('reads nested anchors through real directories unchanged', () => {
    // The containment check walks every directory between root and leaf; ordinary
    // nested sources must survive that walk byte-identically.
    expect(readAnchorContentsSync(['lib/b.ts'], root)).toEqual({
      contents: [{ file: 'lib/b.ts', content: 'B' }],
      missing: [],
    });
  });
});
