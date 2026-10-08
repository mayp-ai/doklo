import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('keeps the engine HWPX toolchain optional in the flattened CLI release manifest', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const cli = join(root, 'apps/cli');
  const source = readFileSync(join(cli, 'scripts/build-release.mjs'), 'utf8');
  const start = source.indexOf('const DROP_TO_PEER =');
  const end = source.indexOf('function writeManifest()', start);
  const result = runInNewContext(`${source.slice(start, end)}\ncomputeDependencies()`, {
    readFileSync, join, CLI_DIR: cli, PACKAGE_DIRS: [join(root, 'packages/livedoc-engine')], REPO_ROOT: root,
  });
  expect(result.peers).toEqual({ kordoc: '^2.9.0' });
  expect(result.dependencies).not.toHaveProperty('kordoc');
});
