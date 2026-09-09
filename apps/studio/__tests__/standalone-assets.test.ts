import { execFile } from 'node:child_process';
import { renameSync, symlinkSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishDirectoryContainedOptions } from '@doklo-beta/core';
import {
  createConfinedMutationOperations,
  nativeConfinedMutationFileSystem,
  type PublishDirectoryContainedOptions as SourcePublishDirectoryContainedOptions,
} from '../../../packages/core/src/fs/confined-mutation-internal.js';

const mutationHarness = vi.hoisted(() => ({
  beforeCopySync: undefined as ((from: string, to: string) => void) | undefined,
  beforeRemoveSync: undefined as ((path: string) => void) | undefined,
  captureContainedPathIdentity: undefined as ((
    root: string,
    relativePath: string,
    options?: { allowMissingLeaf?: boolean },
  ) => Promise<unknown>) | undefined,
  publishDirectoryContained: undefined as ((
    root: string,
    stagedRelativePath: string,
    destinationRelativePath: string,
    options?: SourcePublishDirectoryContainedOptions,
  ) => Promise<void>) | undefined,
  removeContained: undefined as ((
    root: string,
    relativePath: string,
    options?: { force?: boolean; recursive?: boolean },
  ) => Promise<void>) | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    cpSync: (from: string, to: string, options?: object) => {
      mutationHarness.beforeCopySync?.(from, to);
      return actual.cpSync(from, to, options);
    },
    rmSync: (path: string, options?: object) => {
      mutationHarness.beforeRemoveSync?.(path);
      return actual.rmSync(path, options);
    },
  };
});

vi.mock('@doklo-beta/core', async () => {
  const actual = await vi.importActual<typeof import('@doklo-beta/core')>(
    '@doklo-beta/core',
  );
  return {
    ...actual,
    captureContainedPathIdentity: (
      root: string,
      relativePath: string,
      options?: { allowMissingLeaf?: boolean },
    ) => mutationHarness.captureContainedPathIdentity
      ? mutationHarness.captureContainedPathIdentity(root, relativePath, options)
      : actual.captureContainedPathIdentity(root, relativePath, options),
    publishDirectoryContained: (
      root: string,
      stagedRelativePath: string,
      destinationRelativePath: string,
      options?: PublishDirectoryContainedOptions,
    ) => mutationHarness.publishDirectoryContained
      ? mutationHarness.publishDirectoryContained(
        root,
        stagedRelativePath,
        destinationRelativePath,
        options as unknown as SourcePublishDirectoryContainedOptions,
      )
      : actual.publishDirectoryContained(
        root,
        stagedRelativePath,
        destinationRelativePath,
        options,
      ),
    removeContained: (
      root: string,
      relativePath: string,
      options?: { force?: boolean; recursive?: boolean },
    ) => mutationHarness.removeContained
      ? mutationHarness.removeContained(root, relativePath, options)
      : actual.removeContained(root, relativePath, options),
  };
});

import { copyStandaloneAssets } from '../scripts/standalone-assets.mjs';

const execFileAsync = promisify(execFile);

describe('copyStandaloneAssets', () => {
  const temporaryDirectories: string[] = [];

  async function makeStudioFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'doklo-standalone-assets-'));
    temporaryDirectories.push(root);

    const studioDir = join(root, 'apps', 'studio');
    const serverDir = join(studioDir, '.next', 'standalone', 'apps', 'studio');
    await mkdir(join(serverDir, '.next'), { recursive: true });
    await writeFile(join(serverDir, 'server.js'), '// fixture');
    return studioDir;
  }

  async function writeFixtureFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }

  async function snapshotDirectory(root: string, current = root): Promise<string[]> {
    const entries = await readdir(current);
    const snapshot: string[] = [];
    for (const entry of entries.sort()) {
      const path = join(current, entry);
      const relativePath = path.slice(root.length + 1);
      const metadata = await lstat(path);
      const mode = (metadata.mode & 0o777).toString(8);
      if (metadata.isDirectory()) {
        snapshot.push(`directory:${mode}:${relativePath}`);
        snapshot.push(...await snapshotDirectory(root, path));
      } else if (metadata.isSymbolicLink()) {
        snapshot.push(`symlink:${mode}:${relativePath}:${await readlink(path)}`);
      } else {
        snapshot.push(`file:${mode}:${relativePath}:${(await readFile(path)).toString('hex')}`);
      }
    }
    return snapshot;
  }

  async function prepareIsolatedReleaseFixture(root: string) {
    const cliDir = join(root, 'apps', 'cli');
    const releaseDir = join(cliDir, 'release');
    const releaseScript = join(cliDir, 'scripts', 'build-release.mjs');
    const sourceScript = fileURLToPath(
      new URL('../../cli/scripts/build-release.mjs', import.meta.url),
    );
    await writeFixtureFile(releaseScript, await readFile(sourceScript, 'utf-8'));
    // build-release.mjs imports three sibling modules by relative path: the
    // content guard, the release prerequisite contract, and the Node.js
    // support range.
    for (const sibling of [
      'release-content-guard.mjs',
      'release-node-support.mjs',
      'release-prerequisites.mjs',
    ]) {
      await writeFixtureFile(
        join(cliDir, 'scripts', sibling),
        await readFile(
          fileURLToPath(new URL(`../../cli/scripts/${sibling}`, import.meta.url)),
          'utf-8',
        ),
      );
    }
    // Satisfy the release prerequisites so ensureWorkspaceBuilt() does not shell
    // out to pnpm inside the fixture; these tests exercise containment, not the
    // build ordering (apps/cli/__tests__/release-prerequisites.test.ts does).
    await writeFixtureFile(join(cliDir, 'dist', 'api.js'), 'export {};\n');
    await writeFixtureFile(join(releaseDir, 'prior.txt'), 'prior-valid-release\n');
    await writeFixtureFile(
      join(releaseDir, 'nested', 'preserved.txt'),
      'nested-prior-release\n',
    );
    await writeFixtureFile(
      join(cliDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/cli',
        version: '1.0.0',
        description: 'fixture',
        keywords: [],
      }),
    );
    await writeFixtureFile(join(cliDir, 'src', 'i18n', 'en.json'), '{}\n');
    await writeFixtureFile(join(root, 'packages', 'fake', 'dist', 'index.js'), 'export {};\n');
    await writeFixtureFile(
      join(root, 'packages', 'fake', 'package.json'),
      '{"name":"@fixture/fake","version":"1.0.0"}\n',
    );
    await writeFixtureFile(
      join(root, 'packages', 'livedoc-engine', 'dist', 'index.js'),
      'export {};\n',
    );
    await writeFixtureFile(
      join(root, 'packages', 'livedoc-engine', 'package.json'),
      '{"name":"@fixture/livedoc-engine","version":"1.0.0"}\n',
    );
    await writeFixtureFile(
      join(root, 'packages', 'livedoc-engine', 'templates', 'template.txt'),
      'template\n',
    );
    await writeFixtureFile(
      join(root, 'packages', 'livedoc-engine', 'src', 'css', 'default.css'),
      'body {}\n',
    );
    await writeFixtureFile(
      join(root, 'apps', 'studio', '.next', 'standalone', 'apps', 'studio', 'server.js'),
      '// fixture\n',
    );
    await writeFixtureFile(
      join(
        root,
        'apps',
        'studio',
        '.next',
        'standalone',
        'apps',
        'studio',
        '.next',
        'static',
        'asset.txt',
      ),
      'static\n',
    );
    return { cliDir, releaseDir, releaseScript };
  }

  afterEach(async () => {
    mutationHarness.beforeCopySync = undefined;
    mutationHarness.beforeRemoveSync = undefined;
    mutationHarness.captureContainedPathIdentity = undefined;
    mutationHarness.publishDirectoryContained = undefined;
    mutationHarness.removeContained = undefined;
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it('awaits the standalone asset copy seam in deterministic order', async () => {
    const events: string[] = [];
    const { createStandaloneAssetFileSystem } = await import(
      '../scripts/standalone-assets-internal.mjs'
    );
    const fileSystem = createStandaloneAssetFileSystem({
      beforeCopy: async () => {
        events.push('before-copy:start');
        await Promise.resolve();
        events.push('before-copy:end');
      },
      copy: async () => {
        events.push('copy:start');
        await Promise.resolve();
        events.push('copy:end');
      },
    });

    await fileSystem.copyDirectory('/source', '/destination', {
      recursive: true,
    });

    expect(events).toEqual([
      'before-copy:start',
      'before-copy:end',
      'copy:start',
      'copy:end',
    ]);
  });

  it('copies the current Next static files beside a reused standalone server', async () => {
    const studioDir = await makeStudioFixture();
    const sourceAsset = join(studioDir, '.next', 'static', 'chunks', 'app.js');
    const destinationAsset = join(
      studioDir,
      '.next',
      'standalone',
      'apps',
      'studio',
      '.next',
      'static',
      'chunks',
      'app.js',
    );
    await writeFixtureFile(sourceAsset, 'current-build');
    await writeFixtureFile(destinationAsset, 'stale-build');

    await copyStandaloneAssets({ studioDir, log: () => undefined, warn: () => undefined });

    await expect(readFile(destinationAsset, 'utf8')).resolves.toBe('current-build');
  });

  it('rejects an empty Next static tree before release packaging', async () => {
    const studioDir = await makeStudioFixture();
    await mkdir(join(studioDir, '.next', 'static'), { recursive: true });

    await expect(
      Promise.resolve().then(() =>
        copyStandaloneAssets({ studioDir, log: () => undefined, warn: () => undefined }),
      ),
    ).rejects.toThrow(/required asset directory does not contain files/);
  });

  it('removes stale packaged public assets when the current build has no public source', async () => {
    const studioDir = await makeStudioFixture();
    const stalePublicAsset = join(
      studioDir,
      '.next',
      'standalone',
      'apps',
      'studio',
      'public',
      'removed.txt',
    );
    await writeFixtureFile(join(studioDir, '.next', 'static', 'chunks', 'app.js'), 'current-build');
    await writeFixtureFile(stalePublicAsset, 'stale-build');

    await copyStandaloneAssets({ studioDir, log: () => undefined, warn: () => undefined });

    await expect(lstat(stalePublicAsset)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked server directory without changing the external target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-standalone-assets-link-'));
    temporaryDirectories.push(root);
    const studioDir = join(root, 'apps', 'studio');
    const standaloneApps = join(studioDir, '.next', 'standalone', 'apps');
    const outside = join(root, 'outside');

    await writeFixtureFile(join(studioDir, '.next', 'static', 'chunks', 'app.js'), 'current-build');
    await writeFixtureFile(join(studioDir, 'public', 'brand.txt'), 'inside-public');
    await writeFixtureFile(join(outside, 'server.js'), '// external fixture');
    await writeFixtureFile(join(outside, 'public', 'sentinel.txt'), 'do-not-delete');
    await mkdir(standaloneApps, { recursive: true });
    await symlink(outside, join(standaloneApps, 'studio'), 'dir');
    const before = await snapshotDirectory(outside);

    let errorMessage: string | undefined;
    try {
      await copyStandaloneAssets({ studioDir, log: () => undefined, warn: () => undefined });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect.soft(errorMessage).toMatch(/symbolic link/);
    expect.soft(await snapshotDirectory(outside)).toEqual(before);
  });

  it('rejects a symlinked required static source without copying from outside the build', async () => {
    const studioDir = await makeStudioFixture();
    const root = dirname(dirname(studioDir));
    const outside = join(root, 'outside-static');
    const sourceStatic = join(studioDir, '.next', 'static');
    const destinationAsset = join(
      studioDir,
      '.next',
      'standalone',
      'apps',
      'studio',
      '.next',
      'static',
      'chunks',
      'app.js',
    );
    await writeFixtureFile(join(outside, 'chunks', 'app.js'), 'outside-build');
    await symlink(outside, sourceStatic, 'dir');
    const before = await snapshotDirectory(outside);

    await expect(
      Promise.resolve().then(() =>
        copyStandaloneAssets({ studioDir, log: () => undefined, warn: () => undefined }),
      ),
    ).rejects.toThrow(/symbolic link/);

    await expect(snapshotDirectory(outside)).resolves.toEqual(before);
    await expect(lstat(destinationAsset)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked .next parent without changing the external build tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-standalone-assets-next-link-'));
    temporaryDirectories.push(root);
    const studioDir = join(root, 'apps', 'studio');
    const outsideNext = join(root, 'outside-next');
    const externalServerDir = join(outsideNext, 'standalone', 'apps', 'studio');
    await writeFixtureFile(join(outsideNext, 'static', 'chunks', 'app.js'), 'outside-build');
    await writeFixtureFile(join(externalServerDir, 'server.js'), '// external fixture');
    await writeFixtureFile(join(externalServerDir, 'public', 'sentinel.txt'), 'do-not-delete');
    await writeFixtureFile(join(studioDir, 'public', 'brand.txt'), 'inside-public');
    await mkdir(studioDir, { recursive: true });
    await symlink(outsideNext, join(studioDir, '.next'), 'dir');
    const before = await snapshotDirectory(outsideNext);

    await expect(
      Promise.resolve().then(() =>
        copyStandaloneAssets({ studioDir, log: () => undefined, warn: () => undefined }),
      ),
    ).rejects.toThrow(/symbolic link/);

    await expect(snapshotDirectory(outsideNext)).resolves.toEqual(before);
  });

  const mutationCases = [
    {
      label: 'public',
      sourceRelative: 'public',
      destinationRelative: 'public',
      assetRelative: 'brand.txt',
    },
    {
      label: 'Next static',
      sourceRelative: join('.next', 'static'),
      destinationRelative: join('.next', 'static'),
      assetRelative: join('chunks', 'app.js'),
    },
  ] as const;

  it.each(mutationCases)(
    'rejects a $label destination-parent swap immediately before stale cleanup',
    async ({ sourceRelative, destinationRelative, assetRelative }) => {
      const fixture = await makeAssetMutationFixture({
        sourceRelative,
        destinationRelative,
        assetRelative,
      });
      let swapped = false;
      let expectedExternalSnapshot = fixture.externalSnapshot;
      const swapSync = () => {
        if (swapped) return;
        swapped = true;
        renameSync(fixture.parent, fixture.preservedParent);
        symlinkSync(fixture.outside, fixture.parent, 'dir');
      };
      mutationHarness.beforeRemoveSync = (path) => {
        if (path === fixture.destination) swapSync();
      };
      const confined = createConfinedMutationOperations({
        ...nativeConfinedMutationFileSystem,
        beforeFinalMutation: async (context) => {
          const details = context as typeof context & {
            backup?: string;
            mutation?: string;
          };
          if (
            swapped
            || details.operation !== 'publish-directory'
            || details.mutation !== 'move-destination-to-backup'
            || details.destination !== fixture.physicalDestination
          ) return;
          swapped = true;
          await nativeConfinedMutationFileSystem.rename(
            fixture.parent,
            fixture.preservedParent,
          );
          await symlink(fixture.outside, fixture.parent, 'dir');
          const externalBackup = join(
            fixture.outside,
            relative(fixture.physicalParent, details.backup!),
          );
          await writeFixtureFile(join(externalBackup, 'marker.txt'), 'do-not-clean\n');
          expectedExternalSnapshot = await snapshotDirectory(fixture.outside);
        },
      });
      mutationHarness.publishDirectoryContained = confined.publishDirectoryContained;
      mutationHarness.captureContainedPathIdentity = confined.captureContainedPathIdentity;
      mutationHarness.removeContained = confined.removeContained;

      const error = await Promise.resolve().then(() =>
        copyStandaloneAssets({
          studioDir: fixture.studioDir,
          log: () => undefined,
          warn: () => undefined,
        }),
      ).then(() => undefined, (reason: unknown) => reason);

      expect(swapped).toBe(true);
      expect.soft(error).toMatchObject({
        code: 'PATH_IDENTITY_CHANGED',
        operation: 'publish-directory',
        retryable: true,
      });
      expect.soft(await snapshotDirectory(fixture.outside)).toEqual(
        expectedExternalSnapshot,
      );
      await expect.soft(
        readFile(
          join(fixture.preservedParent, relative(fixture.parent, fixture.destination), assetRelative),
          'utf-8',
        ),
      ).resolves.toBe('stale-build');
    },
  );

  it('leaves a same-type replacement stage intact after publication identity changes', async () => {
    const fixture = await makeAssetMutationFixture({
      sourceRelative: 'public',
      destinationRelative: 'public',
      assetRelative: 'brand.txt',
    });
    let replacementStage: string | undefined;
    let preservedStage: string | undefined;
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async (context) => {
        if (
          replacementStage
          || context.operation !== 'publish-directory'
          || context.mutation !== 'move-destination-to-backup'
          || context.destination !== fixture.physicalDestination
          || !context.staged
        ) return;
        replacementStage = context.staged;
        preservedStage = `${context.staged}.original`;
        await nativeConfinedMutationFileSystem.rename(context.staged, preservedStage);
        await mkdir(context.staged, { recursive: true });
        await writeFile(join(context.staged, 'replacement.txt'), 'replacement-stage\n');
      },
    });
    mutationHarness.publishDirectoryContained = confined.publishDirectoryContained;
    mutationHarness.captureContainedPathIdentity = confined.captureContainedPathIdentity;
    mutationHarness.removeContained = confined.removeContained;

    const error = await Promise.resolve().then(() =>
      copyStandaloneAssets({
        studioDir: fixture.studioDir,
        log: () => undefined,
        warn: () => undefined,
      }),
    ).then(() => undefined, (reason: unknown) => reason);

    expect.soft(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'publish-directory',
      retryable: true,
    });
    expect(replacementStage).toBeDefined();
    expect(preservedStage).toBeDefined();
    await expect.soft(
      readFile(join(replacementStage!, 'replacement.txt'), 'utf-8'),
    ).resolves.toBe('replacement-stage\n');
    await expect.soft(
      readFile(join(preservedStage!, 'brand.txt'), 'utf-8'),
    ).resolves.toBe('current-public');
    await expect.soft(
      readFile(join(fixture.destination, 'brand.txt'), 'utf-8'),
    ).resolves.toBe('stale-build');
  });

  it('rejects a staged tree replacement after copy validation and before publication', async () => {
    const fixture = await makeAssetMutationFixture({
      sourceRelative: 'public',
      destinationRelative: 'public',
      assetRelative: 'brand.txt',
    });
    let replacementStage: string | undefined;
    let preservedStage: string | undefined;
    const confined = createConfinedMutationOperations(
      nativeConfinedMutationFileSystem,
    );
    mutationHarness.publishDirectoryContained = async (
      root,
      stagedRelativePath,
      destinationRelativePath,
      options,
    ) => {
      if (!replacementStage) {
        replacementStage = join(root, stagedRelativePath);
        preservedStage = `${replacementStage}.original`;
        await rename(replacementStage, preservedStage);
        await mkdir(replacementStage, { recursive: true });
        await writeFile(
          join(replacementStage, 'replacement.txt'),
          'replacement-stage\n',
        );
      }
      await confined.publishDirectoryContained(
        root,
        stagedRelativePath,
        destinationRelativePath,
        options,
      );
    };
    mutationHarness.captureContainedPathIdentity = confined.captureContainedPathIdentity;
    mutationHarness.removeContained = confined.removeContained;

    const error = await Promise.resolve().then(() =>
      copyStandaloneAssets({
        studioDir: fixture.studioDir,
        log: () => undefined,
        warn: () => undefined,
      }),
    ).then(() => undefined, (reason: unknown) => reason);

    expect.soft(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'publish-directory',
      retryable: true,
    });
    expect(replacementStage).toBeDefined();
    expect(preservedStage).toBeDefined();
    await expect.soft(
      readFile(join(replacementStage!, 'replacement.txt'), 'utf-8'),
    ).resolves.toBe('replacement-stage\n');
    await expect.soft(
      readFile(join(preservedStage!, 'brand.txt'), 'utf-8'),
    ).resolves.toBe('current-public');
    await expect.soft(
      readFile(join(fixture.destination, 'brand.txt'), 'utf-8'),
    ).resolves.toBe('stale-build');
  });

  it('leaves a same-type replacement parent stage intact after pre-copy identity changes', async () => {
    const fixture = await makeAssetMutationFixture({
      sourceRelative: 'public',
      destinationRelative: 'public',
      assetRelative: 'brand.txt',
    });
    let replacementStage: string | undefined;
    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async (context) => {
        if (
          replacementStage
          || context.operation !== 'remove'
          || dirname(context.destination) !== fixture.physicalParent
          || context.destination === fixture.physicalDestination
        ) return;
        await nativeConfinedMutationFileSystem.rename(
          fixture.parent,
          fixture.preservedParent,
        );
        await mkdir(fixture.parent, { recursive: true });
        replacementStage = join(
          fixture.parent,
          relative(fixture.physicalParent, context.destination),
        );
        await writeFixtureFile(
          join(replacementStage, 'replacement.txt'),
          'replacement-parent-stage\n',
        );
      },
    });
    mutationHarness.publishDirectoryContained = confined.publishDirectoryContained;
    mutationHarness.captureContainedPathIdentity = confined.captureContainedPathIdentity;
    mutationHarness.removeContained = confined.removeContained;

    const error = await Promise.resolve().then(() =>
      copyStandaloneAssets({
        studioDir: fixture.studioDir,
        log: () => undefined,
        warn: () => undefined,
      }),
    ).then(() => undefined, (reason: unknown) => reason);

    expect.soft(error).toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'remove',
      retryable: true,
    });
    expect(replacementStage).toBeDefined();
    await expect.soft(
      readFile(join(replacementStage!, 'replacement.txt'), 'utf-8'),
    ).resolves.toBe('replacement-parent-stage\n');
    await expect.soft(
      readFile(
        join(fixture.preservedParent, relative(fixture.parent, fixture.destination), 'brand.txt'),
        'utf-8',
      ),
    ).resolves.toBe('stale-build');
  });

  it('exits nonzero when the standalone copy script rejects an asset mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-standalone-script-failure-'));
    temporaryDirectories.push(root);
    const loader = await writeFailureLoader(root);
    const script = fileURLToPath(
      new URL('../scripts/copy-standalone-assets.mjs', import.meta.url),
    );

    const failure = await execFileAsync(
      process.execPath,
      ['--experimental-loader', loader, script],
      { cwd: root, encoding: 'utf-8' },
    ).then(() => undefined, (error: unknown) => error as {
      code?: number;
      stderr?: string;
    });

    expect(failure).toMatchObject({ code: 1 });
    expect(failure?.stderr).toContain('injected asset identity failure');
  });

  it('exits nonzero and preserves the prior release on asset mutation failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-release-asset-failure-'));
    temporaryDirectories.push(root);
    const cliDir = join(root, 'apps', 'cli');
    const releaseDir = join(cliDir, 'release');
    const releaseScript = join(cliDir, 'scripts', 'build-release.mjs');
    const sourceScript = fileURLToPath(
      new URL('../../cli/scripts/build-release.mjs', import.meta.url),
    );
    await writeFixtureFile(releaseScript, await readFile(sourceScript, 'utf-8'));
    // Every sibling module build-release.mjs imports, plus the apps/cli build
    // output its prerequisite check requires (see prepareIsolatedReleaseFixture).
    for (const sibling of [
      'release-content-guard.mjs',
      'release-node-support.mjs',
      'release-prerequisites.mjs',
    ]) {
      await writeFixtureFile(
        join(cliDir, 'scripts', sibling),
        await readFile(
          fileURLToPath(new URL(`../../cli/scripts/${sibling}`, import.meta.url)),
          'utf-8',
        ),
      );
    }
    await writeFixtureFile(join(cliDir, 'dist', 'api.js'), 'export {};\n');
    await writeFixtureFile(join(releaseDir, 'prior.txt'), 'prior-valid-release\n');
    await writeFixtureFile(join(root, 'packages', 'fake', 'dist', 'index.js'), 'export {};\n');
    await writeFixtureFile(
      join(root, 'packages', 'fake', 'package.json'),
      '{"name":"@fixture/fake","version":"1.0.0"}\n',
    );
    await writeFixtureFile(
      join(root, 'packages', 'livedoc-engine', 'templates', 'template.txt'),
      'template\n',
    );
    await writeFixtureFile(
      join(root, 'packages', 'livedoc-engine', 'dist', 'index.js'),
      'export {};\n',
    );
    await writeFixtureFile(
      join(root, 'packages', 'livedoc-engine', 'src', 'css', 'default.css'),
      'body {}\n',
    );
    await writeFixtureFile(join(cliDir, 'src', 'i18n', 'en.json'), '{}\n');
    await writeFixtureFile(
      join(root, 'apps', 'studio', '.next', 'standalone', 'server.js'),
      '// fixture\n',
    );
    const loader = await writeFailureLoader(root, { mockEsbuild: true });

    const failure = await execFileAsync(
      process.execPath,
      ['--experimental-loader', loader, releaseScript],
      { cwd: root, encoding: 'utf-8' },
    ).then(() => undefined, (error: unknown) => error as {
      code?: number;
      stderr?: string;
    });

    expect(failure).toMatchObject({ code: 1 });
    expect(failure?.stderr).toContain('injected asset identity failure');
    await expect(readFile(join(releaseDir, 'prior.txt'), 'utf-8')).resolves.toBe(
      'prior-valid-release\n',
    );
    const abandonedStages = (await readdir(cliDir)).filter(
      (entry) => entry.includes('.release.stage-'),
    );
    expect(abandonedStages).toHaveLength(1);
    await expect(
      readFile(join(cliDir, abandonedStages[0]!, 'dist', 'index.js'), 'utf-8'),
    ).resolves.toContain('#!/usr/bin/env node');
  });

  it('rejects a release stage replacement during a build phase that returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-release-stage-replacement-'));
    temporaryDirectories.push(root);
    const { cliDir, releaseDir, releaseScript } = await prepareIsolatedReleaseFixture(root);
    const expectedReleaseSnapshot = await snapshotDirectory(releaseDir);
    const loader = await writeFailureLoader(root, {
      mockEsbuild: true,
      failStandaloneAssets: false,
      replaceReleaseStageDuringBuild: true,
    });

    const failure = await execFileAsync(
      process.execPath,
      ['--experimental-loader', loader, releaseScript],
      { cwd: root, encoding: 'utf-8' },
    ).then(() => undefined, (error: unknown) => error as {
      code?: number;
      stderr?: string;
    });

    expect.soft(failure).toMatchObject({ code: 1 });
    expect.soft(failure?.stderr).toContain('PATH_IDENTITY_CHANGED');
    expect.soft(failure?.stderr).toContain('PathIdentityChangedError');
    expect.soft(await snapshotDirectory(releaseDir)).toEqual(
      expectedReleaseSnapshot,
    );
    const replacementStage = (await readdir(cliDir)).find(
      (entry) => entry.startsWith('.release.stage-') && !entry.endsWith('.original'),
    );
    expect(replacementStage).toBeDefined();
    await expect(
      readFile(join(cliDir, replacementStage!, 'replacement.txt'), 'utf-8'),
    ).resolves.toBe('replacement-release-stage\n');
    await expect(
      readFile(join(cliDir, `${replacementStage}.original`, 'dist', 'index.js'), 'utf-8'),
    ).resolves.toContain('#!/usr/bin/env node');
  });

  it('rejects a release stage replacement immediately before final publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-release-final-stage-replacement-'));
    temporaryDirectories.push(root);
    const { cliDir, releaseDir, releaseScript } = await prepareIsolatedReleaseFixture(root);
    const expectedReleaseSnapshot = await snapshotDirectory(releaseDir);
    const loader = await writeFailureLoader(root, {
      mockEsbuild: true,
      failStandaloneAssets: false,
      replaceReleaseStageBeforePublish: true,
    });

    const failure = await execFileAsync(
      process.execPath,
      ['--experimental-loader', loader, releaseScript],
      { cwd: root, encoding: 'utf-8' },
    ).then(() => undefined, (error: unknown) => error as {
      code?: number;
      stderr?: string;
    });

    expect.soft(failure).toMatchObject({ code: 1 });
    expect.soft(failure?.stderr).toContain('PATH_IDENTITY_CHANGED');
    expect.soft(failure?.stderr).toContain('PathIdentityChangedError');
    expect.soft(await snapshotDirectory(releaseDir)).toEqual(
      expectedReleaseSnapshot,
    );
    const replacementStage = (await readdir(cliDir)).find(
      (entry) => entry.startsWith('.release.stage-') && !entry.endsWith('.original'),
    );
    expect(replacementStage).toBeDefined();
    await expect(
      readFile(join(cliDir, replacementStage!, 'replacement.txt'), 'utf-8'),
    ).resolves.toBe('replacement-release-stage\n');
    await expect(
      readFile(join(cliDir, `${replacementStage}.original`, 'package.json'), 'utf-8'),
    ).resolves.toContain('"name": "@mayp/doklo"');
  });

  it.each(mutationCases)(
    'rejects a $label destination-parent swap immediately before staged copy',
    async ({ sourceRelative, destinationRelative, assetRelative }) => {
      const fixture = await makeAssetMutationFixture({
        sourceRelative,
        destinationRelative,
        assetRelative,
      });
      let swapped = false;
      let expectedExternalSnapshot = fixture.externalSnapshot;
      const swapSync = () => {
        if (swapped) return;
        swapped = true;
        renameSync(fixture.parent, fixture.preservedParent);
        symlinkSync(fixture.outside, fixture.parent, 'dir');
      };
      mutationHarness.beforeCopySync = (from, to) => {
        if (from === fixture.source && to === fixture.destination) swapSync();
      };
      const confined = createConfinedMutationOperations({
        ...nativeConfinedMutationFileSystem,
        beforeFinalMutation: async (context) => {
          if (
            swapped
            || context.operation !== 'remove'
            || dirname(context.destination) !== fixture.physicalParent
            || context.destination === fixture.physicalDestination
          ) return;
          swapped = true;
          await nativeConfinedMutationFileSystem.rename(
            fixture.parent,
            fixture.preservedParent,
          );
          await symlink(fixture.outside, fixture.parent, 'dir');
          const externalStage = join(
            fixture.outside,
            relative(fixture.physicalParent, context.destination),
          );
          await writeFixtureFile(join(externalStage, 'marker.txt'), 'do-not-clean\n');
          expectedExternalSnapshot = await snapshotDirectory(fixture.outside);
        },
      });
      mutationHarness.publishDirectoryContained = confined.publishDirectoryContained;
      mutationHarness.captureContainedPathIdentity = confined.captureContainedPathIdentity;
      mutationHarness.removeContained = confined.removeContained;

      const error = await Promise.resolve().then(() =>
        copyStandaloneAssets({
          studioDir: fixture.studioDir,
          log: () => undefined,
          warn: () => undefined,
        }),
      ).then(() => undefined, (reason: unknown) => reason);

      expect(swapped).toBe(true);
      expect.soft(error).toMatchObject({
        code: 'PATH_IDENTITY_CHANGED',
        operation: 'remove',
        retryable: true,
      });
      expect.soft(await snapshotDirectory(fixture.outside)).toEqual(
        expectedExternalSnapshot,
      );
      await expect.soft(
        readFile(
          join(fixture.preservedParent, relative(fixture.parent, fixture.destination), assetRelative),
          'utf-8',
        ),
      ).resolves.toBe('stale-build');
    },
  );

  async function makeAssetMutationFixture({
    sourceRelative,
    destinationRelative,
    assetRelative,
  }: {
    sourceRelative: string;
    destinationRelative: string;
    assetRelative: string;
  }) {
    const studioDir = await makeStudioFixture();
    const root = dirname(dirname(studioDir));
    const serverDir = join(studioDir, '.next', 'standalone', 'apps', 'studio');
    const source = join(studioDir, sourceRelative);
    const destination = join(serverDir, destinationRelative);
    const parent = dirname(destination);
    const preservedParent = `${parent}-original`;
    const outside = join(root, `outside-${destinationRelative.replaceAll('/', '-')}`);
    await writeFixtureFile(join(studioDir, '.next', 'static', 'chunks', 'app.js'), 'current-static');
    if (sourceRelative === 'public') {
      await writeFixtureFile(join(source, assetRelative), 'current-public');
    }
    await writeFixtureFile(join(destination, assetRelative), 'stale-build');
    await writeFixtureFile(join(outside, relative(parent, destination), 'protected.txt'), 'external\n');
    await writeFixtureFile(join(outside, 'sentinel.txt'), 'sentinel\n');
    const physicalParent = await import('node:fs/promises').then(({ realpath }) => realpath(parent));
    const physicalDestination = await import('node:fs/promises').then(({ realpath }) => realpath(destination));
    return {
      studioDir,
      source,
      destination,
      parent,
      preservedParent,
      outside,
      physicalParent,
      physicalDestination,
      externalSnapshot: await snapshotDirectory(outside),
    };
  }

  async function writeFailureLoader(
    root: string,
    options: {
      failStandaloneAssets?: boolean;
      mockEsbuild?: boolean;
      replaceReleaseStageBeforePublish?: boolean;
      replaceReleaseStageDuringBuild?: boolean;
    } = {},
  ): Promise<string> {
    const standaloneMock = join(root, 'standalone-assets-mock.mjs');
    const coreForwarder = join(root, 'core-forwarder.mjs');
    const esbuildMock = join(root, 'esbuild-mock.mjs');
    const loader = join(root, 'loader.mjs');
    const failStandaloneAssets = options.failStandaloneAssets ?? true;
    await writeFile(standaloneMock, `
      export function assertDirectoryContainsFiles() {}
      export async function copyStandaloneAssets() {
        ${failStandaloneAssets ? `
        const error = new Error('injected asset identity failure');
        error.code = 'PATH_IDENTITY_CHANGED';
        error.retryable = true;
        throw error;
        ` : ''}
      }
    `);
    const realCoreUrl = pathToFileURL(
      createRequire(import.meta.url).resolve('@doklo-beta/core'),
    ).href;
    await writeFile(coreForwarder, `
      import * as core from ${JSON.stringify(realCoreUrl)};
      import { mkdir, rename, writeFile } from 'node:fs/promises';
      import { resolve } from 'node:path';
      async function forward(operation) {
        try {
          return await operation();
        } catch (error) {
          process.stderr.write(\`[core-error-code] \${error?.code ?? 'UNKNOWN'}\\n\`);
          throw error;
        }
      }
      export function captureContainedPathIdentity(...args) {
        return core.captureContainedPathIdentity(...args);
      }
      export function assertContainedPathIdentity(...args) {
        return forward(() => core.assertContainedPathIdentity(...args));
      }
      export function removeContained(...args) {
        return core.removeContained(...args);
      }
      export async function publishDirectoryContained(root, staged, destination, options = {}) {
        const stagedPath = resolve(root, staged);
        ${options.replaceReleaseStageBeforePublish ? `
          await rename(stagedPath, \`\${stagedPath}.original\`);
          await mkdir(stagedPath, { recursive: true });
          await writeFile(resolve(stagedPath, 'replacement.txt'), 'replacement-release-stage\\n');
        ` : ''}
        return forward(() => core.publishDirectoryContained(
          root,
          staged,
          destination,
          options,
        ));
      }
    `);
    await writeFile(esbuildMock, `
      import { mkdir, rename, writeFile } from 'node:fs/promises';
      import { dirname, join } from 'node:path';
      export async function build(options) {
        await mkdir(options.outdir, { recursive: true });
        await writeFile(join(options.outdir, 'index.js'), '#!/usr/bin/env node\\n');
        await writeFile(join(options.outdir, 'api.js'), 'export {};\\n');
        ${options.replaceReleaseStageDuringBuild ? `
          const releaseStage = dirname(options.outdir);
          await rename(releaseStage, \`\${releaseStage}.original\`);
          await mkdir(options.outdir, { recursive: true });
          await writeFile(join(options.outdir, 'index.js'), '#!/usr/bin/env node\\n');
          await writeFile(join(options.outdir, 'api.js'), 'export {};\\n');
          await writeFile(join(releaseStage, 'replacement.txt'), 'replacement-release-stage\\n');
        ` : ''}
      }
    `);
    const redirects = {
      './standalone-assets.mjs': pathToFileURL(standaloneMock).href,
      '../../studio/scripts/standalone-assets.mjs': pathToFileURL(standaloneMock).href,
      '@doklo-beta/core': pathToFileURL(coreForwarder).href,
      ...(options.mockEsbuild
        ? { esbuild: pathToFileURL(esbuildMock).href }
        : {}),
    };
    await writeFile(loader, `
      const redirects = new Map(Object.entries(${JSON.stringify(redirects)}));
      export async function resolve(specifier, context, nextResolve) {
        const redirected = redirects.get(specifier);
        if (redirected) return { url: redirected, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `);
    return loader;
  }
});
