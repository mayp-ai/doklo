import { afterEach, describe, expect, it } from 'vitest';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAllIa,
  loadDoksState,
  loadIaFile,
  loadLexiconState,
  loadRolesState,
  loadWorkspaceState,
} from '../lib/data';
import { revisionOf } from '../lib/load-state';

const DEMO = fileURLToPath(new URL('../demo', import.meta.url));
const originalRoot = process.env.DOKLO_WORKSPACE_ROOT;
const scratchRoots: string[] = [];

async function scratchWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doklo-studio-load-state-'));
  scratchRoots.push(dir);
  await cp(DEMO, dir, { recursive: true });
  process.env.DOKLO_WORKSPACE_ROOT = dir;
  return dir;
}

/** A minimal, contract-valid v2 ia.json (auto route hierarchy + evidence). */
function v2IaFile(serviceId: string) {
  return {
    service_id: serviceId,
    version: 2,
    trees: [{
      tree_id: `${serviceId}-routes`,
      type: 'route_hierarchy',
      source: 'auto',
      producer: 'doklo-route-hierarchy@1',
      platform: 'all',
      nodes: [{
        path: '/auth/signin',
        kind: 'destination',
        label: 'Sign in',
        curated_fields: [],
        bindings: [{ dok_ref: 'AUTH-SIGNIN', source: 'auto' }],
        evidence: [{
          kind: 'route_source',
          file: 'app/auth/signin/page.tsx',
        }],
        tags: [],
        children: [],
      }],
    }],
  };
}

function readerThatFailsAt(target: string) {
  return {
    async readFile(path: string): Promise<string> {
      if (path === target) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
          code: 'EACCES',
        });
      }
      return readFile(path, 'utf-8');
    },
  };
}

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.DOKLO_WORKSPACE_ROOT;
  else process.env.DOKLO_WORKSPACE_ROOT = originalRoot;
  await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, {
    force: true,
    recursive: true,
  })));
});

describe('typed JSON load states', () => {
  it('returns missing with the exact Lexicon path when the file is absent', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    await unlink(path);

    expect(await loadLexiconState()).toEqual({ kind: 'missing', path });
  });

  it('returns empty data and a byte revision for a valid empty Lexicon', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    const contents = '{"terms":[],"version":1}\n';
    await writeFile(path, contents, 'utf-8');

    const state = await loadLexiconState();

    expect(state).toEqual({
      kind: 'empty',
      path,
      data: { terms: [], version: 1 },
      revision: revisionOf(contents),
    });
  });

  it('returns invalid for malformed Lexicon JSON', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    await writeFile(path, '{ invalid\n', 'utf-8');

    const state = await loadLexiconState();

    expect(state.kind).toBe('invalid');
    expect(state.path).toBe(path);
    if (state.kind === 'invalid') expect(state.message).not.toBe('');
  });

  it('returns invalid for schema-invalid Lexicon JSON', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    await writeFile(path, '{"terms":[{"bad":true}],"version":1}\n', 'utf-8');

    const state = await loadLexiconState();

    expect(state.kind).toBe('invalid');
    expect(state.path).toBe(path);
  });

  it('returns unreadable when the Lexicon path cannot be read as a file', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');

    const state = await loadLexiconState(readerThatFailsAt(path));

    expect(state.kind).toBe('unreadable');
    expect(state.path).toBe(path);
    if (state.kind === 'unreadable') expect(state.message).not.toBe('');
  });

  it('returns ready data and a byte revision for a non-empty Lexicon', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    const contents = await readFile(path, 'utf-8');

    const state = await loadLexiconState();

    expect(state.kind).toBe('ready');
    expect(state.path).toBe(path);
    if (state.kind === 'ready') {
      expect(state.data.terms.length).toBeGreaterThan(0);
      expect(state.revision).toBe(revisionOf(contents));
    }
  });

  it('classifies an empty Workspace by its zero services', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, 'workspace.json');
    const contents = '{"workspace_id":"empty","name":"Empty","services":[]}\n';
    await writeFile(path, contents, 'utf-8');

    const state = await loadWorkspaceState();

    expect(state.kind).toBe('empty');
    expect(state.path).toBe(path);
    if (state.kind === 'empty') {
      expect(state.data.services).toEqual([]);
      expect(state.revision).toBe(revisionOf(contents));
    }
  });

  it('loads a non-empty Roles file as ready', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'roles.json');

    const state = await loadRolesState();

    expect(state.kind).toBe('ready');
    expect(state.path).toBe(path);
    if (state.kind === 'ready') expect(state.data.roles.length).toBeGreaterThan(0);
  });
});

describe('Dok catalog load states', () => {
  it('returns missing when the Dok directory is absent', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks');
    await rm(path, { recursive: true });

    expect(await loadDoksState()).toEqual({ kind: 'missing', path });
  });

  it('returns ready Doks with exact paths and per-file revisions in filename order', async () => {
    const dir = await scratchWorkspace();
    const doksPath = join(dir, '.doklo', 'hub', 'doks');
    const jsonFiles = (await readdir(doksPath))
      .filter((entry) => entry.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));

    const state = await loadDoksState();

    expect(state.kind).toBe('ready');
    expect(state.path).toBe(doksPath);
    if (state.kind !== 'ready') return;
    expect(state.data.doks.map((dok) => `${dok.dok_id}.json`)).toEqual(jsonFiles);
    for (const dok of state.data.doks) {
      const expectedPath = join(doksPath, `${dok.dok_id}.json`);
      expect(state.data.paths[dok.dok_id]).toBe(expectedPath);
      const contents = await readFile(expectedPath, 'utf-8');
      expect(state.data.revisions[dok.dok_id]).toBe(revisionOf(contents));
    }
  });

  it('returns empty for an existing Dok directory with no JSON files', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks');
    for (const entry of await readdir(path)) await rm(join(path, entry), { recursive: true });

    const state = await loadDoksState();

    expect(state).toEqual({
      kind: 'empty',
      path,
      data: { doks: [], paths: {}, revisions: {} },
      revision: revisionOf(''),
    });
  });

  it('fails the whole catalog on one invalid Dok and reports its exact filename', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'BROKEN.json');
    await writeFile(path, '{"dok_id":"invalid"}\n', 'utf-8');

    const state = await loadDoksState();

    expect(state.kind).toBe('invalid');
    expect(state.path).toBe(path);
  });

  it('rejects a duplicate dok_id without overwriting its path or revision', async () => {
    const dir = await scratchWorkspace();
    const doksPath = join(dir, '.doklo', 'hub', 'doks');
    const originalPath = join(doksPath, 'AUTH-SOCIAL.json');
    const duplicatePath = join(doksPath, 'ZZZ-DUPLICATE.json');
    await writeFile(duplicatePath, await readFile(originalPath, 'utf-8'), 'utf-8');

    const state = await loadDoksState();

    expect(state).toEqual({
      kind: 'invalid',
      path: duplicatePath,
      message: `Duplicate dok_id AUTH-SOCIAL: ${duplicatePath} conflicts with ${originalPath}.`,
    });
  });

  it('fails the whole catalog on one unreadable Dok and reports its exact filename', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'BROKEN.json');
    await writeFile(path, '{}\n', 'utf-8');

    const state = await loadDoksState(readerThatFailsAt(path));

    expect(state.kind).toBe('unreadable');
    expect(state.path).toBe(path);
  });

  it('fails the catalog when an enumerated Dok disappears while it is read', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const reader = {
      async readFile(filePath: string): Promise<string> {
        if (filePath === path) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
            code: 'ENOENT',
          });
        }
        return readFile(filePath, 'utf-8');
      },
    };

    const state = await loadDoksState(reader);

    expect(state.kind).toBe('invalid');
    expect(state.path).toBe(path);
    if (state.kind === 'invalid') expect(state.message).toMatch(/disappeared/i);
  });
});

describe('per-service IA load states', () => {
  it('preserves missing IA as an allowed absence with its exact service path', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'services', 'api', 'ia.json');

    expect(await loadIaFile('api')).toEqual({ kind: 'missing', path });
  });

  it('reads a v1 file as a v1 document without migrating it', async () => {
    await scratchWorkspace();

    const state = await loadIaFile('web');

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.data.version).toBe(1);
    expect(state.data.file.service_id).toBe('web');
    expect(state.data.file.trees.length).toBeGreaterThan(0);
  });

  it('reads a v2 file as a v2 document with bindings and evidence intact', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'services', 'web', 'ia.json');
    await writeFile(path, `${JSON.stringify(v2IaFile('web'))}\n`, 'utf-8');

    const state = await loadIaFile('web');

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.data.version).toBe(2);
    if (state.data.version !== 2) return;
    const [tree] = state.data.file.trees;
    const destination = tree!.nodes[0]!;
    expect(tree).toMatchObject({ type: 'route_hierarchy', source: 'auto' });
    expect(destination).toMatchObject({
      kind: 'destination',
      bindings: [{ dok_ref: 'AUTH-SIGNIN', source: 'auto' }],
    });
  });

  it('returns empty for a v2 file with no trees', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'services', 'web', 'ia.json');
    await writeFile(
      path,
      '{"service_id":"web","version":2,"trees":[]}\n',
      'utf-8',
    );

    const state = await loadIaFile('web');

    expect(state.kind).toBe('empty');
  });

  it('rejects a v2 file owned by a different service', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'services', 'web', 'ia.json');
    await writeFile(path, `${JSON.stringify(v2IaFile('api'))}\n`, 'utf-8');

    const state = await loadIaFile('web');

    expect(state.kind).toBe('invalid');
    if (state.kind !== 'invalid') return;
    expect(state.message).toContain('web');
    expect(state.message).toContain('api');
  });

  it.each([
    {
      label: 'malformed JSON',
      contents: '{ invalid\n',
    },
    {
      label: 'schema-invalid JSON',
      contents: '{"service_id":"web","trees":"invalid","edges":[],"version":1}\n',
    },
    {
      label: 'v2-stamped JSON that no contract accepts',
      contents:
        '{"service_id":"web","version":2,"trees":[{"tree_id":"t",' +
        '"type":"route_hierarchy","source":"auto","nodes":[]}]}\n',
    },
  ])('returns invalid for $label instead of collapsing it to absence', async ({ contents }) => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'services', 'web', 'ia.json');
    await writeFile(path, contents, 'utf-8');

    const state = await loadIaFile('web');

    expect(state?.kind).toBe('invalid');
    expect(state?.path).toBe(path);
    if (state?.kind === 'invalid') expect(state.message).not.toBe('');
  });

  it('returns unreadable for an IA read failure and keeps the exact path', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'services', 'web', 'ia.json');

    const state = await loadIaFile('web', readerThatFailsAt(path));

    expect(state?.kind).toBe('unreadable');
    expect(state?.path).toBe(path);
    if (state?.kind === 'unreadable') {
      expect(state.message).toContain('permission denied');
    }
  });

  it('rejects a schema-valid IA file owned by a different service', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'services', 'web', 'ia.json');
    const contents = JSON.parse(await readFile(path, 'utf-8')) as {
      service_id: string;
    };
    contents.service_id = 'api';
    await writeFile(path, `${JSON.stringify(contents)}\n`, 'utf-8');

    const state = await loadIaFile('web');

    expect(state.kind).toBe('invalid');
    expect(state.path).toBe(path);
    if (state.kind === 'invalid') {
      expect(state.message).toContain('web');
      expect(state.message).toContain('api');
    }
  });

  it('keeps each service state distinct when loading the IA catalog', async () => {
    const dir = await scratchWorkspace();
    const webPath = join(dir, '.doklo', 'hub', 'services', 'web', 'ia.json');
    const apiPath = join(dir, '.doklo', 'hub', 'services', 'api', 'ia.json');
    await writeFile(webPath, '{ invalid\n', 'utf-8');

    const states = await loadAllIa(['web', 'api']);

    expect(states.web?.kind).toBe('invalid');
    expect(states.web?.path).toBe(webPath);
    expect(states.api).toEqual({ kind: 'missing', path: apiPath });
  });
});
