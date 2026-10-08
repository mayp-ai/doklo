import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createConfinedMutationOperations,
  nativeConfinedMutationFileSystem,
} from '../src/fs/confined-mutation-internal.js';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function rejectedReason(promise: Promise<void>): Promise<unknown> {
  return promise.then(() => undefined, (reason: unknown) => reason);
}

describe('confined mutation reauthorization', () => {
  it.each(['mtimeNs', 'ctimeNs'] as const)('rejects a changed publish destination even when its inode is reused (%s)', async (field) => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-publish-snapshot-'));
    try {
      await mkdir(join(root, 'official'));
      await mkdir(join(root, 'staged'));
      await writeFile(join(root, 'staged/new.txt'), 'new publication');
      const original = await nativeConfinedMutationFileSystem.lstat(join(root, 'official'));
      let changed = false;
      const confined = createConfinedMutationOperations({
        ...nativeConfinedMutationFileSystem,
        lstat: async (path) => {
          if (path.endsWith('/official')) {
            // Deterministically model inode reuse and separately exercise each
            // timestamp, independent of the host filesystem's allocation.
            return Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
              [field]: original[field] + (changed ? 1n : 0n),
            });
          }
          return nativeConfinedMutationFileSystem.lstat(path);
        },
      });
      const expectedDestination = await confined.captureDirectoryPublishDestination(root, 'official');
      await writeFile(join(root, 'official/keep.txt'), 'concurrent content');
      changed = true;

      await expect(confined.publishDirectoryContained(root, 'staged', 'official', {
        expectedDestination,
      })).rejects.toMatchObject({ code: 'PATH_IDENTITY_CHANGED' });
      expect(await readFile(join(root, 'official/keep.txt'), 'utf8')).toBe('concurrent content');
      expect(await readFile(join(root, 'staged/new.txt'), 'utf8')).toBe('new publication');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves an EACCES error from reauthorization realpath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-reauthorize-'));
    await writeFile(join(root, 'target.json'), 'original\n');
    const injectedError = errnoError('EACCES');
    let rejectReauthorization = false;
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      realpath: async (path) => {
        if (rejectReauthorization) throw injectedError;
        return nativeConfinedMutationFileSystem.realpath(path);
      },
    });
    const expected = await confined.captureContainedPathIdentity(
      root,
      'target.json',
    );
    rejectReauthorization = true;

    const error = await rejectedReason(
      confined.assertContainedPathIdentity(root, 'target.json', expected),
    );

    expect(error).toBe(injectedError);
    expect(error).toMatchObject({ code: 'EACCES' });
  });

  it('preserves an EMFILE error from reauthorization lstat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-reauthorize-'));
    await writeFile(join(root, 'target.json'), 'original\n');
    const injectedError = errnoError('EMFILE');
    let rejectReauthorization = false;
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      lstat: async (path) => {
        if (rejectReauthorization) throw injectedError;
        return nativeConfinedMutationFileSystem.lstat(path);
      },
    });
    const expected = await confined.captureContainedPathIdentity(
      root,
      'target.json',
    );
    rejectReauthorization = true;

    const error = await rejectedReason(
      confined.assertContainedPathIdentity(root, 'target.json', expected),
    );

    expect(error).toBe(injectedError);
    expect(error).toMatchObject({ code: 'EMFILE' });
  });
});
