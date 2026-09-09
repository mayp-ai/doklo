import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IaFileV2Schema,
  ServiceCodeMappingFileSchema,
  type IaLabel,
  type IaNodeV2,
  type ProjectIR,
  type ServiceCodeMappingFile,
} from '@doklo-beta/core';
import {
  assignDokIds,
  deriveCodeMapping,
  deriveIA,
  mergeDerivedCodeMapping,
  mergeDerivedIA,
  ROUTE_HIERARCHY_PRODUCER,
  type DeriveServiceMetaContext,
} from '../src/derive-service-meta.js';
import type {
  ConsolidatedFeature,
  ConsolidatedFeatureConfig,
} from '../src/legacy-types.js';

const OLD_TIME = '2026-07-14T00:00:00.000Z';
const NOW = '2026-07-15T00:00:00.000Z';
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function feature(
  canonicalId: string,
  prefix: string | undefined,
  primaryRoute: string,
  overrides: Partial<ConsolidatedFeature> = {},
): ConsolidatedFeature {
  return {
    canonical_id: canonicalId,
    label: canonicalId,
    decision: 'keep',
    members: [canonicalId],
    primary_route: primaryRoute,
    reason: '',
    user_reviewed: false,
    ...(prefix === undefined ? {} : { dok_id_prefix: prefix }),
    ...overrides,
  };
}

function consolidated(
  groups: Array<{ id: string; features: ConsolidatedFeature[] }>,
): ConsolidatedFeatureConfig {
  return {
    projectName: 'demo',
    basedOnFeaturesAt: OLD_TIME,
    generatedAt: OLD_TIME,
    model: 'test',
    originalFeatureIds: groups.flatMap((group) => group.features.flatMap((feature) => feature.members)),
    groups: groups.map((group) => ({
      group_id: group.id,
      label: group.id,
      features: group.features,
      excluded: [],
    })),
    userReviewed: false,
    stats: {
      originalFeatures: groups.reduce((count, group) => count + group.features.length, 0),
      consolidatedFeatures: groups.reduce((count, group) => count + group.features.length, 0),
      merges: 0,
      excluded: 0,
    },
  };
}

function projectIR(routes: ProjectIR['routes']): ProjectIR {
  return {
    framework: 'nextjs',
    root: '/service',
    files: [...new Set(routes.map((route) => route.file))],
    routes,
    components: [],
    stores: [],
    role_signals: [],
  };
}

function page(path: string, file: string): ProjectIR['routes'][number] {
  return {
    path,
    kind: 'page',
    file,
    dynamic_params: [],
    layout_chain: [],
  };
}

function context(
  config: ConsolidatedFeatureConfig,
  ir: ProjectIR,
  availableDokIds: Iterable<string>,
  serviceRoot = '/service',
  dokNames?: ReadonlyMap<string, IaLabel>,
): DeriveServiceMetaContext {
  return {
    serviceId: 'web',
    serviceRoot,
    consolidated: config,
    ir,
    availableDokIds: new Set(availableDokIds),
    ...(dokNames === undefined ? {} : { dokNames }),
  };
}

function findNode(nodes: readonly IaNodeV2[], path: string): IaNodeV2 | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const nested = findNode(node.children, path);
    if (nested) return nested;
  }
  return undefined;
}

async function makeServiceRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-service-meta-'));
  tempRoots.push(root);

  await Promise.all(Object.entries(files).map(async ([filePath, contents]) => {
    const absolutePath = join(root, filePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }));

  return root;
}

function expectedHash(parts: Array<{ path: string; contents?: string }>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part.path);
    hash.update('\0');
    hash.update(part.contents ?? '<missing>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

describe('assignDokIds', () => {
  it('preserves stored order and skips excluded or prefixless features', () => {
    const config = consolidated([
      {
        id: 'first',
        features: [
          feature('a', 'AUTH', '/a'),
          // Shares the 'AUTH' prefix with `a`, but is excluded — exclusion is
          // checked before the collision check, so this must not throw.
          feature('ignored', 'AUTH', '/ignored', { decision: 'exclude' }),
          feature('no-prefix', undefined, '/no-prefix'),
          feature('b', 'PROF', '/b'),
        ],
      },
      { id: 'second', features: [feature('c', 'ADMIN', '/c')] },
    ]);

    expect([...assignDokIds(config).entries()]).toEqual([
      ['a', 'AUTH'],
      ['b', 'PROF'],
      ['c', 'ADMIN'],
    ]);
  });

  it('uses the prefix verbatim as the dok id (no serial)', () => {
    const config = consolidated([
      { id: 'auth', features: [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')] },
    ]);

    expect(assignDokIds(config).get('auth-signin')).toBe('AUTH-SIGNIN');
  });

  it('throws on duplicate prefixes instead of silently numbering', () => {
    const config = consolidated([
      {
        id: 'auth',
        features: [
          feature('a', 'AUTH', '/a'),
          feature('b', 'AUTH', '/b'),
        ],
      },
    ]);

    expect(() => assignDokIds(config)).toThrow(/AUTH/);
  });
});

describe('deriveIA', () => {
  it('builds a hierarchical sitemap, gates references on actual Doks, and uses feature labels', () => {
    const config = consolidated([
      {
        id: 'main',
        features: [
          feature('auth', 'AUTH', '/auth/signin', { label: 'Sign in' }),
          feature('missing', 'MISS', '/missing'),
        ],
      },
    ]);
    const ir = projectIR([
      page('/missing', 'app/missing/page.tsx'),
      page('/auth/signin', 'app/auth/signin/page.tsx'),
      page('/auth/signin', 'legacy/auth/signin/page.tsx'),
      {
        path: '/api/auth',
        kind: 'api',
        http_method: 'POST',
        file: 'app/api/auth/route.ts',
        dynamic_params: [],
        layout_chain: [],
      },
    ]);

    const ia = deriveIA(context(config, ir, ['AUTH']));
    const parsed = IaFileV2Schema.parse(ia);
    const tree = parsed.trees[0]!;
    const nodes = parsed.trees[0]!.nodes;

    expect(parsed.version).toBe(2);
    expect(parsed.trees).toHaveLength(1);
    expect(tree).toMatchObject({
      tree_id: 'web-routes',
      type: 'route_hierarchy',
      source: 'auto',
      producer: ROUTE_HIERARCHY_PRODUCER,
      platform: 'all',
    });
    expect(nodes.map((node) => node.path)).toEqual(['/auth', '/missing']);
    expect(findNode(nodes, '/auth')).toMatchObject({ label: 'Auth', kind: 'group' });
    expect(findNode(nodes, '/auth/signin')).toMatchObject({
      label: 'Sign in',
      kind: 'destination',
      bindings: [{ dok_ref: 'AUTH', source: 'auto' }],
      evidence: [{ kind: 'route_source', file: 'app/auth/signin/page.tsx' }],
    });
    // The Dok was never generated, so the surface exists with nothing bound.
    expect(findNode(nodes, '/missing')).toMatchObject({
      kind: 'destination',
      bindings: [],
    });
    expect(parsed).not.toHaveProperty('updated_at');
    expect(parsed).not.toHaveProperty('edges');
  });

  it('uses a validated Dok name when the consolidated feature label is blank', () => {
    const config = consolidated([{
      id: 'main',
      features: [feature('profile', 'PROF', '/profile', { label: '  ' })],
    }]);
    const ir = projectIR([page('/profile', 'app/profile/page.tsx')]);

    const ia = deriveIA(context(
      config,
      ir,
      ['PROF'],
      '/service',
      new Map([['PROF', { term_ref: 'TERM-PROFILE_NAME' }]]),
    ));

    expect(findNode(ia.trees[0]!.nodes, '/profile')?.label).toEqual({
      term_ref: 'TERM-PROFILE_NAME',
    });
  });
});

describe('mergeDerivedIA re-export', () => {
  it('merges deriveIA output and returns the original file on a semantic no-op', () => {
    const config = consolidated([
      {
        id: 'main',
        features: [feature('auth', 'AUTH', '/auth')],
      },
    ]);
    const derived = deriveIA(context(
      config,
      projectIR([page('/auth', 'app/auth/page.tsx')]),
      ['AUTH'],
    ));

    const first = mergeDerivedIA(null, derived, NOW);

    expect(first.changed).toBe(true);
    expect(IaFileV2Schema.parse(first.file)).toEqual(first.file);
    expect(first.file.updated_at).toBe(NOW);
    expect(first.file.trees[0]).toMatchObject({
      tree_id: 'web-routes',
      type: 'route_hierarchy',
      source: 'auto',
      producer: ROUTE_HIERARCHY_PRODUCER,
    });
    expect(findNode(first.file.trees[0]!.nodes, '/auth')).toMatchObject({
      kind: 'destination',
      bindings: [{ dok_ref: 'AUTH', source: 'auto' }],
    });

    const second = mergeDerivedIA(first.file, derived, '2026-07-16T00:00:00.000Z');
    expect(second).toEqual({ file: first.file, changed: false });
  });
});

describe('deriveCodeMapping', () => {
  it('prefers sorted deduped source_files, omits unavailable Doks, and has no timestamps', async () => {
    const root = await makeServiceRoot({
      'src/a.ts': 'alpha',
      'src/b.ts': 'beta',
    });
    const config = consolidated([
      {
        id: 'main',
        features: [
          feature('auth', 'AUTH', '/auth', {
            source_files: ['src/b.ts', 'src/a.ts', 'src/b.ts'],
          }),
          feature('hidden', 'HIDDEN', '/hidden', { source_files: ['src/a.ts'] }),
        ],
      },
    ]);
    const ir = projectIR([
      page('/auth', 'app/auth/page.tsx'),
      page('/hidden', 'app/hidden/page.tsx'),
    ]);

    const mapping = await deriveCodeMapping(context(config, ir, ['AUTH'], root));
    const parsed = ServiceCodeMappingFileSchema.parse(mapping);

    expect(parsed.entries.map((entry) => entry.dok_id)).toEqual(['AUTH']);
    expect(parsed.entries[0]!.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parsed.entries[0]!.content_hash).toBe(expectedHash([
      { path: 'src/a.ts', contents: 'alpha' },
      { path: 'src/b.ts', contents: 'beta' },
    ]));
    expect(parsed).not.toHaveProperty('updated_at');
    expect(parsed.entries[0]).not.toHaveProperty('last_synced_at');
  });

  it('changes the content hash with bytes and hashes missing listed paths with a stable marker', async () => {
    const root = await makeServiceRoot({ 'src/a.ts': 'before' });
    const config = consolidated([
      {
        id: 'main',
        features: [
          feature('present', 'PRES', '/present', { source_files: ['src/a.ts'] }),
          feature('missing', 'MISS', '/missing', { source_files: ['src/missing.ts'] }),
        ],
      },
    ]);
    const ctx = context(config, projectIR([]), ['PRES', 'MISS'], root);

    const before = await deriveCodeMapping(ctx);
    await writeFile(join(root, 'src/a.ts'), 'after');
    const after = await deriveCodeMapping(ctx);

    const beforePresent = before.entries.find((entry) => entry.dok_id === 'PRES')!;
    const afterPresent = after.entries.find((entry) => entry.dok_id === 'PRES')!;
    const missing = after.entries.find((entry) => entry.dok_id === 'MISS')!;
    expect(afterPresent.content_hash).not.toBe(beforePresent.content_hash);
    expect(missing.content_hash).toBe(expectedHash([{ path: 'src/missing.ts' }]));
  });

  it('falls back to the primary page route only for a legacy cache without source_files', async () => {
    const root = await makeServiceRoot({
      'app/legacy/page.tsx': 'legacy page',
      'legacy-pages/legacy.tsx': 'older page',
    });
    const config = consolidated([
      { id: 'main', features: [feature('legacy', 'LEG', '/legacy')] },
    ]);
    const ir = projectIR([
      page('/legacy', 'legacy-pages/legacy.tsx'),
      page('/legacy', 'app/legacy/page.tsx'),
    ]);

    const mapping = await deriveCodeMapping(context(config, ir, ['LEG'], root));

    expect(mapping.entries[0]!.files.map((file) => file.path)).toEqual([
      'app/legacy/page.tsx',
      'legacy-pages/legacy.tsx',
    ]);
    expect(mapping.entries[0]!.content_hash).toBe(expectedHash([
      { path: 'app/legacy/page.tsx', contents: 'legacy page' },
      { path: 'legacy-pages/legacy.tsx', contents: 'older page' },
    ]));
  });

  it('keeps an explicitly empty source_files list empty', async () => {
    const root = await makeServiceRoot({
      'app/empty/page.tsx': 'empty-array fallback page',
    });
    const config = consolidated([
      {
        id: 'main',
        features: [feature('empty', 'EMPT', '/empty', { source_files: [] })],
      },
    ]);
    const ir = projectIR([page('/empty', 'app/empty/page.tsx')]);

    const mapping = await deriveCodeMapping(context(config, ir, ['EMPT'], root));

    expect(mapping.entries[0]!.files).toEqual([]);
    expect(mapping.entries[0]!.content_hash).toBe('');
  });

  it.each([
    ['traversal', '../outside.ts'],
    ['absolute', '/tmp/outside.ts'],
    ['NUL byte', 'src/unsafe\0.ts'],
  ])('rejects a %s source path before hashing', async (_label, unsafePath) => {
    const root = await makeServiceRoot({});
    const config = consolidated([{ id: 'main', features: [
      feature('unsafe', 'SAFE', '/safe', { source_files: [unsafePath] }),
    ] }]);

    await expect(deriveCodeMapping(context(
      config,
      projectIR([]),
      ['SAFE'],
      root,
    ))).rejects.toThrow(/outside service root/i);
  });

  it('rejects a symlink whose existing target escapes the service root', async () => {
    const container = await makeServiceRoot({ 'outside.ts': 'secret' });
    const root = join(container, 'service');
    await mkdir(root);
    await symlink('../outside.ts', join(root, 'link.ts'));
    const config = consolidated([{ id: 'main', features: [
      feature('unsafe', 'SAFE', '/safe', { source_files: ['link.ts'] }),
    ] }]);

    await expect(deriveCodeMapping(context(
      config,
      projectIR([]),
      ['SAFE'],
      root,
    ))).rejects.toThrow(/outside service root/i);
  });

  it('does not treat a missing service root as an ordinary missing source file', async () => {
    const container = await makeServiceRoot({});
    const missingRoot = join(container, 'missing-service');
    const config = consolidated([{ id: 'main', features: [
      feature('missing', 'MISS', '/missing', { source_files: ['src/missing.ts'] }),
    ] }]);

    await expect(deriveCodeMapping(context(
      config,
      projectIR([]),
      ['MISS'],
      missingRoot,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('mergeDerivedCodeMapping', () => {
  const existing: ServiceCodeMappingFile = ServiceCodeMappingFileSchema.parse({
    service_id: 'web',
    entries: [
      {
        dok_id: 'AUTH',
        files: [
          {
            path: 'src/auth.ts',
            functions: ['signIn'],
            components: ['SignInForm'],
            lines: '10-42',
            last_commit: 'abc123',
          },
        ],
        exposes_apis: [{ method: 'POST', endpoint: '/auth/sign-in' }],
        consumes_apis: [{ method: 'GET', endpoint: '/session' }],
        db_tables: ['users', 'sessions'],
        content_hash: 'auth-hash',
        sync_status: 'synced',
        last_synced_at: OLD_TIME,
      },
      {
        dok_id: 'PROF',
        files: [{ path: 'src/profile.ts', functions: [], components: [] }],
        content_hash: 'profile-hash',
        sync_status: 'synced',
        last_synced_at: OLD_TIME,
      },
    ],
    version: 2,
    updated_at: OLD_TIME,
  });

  const derived: ServiceCodeMappingFile = ServiceCodeMappingFileSchema.parse({
    service_id: 'web',
    entries: [
      {
        dok_id: 'AUTH',
        files: [{ path: 'src/auth.ts', functions: [], components: [] }],
        content_hash: 'auth-hash',
        sync_status: 'synced',
      },
      {
        dok_id: 'PROF',
        files: [{ path: 'src/profile.ts', functions: [], components: [] }],
        content_hash: 'profile-hash',
        sync_status: 'synced',
      },
    ],
    version: 1,
  });

  it('preserves entry and matching-file enrichments on a semantic no-op', () => {
    const result = mergeDerivedCodeMapping(existing, derived, NOW);

    expect(result).toEqual({ file: existing, changed: false });
  });

  it('stamps only changed entries and the file while retaining enrichments', () => {
    const changedDerived: ServiceCodeMappingFile = {
      ...derived,
      version: existing.version,
      entries: derived.entries.map((entry) => (
        entry.dok_id === 'AUTH'
          ? { ...entry, content_hash: 'changed-auth-hash' }
          : entry
      )),
    };

    const result = mergeDerivedCodeMapping(existing, changedDerived, NOW);
    const auth = result.file.entries.find((entry) => entry.dok_id === 'AUTH')!;
    const profile = result.file.entries.find((entry) => entry.dok_id === 'PROF')!;

    expect(result.changed).toBe(true);
    expect(ServiceCodeMappingFileSchema.parse(result.file)).toEqual(result.file);
    expect(result.file.version).toBe(existing.version);
    expect(result.file.updated_at).toBe(NOW);
    expect(auth.last_synced_at).toBe(NOW);
    expect(profile.last_synced_at).toBe(OLD_TIME);
    expect(auth.exposes_apis).toEqual(existing.entries[0]!.exposes_apis);
    expect(auth.consumes_apis).toEqual(existing.entries[0]!.consumes_apis);
    expect(auth.db_tables).toEqual(existing.entries[0]!.db_tables);
    expect(auth.files[0]).toEqual(existing.entries[0]!.files[0]);
    expect(existing.entries[0]!.content_hash).toBe('auth-hash');
  });
});
