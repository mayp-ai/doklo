import { describe, it, expect } from 'vitest';
import type { ProjectIR } from '@doklo-beta/core';
import { irToFeatures } from '../src/ir-to-features.js';
import { ensureUniquePrefix } from '../src/dok-id-prefix.js';

function ir(overrides: Partial<ProjectIR> = {}): ProjectIR {
  return {
    framework: 'nextjs',
    root: '/proj',
    files: [],
    routes: [],
    components: [],
    stores: [],
    ...overrides,
  };
}

describe('irToFeatures', () => {
  it('returns an empty FeatureConfig when there are no page routes', () => {
    const fc = irToFeatures(ir(), { projectName: 'demo' });
    expect(fc.projectName).toBe('demo');
    expect(fc.featureGroups).toEqual([]);
    expect(fc.totalFiles).toBe(0);
  });

  it('groups page routes by their first path segment', () => {
    const fc = irToFeatures(
      ir({
        routes: [
          { path: '/auth/signin', kind: 'page', file: 'app/auth/signin/page.tsx', dynamic_params: [], layout_chain: [] },
          { path: '/auth/signup', kind: 'page', file: 'app/auth/signup/page.tsx', dynamic_params: [], layout_chain: [] },
          { path: '/admin/users', kind: 'page', file: 'app/admin/users/page.tsx', dynamic_params: [], layout_chain: [] },
        ],
      }),
      { projectName: 'demo' },
    );
    const ids = fc.featureGroups.map((g) => g.id).sort();
    expect(ids).toEqual(['admin', 'auth']);
    const auth = fc.featureGroups.find((g) => g.id === 'auth');
    expect(auth?.features).toHaveLength(2);
  });

  it('handles the home route ("/") under the "_root" group', () => {
    const fc = irToFeatures(
      ir({ routes: [{ path: '/', kind: 'page', file: 'app/page.tsx', dynamic_params: [], layout_chain: [] }] }),
      { projectName: 'demo' },
    );
    expect(fc.featureGroups[0]?.id).toBe('_root');
    expect(fc.featureGroups[0]?.features[0]?.routePath).toBe('/');
  });

  it('produces unique feature ids per route path', () => {
    const fc = irToFeatures(
      ir({
        routes: [
          { path: '/program', kind: 'page', file: 'app/program/page.tsx', dynamic_params: [], layout_chain: [] },
          {
            path: '/program/[id]',
            kind: 'page',
            file: 'app/program/[id]/page.tsx',
            dynamic_params: ['id'],
            layout_chain: [],
          },
        ],
      }),
      { projectName: 'demo' },
    );
    const featureIds = fc.featureGroups[0]!.features.map((f) => f.id);
    expect(new Set(featureIds).size).toBe(featureIds.length);
  });

  it('disambiguates route paths that collapse to the same feature id', () => {
    const fc = irToFeatures(
      ir({
        routes: [
          {
            path: '/create/template',
            kind: 'page',
            file: 'app/create/template/page.tsx',
            dynamic_params: [],
            layout_chain: [],
          },
          {
            path: '/create-template',
            kind: 'page',
            file: 'app/create-template/page.tsx',
            dynamic_params: [],
            layout_chain: [],
          },
        ],
      }),
      { projectName: 'demo' },
    );

    const idByRoute = new Map(
      fc.featureGroups.flatMap((group) => group.features)
        .map((feature) => [feature.routePath, feature.id]),
    );
    expect(Object.fromEntries(idByRoute)).toEqual({
      '/create-template': 'create-template',
      '/create/template': 'create-template-path2',
    });

    const prefixes = new Set<string>();
    for (const group of fc.featureGroups) {
      for (const feature of group.features) {
        prefixes.add(ensureUniquePrefix(undefined, feature.id, group.id, prefixes));
      }
    }
    expect(prefixes.size).toBe(2);
  });

  it('skips api/layout/middleware/route_group routes', () => {
    const fc = irToFeatures(
      ir({
        routes: [
          { path: '/page', kind: 'page', file: 'app/page/page.tsx', dynamic_params: [], layout_chain: [] },
          { path: '/api/users', kind: 'api', file: 'app/api/users/route.ts', dynamic_params: [], layout_chain: [] },
          { path: '/', kind: 'layout', file: 'app/layout.tsx', dynamic_params: [], layout_chain: [] },
          { path: '/middleware', kind: 'middleware', file: 'middleware.ts', dynamic_params: [], layout_chain: [] },
        ],
      }),
      { projectName: 'demo' },
    );
    // Only the one page route — no group from api/layout/middleware.
    expect(fc.featureGroups.flatMap((g) => g.features.map((f) => f.routePath))).toEqual(['/page']);
  });

  it('attaches api routes whose first segment matches the group', () => {
    const fc = irToFeatures(
      ir({
        routes: [
          { path: '/admin/users', kind: 'page', file: 'app/admin/users/page.tsx', dynamic_params: [], layout_chain: [] },
          { path: '/api/admin/users', kind: 'api', file: 'app/api/admin/users/route.ts', dynamic_params: [], layout_chain: [] },
          { path: '/api/auth/login', kind: 'api', file: 'app/api/auth/login/route.ts', dynamic_params: [], layout_chain: [] },
        ],
      }),
      { projectName: 'demo' },
    );
    const admin = fc.featureGroups.find((g) => g.id === 'admin');
    expect(admin?.features[0]?.apiRoutes).toEqual(['/api/admin/users']);
  });

  it('marks every feature enabled by default', () => {
    const fc = irToFeatures(
      ir({ routes: [{ path: '/x', kind: 'page', file: 'app/x/page.tsx', dynamic_params: [], layout_chain: [] }] }),
      { projectName: 'demo' },
    );
    expect(fc.featureGroups[0]?.enabled).toBe(true);
    expect(fc.featureGroups[0]?.features[0]?.enabled).toBe(true);
  });

  it('records every component file in sharedInfrastructure (no import graph yet)', () => {
    const fc = irToFeatures(
      ir({
        routes: [{ path: '/x', kind: 'page', file: 'app/x/page.tsx', dynamic_params: [], layout_chain: [] }],
        components: [
          { name: 'Button', file: 'components/Button.tsx', kind: 'component', is_exported: true, inputs: [] },
          { name: 'useAuth', file: 'hooks/useAuth.ts', kind: 'hook', is_exported: true, inputs: [] },
        ],
        stores: [],
      }),
      { projectName: 'demo' },
    );
    expect(fc.sharedInfrastructure.sharedComponents).toContain('components/Button.tsx');
    expect(fc.sharedInfrastructure.sharedHooks).toContain('hooks/useAuth.ts');
  });

  it('respects projectRoot from the IR', () => {
    const fc = irToFeatures(ir({ root: '/abs/path/to/proj' }), { projectName: 'demo' });
    expect(fc.projectRoot).toBe('/abs/path/to/proj');
  });
});

describe('irToFeatures with import graph', () => {
  function pageRoute(path: string, file: string) {
    return { path, kind: 'page' as const, file, dynamic_params: [], layout_chain: [] };
  }

  it('populates feature.files from BFS-reachable set when graph is present', () => {
    const fc = irToFeatures(
      ir({
        files: [
          'app/admin/page.tsx',
          'components/AdminTable.tsx',
          'components/AdminForm.tsx',
        ],
        routes: [pageRoute('/admin', 'app/admin/page.tsx')],
        framework_specific: {
          import_graph: {
            'app/admin/page.tsx': ['components/AdminTable.tsx', 'components/AdminForm.tsx'],
            'components/AdminTable.tsx': [],
            'components/AdminForm.tsx': [],
          },
        },
      }),
      { projectName: 'demo' },
    );
    const feature = fc.featureGroups[0]!.features[0]!;
    const paths = feature.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'app/admin/page.tsx',
      'components/AdminForm.tsx',
      'components/AdminTable.tsx',
    ]);
    expect(feature.components).toEqual(
      expect.arrayContaining(['components/AdminTable.tsx', 'components/AdminForm.tsx']),
    );
  });

  it('promotes files reachable from ≥sharedThreshold features to sharedInfrastructure', () => {
    const fc = irToFeatures(
      ir({
        files: ['p1.tsx', 'p2.tsx', 'p3.tsx', 'shared.tsx', 'only1.tsx'],
        routes: [
          pageRoute('/a', 'p1.tsx'),
          pageRoute('/b', 'p2.tsx'),
          pageRoute('/c', 'p3.tsx'),
        ],
        framework_specific: {
          import_graph: {
            'p1.tsx': ['shared.tsx', 'only1.tsx'],
            'p2.tsx': ['shared.tsx'],
            'p3.tsx': ['shared.tsx'],
            'shared.tsx': [],
            'only1.tsx': [],
          },
        },
      }),
      { projectName: 'demo', sharedThreshold: 3 },
    );
    // shared.tsx appears in 3 features (p1, p2, p3) → promoted to shared
    expect(fc.sharedInfrastructure.sharedComponents).toContain('shared.tsx');
    // only1.tsx appears in only 1 feature → stays in that feature
    const a = fc.featureGroups
      .flatMap((g) => g.features)
      .find((f) => f.routePath === '/a');
    expect(a?.files.map((f) => f.path)).toContain('only1.tsx');
    // None of the feature.files arrays contain shared.tsx (it's hoisted out)
    for (const g of fc.featureGroups) {
      for (const f of g.features) {
        const sharedInFeature = f.files.find((x) => x.path === 'shared.tsx');
        expect(sharedInFeature).toBeUndefined();
      }
    }
  });

  it('marks the entry file as role=entry, others by inferred role', () => {
    const fc = irToFeatures(
      ir({
        routes: [pageRoute('/x', 'app/x/page.tsx')],
        framework_specific: {
          import_graph: {
            'app/x/page.tsx': [
              'components/MyComponent.tsx',
              'hooks/useThing.ts',
              'lib/util.ts',
              'types/foo.types.ts',
            ],
            'components/MyComponent.tsx': [],
            'hooks/useThing.ts': [],
            'lib/util.ts': [],
            'types/foo.types.ts': [],
          },
        },
      }),
      { projectName: 'demo' },
    );
    const feature = fc.featureGroups[0]!.features[0]!;
    const byPath = Object.fromEntries(feature.files.map((f) => [f.path, f.role]));
    expect(byPath['app/x/page.tsx']).toBe('entry');
    expect(byPath['components/MyComponent.tsx']).toBe('component');
    expect(byPath['hooks/useThing.ts']).toBe('hook');
    expect(byPath['lib/util.ts']).toBe('util');
    expect(byPath['types/foo.types.ts']).toBe('type');
  });

  it('falls back to entry-only when no import_graph is in framework_specific', () => {
    const fc = irToFeatures(
      ir({
        routes: [pageRoute('/x', 'app/x/page.tsx')],
        // no framework_specific.import_graph
      }),
      { projectName: 'demo' },
    );
    const feature = fc.featureGroups[0]!.features[0]!;
    expect(feature.files).toEqual([
      { path: 'app/x/page.tsx', role: 'entry', depth: 0, isShared: false },
    ]);
  });

  it('honors sharedThreshold option (lower = more files promoted to shared)', () => {
    const fc = irToFeatures(
      ir({
        routes: [
          pageRoute('/a', 'p1.tsx'),
          pageRoute('/b', 'p2.tsx'),
        ],
        framework_specific: {
          import_graph: {
            'p1.tsx': ['shared.tsx'],
            'p2.tsx': ['shared.tsx'],
            'shared.tsx': [],
          },
        },
      }),
      { projectName: 'demo', sharedThreshold: 2 },
    );
    // 2 features both reach shared.tsx; threshold=2 → promoted
    expect(fc.sharedInfrastructure.sharedComponents).toContain('shared.tsx');
  });

  it('reports unmapped files (not reachable from any feature) when graph present', () => {
    const fc = irToFeatures(
      ir({
        files: ['app/x/page.tsx', 'components/Used.tsx', 'components/Orphan.tsx'],
        routes: [pageRoute('/x', 'app/x/page.tsx')],
        framework_specific: {
          import_graph: {
            'app/x/page.tsx': ['components/Used.tsx'],
            'components/Used.tsx': [],
            // Orphan.tsx is in IR.files but not reachable from any page
          },
        },
      }),
      { projectName: 'demo' },
    );
    expect(fc.unmappedFiles).toContain('components/Orphan.tsx');
    expect(fc.unmappedFiles).not.toContain('app/x/page.tsx');
    expect(fc.unmappedFiles).not.toContain('components/Used.tsx');
  });

  it('keeps shared infra OUT of feature.files but IN feature.logic_files (drift closure, B1)', () => {
    // Three pages all reach one util → the util is promoted to shared infra and
    // dropped from every feature's display `files`. The drift closure
    // (`logic_files`) must nonetheless retain it, or a change to that shared util
    // would go undetected — the B1 false-fresh.
    const fc = irToFeatures(
      ir({
        files: ['p1.tsx', 'p2.tsx', 'p3.tsx', 'shared.tsx'],
        routes: [
          pageRoute('/a', 'p1.tsx'),
          pageRoute('/b', 'p2.tsx'),
          pageRoute('/c', 'p3.tsx'),
        ],
        framework_specific: {
          import_graph: {
            'p1.tsx': ['shared.tsx'],
            'p2.tsx': ['shared.tsx'],
            'p3.tsx': ['shared.tsx'],
            'shared.tsx': [],
          },
        },
      }),
      { projectName: 'demo', sharedThreshold: 3 },
    );
    const a = fc.featureGroups.flatMap((g) => g.features).find((f) => f.routePath === '/a')!;
    // Display set: shared infra hoisted out, entry retained.
    expect(a.files.map((f) => f.path)).not.toContain('shared.tsx');
    expect(a.files.map((f) => f.path)).toContain('p1.tsx');
    // Drift set: the full reachable closure keeps the shared util.
    expect(a.logic_files).toContain('shared.tsx');
    expect(a.logic_files).toContain('p1.tsx');
  });

  it('sets logic_files equal to the display file paths when no import_graph (fallback)', () => {
    const fc = irToFeatures(
      ir({ routes: [pageRoute('/x', 'app/x/page.tsx')] }),
      { projectName: 'demo' },
    );
    const feature = fc.featureGroups[0]!.features[0]!;
    // Without a graph there is no closure to widen to: drift set == display set.
    expect(feature.files.map((f) => f.path)).toEqual(['app/x/page.tsx']);
    expect(feature.logic_files).toEqual(['app/x/page.tsx']);
  });
});

 it('carries generic file candidates without inventing HTTP routes', () => {
    const fc = irToFeatures(ir({ framework: 'unknown', files: ['src/a.py', 'src/b.py'],
      analysis_units: [{ id: 'source-src', label: 'src', files: ['src/a.py', 'src/b.py'] }],
    }), { projectName: 'python' });
    const feature = fc.featureGroups.flatMap(group => group.features)[0]!;
    expect(feature.routePath).toBe('');
    expect(feature.files.map(file => file.path)).toEqual(['src/a.py', 'src/b.py']);
    expect(feature.logic_files).toEqual(['src/a.py', 'src/b.py']);
    expect(fc.unmappedFiles).toEqual([]);
  });

it('describes non-web candidates and filenames to consolidation', async () => {
  const { buildConsolidationPromptParts } = await import('../src/consolidator.js');
  const fc = irToFeatures(ir({ framework: 'unknown', files: ['src/__init__.py', 'src/orders.py', 'src/billing.py'],
    analysis_units: [{ id: 'source-src', label: 'src', files: ['src/__init__.py', 'src/orders.py', 'src/billing.py'] }],
  }), { projectName: 'python' });
  const prompt = buildConsolidationPromptParts(fc);
  expect(prompt.userPrompt).toContain('orders.py');
  expect(prompt.userPrompt).toContain('billing.py');
  expect(prompt.systemPrompt).toContain('file-based');
  expect(prompt.systemPrompt).not.toContain("analyzing a Next.js project");
});
