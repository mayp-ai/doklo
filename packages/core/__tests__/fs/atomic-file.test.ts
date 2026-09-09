import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertContainedPathIdentity,
  captureContainedPathIdentity,
  PathIdentityChangedError,
  PathOutsideRootError,
  publishDirectoryContained,
  removeContained,
  resolveContainedPath,
  unlinkContained,
  writeFileAtomic,
  writeFileAtomicContained,
} from '../../src/index.js';
import * as core from '../../src/index.js';
import {
  createConfinedMutationOperations,
  nativeConfinedMutationFileSystem,
} from '../../src/fs/confined-mutation-internal.js';

const execFileAsync = promisify(execFile);

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function withoutStableIdentity<T extends { dev: bigint; ino: bigint }>(
  stats: T,
): T {
  return { ...stats, dev: 0n, ino: 0n };
}

async function rejectedReason(promise: Promise<void>): Promise<unknown> {
  return promise.then(() => undefined, (reason: unknown) => reason);
}

async function readUtf8IfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

type DirectoryPublisher = (
  root: string,
  stagedRelativePath: string,
  destinationRelativePath: string,
  options?: {
    expectedDestination?: (
      | { exists: false }
      | {
        exists: true;
        realPath: string;
        device: string;
        inode: string;
      }
    );
  },
) => Promise<void>;

function publicDirectoryPublisher(): DirectoryPublisher {
  return (core as typeof core & {
    publishDirectoryContained: DirectoryPublisher;
  }).publishDirectoryContained;
}

function privateDirectoryPublisher(
  confined: ReturnType<typeof createConfinedMutationOperations>,
): DirectoryPublisher {
  return (confined as typeof confined & {
    publishDirectoryContained: DirectoryPublisher;
  }).publishDirectoryContained;
}

describe('shared filesystem primitives', () => {
  it('rejects an assertion when an existing file path has been replaced with the same type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'target.json');
    const preservedOriginal = join(root, 'target.original.json');
    await writeFile(destination, 'original\n');
    const expectedIdentity = await captureContainedPathIdentity(
      root,
      'target.json',
    );
    await rename(destination, preservedOriginal);
    await writeFile(destination, 'replacement\n');

    const error = await rejectedReason(
      assertContainedPathIdentity(root, 'target.json', expectedIdentity),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      retryable: true,
    });
    expect(await readFile(destination, 'utf-8')).toBe('replacement\n');
    expect(await readFile(preservedOriginal, 'utf-8')).toBe('original\n');
  });

  it('rejects an atomic write bound to a replaced file identity and preserves both files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'target.json');
    const preservedOriginal = join(root, 'target.original.json');
    await writeFile(destination, 'original\n');
    const expectedIdentity = await captureContainedPathIdentity(
      root,
      'target.json',
    );
    await rename(destination, preservedOriginal);
    await writeFile(destination, 'replacement\n');

    const error = await rejectedReason(
      writeFileAtomicContained(root, 'target.json', 'new bytes\n', {
        replace: true,
        expectedIdentity,
      }),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      retryable: true,
    });
    expect(await readFile(destination, 'utf-8')).toBe('replacement\n');
    expect(await readFile(preservedOriginal, 'utf-8')).toBe('original\n');
  });

  it('rejects an unlink bound to a replaced file identity and preserves both files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'target.json');
    const preservedOriginal = join(root, 'target.original.json');
    await writeFile(destination, 'original\n');
    const expectedIdentity = await captureContainedPathIdentity(
      root,
      'target.json',
    );
    await rename(destination, preservedOriginal);
    await writeFile(destination, 'replacement\n');

    const error = await rejectedReason(
      unlinkContained(root, 'target.json', { expectedIdentity }),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      retryable: true,
    });
    expect(await readFile(destination, 'utf-8')).toBe('replacement\n');
    expect(await readFile(preservedOriginal, 'utf-8')).toBe('original\n');
  });

  it('rejects a remove bound to a replaced file identity and preserves both files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'target.json');
    const preservedOriginal = join(root, 'target.original.json');
    await writeFile(destination, 'original\n');
    const expectedIdentity = await captureContainedPathIdentity(
      root,
      'target.json',
    );
    await rename(destination, preservedOriginal);
    await writeFile(destination, 'replacement\n');

    const error = await rejectedReason(
      removeContained(root, 'target.json', { expectedIdentity }),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      retryable: true,
    });
    expect(await readFile(destination, 'utf-8')).toBe('replacement\n');
    expect(await readFile(preservedOriginal, 'utf-8')).toBe('original\n');
  });

  it('rejects publication bound to a replaced staged directory and preserves every tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const staged = join(root, '.stage');
    const preservedStaged = join(root, '.stage.original');
    const published = join(root, 'published');
    await mkdir(staged);
    await writeFile(join(staged, 'original.txt'), 'original stage\n');
    await mkdir(published);
    await writeFile(join(published, 'published.txt'), 'prior published\n');
    const expectedStagedIdentity = await captureContainedPathIdentity(
      root,
      '.stage',
    );
    await rename(staged, preservedStaged);
    await mkdir(staged);
    await writeFile(join(staged, 'replacement.txt'), 'replacement stage\n');

    const error = await rejectedReason(
      publishDirectoryContained(root, '.stage', 'published', {
        expectedStagedIdentity,
      }),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      retryable: true,
    });
    expect(await readFile(join(staged, 'replacement.txt'), 'utf-8')).toBe(
      'replacement stage\n',
    );
    expect(
      await readFile(join(preservedStaged, 'original.txt'), 'utf-8'),
    ).toBe('original stage\n');
    expect(await readFile(join(published, 'published.txt'), 'utf-8')).toBe(
      'prior published\n',
    );
  });

  it('atomically replaces a contained file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    await mkdir(join(root, '.doklo', 'hub'), { recursive: true });
    await writeFile(join(root, '.doklo', 'hub', 'roles.json'), '{"version":1}\n');

    const destination = join(root, '.doklo', 'hub', 'roles.json');
    await writeFileAtomicContained(
      root,
      '.doklo/hub/roles.json',
      '{"version":2}\n',
    );

    expect(await readFile(destination, 'utf-8')).toBe('{"version":2}\n');
  });

  it('atomically refuses to clobber and preserves old bytes when publish fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'roles.json');
    await writeFile(destination, 'preserve\n');

    await expect(
      writeFileAtomic(destination, 'replacement\n', { replace: false }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf-8')).toBe('preserve\n');
  });

  it('publishes a missing contained file without clobbering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));

    await writeFileAtomicContained(root, 'roles.json', 'created\n', {
      replace: false,
    });

    expect(await readFile(join(root, 'roles.json'), 'utf-8')).toBe('created\n');
  });

  it('rejects a parent-directory escape', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const root = join(parent, 'root');
    await mkdir(root);
    await writeFile(join(parent, 'outside.json'), 'preserve\n');

    await expect(
      resolveContainedPath(root, '../outside.json'),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('rejects an absolute path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const outside = join(
      await mkdtemp(join(tmpdir(), 'doklo-core-fs-outside-')),
      'roles.json',
    );
    await writeFile(outside, 'preserve\n');

    await expect(
      resolveContainedPath(root, outside),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('rejects a parent symlink that escapes the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-core-fs-outside-'));
    const outsideFile = join(outside, 'roles.json');
    await mkdir(join(root, '.doklo'));
    await writeFile(outsideFile, 'preserve\n');
    await symlink(outside, join(root, '.doklo', 'hub'));

    await expect(
      resolveContainedPath(root, '.doklo/hub/roles.json', {
        allowMissingLeaf: true,
        rejectSymlinkLeaf: true,
      }),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
    expect(await readFile(outsideFile, 'utf-8')).toBe('preserve\n');
  });

  it('rejects an in-root symlinked parent segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    await mkdir(join(root, '.doklo', 'other'), { recursive: true });
    await writeFile(join(root, '.doklo', 'other', 'roles.json'), 'preserve\n');
    await symlink('other', join(root, '.doklo', 'hub'));

    await expect(
      resolveContainedPath(root, '.doklo/hub/roles.json', {
        rejectSymlinkLeaf: true,
      }),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('resolves dot to the physical root without hanging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const moduleUrl = new URL('../../src/index.ts', import.meta.url).href;
    const script = `
      const { resolveContainedPath } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(await resolveContainedPath(${JSON.stringify(root)}, '.'));
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        killSignal: 'SIGKILL',
        timeout: 2_000,
      },
    );

    expect(stdout).toBe(await realpath(root));
  });

  it('rejects a symlink leaf when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    await mkdir(join(root, '.doklo', 'hub'), { recursive: true });
    await writeFile(join(root, 'actual.json'), 'preserve\n');
    await symlink(
      join(root, 'actual.json'),
      join(root, '.doklo', 'hub', 'roles.json'),
    );

    await expect(
      resolveContainedPath(root, '.doklo/hub/roles.json', {
        rejectSymlinkLeaf: true,
      }),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('allows a missing leaf only when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    await mkdir(join(root, '.doklo', 'hub'), { recursive: true });
    const relativePath = '.doklo/hub/roles.json';
    const realRoot = await realpath(root);

    await expect(
      resolveContainedPath(root, relativePath),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      resolveContainedPath(root, relativePath, { allowMissingLeaf: true }),
    ).resolves.toBe(join(realRoot, relativePath));
  });

  it('applies the requested file mode to the published file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'roles.json');

    await writeFileAtomicContained(root, 'roles.json', 'private\n', {
      mode: 0o600,
    });

    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  it('publishes binary bytes without text coercion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'roles.bin');
    const bytes = new Uint8Array([0x00, 0xff, 0x0a, 0x80]);

    await writeFileAtomicContained(root, 'roles.bin', bytes);

    expect([...await readFile(destination)]).toEqual([...bytes]);
  });

  it('removes the temporary file when no-clobber publish fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'roles.json');
    await writeFile(destination, 'preserve\n');

    await expect(
      writeFileAtomicContained(root, 'roles.json', 'replacement\n', {
        replace: false,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readdir(root)).toEqual(['roles.json']);
  });

  it('unlinks and recursively removes only root-relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    await mkdir(join(root, 'tree', 'nested'), { recursive: true });
    await writeFile(join(root, 'single.json'), 'remove\n');
    await writeFile(join(root, 'tree', 'nested', 'leaf.json'), 'remove\n');

    await unlinkContained(root, 'single.json');
    await removeContained(root, 'tree', { recursive: true });

    await expect(stat(join(root, 'single.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      removeContained(root, '../outside', { recursive: true }),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('publishes a staged sibling directory over a nonempty destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(join(destination, 'stale.txt'), 'stale\n');

    await publicDirectoryPublisher()(
      root,
      'bundle/.public.stage',
      'bundle/public',
    );

    expect(await readFile(join(destination, 'current.txt'), 'utf-8')).toBe(
      'current\n',
    );
    await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(parent)).toEqual(['public']);
  });

  it('rejects a planned-path directory present when the publish barrier checks an absent expectation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(
      join(destination, 'ADMIN-BANN.md'),
      'concurrent user-owned content\n',
    );

    const error = await rejectedReason(
      publicDirectoryPublisher()(
        root,
        'bundle/.public.stage',
        'bundle/public',
        { expectedDestination: { exists: false } },
      ),
    );

    expect({
      error,
      destinationBytes: await readUtf8IfExists(
        join(destination, 'ADMIN-BANN.md'),
      ),
      stagedBytes: await readUtf8IfExists(join(staged, 'current.txt')),
    }).toMatchObject({
      error: {
        code: 'PATH_IDENTITY_CHANGED',
        operation: 'publish-directory',
        path: 'bundle/public',
        retryable: true,
      },
      destinationBytes: 'concurrent user-owned content\n',
      stagedBytes: 'current\n',
    });
  });

  it('rejects an empty directory present when the publish barrier checks an absent expectation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');

    const error = await rejectedReason(
      publicDirectoryPublisher()(
        root,
        'bundle/.public.stage',
        'bundle/public',
        { expectedDestination: { exists: false } },
      ),
    );

    expect({
      error,
      destinationEntries: await readdir(destination),
      stagedBytes: await readUtf8IfExists(join(staged, 'current.txt')),
    }).toMatchObject({
      error: {
        code: 'PATH_IDENTITY_CHANGED',
        operation: 'publish-directory',
        path: 'bundle/public',
        retryable: true,
      },
      destinationEntries: [],
      stagedBytes: 'current\n',
    });
  });

  it('does not replace a destination that differs from the approved directory identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    const approvedDestination = join(parent, 'public-approved');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(join(destination, 'approved.txt'), 'approved\n');
    const approvedStats = await nativeConfinedMutationFileSystem.lstat(
      destination,
    );
    const expectedDestination = {
      exists: true as const,
      realPath: await realpath(destination),
      device: String(approvedStats.dev),
      inode: String(approvedStats.ino),
    };
    await nativeConfinedMutationFileSystem.rename(
      destination,
      approvedDestination,
    );
    await mkdir(destination);
    await writeFile(join(destination, 'replacement.txt'), 'replacement\n');

    const error = await rejectedReason(
      publicDirectoryPublisher()(
        root,
        'bundle/.public.stage',
        'bundle/public',
        { expectedDestination },
      ),
    );

    expect({
      error,
      replacementBytes: await readUtf8IfExists(
        join(destination, 'replacement.txt'),
      ),
      approvedBytes: await readFile(
        join(approvedDestination, 'approved.txt'),
        'utf-8',
      ),
      stagedBytes: await readUtf8IfExists(join(staged, 'current.txt')),
    }).toMatchObject({
      error: {
        code: 'PATH_IDENTITY_CHANGED',
        operation: 'publish-directory',
        path: 'bundle/public',
        retryable: true,
      },
      replacementBytes: 'replacement\n',
      approvedBytes: 'approved\n',
      stagedBytes: 'current\n',
    });
  });

  it('rejects staged and destination directories with different parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    await mkdir(join(root, 'staging', 'public'), { recursive: true });
    await mkdir(join(root, 'bundle'), { recursive: true });

    await expect(
      publicDirectoryPublisher()(
        root,
        'staging/public',
        'bundle/public',
      ),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('rejects a same-type destination replacement before directory publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    const preservedDestination = join(parent, 'public-original');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(join(destination, 'stale.txt'), 'stale\n');
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async (context) => {
        const mutation = (context as { mutation?: string }).mutation;
        if (mutation !== 'move-destination-to-backup') return;
        await nativeConfinedMutationFileSystem.rename(
          destination,
          preservedDestination,
        );
        await mkdir(destination);
        await writeFile(join(destination, 'replacement.txt'), 'replacement\n');
      },
    });

    const error = await rejectedReason(
      privateDirectoryPublisher(confined)(
        root,
        'bundle/.public.stage',
        'bundle/public',
      ),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'publish-directory',
      path: 'bundle/public',
      retryable: true,
    });
    expect(
      await readFile(join(preservedDestination, 'stale.txt'), 'utf-8'),
    ).toBe('stale\n');
    expect(
      await readFile(join(destination, 'replacement.txt'), 'utf-8'),
    ).toBe('replacement\n');
    expect(await readFile(join(staged, 'current.txt'), 'utf-8')).toBe(
      'current\n',
    );
  });

  it('does not publish, roll back, or clean through a changed directory parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-core-fs-outside-'));
    const parent = join(root, 'bundle');
    const preservedParent = join(root, 'bundle-original');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    const externalSentinel = join(outside, 'sentinel.txt');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(join(destination, 'stale.txt'), 'stale\n');
    await mkdir(join(outside, '.public.stage'));
    await mkdir(join(outside, 'public'));
    await writeFile(join(outside, '.public.stage', 'external.txt'), 'stage-external\n');
    await writeFile(join(outside, 'public', 'external.txt'), 'destination-external\n');
    await writeFile(externalSentinel, 'sentinel\n');
    const sentinelHash = sha256(await readFile(externalSentinel));
    let externalBackup = '';
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async (context) => {
        const details = context as typeof context & {
          backup?: string;
          mutation?: string;
        };
        if (details.mutation !== 'move-stage-to-destination') return;
        await nativeConfinedMutationFileSystem.rename(parent, preservedParent);
        await symlink(outside, parent);
        externalBackup = join(outside, basename(details.backup!));
        await mkdir(externalBackup);
        await writeFile(join(externalBackup, 'external.txt'), 'backup-external\n');
      },
    });

    const error = await rejectedReason(
      privateDirectoryPublisher(confined)(
        root,
        'bundle/.public.stage',
        'bundle/public',
      ),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'publish-directory',
      path: 'bundle/public',
      retryable: true,
    });
    expect(sha256(await readFile(externalSentinel))).toBe(sentinelHash);
    expect(
      await readFile(join(outside, '.public.stage', 'external.txt'), 'utf-8'),
    ).toBe('stage-external\n');
    expect(
      await readFile(join(outside, 'public', 'external.txt'), 'utf-8'),
    ).toBe('destination-external\n');
    expect(await readFile(join(externalBackup, 'external.txt'), 'utf-8')).toBe(
      'backup-external\n',
    );
    expect(await readFile(join(preservedParent, '.public.stage', 'current.txt'), 'utf-8')).toBe(
      'current\n',
    );
    expect(
      (await readdir(preservedParent)).some((entry) => entry.includes('.backup-')),
    ).toBe(true);
  });

  it('restores the prior directory when staged publication fails without an identity swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(join(destination, 'stale.txt'), 'stale\n');
    const physicalStaged = await realpath(staged);
    const physicalDestination = await realpath(destination);
    let rejectedPublish = false;
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      rename: async (oldPath, newPath) => {
        if (
          !rejectedPublish
          && oldPath === physicalStaged
          && newPath === physicalDestination
        ) {
          rejectedPublish = true;
          throw Object.assign(new Error('injected directory publish failure'), {
            code: 'EIO',
          });
        }
        await nativeConfinedMutationFileSystem.rename(oldPath, newPath);
      },
    });

    await expect(
      privateDirectoryPublisher(confined)(
        root,
        'bundle/.public.stage',
        'bundle/public',
      ),
    ).rejects.toMatchObject({ code: 'EIO' });

    expect(rejectedPublish).toBe(true);
    expect(await readFile(join(destination, 'stale.txt'), 'utf-8')).toBe(
      'stale\n',
    );
    expect(await readFile(join(staged, 'current.txt'), 'utf-8')).toBe(
      'current\n',
    );
    expect(
      (await readdir(parent)).filter((entry) => entry.includes('.backup-')),
    ).toEqual([]);
  });

  it('keeps the complete published directory when recursive backup cleanup partially fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current-a.txt'), 'current-a\n');
    await writeFile(join(staged, 'current-b.txt'), 'current-b\n');
    await writeFile(join(destination, 'stale-a.txt'), 'stale-a\n');
    await writeFile(join(destination, 'stale-b.txt'), 'stale-b\n');
    let backup = '';
    let cleanupCalls = 0;
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      rm: async (path, options) => {
        if (!basename(path).includes('.backup-')) {
          await nativeConfinedMutationFileSystem.rm(path, options);
          return;
        }
        cleanupCalls += 1;
        backup = path;
        await unlink(join(path, 'stale-a.txt'));
        throw Object.assign(new Error('injected partial backup cleanup'), {
          code: 'EIO',
        });
      },
    });

    await expect(
      privateDirectoryPublisher(confined)(
        root,
        'bundle/.public.stage',
        'bundle/public',
      ),
    ).rejects.toMatchObject({ code: 'EIO' });

    expect(cleanupCalls).toBe(1);
    expect(await readFile(join(destination, 'current-a.txt'), 'utf-8')).toBe(
      'current-a\n',
    );
    expect(await readFile(join(destination, 'current-b.txt'), 'utf-8')).toBe(
      'current-b\n',
    );
    await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(backup, 'stale-a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(backup, 'stale-b.txt'), 'utf-8')).toBe(
      'stale-b\n',
    );
  });

  it('publishes without directory fsync when the private platform capability disables it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(join(destination, 'stale.txt'), 'stale\n');
    const physicalParent = await realpath(parent);
    let directorySyncAttempts = 0;
    const fileSystem = {
      ...nativeConfinedMutationFileSystem,
      directorySync: 'unsupported' as const,
      open: async (path: string, flags: string | number, mode?: number) => {
        const handle = await nativeConfinedMutationFileSystem.open(
          path,
          flags,
          mode,
        );
        if (path !== physicalParent) return handle;
        return {
          stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
          sync: async () => {
            directorySyncAttempts += 1;
            throw Object.assign(new Error('directory sync unsupported'), {
              code: 'EINVAL',
            });
          },
          close: () => handle.close(),
        } as typeof handle;
      },
    };
    const confined = createConfinedMutationOperations(fileSystem);

    await privateDirectoryPublisher(confined)(
      root,
      'bundle/.public.stage',
      'bundle/public',
    );

    expect(directorySyncAttempts).toBe(0);
    expect(await readFile(join(destination, 'current.txt'), 'utf-8')).toBe(
      'current\n',
    );
    expect(await readdir(parent)).toEqual(['public']);
  });

  it('fails and rolls back on an unexpected supported-platform directory fsync error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const parent = join(root, 'bundle');
    const staged = join(parent, '.public.stage');
    const destination = join(parent, 'public');
    await mkdir(staged, { recursive: true });
    await mkdir(destination);
    await writeFile(join(staged, 'current.txt'), 'current\n');
    await writeFile(join(destination, 'stale.txt'), 'stale\n');
    const physicalParent = await realpath(parent);
    let injected = false;
    const fileSystem = {
      ...nativeConfinedMutationFileSystem,
      directorySync: 'supported' as const,
      open: async (path: string, flags: string | number, mode?: number) => {
        const handle = await nativeConfinedMutationFileSystem.open(
          path,
          flags,
          mode,
        );
        if (path !== physicalParent) return handle;
        return {
          stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
          sync: async () => {
            if (!injected) {
              injected = true;
              throw Object.assign(new Error('unexpected directory sync failure'), {
                code: 'EIO',
              });
            }
            await handle.sync();
          },
          close: () => handle.close(),
        } as typeof handle;
      },
    };
    const confined = createConfinedMutationOperations(fileSystem);

    await expect(
      privateDirectoryPublisher(confined)(
        root,
        'bundle/.public.stage',
        'bundle/public',
      ),
    ).rejects.toMatchObject({ code: 'EIO' });

    expect(injected).toBe(true);
    expect(await readFile(join(destination, 'stale.txt'), 'utf-8')).toBe(
      'stale\n',
    );
    expect(await readFile(join(staged, 'current.txt'), 'utf-8')).toBe(
      'current\n',
    );
    expect(
      (await readdir(parent)).filter((entry) => entry.includes('.backup-')),
    ).toEqual([]);
  });

  it('rejects a parent identity swap before no-clobber publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-core-fs-outside-'));
    const originalParent = join(root, '.doklo', 'hub-original');
    const parent = join(root, '.doklo', 'hub');
    const relativePath = '.doklo/hub/roles.json';
    const originalBytes = 'workspace-original\n';
    const externalSentinel = join(outside, 'sentinel.json');
    const externalBytes = 'external-preserve\n';
    let externalStaging = '';

    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, 'roles.json'), originalBytes);
    await writeFile(externalSentinel, externalBytes);
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async ({ temporary }) => {
        await nativeConfinedMutationFileSystem.rename(parent, originalParent);
        await symlink(outside, parent);
        externalStaging = join(outside, basename(temporary!));
        await writeFile(externalStaging, 'attacker-staging\n');
      },
    });

    const error = await confined.writeFileAtomicContained(
      root,
      relativePath,
      'replacement\n',
      {
        replace: false,
      },
    ).then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(PathIdentityChangedError);
    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'write',
      path: relativePath,
      retryable: true,
    });

    expect(sha256(await readFile(externalSentinel))).toBe(sha256(externalBytes));
    await expect(stat(join(outside, 'roles.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(originalParent, 'roles.json'), 'utf-8')).toBe(originalBytes);
    expect(await readFile(externalStaging, 'utf-8')).toBe('attacker-staging\n');
  });

  it('rejects a destination leaf identity swap before replacement publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-core-fs-outside-'));
    const relativePath = '.doklo/hub/roles.json';
    const destination = join(root, relativePath);
    const preservedOriginal = join(root, '.doklo', 'hub', 'roles.original.json');
    const externalSentinel = join(outside, 'sentinel.json');
    const originalBytes = 'workspace-original\n';
    const externalBytes = 'external-preserve\n';

    await mkdir(join(root, '.doklo', 'hub'), { recursive: true });
    await writeFile(destination, originalBytes);
    await writeFile(externalSentinel, externalBytes);
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async () => {
        await nativeConfinedMutationFileSystem.rename(destination, preservedOriginal);
        await symlink(externalSentinel, destination);
      },
    });

    const error = await confined.writeFileAtomicContained(
      root,
      relativePath,
      'replacement\n',
    ).then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(PathIdentityChangedError);
    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'write',
      path: relativePath,
      retryable: true,
    });

    expect(sha256(await readFile(externalSentinel))).toBe(sha256(externalBytes));
    await expect(stat(join(outside, 'roles.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(preservedOriginal, 'utf-8')).toBe(originalBytes);
  });

  it('fails closed on a same-type leaf replacement when stable identity is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const relativePath = 'roles.json';
    const destination = join(root, relativePath);
    const preservedOriginal = join(root, 'roles.original.json');
    await writeFile(destination, 'workspace-original\n');
    const physicalDestination = await realpath(destination);
    let barrierCalls = 0;

    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      lstat: async (path) => {
        const stats = await nativeConfinedMutationFileSystem.lstat(path);
        return path === physicalDestination ? withoutStableIdentity(stats) : stats;
      },
      beforeFinalMutation: async () => {
        barrierCalls += 1;
        await nativeConfinedMutationFileSystem.rename(
          destination,
          preservedOriginal,
        );
        await writeFile(destination, 'replacement-entry\n');
      },
    });

    const error = await rejectedReason(
      confined.writeFileAtomicContained(root, relativePath, 'new-bytes\n'),
    );

    expect(error).toBeInstanceOf(PathIdentityChangedError);
    expect(barrierCalls).toBe(0);
    expect(await readFile(destination, 'utf-8')).toBe('workspace-original\n');
    await expect(stat(preservedOriginal)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not publish no-clobber output when staging identity is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'roles.json');
    let linkCalls = 0;
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      lstat: async (path) => {
        const stats = await nativeConfinedMutationFileSystem.lstat(path);
        return basename(path).endsWith('.tmp')
          ? withoutStableIdentity(stats)
          : stats;
      },
      open: async (path, flags, mode) => {
        const handle = await nativeConfinedMutationFileSystem.open(
          path,
          flags,
          mode,
        );
        if (!basename(path).endsWith('.tmp')) return handle;
        return {
          stat: async () => withoutStableIdentity(
            await handle.stat({ bigint: true }),
          ),
          writeFile: (...args) => handle.writeFile(...args),
          sync: () => handle.sync(),
          close: () => handle.close(),
        } as typeof handle;
      },
      link: async (existingPath, newPath) => {
        linkCalls += 1;
        await nativeConfinedMutationFileSystem.link(existingPath, newPath);
      },
    });

    const error = await rejectedReason(
      confined.writeFileAtomicContained(root, 'roles.json', 'new-bytes\n', {
        replace: false,
      }),
    );

    expect(error).toBeInstanceOf(PathIdentityChangedError);
    expect(linkCalls).toBe(0);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unlink leaf replacement without deleting either regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const relativePath = 'roles.json';
    const destination = join(root, relativePath);
    const preservedOriginal = join(root, 'roles.original.json');
    await writeFile(destination, 'workspace-original\n');
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async () => {
        await nativeConfinedMutationFileSystem.rename(
          destination,
          preservedOriginal,
        );
        await writeFile(destination, 'replacement-entry\n');
      },
    });

    const error = await rejectedReason(
      confined.unlinkContained(root, relativePath),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'unlink',
    });
    expect(await readFile(destination, 'utf-8')).toBe('replacement-entry\n');
    expect(await readFile(preservedOriginal, 'utf-8')).toBe(
      'workspace-original\n',
    );
  });

  it('rejects an unlink parent replacement without deleting outside bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-core-fs-outside-'));
    const parent = join(root, 'hub');
    const preservedParent = join(root, 'hub-original');
    await mkdir(parent);
    await writeFile(join(parent, 'roles.json'), 'workspace-original\n');
    await writeFile(join(outside, 'roles.json'), 'outside-preserve\n');
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async () => {
        await nativeConfinedMutationFileSystem.rename(parent, preservedParent);
        await symlink(outside, parent);
      },
    });

    const error = await rejectedReason(
      confined.unlinkContained(root, 'hub/roles.json'),
    );

    expect(error).toMatchObject({ code: 'PATH_IDENTITY_CHANGED' });
    expect(await readFile(join(outside, 'roles.json'), 'utf-8')).toBe(
      'outside-preserve\n',
    );
    expect(await readFile(join(preservedParent, 'roles.json'), 'utf-8')).toBe(
      'workspace-original\n',
    );
  });

  it('rejects a recursive remove leaf replacement without deleting either tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const destination = join(root, 'standalone');
    const preservedOriginal = join(root, 'standalone-original');
    await mkdir(destination);
    await writeFile(join(destination, 'original.txt'), 'workspace-original\n');
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async () => {
        await nativeConfinedMutationFileSystem.rename(
          destination,
          preservedOriginal,
        );
        await mkdir(destination);
        await writeFile(
          join(destination, 'replacement.txt'),
          'replacement-entry\n',
        );
      },
    });

    const error = await rejectedReason(
      confined.removeContained(root, 'standalone', { recursive: true }),
    );

    expect(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'remove',
    });
    expect(
      await readFile(join(destination, 'replacement.txt'), 'utf-8'),
    ).toBe('replacement-entry\n');
    expect(
      await readFile(join(preservedOriginal, 'original.txt'), 'utf-8'),
    ).toBe('workspace-original\n');
  });

  it('rejects a recursive remove parent replacement without deleting outside tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-core-fs-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-core-fs-outside-'));
    const parent = join(root, 'bundle');
    const preservedParent = join(root, 'bundle-original');
    await mkdir(join(parent, 'standalone'), { recursive: true });
    await writeFile(
      join(parent, 'standalone', 'original.txt'),
      'workspace-original\n',
    );
    await mkdir(join(outside, 'standalone'));
    await writeFile(
      join(outside, 'standalone', 'outside.txt'),
      'outside-preserve\n',
    );
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async () => {
        await nativeConfinedMutationFileSystem.rename(parent, preservedParent);
        await symlink(outside, parent);
      },
    });

    const error = await rejectedReason(
      confined.removeContained(root, 'bundle/standalone', { recursive: true }),
    );

    expect(error).toMatchObject({ code: 'PATH_IDENTITY_CHANGED' });
    expect(
      await readFile(join(outside, 'standalone', 'outside.txt'), 'utf-8'),
    ).toBe('outside-preserve\n');
    expect(
      await readFile(
        join(preservedParent, 'standalone', 'original.txt'),
        'utf-8',
      ),
    ).toBe('workspace-original\n');
  });
});
