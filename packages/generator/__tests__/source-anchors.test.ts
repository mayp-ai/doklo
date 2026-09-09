import { describe, it, expect } from 'vitest';
import type { ProjectIR } from '@doklo-beta/core';
import { irToFeatures } from '../src/ir-to-features.js';
import { attachSourceFiles } from '../src/consolidator.js';
import type {
  Feature,
  FeatureFile,
  FeatureConfig,
  ConsolidatedFeature,
  ConsolidatedFeatureConfig,
} from '../src/legacy-types.js';

// ───────── builders ─────────────────────────────────────────────────

function file(path: string, role: FeatureFile['role'] = 'component'): FeatureFile {
  return { path, role, depth: role === 'entry' ? 0 : 1, isShared: false };
}

function feature(id: string, files: FeatureFile[]): Feature {
  return {
    id,
    label: id,
    routePath: `/${id}`,
    entryPoint: files[0]?.path ?? `${id}/page.tsx`,
    files,
    apiRoutes: [],
    components: [],
    stores: [],
    enabled: true,
  };
}

function featureConfig(features: Feature[]): FeatureConfig {
  return {
    projectName: 'demo',
    projectRoot: '/proj',
    featureGroups: [
      {
        id: 'g',
        label: 'g',
        routePrefix: '/g',
        description: '',
        features,
        totalFileCount: features.reduce((a, f) => a + f.files.length, 0),
        enabled: true,
      },
    ],
    sharedInfrastructure: {
      sharedComponents: [],
      sharedUtils: [],
      sharedHooks: [],
      sharedTypes: [],
      sharedStores: [],
    },
    terminology: {},
    generatedAt: '2026-06-03T00:00:00.000Z',
    totalFiles: 0,
    unmappedFiles: [],
  };
}

function decision(
  canonical_id: string,
  members: string[],
  primary_route: string,
): ConsolidatedFeature {
  return {
    canonical_id,
    label: canonical_id,
    decision: members.length > 1 ? 'merge' : 'keep',
    members,
    primary_route,
    reason: '',
    user_reviewed: false,
    dok_id_prefix: canonical_id.toUpperCase().slice(0, 6),
  };
}

function consolidatedConfig(decisions: ConsolidatedFeature[]): ConsolidatedFeatureConfig {
  return {
    projectName: 'demo',
    basedOnFeaturesAt: '2026-06-03T00:00:00.000Z',
    generatedAt: '2026-06-03T00:00:00.000Z',
    model: 'test',
    originalFeatureIds: decisions.flatMap((feature) => feature.members),
    userReviewed: false,
    groups: [{ group_id: 'g', label: 'g', features: decisions, excluded: [] }],
    stats: { originalFeatures: 0, consolidatedFeatures: 0, merges: 0, excluded: 0 },
  };
}

// ───────── attachSourceFiles ─────────────────────────────────────────

describe('attachSourceFiles', () => {
  it('carries a keep feature\'s own file paths onto the consolidated feature', () => {
    const source = featureConfig([
      feature('auth-signin', [
        file('app/auth/signin/page.tsx', 'entry'),
        file('components/SigninForm.tsx', 'component'),
      ]),
    ]);
    const config = consolidatedConfig([decision('auth-signin', ['auth-signin'], '/auth/signin')]);

    attachSourceFiles(config, source);

    expect(config.groups[0]!.features[0]!.source_files).toEqual([
      'app/auth/signin/page.tsx',
      'components/SigninForm.tsx',
    ]);
  });

  it('unions + dedups files across merged members (i18n merge)', () => {
    const source = featureConfig([
      feature('impact-form', [
        file('app/impact/page.tsx', 'entry'),
        file('components/ImpactForm.tsx', 'component'),
      ]),
      feature('impact-form-en', [
        file('app/impact/en/page.tsx', 'entry'),
        file('components/ImpactForm.tsx', 'component'), // shared between locales
      ]),
    ]);
    const config = consolidatedConfig([
      decision('impact-form', ['impact-form', 'impact-form-en'], '/impact'),
    ]);

    attachSourceFiles(config, source);

    expect(config.groups[0]!.features[0]!.source_files).toEqual([
      'app/impact/page.tsx',
      'components/ImpactForm.tsx',
      'app/impact/en/page.tsx',
    ]);
  });

  it('leaves source_files empty when a member id is not found in the source', () => {
    const source = featureConfig([feature('known', [file('app/known/page.tsx', 'entry')])]);
    const config = consolidatedConfig([decision('ghost', ['ghost'], '/ghost')]);

    attachSourceFiles(config, source);

    expect(config.groups[0]!.features[0]!.source_files).toEqual([]);
  });

  it('unions member logic_files (shared infra incl.) while source_files stays display-only (B1)', () => {
    // Two members each reach a shared util that is NOT in their display files.
    // logic_files carries that shared closure; source_files must not.
    const source = featureConfig([
      { ...feature('a', [file('app/a/page.tsx', 'entry')]), logic_files: ['app/a/page.tsx', 'lib/shared.ts'] },
      { ...feature('b', [file('app/b/page.tsx', 'entry')]), logic_files: ['app/b/page.tsx', 'lib/shared.ts'] },
    ]);
    const config = consolidatedConfig([decision('ab', ['a', 'b'], '/a')]);

    attachSourceFiles(config, source);

    const merged = config.groups[0]!.features[0]!;
    // Display set: member display files only — shared infra excluded.
    expect(merged.source_files).toEqual(['app/a/page.tsx', 'app/b/page.tsx']);
    // Drift set: dedup union incl. the shared util (deduped to one entry).
    expect(merged.logic_files).toEqual(['app/a/page.tsx', 'lib/shared.ts', 'app/b/page.tsx']);
  });

  it('falls back to display files for source features without logic_files (legacy config)', () => {
    // A source FeatureConfig produced before logic_files existed: the drift set
    // must equal the display set so the resulting hash is unchanged.
    const source = featureConfig([
      feature('a', [file('app/a/page.tsx', 'entry'), file('components/A.tsx', 'component')]),
    ]);
    const config = consolidatedConfig([decision('a', ['a'], '/a')]);

    attachSourceFiles(config, source);

    const merged = config.groups[0]!.features[0]!;
    expect(merged.source_files).toEqual(['app/a/page.tsx', 'components/A.tsx']);
    expect(merged.logic_files).toEqual(['app/a/page.tsx', 'components/A.tsx']);
  });
});

// ───────── realistic pipeline (realistic shape, no LLM) ────────────

describe('source provenance survives the full deterministic pipeline', () => {
  // Mirrors a realistic app: nested routes, a merged i18n pair, components +
  // hook + store reachable via the import graph, and one shared file that
  // must NOT pollute per-Dok provenance.
  function realisticIR(): ProjectIR {
    return {
      framework: 'nextjs',
      root: '/proj',
      files: [
        'app/program/[id]/page.tsx',
        'app/impact/page.tsx',
        'app/impact/en/page.tsx',
        'components/ProgramDetail.tsx',
        'components/ImpactForm.tsx',
        'hooks/useProgram.ts',
        'stores/program.store.ts',
        'lib/format.ts', // shared across all 3 pages → hoisted out
      ],
      routes: [
        { path: '/program/[id]', kind: 'page', file: 'app/program/[id]/page.tsx', dynamic_params: ['id'], layout_chain: [] },
        { path: '/impact', kind: 'page', file: 'app/impact/page.tsx', dynamic_params: [], layout_chain: [] },
        { path: '/impact/en', kind: 'page', file: 'app/impact/en/page.tsx', dynamic_params: [], layout_chain: [] },
      ],
      components: [],
      stores: [],
      framework_specific: {
        import_graph: {
          'app/program/[id]/page.tsx': ['components/ProgramDetail.tsx', 'hooks/useProgram.ts', 'stores/program.store.ts', 'lib/format.ts'],
          'app/impact/page.tsx': ['components/ImpactForm.tsx', 'lib/format.ts'],
          'app/impact/en/page.tsx': ['components/ImpactForm.tsx', 'lib/format.ts'],
          'components/ProgramDetail.tsx': [],
          'components/ImpactForm.tsx': [],
          'hooks/useProgram.ts': [],
          'stores/program.store.ts': [],
          'lib/format.ts': [],
        },
      },
    };
  }

  it('every consolidated feature carries non-empty, real, own-only file paths', () => {
    const ir = realisticIR();
    const source = irToFeatures(ir, { projectName: 'demo', sharedThreshold: 3 });

    // Deterministic stand-in for the LLM consolidation: keep every feature,
    // merge the two impact locale variants.
    const allFeatures = source.featureGroups.flatMap((g) => g.features);
    const impactIds = allFeatures.filter((f) => f.id.startsWith('impact')).map((f) => f.id);
    const programId = allFeatures.find((f) => f.id.startsWith('program'))!.id;

    const config: ConsolidatedFeatureConfig = {
      projectName: 'demo',
      basedOnFeaturesAt: source.generatedAt,
      generatedAt: source.generatedAt,
      model: 'test',
      originalFeatureIds: allFeatures.map((feature) => feature.id),
      userReviewed: false,
      stats: { originalFeatures: 0, consolidatedFeatures: 0, merges: 0, excluded: 0 },
      groups: [
        {
          group_id: 'all',
          label: 'all',
          excluded: [],
          features: [
            decision('program', [programId], '/program/[id]'),
            decision('impact', impactIds, '/impact'),
          ],
        },
      ],
    };

    attachSourceFiles(config, source);

    const irFiles = new Set(ir.files);
    for (const f of config.groups[0]!.features) {
      // non-empty
      expect(f.source_files && f.source_files.length).toBeGreaterThan(0);
      // every anchor points at a file that actually exists in the IR
      for (const path of f.source_files!) {
        expect(irFiles.has(path), `${path} should be a real IR file`).toBe(true);
      }
      // shared infra must not leak into a single Dok's provenance
      expect(f.source_files).not.toContain('lib/format.ts');
    }

    const program = config.groups[0]!.features.find((f) => f.canonical_id === 'program')!;
    expect(program.source_files).toEqual(
      expect.arrayContaining([
        'app/program/[id]/page.tsx',
        'components/ProgramDetail.tsx',
        'hooks/useProgram.ts',
        'stores/program.store.ts',
      ]),
    );

    const impact = config.groups[0]!.features.find((f) => f.canonical_id === 'impact')!;
    expect(impact.source_files).toEqual(
      expect.arrayContaining([
        'app/impact/page.tsx',
        'app/impact/en/page.tsx',
        'components/ImpactForm.tsx',
      ]),
    );
  });
});
