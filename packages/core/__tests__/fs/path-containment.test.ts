import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PathOutsideRootError,
  resolveContainedPath,
  resolveContainedPathSync,
} from '../../src/fs/path-containment.js';

// `resolveContainedPathSync` exists only because drift verification is consumed
// synchronously (MCP) while generate resolves anchors asynchronously. Drift
// compares a hash computed over what the async form admitted against a hash
// recomputed over what the sync form admits — so the moment their verdicts
// disagree, an untouched Dok hashes differently on the two sides and goes
// permanently stale. This suite is the parity pin between them.

type Verdict =
  | { admitted: true; resolved: string }
  | { admitted: false; kind: 'outside' | 'missing' };

function classify(error: unknown): Verdict {
  if (error instanceof PathOutsideRootError) return { admitted: false, kind: 'outside' };
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { admitted: false, kind: 'missing' };
  throw error;
}

describe('resolveContainedPathSync parity with resolveContainedPath', () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'doklo-containment-'));
    root = join(base, 'project');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'a.ts'), 'A');
    await writeFile(join(root, 'lib/b.ts'), 'B');

    // A real, readable file just outside the root — the escape target.
    await writeFile(join(base, 'escape.ts'), 'ESCAPED');

    // The two ways a lexically-innocent path still reaches outside: a symlinked
    // leaf, and an ordinary-looking path behind a symlinked directory.
    await symlink(join(base, 'escape.ts'), join(root, 'link.ts'));
    await symlink(base, join(root, 'outside-dir'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // The input classes the containment rule has to decide. `admitted` is asserted
  // outright too, so a change that makes *both* forms wrong in the same way is
  // still caught rather than passing as "in agreement".
  const cases: {
    name: string;
    file: (base: string) => string;
    admitted: boolean;
  }[] = [
    { name: 'a plain file in the root', file: () => 'a.ts', admitted: true },
    { name: 'a nested file', file: () => 'lib/b.ts', admitted: true },
    { name: 'the root itself', file: () => '.', admitted: true },
    { name: 'a parent-relative escape', file: () => '../escape.ts', admitted: false },
    { name: 'a deep parent-relative escape', file: () => 'lib/../../escape.ts', admitted: false },
    { name: 'an absolute path', file: (b) => join(b, 'escape.ts'), admitted: false },
    { name: 'a symlinked leaf pointing outside', file: () => 'link.ts', admitted: false },
    { name: 'a file behind a symlinked directory', file: () => 'outside-dir/escape.ts', admitted: false },
    { name: 'a NUL-poisoned path', file: () => 'a.ts\0.png', admitted: false },
    { name: 'a file that does not exist', file: () => 'gone.ts', admitted: false },
  ];

  for (const { name, file, admitted } of cases) {
    it(`agrees on ${name}`, async () => {
      const relativePath = file(base);

      let asyncVerdict: Verdict;
      try {
        asyncVerdict = { admitted: true, resolved: await resolveContainedPath(root, relativePath) };
      } catch (error) {
        asyncVerdict = classify(error);
      }

      let syncVerdict: Verdict;
      try {
        syncVerdict = { admitted: true, resolved: resolveContainedPathSync(root, relativePath) };
      } catch (error) {
        syncVerdict = classify(error);
      }

      expect(asyncVerdict.admitted).toBe(admitted);
      // Same verdict, and when admitted the same resolved realpath — a resolved
      // path that differed would read a different file into the hash.
      expect(syncVerdict).toEqual(asyncVerdict);
    });
  }

  it('rejects an escaping path whose target really exists', () => {
    // Guards the fixture: the escape cases only prove anything while the target
    // is a real, readable file that a naive join+read would have accepted.
    expect(() => resolveContainedPathSync(root, '../escape.ts')).toThrow(PathOutsideRootError);
    expect(resolveContainedPathSync(join(base, 'project'), 'a.ts')).toContain('a.ts');
  });
});
