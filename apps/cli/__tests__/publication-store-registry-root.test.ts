import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializePublication, type PublicationV1 } from '@doklo-beta/livedoc-engine';

const injected = vi.hoisted(() => ({ publicationFile: '' }));

vi.mock('../src/lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/paths.js')>();
  return {
    ...actual,
    workspacePaths(root: string) {
      const paths = actual.workspacePaths(root);
      return {
        ...paths,
        publicationFile: (name: string) => injected.publicationFile || paths.publicationFile(name),
      };
    },
  };
});

import {
  listPublications,
  loadPublication,
  PublicationNotFoundError,
  removePublication,
} from '../src/lib/publication-store.js';

const roots: string[] = [];

afterEach(async () => {
  injected.publicationFile = '';
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('publication registry root confinement', () => {
  it('does not load a definition redirected elsewhere inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-publication-registry-'));
    roots.push(root);
    const redirected = join(root, 'other-source', 'public-help.json');
    await mkdir(dirname(redirected), { recursive: true });
    await writeFile(redirected, serializePublication(publication()));
    injected.publicationFile = redirected;

    await expect(loadPublication(root, 'public-help')).rejects.toBeInstanceOf(
      PublicationNotFoundError,
    );
    await expect(removePublication(root, 'public-help')).rejects.toBeInstanceOf(
      PublicationNotFoundError,
    );
    expect(await listPublications(root)).toEqual([]);
    await expect(access(join(root, '.doklo/livedocs/publications'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

function publication(): PublicationV1 {
  return {
    schema_version: 1,
    name: 'public-help',
    display_name: 'Public Help',
    template: 'help-page',
    selection: { mode: 'all' },
    selected_dok_ids: ['AUTH'],
    format: 'html',
    locale: 'en',
    vars: { title: 'Help Center' },
    output_dir: 'help-page/public-help',
    created_at: '2026-07-17T03:04:05.678Z',
  };
}
