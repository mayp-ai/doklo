import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAnchorContentsSync } from '@doklo-beta/core';
import { resolveContainedPath } from '@doklo-beta/generator';

// Drift hashes are only comparable if generate and verify admit exactly the same
// anchor files. `readAnchorContents*` (core) carries a synchronous port of
// `resolveContainedPath` because drift verification is consumed synchronously by
// the MCP server — so the containment rule now exists in two implementations.
// This test is the lockstep guard between them: if either side ever changes its
// mind about which paths are inside the project root, it fails here rather than
// silently false-staling Doks in the field.
//
// Scope is the *containment* verdict, not readability: a directory anchor is
// admitted by the resolver but fails the read (EISDIR), which is a difference in
// what can be read, not in what is contained. All fixtures below are regular
// files or rejected paths, so the two verdicts must agree exactly.
describe('anchor read containment contract', () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'doklo-anchor-contract-'));
    root = join(base, 'project');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'a.ts'), 'A');
    await writeFile(join(root, 'lib/b.ts'), 'B');

    // A real, readable file just outside the root — the escape target.
    await writeFile(join(base, 'escape.ts'), 'ESCAPED');

    // A symlink whose leaf points outside the root, and a symlinked directory
    // that redirects out of it: the two ways a lexically-innocent path can still
    // reach outside.
    await symlink(join(base, 'escape.ts'), join(root, 'link.ts'));
    await symlink(base, join(root, 'outside-dir'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const cases: { name: string; file: string; admitted: boolean }[] = [
    { name: 'a plain file in the root', file: 'a.ts', admitted: true },
    { name: 'a nested file', file: 'lib/b.ts', admitted: true },
    { name: 'a parent-relative escape', file: '../escape.ts', admitted: false },
    { name: 'a deep parent-relative escape', file: 'lib/../../escape.ts', admitted: false },
    { name: 'an absolute path', file: '/etc/hosts', admitted: false },
    { name: 'a symlinked leaf pointing outside', file: 'link.ts', admitted: false },
    { name: 'a file behind a symlinked directory', file: 'outside-dir/escape.ts', admitted: false },
    { name: 'a NUL-poisoned path', file: 'a.ts\0.png', admitted: false },
    { name: 'a file that does not exist', file: 'gone.ts', admitted: false },
  ];

  for (const { name, file, admitted } of cases) {
    it(`agrees on ${name}`, async () => {
      // What generate's resolver decides.
      let resolverAdmits = true;
      try {
        await resolveContainedPath(root, file);
      } catch {
        resolverAdmits = false;
      }

      // What verify's reader decides, observed through where the anchor lands.
      const read = readAnchorContentsSync([file], root);
      const readerAdmits = read.contents.some((entry) => entry.file === file);

      expect(resolverAdmits).toBe(admitted);
      expect(readerAdmits).toBe(resolverAdmits);
      // Anything not hashed is reported, so drift can be attributed to it.
      expect(read.missing).toEqual(admitted ? [] : [file]);
    });
  }

  it('refuses an escaping anchor whose target really exists', () => {
    // Guards against the fixture rotting into a trivially-missing file: the
    // structural false stale this rule fixes only happens when the escaping path
    // resolves to something a naive join+read would have hashed.
    expect(existsSync(join(root, '../escape.ts'))).toBe(true);
    expect(readAnchorContentsSync(['../escape.ts'], root)).toEqual({
      contents: [],
      missing: ['../escape.ts'],
    });
  });
});
