import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PathOutsideRootError,
  resolveContainedOutputPath,
} from '../src/path-containment.js';

describe('path containment public API', () => {
  it('exports the shared resolver and its typed error', async () => {
    const generator = await import('../src/index.js');

    expect(generator).toHaveProperty('resolveContainedPath');
    expect(generator).toHaveProperty('resolveContainedOutputPath');
    expect(generator).toHaveProperty('PathOutsideRootError');
  });

  it('resolves a missing output beneath the real workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-output-path-'));

    await expect(
      resolveContainedOutputPath(root, '.doklo/hub/services/web/ia.json'),
    ).resolves.toBe(join(
      await realpath(root),
      '.doklo/hub/services/web/ia.json',
    ));
  });

  it('rejects an output whose parent symlink escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-output-path-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-output-outside-'));
    await mkdir(join(root, '.doklo', 'hub'), { recursive: true });
    await symlink(outside, join(root, '.doklo', 'hub', 'services'));

    await expect(
      resolveContainedOutputPath(root, '.doklo/hub/services/web/ia.json'),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('rejects a final output symlink even when its target is inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-output-path-'));
    await mkdir(join(root, '.doklo', 'hub', 'services', 'web'), { recursive: true });
    await symlink(
      join(root, 'workspace.json'),
      join(root, '.doklo', 'hub', 'services', 'web', 'ia.json'),
    );

    await expect(
      resolveContainedOutputPath(root, '.doklo/hub/services/web/ia.json'),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });
});
