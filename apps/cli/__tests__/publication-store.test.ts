import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConfinedMutationOperations,
  nativeConfinedMutationFileSystem,
} from '../../../packages/core/src/fs/confined-mutation-internal.js';
import {
  serializePublication,
  type PublicationV1,
} from '@doklo-beta/livedoc-engine';
import {
  createPublication,
  InvalidPublicationFileError,
  listPublications,
  loadPublication,
  PublicationNotFoundError,
  removePublication,
  UnreadablePublicationFileError,
} from '../src/lib/publication-store.js';
import { workspacePaths } from '../src/lib/paths.js';

type WriteFileAtomicContained = (
  root: string,
  relativePath: string,
  bytes: string | Uint8Array,
  options?: { mode?: number; replace?: boolean },
) => Promise<void>;

type UnlinkContained = (root: string, relativePath: string) => Promise<void>;

const mutationHarness = vi.hoisted(() => ({
  writeFileAtomicContained: undefined as WriteFileAtomicContained | undefined,
  unlinkContained: undefined as UnlinkContained | undefined,
  beforeWriteFileAtomicContained: undefined as (() => Promise<void>) | undefined,
  beforeUnlinkContained: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('@doklo-beta/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@doklo-beta/core')>();
  return {
    ...original,
    async writeFileAtomicContained(...args: Parameters<WriteFileAtomicContained>) {
      await mutationHarness.beforeWriteFileAtomicContained?.();
      return mutationHarness.writeFileAtomicContained
        ? mutationHarness.writeFileAtomicContained(...args)
        : original.writeFileAtomicContained(...args);
    },
    async unlinkContained(...args: Parameters<UnlinkContained>) {
      await mutationHarness.beforeUnlinkContained?.();
      return mutationHarness.unlinkContained
        ? mutationHarness.unlinkContained(...args)
        : original.unlinkContained(...args);
    },
  };
});

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-publication-store-'));
  roots.push(root);
  return root;
}

function publication(name = 'public-help', overrides: Partial<PublicationV1> = {}): PublicationV1 {
  return {
    schema_version: 1,
    name,
    display_name: name,
    template: 'help-page',
    selection: { mode: 'all' },
    selected_dok_ids: ['AUTH'],
    format: 'html',
    locale: 'en',
    vars: { title: 'Help Center' },
    output_dir: `help-page/${name}`,
    created_at: '2026-07-17T03:04:05.678Z',
    ...overrides,
  };
}

afterEach(async () => {
  mutationHarness.writeFileAtomicContained = undefined;
  mutationHarness.unlinkContained = undefined;
  mutationHarness.beforeWriteFileAtomicContained = undefined;
  mutationHarness.beforeUnlinkContained = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('publication store', () => {
  it('survives a fresh load byte-for-byte', async () => {
    const root = await workspace();
    const value = publication();

    const created = await createPublication(root, value);
    const loaded = await loadPublication(root, value.name);

    expect(loaded).toEqual(value);
    expect(created).toBe(join(
      await realpath(workspacePaths(root).publicationsDir),
      `${value.name}.json`,
    ));
    expect(await readFile(created, 'utf8')).toBe(serializePublication(value));
  });

  it('creates without clobbering and only overwrites an already-valid definition explicitly', async () => {
    const root = await workspace();
    const original = publication();
    await createPublication(root, original);

    await expect(createPublication(root, publication('public-help', {
      display_name: 'Changed',
    }))).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    expect(await loadPublication(root, 'public-help')).toEqual(original);

    const updated = publication('public-help', { display_name: 'Changed' });
    await createPublication(root, updated, { overwrite: true });
    expect(await loadPublication(root, 'public-help')).toEqual(updated);
  });

  it('keeps created_at immutable on explicit overwrite', async () => {
    const root = await workspace();
    const original = publication();
    await createPublication(root, original);

    await expect(createPublication(root, publication('public-help', {
      created_at: '2026-07-18T03:04:05.678Z',
    }), { overwrite: true })).rejects.toThrow(/created_at.*immutable/i);

    expect(await loadPublication(root, 'public-help')).toEqual(original);
  });

  it('lists valid regular JSON definitions by publication name', async () => {
    const root = await workspace();
    await createPublication(root, publication('zebra-help'));
    await createPublication(root, publication('alpha-help'));
    const paths = workspacePaths(root);
    await writeFile(join(paths.publicationsDir, 'notes.txt'), 'not a publication');
    await mkdir(join(paths.publicationsDir, 'directory.json'));
    await symlink(join(paths.publicationsDir, 'notes.txt'), join(paths.publicationsDir, 'linked.json'));

    expect((await listPublications(root)).map(({ name }) => name)).toEqual([
      'alpha-help',
      'zebra-help',
    ]);
  });

  it('reports missing definitions consistently for load and remove', async () => {
    const root = await workspace();

    await expect(loadPublication(root, 'missing')).rejects.toBeInstanceOf(PublicationNotFoundError);
    await expect(removePublication(root, 'missing')).rejects.toBeInstanceOf(PublicationNotFoundError);
    expect(await listPublications(root)).toEqual([]);
  });

  it('reports invalid JSON and never removes it', async () => {
    const root = await workspace();
    const paths = workspacePaths(root);
    await mkdir(paths.publicationsDir, { recursive: true });
    const path = paths.publicationFile('broken');
    await writeFile(path, '{broken\n');

    await expect(loadPublication(root, 'broken')).rejects.toBeInstanceOf(InvalidPublicationFileError);
    await expect(listPublications(root)).rejects.toBeInstanceOf(InvalidPublicationFileError);
    await expect(removePublication(root, 'broken')).rejects.toBeInstanceOf(InvalidPublicationFileError);
    expect((await lstat(path)).isFile()).toBe(true);
  });

  it('reports unreadable definitions and never removes them', async () => {
    const root = await workspace();
    const path = await createPublication(root, publication('private-help'));
    await chmod(path, 0o000);
    try {
      await expect(loadPublication(root, 'private-help')).rejects.toBeInstanceOf(UnreadablePublicationFileError);
      await expect(removePublication(root, 'private-help')).rejects.toBeInstanceOf(UnreadablePublicationFileError);
      expect((await lstat(path)).isFile()).toBe(true);
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('removes only a validated regular publication file', async () => {
    const root = await workspace();
    await createPublication(root, publication());

    await removePublication(root, 'public-help');

    await expect(loadPublication(root, 'public-help')).rejects.toBeInstanceOf(PublicationNotFoundError);
  });

  it('rejects a symlinked definitions parent without writing outside the workspace', async () => {
    const root = await workspace();
    const external = await workspace();
    const paths = workspacePaths(root);
    await mkdir(paths.livedocsDir, { recursive: true });
    await symlink(external, paths.publicationsDir);

    await expect(createPublication(root, publication())).rejects.toThrow(/outside|root/i);
    await expect(listPublications(root)).rejects.toThrow(/outside|root/i);
    expect(await readFileOrNull(join(external, 'public-help.json'))).toBeNull();
  });

  it('rejects symlinked leaves for load, overwrite, and remove', async () => {
    const root = await workspace();
    const external = join(await workspace(), 'external.json');
    const paths = workspacePaths(root);
    await mkdir(paths.publicationsDir, { recursive: true });
    await writeFile(external, serializePublication(publication()));
    await symlink(external, paths.publicationFile('public-help'));

    await expect(loadPublication(root, 'public-help')).rejects.toThrow(/outside|root/i);
    await expect(createPublication(root, publication(), { overwrite: true })).rejects.toThrow(/outside|root/i);
    await expect(removePublication(root, 'public-help')).rejects.toThrow(/outside|root/i);
    expect(await readFile(external, 'utf8')).toBe(serializePublication(publication()));
  });

  it('rejects names that could escape the definitions directory', async () => {
    const root = await workspace();

    await expect(loadPublication(root, '../outside')).rejects.toThrow();
    await expect(removePublication(root, '../outside')).rejects.toThrow();
  });

  it('rejects a Publication registry replacement immediately before definition save', async () => {
    const root = await workspace();
    const siblingFixture = await workspace();
    const paths = workspacePaths(root);
    const preservedRegistry = join(paths.livedocsDir, 'publications-original');
    const sentinelBytes = 'sibling-preserve';
    await mkdir(paths.publicationsDir, { recursive: true });
    await writeFile(join(siblingFixture, 'sentinel.txt'), sentinelBytes);

    const confined = createConfinedMutationOperations({
      ...nativeConfinedMutationFileSystem,
      beforeFinalMutation: async () => {
        await rename(paths.publicationsDir, preservedRegistry);
        await symlink(siblingFixture, paths.publicationsDir);
      },
    });
    mutationHarness.writeFileAtomicContained = confined.writeFileAtomicContained;

    await expect(createPublication(root, publication())).rejects.toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'write',
      retryable: true,
    });

    expect(sha256(await readFile(join(siblingFixture, 'sentinel.txt')))).toBe(
      sha256(sentinelBytes),
    );
    expect(await readdir(siblingFixture)).toEqual(['sentinel.txt']);
    const preservedEntries = await readdir(preservedRegistry);
    expect(preservedEntries).toHaveLength(1);
    expect(preservedEntries[0]).toMatch(/^\.public-help\.json\..+\.tmp$/);
    await expect(access(join(preservedRegistry, 'public-help.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(join(siblingFixture, 'public-help.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a same-type Publication definition replacement before overwrite save', async () => {
    const root = await workspace();
    const original = publication();
    const destination = await createPublication(root, original);
    const preservedOriginal = join(
      workspacePaths(root).publicationsDir,
      'public-help.original.json',
    );
    const originalBytes = serializePublication(original);
    const replacement = publication('public-help', { display_name: 'Concurrent value' });
    const replacementBytes = serializePublication(replacement);
    mutationHarness.beforeWriteFileAtomicContained = async () => {
      await rename(destination, preservedOriginal);
      await writeFile(destination, replacementBytes);
    };

    await expect(createPublication(root, publication('public-help', {
      display_name: 'Requested value',
    }), { overwrite: true })).rejects.toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'write',
      retryable: true,
    });

    expect(sha256(await readFile(preservedOriginal))).toBe(sha256(originalBytes));
    expect(sha256(await readFile(destination))).toBe(sha256(replacementBytes));
  });

  it('rejects a same-type Publication definition replacement before removal', async () => {
    const root = await workspace();
    const original = publication();
    const destination = await createPublication(root, original);
    const preservedOriginal = join(
      workspacePaths(root).publicationsDir,
      'public-help.original.json',
    );
    const originalBytes = serializePublication(original);
    const replacement = publication('public-help', { display_name: 'Concurrent value' });
    const replacementBytes = serializePublication(replacement);
    mutationHarness.beforeUnlinkContained = async () => {
      await rename(destination, preservedOriginal);
      await writeFile(destination, replacementBytes);
    };

    await expect(removePublication(root, 'public-help')).rejects.toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      operation: 'unlink',
      retryable: true,
    });

    expect(sha256(await readFile(preservedOriginal))).toBe(sha256(originalBytes));
    expect(sha256(await readFile(destination))).toBe(sha256(replacementBytes));
  });
});

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
