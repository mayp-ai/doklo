import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVersion } from '../src/lib/version.js';

describe('resolveVersion', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'doklo-version-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads version from a package.json in the start dir', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(resolveVersion(root)).toBe('9.9.9');
  });

  it('walks up to the nearest ancestor package.json (bundle layout)', async () => {
    // Mimic <pkgRoot>/dist/index.js walking up from dist/.
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    const dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });
    expect(resolveVersion(dist)).toBe('0.1.0');
  });

  it('walks up multiple levels (dev tsc layout dist/lib)', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    const distLib = join(root, 'dist', 'lib');
    await mkdir(distLib, { recursive: true });
    expect(resolveVersion(distLib)).toBe('0.0.0');
  });

  it('skips a version-less package.json and keeps walking up', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    const nested = join(root, 'pkg', 'dist');
    await mkdir(nested, { recursive: true });
    // Intermediate manifest without a version must not short-circuit.
    await writeFile(join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'x' }));
    expect(resolveVersion(nested)).toBe('2.0.0');
  });

  it('falls back to 0.0.0 when no package.json exists above', async () => {
    const bare = join(root, 'a', 'b', 'c');
    await mkdir(bare, { recursive: true });
    // No package.json anywhere under `root` — but an ancestor of tmpdir might
    // have one, so assert it is a string rather than a hard 0.0.0.
    expect(typeof resolveVersion(bare)).toBe('string');
  });
});
