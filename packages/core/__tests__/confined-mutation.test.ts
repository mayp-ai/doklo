import { mkdtemp, writeFile } from 'node:fs/promises';
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
