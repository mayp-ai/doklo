import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseConsolidatedFeatureConfig,
  type ConsolidatedFeatureConfig,
} from '../lib/consolidation';
import { mergeGroups, setDokIdPrefix, toggleExcludeFeature } from '../lib/consolidation-edit';
import { revisionOf } from '../lib/load-state';
import { saveConsolidatedAction } from '../lib/actions';

const atomicFault = vi.hoisted(() => ({ enabled: false }));

vi.mock('@doklo-beta/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/core')>();
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (atomicFault.enabled) {
        throw Object.assign(new Error('permission denied by deterministic test fault'), {
          code: 'EACCES',
        });
      }
      return actual.writeFileAtomic(...args);
    },
  };
});

const DEMO = fileURLToPath(new URL('../demo', import.meta.url));
const originalRoot = process.env.DOKLO_WORKSPACE_ROOT;
const scratchRoots: string[] = [];

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'doklo-consol-')));
  scratchRoots.push(dir);
  await cp(DEMO, dir, { recursive: true });
  process.env.DOKLO_WORKSPACE_ROOT = dir;
  return dir;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

afterEach(async () => {
  atomicFault.enabled = false;
  if (originalRoot === undefined) delete process.env.DOKLO_WORKSPACE_ROOT;
  else process.env.DOKLO_WORKSPACE_ROOT = originalRoot;
  await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('saveConsolidatedAction', () => {
  it('saves a group merge from a legacy route-slug collision and persists repaired ids', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const legacy: ConsolidatedFeatureConfig = {
      projectName: 'test',
      basedOnFeaturesAt: '2026-09-08T00:00:00.000Z',
      generatedAt: '2026-09-08T00:01:00.000Z',
      model: 'test',
      groups: [
        {
          group_id: 'direct',
          label: 'Direct',
          excluded: [],
          features: [{
            canonical_id: 'create-template',
            label: 'Direct template',
            decision: 'keep',
            members: ['create-template'],
            primary_route: '/create-template',
            reason: '',
            user_reviewed: false,
            dok_id_prefix: 'TEMPLATE',
            source_files: ['app/create/template/page.tsx'],
            logic_files: ['app/create/template/page.tsx'],
          }],
        },
        {
          group_id: 'nested',
          label: 'Nested',
          excluded: [],
          features: [{
            canonical_id: 'create-template',
            label: 'Nested template',
            decision: 'keep',
            members: ['create-template'],
            primary_route: '/create/template',
            reason: '',
            user_reviewed: false,
            dok_id_prefix: 'CREATE-TPL',
            source_files: ['app/create/template/page.tsx'],
            logic_files: ['app/create/template/page.tsx'],
          }],
        },
      ],
      originalFeatureIds: ['create-template', 'create-template'],
      userReviewed: false,
      stats: { originalFeatures: 2, consolidatedFeatures: 2, merges: 0, excluded: 0 },
    };
    const before = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(path, before, 'utf-8');
    const displayed = parseConsolidatedFeatureConfig(legacy);
    const edited = mergeGroups(displayed, ['direct', 'nested']);

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: edited,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const saved = await readJson<ConsolidatedFeatureConfig>(path);
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0]?.features.map((feature) => feature.canonical_id)).toEqual([
      'create-template',
      'create-template-path2',
    ]);
    expect(saved.originalFeatureIds).toEqual(['create-template', 'create-template-path2']);
  });

  it('writes an edited config, recomputes stats, and returns the affected path and revision', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');
    const config = JSON.parse(before) as ConsolidatedFeatureConfig;
    const edited = toggleExcludeFeature(config, 'auth-signin');

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: edited,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.path).toBe(path);
    const after = await readFile(path, 'utf-8');
    expect(result.revision).toBe(revisionOf(after));
    const saved = JSON.parse(after) as ConsolidatedFeatureConfig;
    expect(saved.userReviewed).toBe(true);
    expect(saved.stats.excluded).toBe(1);
    expect(saved.groups[0].features[0].decision).toBe('exclude');
  });

  it('preserves unknown current fields recursively while applying validated client data', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const clean = await readJson<ConsolidatedFeatureConfig>(path);
    const seeded = JSON.parse(JSON.stringify(clean)) as Record<string, any>;
    seeded.server_extension = { retained: true };
    seeded.groups[0].server_group_extension = { retained: true };
    seeded.groups[0].features[0].server_feature_extension = {
      nested: { retained: true },
    };
    await writeFile(path, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');
    const before = await readFile(path, 'utf-8');
    const edited = toggleExcludeFeature(clean, 'auth-signin');

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: edited,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<Record<string, any>>(path);
    expect(saved.server_extension).toEqual({ retained: true });
    expect(saved.groups[0].server_group_extension).toEqual({ retained: true });
    expect(saved.groups[0].features[0].server_feature_extension).toEqual({
      nested: { retained: true },
    });
    expect(saved.groups[0].features[0].decision).toBe('exclude');
  });

  it('derives the save from current data and preserves server-owned root fields and feature provenance', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const current = await readJson<ConsolidatedFeatureConfig>(path);
    const storedFeature = current.groups[0].features[0];
    const seeded = {
      ...current,
      notes: 'server-owned root note',
      groups: current.groups.map((group, groupIndex) =>
        groupIndex === 0
          ? {
              ...group,
              features: group.features.map((feature, featureIndex) =>
                featureIndex === 0
                  ? {
                      ...feature,
                      members: ['auth-signin', 'auth-callback'],
                      primary_route: '/signin',
                      reason: 'server-derived consolidation reason',
                      user_reviewed: false,
                      dok_id_prefix: 'AUTH',
                      source_files: ['app/signin/page.tsx'],
                      logic_files: ['app/signin/page.tsx', 'lib/auth.ts'],
                      metadata: {
                        locales: ['ko', 'en'],
                        variant_type: 'i18n' as const,
                        note: 'server-derived metadata note',
                      },
                    }
                  : feature,
              ),
            }
          : group,
      ),
    };
    await writeFile(path, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');
    const before = await readFile(path, 'utf-8');
    const malicious = JSON.parse(JSON.stringify(seeded)) as ConsolidatedFeatureConfig;
    malicious.projectName = 'client-overwrite';
    malicious.basedOnFeaturesAt = 'client-overwrite';
    malicious.model = 'client-overwrite';
    malicious.originalFeatureIds = ['client-overwrite'];
    malicious.notes = 'client-overwrite';
    malicious.stats.originalFeatures = 999;
    malicious.groups[0].label = 'Renamed auth group';
    malicious.groups[0].features[0] = {
      ...malicious.groups[0].features[0],
      label: 'Renamed login feature',
      decision: 'exclude',
      prev_decision: 'keep',
      members: ['client-overwrite'],
      primary_route: '/client-overwrite',
      reason: 'client-overwrite',
      user_reviewed: true,
      dok_id_prefix: 'CLIENT',
      source_files: ['client-overwrite.ts'],
      logic_files: ['client-overwrite.ts'],
      metadata: {
        locales: ['client-overwrite'],
        variant_type: 'other',
        note: 'client-overwrite',
      },
    };

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: malicious,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<ConsolidatedFeatureConfig>(path);
    expect(saved).toMatchObject({
      projectName: seeded.projectName,
      basedOnFeaturesAt: seeded.basedOnFeaturesAt,
      model: seeded.model,
      originalFeatureIds: seeded.originalFeatureIds,
      notes: seeded.notes,
      stats: { originalFeatures: seeded.stats.originalFeatures },
    });
    expect(saved.groups[0].label).toBe('Renamed auth group');
    expect(saved.groups[0].features[0]).toEqual({
      ...storedFeature,
      members: ['auth-signin', 'auth-callback'],
      primary_route: '/signin',
      reason: 'server-derived consolidation reason',
      user_reviewed: false,
      // dok_id_prefix is Studio-editable (like decision/prev_decision) — unlike
      // every other field asserted here, the client's edited value must win.
      dok_id_prefix: 'CLIENT',
      source_files: ['app/signin/page.tsx'],
      logic_files: ['app/signin/page.tsx', 'lib/auth.ts'],
      metadata: {
        locales: ['ko', 'en'],
        variant_type: 'i18n',
        note: 'server-derived metadata note',
      },
      label: storedFeature.label,
      decision: 'exclude',
      prev_decision: 'keep',
    });
  });

  it('preserves duplicate excluded occurrences losslessly through a structural group merge', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const clean = await readJson<ConsolidatedFeatureConfig>(path);
    const storedExcluded = [
      {
        id: 'catalog-legacy',
        reason: 'first stored reason',
        server_extension: { sequence: 1 },
      },
      {
        id: 'catalog-legacy',
        reason: 'second stored reason',
        server_extension: { sequence: 2 },
      },
    ];
    const seeded = JSON.parse(JSON.stringify(clean)) as Record<string, any>;
    seeded.groups.find((group: Record<string, any>) => group.group_id === 'catalog').excluded =
      storedExcluded;
    await writeFile(path, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');
    const before = await readFile(path, 'utf-8');

    const proposal = JSON.parse(JSON.stringify(clean)) as ConsolidatedFeatureConfig;
    const catalog = proposal.groups.find((group) => group.group_id === 'catalog');
    if (!catalog) throw new Error('Missing catalog fixture group.');
    catalog.excluded = [
      { id: 'catalog-legacy', reason: 'client overwrite first' },
      { id: 'catalog-legacy', reason: 'client overwrite second' },
    ];
    const edited = mergeGroups(proposal, ['auth', 'catalog']);

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: edited,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<Record<string, any>>(path);
    const auth = saved.groups.find((group: Record<string, any>) => group.group_id === 'auth');
    expect(auth.features.map((feature: Record<string, any>) => feature.canonical_id)).toEqual([
      'auth-signin',
      'cart',
    ]);
    expect(auth.excluded).toEqual(storedExcluded);
    expect(saved.groups.some((group: Record<string, any>) => group.group_id === 'catalog')).toBe(
      false,
    );
  });

  it.each([
    {
      label: 'injected canonical feature',
      mutate(config: ConsolidatedFeatureConfig) {
        config.groups[0].features.push({
          ...config.groups[0].features[0],
          canonical_id: 'client-injected',
        });
      },
    },
    {
      label: 'deleted canonical feature',
      mutate(config: ConsolidatedFeatureConfig) {
        config.groups[0].features.splice(0, 1);
      },
    },
  ])('rejects a $label and leaves exact bytes unchanged', async ({ mutate }) => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');
    const config = JSON.parse(before) as ConsolidatedFeatureConfig;
    mutate(config);

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).toMatchObject({ code: 'INVALID', path, preserved: true });
    }
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('fails closed for a stale revision and leaves exact external bytes unchanged', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');
    const config = JSON.parse(before) as ConsolidatedFeatureConfig;
    const external = `${before.trimEnd()} \n`;
    await writeFile(path, external, 'utf-8');

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'CONFLICT', path, preserved: true });
    expect(await readFile(path, 'utf-8')).toBe(external);
  });

  it('fails closed for an invalid current cache and leaves exact bytes unchanged', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const valid = await readJson<ConsolidatedFeatureConfig>(path);
    const invalid = '{ "projectName": "broken" }\n';
    await writeFile(path, invalid, 'utf-8');

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: valid,
      expectedRevision: revisionOf(invalid),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'INVALID', path, preserved: true });
    expect(await readFile(path, 'utf-8')).toBe(invalid);
  });

  it('refuses an absent current cache instead of creating one', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const config = await readJson<ConsolidatedFeatureConfig>(path);
    await unlink(path);

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config,
      expectedRevision: revisionOf(''),
    });

    expect(result).toEqual({
      ok: false,
      code: 'MISSING',
      path,
      error: expect.any(String),
      preserved: true,
    });
    await expect(readFile(path, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid incoming data before writing and preserves exact bytes', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: { nope: true },
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID');
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('maps a deterministic permission fault to WRITE_FAILED and preserves exact bytes', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');
    const config = JSON.parse(before) as ConsolidatedFeatureConfig;
    atomicFault.enabled = true;

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: toggleExcludeFeature(config, 'auth-signin'),
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'WRITE_FAILED', path, preserved: true });
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('rejects a save when two live features in the same cache share a dok_id_prefix', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const clean = await readJson<ConsolidatedFeatureConfig>(path);
    const seeded = JSON.parse(JSON.stringify(clean)) as Record<string, any>;
    const cartFeature = seeded.groups
      .flatMap((group: Record<string, any>) => group.features)
      .find((feature: Record<string, any>) => feature.canonical_id === 'cart');
    // Force a same-cache collision: cart takes auth-signin's prefix.
    cartFeature.dok_id_prefix = 'AUTH';
    await writeFile(path, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');
    const before = await readFile(path, 'utf-8');
    const config = JSON.parse(before) as ConsolidatedFeatureConfig;

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      // The edit itself is unrelated — the guard must catch a pre-existing
      // duplicate regardless of what the save is actually changing.
      config: toggleExcludeFeature(config, 'pay'),
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).toMatchObject({ code: 'INVALID', path, preserved: true });
      expect(result.error).toContain('AUTH');
    }
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('rejects a save when the client edit itself introduces a same-cache dok_id_prefix duplicate', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');
    const config = JSON.parse(before) as ConsolidatedFeatureConfig;
    // The stored cache has no collision. The edit itself creates one — a
    // Studio user renaming `pay`'s dok_id_prefix onto `auth-signin`'s — so
    // this exercises the guard through the same path a real prefix edit now
    // takes, not just a pre-seeded on-disk duplicate.
    const edited = setDokIdPrefix(config, 'pay', 'AUTH');

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: edited,
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).toMatchObject({ code: 'INVALID', path, preserved: true });
      expect(result.error).toContain('AUTH');
    }
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('allows two features to share a dok_id_prefix when one of them is excluded', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const clean = await readJson<ConsolidatedFeatureConfig>(path);
    const seeded = JSON.parse(JSON.stringify(clean)) as Record<string, any>;
    const cartFeature = seeded.groups
      .flatMap((group: Record<string, any>) => group.features)
      .find((feature: Record<string, any>) => feature.canonical_id === 'cart');
    // Same prefix as auth-signin, but cart is already excluded — the
    // generator only mints ids for live features (assignDokIds skips
    // decision:'exclude'), so this must not block the save.
    cartFeature.dok_id_prefix = 'AUTH';
    cartFeature.decision = 'exclude';
    await writeFile(path, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');
    const before = await readFile(path, 'utf-8');
    const config = JSON.parse(before) as ConsolidatedFeatureConfig;

    const result = await saveConsolidatedAction({
      serviceId: 'web',
      config: toggleExcludeFeature(config, 'pay'),
      expectedRevision: revisionOf(before),
    });

    expect(result.ok).toBe(true);
  });
});
