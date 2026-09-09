import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConfinedMutationOperations,
  nativeConfinedMutationFileSystem,
} from '../../core/src/fs/confined-mutation-internal.js';

type WriteFileAtomicContained = (
  root: string,
  relativePath: string,
  bytes: string | Uint8Array,
  options?: { mode?: number; replace?: boolean },
) => Promise<void>;

const mutationHarness = vi.hoisted(() => ({
  writeFileAtomicContained: undefined as WriteFileAtomicContained | undefined,
}));

vi.mock('@doklo-beta/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@doklo-beta/core')>();
  return {
    ...original,
    writeFileAtomicContained(...args: Parameters<WriteFileAtomicContained>) {
      return mutationHarness.writeFileAtomicContained
        ? mutationHarness.writeFileAtomicContained(...args)
        : original.writeFileAtomicContained(...args);
    },
  };
});

import {
  writeArtifactAtomic,
  writePlannedArtifact,
} from '../src/atomic-output.js';
import { planRenderOutputs } from '../src/output-plan.js';

afterEach(() => {
  mutationHarness.writeFileAtomicContained = undefined;
});

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function withTmp<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'livedoc-atomic-output-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('writeArtifactAtomic', () => {
  it('does not change an existing artifact without overwrite', async () => {
    await withTmp(async (root) => {
      await writeFile(join(root, 'help.html'), 'original');

      await expect(writeArtifactAtomic(root, 'help.html', 'new')).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });

      expect(await readFile(join(root, 'help.html'), 'utf8')).toBe('original');
      expect(await readdir(root)).toEqual(['help.html']);
    });
  });

  it('replaces an existing artifact only when overwrite is true', async () => {
    await withTmp(async (root) => {
      await writeFile(join(root, 'help.html'), 'original');

      await writeArtifactAtomic(root, 'help.html', 'new', { overwrite: true });

      expect(await readFile(join(root, 'help.html'), 'utf8')).toBe('new');
    });
  });

  it('creates contained parent directories and leaves no temporary file', async () => {
    await withTmp(async (root) => {
      const destination = await writeArtifactAtomic(root, 'nested/help.html', 'new');

      expect(destination).toBe(join(await realpath(root), 'nested', 'help.html'));
      expect(await readFile(destination, 'utf8')).toBe('new');
      expect(await readdir(join(root, 'nested'))).toEqual(['help.html']);
    });
  });

  it('rejects traversal without changing a file outside the output root', async () => {
    await withTmp(async (parent) => {
      const root = join(parent, 'output');
      const sentinel = join(parent, 'sentinel.txt');
      await mkdir(root);
      await writeFile(sentinel, 'original');

      await expect(writeArtifactAtomic(root, '../sentinel.txt', 'new')).rejects.toThrow();

      expect(await readFile(sentinel, 'utf8')).toBe('original');
    });
  });

  it('rejects a symlinked parent without changing its external target', async () => {
    await withTmp(async (parent) => {
      const root = join(parent, 'output');
      const external = join(parent, 'external');
      await mkdir(root);
      await mkdir(external);
      await writeFile(join(external, 'help.html'), 'original');
      await symlink(external, join(root, 'linked'));

      await expect(writeArtifactAtomic(root, 'linked/help.html', 'new', {
        overwrite: true,
      })).rejects.toThrow();

      expect(await readFile(join(external, 'help.html'), 'utf8')).toBe('original');
    });
  });

  it('rejects a symlinked leaf without replacing its external target', async () => {
    await withTmp(async (parent) => {
      const root = join(parent, 'output');
      const external = join(parent, 'external.txt');
      await mkdir(root);
      await writeFile(external, 'original');
      await symlink(external, join(root, 'help.html'));

      await expect(writeArtifactAtomic(root, 'help.html', 'new', {
        overwrite: true,
      })).rejects.toThrow();

      expect(await readFile(external, 'utf8')).toBe('original');
      expect((await lstat(join(root, 'help.html'))).isSymbolicLink()).toBe(true);
    });
  });

  it('rejects an output parent swap immediately before publish without writing externally', async () => {
    await withTmp(async (container) => {
      const root = join(container, 'output');
      const parent = join(root, 'nested');
      const preservedParent = join(root, 'nested-original');
      const outside = join(container, 'outside');
      const originalBytes = 'workspace-original';
      const sentinelBytes = 'external-preserve';
      await mkdir(parent, { recursive: true });
      await mkdir(outside);
      await writeFile(join(parent, 'help.html'), originalBytes);
      await writeFile(join(outside, 'sentinel.txt'), sentinelBytes);
      const plan = await planRenderOutputs({
        outputRoot: root,
        outputDir: '',
        overwrite: true,
        targets: [{ relativePath: 'nested/help.html', format: 'html' }],
        screenshots: [],
      });
      const planned = plan.outputs.find((output) => output.format === 'html');
      expect(planned).toMatchObject({
        relative_path: 'nested/help.html',
        action: 'overwrite',
      });
      if (!planned) throw new Error('planned output is missing');

      const confined = createConfinedMutationOperations({
        ...nativeConfinedMutationFileSystem,
        beforeFinalMutation: async () => {
          await rename(parent, preservedParent);
          await symlink(outside, parent);
        },
      });
      mutationHarness.writeFileAtomicContained = confined.writeFileAtomicContained;

      await expect(writePlannedArtifact(root, planned, 'replacement')).rejects.toMatchObject({
        code: 'PATH_IDENTITY_CHANGED',
        operation: 'write',
        path: 'nested/help.html',
        retryable: true,
      });

      expect(sha256(await readFile(join(outside, 'sentinel.txt')))).toBe(sha256(sentinelBytes));
      expect(await readdir(outside)).toEqual(['sentinel.txt']);
      expect(sha256(await readFile(join(preservedParent, 'help.html')))).toBe(
        sha256(originalBytes),
      );
    });
  });

  it('rejects a same-type output leaf swap immediately before overwrite publish', async () => {
    await withTmp(async (container) => {
      const root = join(container, 'output');
      const outside = join(container, 'outside');
      const destination = join(root, 'help.html');
      const preservedOriginal = join(root, 'help.original.html');
      const originalBytes = 'workspace-original';
      const replacementBytes = 'replacement-entry';
      const sentinelBytes = 'external-preserve';
      await mkdir(root);
      await mkdir(outside);
      await writeFile(destination, originalBytes);
      await writeFile(join(outside, 'sentinel.txt'), sentinelBytes);

      const confined = createConfinedMutationOperations({
        ...nativeConfinedMutationFileSystem,
        beforeFinalMutation: async () => {
          await rename(destination, preservedOriginal);
          await writeFile(destination, replacementBytes);
        },
      });
      mutationHarness.writeFileAtomicContained = confined.writeFileAtomicContained;

      await expect(writeArtifactAtomic(root, 'help.html', 'new-bytes', {
        overwrite: true,
      })).rejects.toMatchObject({
        code: 'PATH_IDENTITY_CHANGED',
        operation: 'write',
        path: 'help.html',
        retryable: true,
      });

      expect(sha256(await readFile(preservedOriginal))).toBe(sha256(originalBytes));
      expect(sha256(await readFile(destination))).toBe(sha256(replacementBytes));
      expect(sha256(await readFile(join(outside, 'sentinel.txt')))).toBe(sha256(sentinelBytes));
      expect(await readdir(outside)).toEqual(['sentinel.txt']);
    });
  });
});
