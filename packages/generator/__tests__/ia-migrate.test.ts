import { describe, expect, it } from 'vitest';
import {
  IaFileV1Schema,
  IaFileV2Schema,
  type IaDestinationNodeV2,
  type IaFileV1,
  type IaFileV2,
  type IaNodeV2,
  type IaTreeV2,
} from '@doklo-beta/core';
import {
  isLegacyFlatAutoTree,
  migrateIaV1ToV2,
  type IaMigrationFailure,
  type IaMigrationResult,
} from '../src/ia-migrate.js';

const OLD_TIME = '2026-07-26T00:00:00.000Z';
const AVAILABLE_DOK_IDS: ReadonlySet<string> = new Set([
  'AUTH-SIGNIN',
  'BOOKMARK',
]);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return Object.freeze(value);
}

function v1File(trees: unknown[], edges: unknown[] = []): IaFileV1 {
  return IaFileV1Schema.parse({
    service_id: 'web',
    trees,
    edges,
    version: 1,
    updated_at: OLD_TIME,
  });
}

// One auto route hierarchy: /auth is a synthetic prefix group, /auth/signin is a
// mapped destination, /auth/[token] is an unmapped one.
function derivedRoutes(): IaFileV2 {
  return IaFileV2Schema.parse({
    service_id: 'web',
    version: 2,
    trees: [{
      tree_id: 'web-routes',
      type: 'route_hierarchy',
      source: 'auto',
      producer: 'doklo-route-hierarchy@1',
      platform: 'all',
      nodes: [{
        path: '/auth',
        kind: 'group',
        label: 'Auth',
        curated_fields: [],
        tags: [],
        children: [
          {
            path: '/auth/signin',
            kind: 'destination',
            label: 'Sign in',
            curated_fields: [],
            bindings: [{ dok_ref: 'AUTH-SIGNIN', source: 'auto' }],
            evidence: [{ kind: 'route_source', file: 'app/auth/signin/page.tsx' }],
            tags: [],
            children: [],
          },
          {
            path: '/auth/[token]',
            kind: 'destination',
            label: 'Auth token',
            curated_fields: [],
            bindings: [],
            evidence: [{ kind: 'route_source', file: 'app/auth/[token]/page.tsx' }],
            tags: [],
            children: [],
          },
        ],
      }],
    }],
  });
}

function legacyFlatNavTree(): Record<string, unknown> {
  return {
    tree_id: 'web-nav',
    type: 'navigation',
    platform: 'all',
    source: 'auto',
    nodes: [
      { path: '/auth/signin', label: 'signin', dok_ref: 'AUTH-SIGNIN', children: [] },
      { path: '/auth/[token]', label: '[token]', children: [] },
    ],
  };
}

function curatedNavTree(
  source: 'manual' | 'auto+manual' = 'manual',
): Record<string, unknown> {
  return {
    tree_id: 'web-main-nav',
    type: 'navigation',
    platform: 'all',
    source,
    nodes: [{
      label: 'Account',
      dok_ref: null,
      tags: ['curated'],
      children: [{
        path: '/auth/signin',
        label: 'Sign in entry',
        dok_ref: 'BOOKMARK',
        children: [],
      }],
    }],
  };
}

/**
 * Runs the migration with frozen inputs and proves the caller's objects survive
 * untouched — a fail-closed run must leave the on-disk file byte-identical.
 */
function migrate(
  v1: IaFileV1,
  options: { derived?: IaFileV2; availableDokIds?: ReadonlySet<string> } = {},
): IaMigrationResult {
  const derived = options.derived ?? derivedRoutes();
  const v1Before = structuredClone(v1);
  const derivedBefore = structuredClone(derived);
  deepFreeze(v1);
  deepFreeze(derived);

  const result = migrateIaV1ToV2({
    v1,
    derived,
    availableDokIds: options.availableDokIds ?? AVAILABLE_DOK_IDS,
  });

  expect(v1).toEqual(v1Before);
  expect(derived).toEqual(derivedBefore);
  return result;
}

function expectOk(result: IaMigrationResult): IaFileV2 {
  if (!result.ok) {
    throw new Error(
      `expected a converted file, got failures: ${JSON.stringify(result.failures)}`,
    );
  }
  return result.file;
}

function expectFailures(result: IaMigrationResult): IaMigrationFailure[] {
  if (result.ok) {
    throw new Error(`expected a fail-closed migration, got ${JSON.stringify(result.file)}`);
  }
  return result.failures;
}

function findNode(nodes: readonly IaNodeV2[], path: string): IaNodeV2 | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findNode(node.children, path);
    if (child !== undefined) return child;
  }
  return undefined;
}

function treeById(file: IaFileV2, treeId: string): IaTreeV2 {
  const tree = file.trees.find((candidate) => candidate.tree_id === treeId);
  if (tree === undefined) throw new Error(`no tree ${treeId}`);
  return tree;
}

function destinationAt(tree: IaTreeV2, path: string): IaDestinationNodeV2 {
  const node = findNode(tree.nodes, path);
  if (node === undefined || node.kind !== 'destination') {
    throw new Error(`no destination at ${path}`);
  }
  return node;
}

// Moved here from the merge suite: after the v2 rewrite the migrator is the only
// owner of the v1 shape predicates, and merge decides ownership from explicit
// fields alone.
describe('isLegacyFlatAutoTree', () => {
  it('recognizes only the exact flat auto navigation fingerprint', () => {
    expect(isLegacyFlatAutoTree({
      tree_id: 'web-nav',
      type: 'navigation',
      platform: 'all',
      source: 'auto',
      nodes: [
        { path: '/auth/signin', label: 'signin', children: [] },
        { path: '/auth/:token', label: ':token', children: [] },
      ],
    }, 'web')).toBe(true);
  });

  it.each([
    {
      name: 'nested',
      nodes: [{
        path: '/auth',
        label: 'Auth',
        children: [{ path: '/auth/signin', label: 'Sign in', children: [] }],
      }],
    },
    {
      name: 'pathless',
      nodes: [{ label: 'Curated group', children: [] }],
    },
    {
      name: 'duplicate',
      nodes: [
        { path: '/auth', label: 'Auth', children: [] },
        { path: '/auth', label: 'Auth duplicate', children: [] },
      ],
    },
  ])('rejects a $name auto navigation tree', ({ nodes }) => {
    expect(isLegacyFlatAutoTree({
      tree_id: 'web-nav',
      type: 'navigation',
      platform: 'all',
      source: 'auto',
      nodes,
    }, 'web')).toBe(false);
  });
});

describe('migrateIaV1ToV2 — deterministic conversion', () => {
  it('replaces a legacy flat auto navigation tree with the derived route hierarchy', () => {
    const derived = derivedRoutes();
    const v1 = v1File([{
      ...legacyFlatNavTree(),
      nodes: [
        { path: '/auth/signin', label: 'signin', dok_ref: 'AUTH-SIGNIN', children: [] },
        { path: '/auth/[token]', label: '[token]', children: [] },
        // A route that no longer exists, bound to a Dok that no longer exists:
        // producer-owned trees are re-derived, so neither blocks the migration.
        { path: '/gone', label: 'gone', dok_ref: 'GHOST', children: [] },
      ],
    }]);

    const file = expectOk(migrate(v1, {
      derived,
      availableDokIds: new Set(['AUTH-SIGNIN']),
    }));

    expect(file).toEqual(IaFileV2Schema.parse({
      service_id: 'web',
      version: 2,
      trees: derived.trees,
    }));
    // v1-only keys are dropped: no edges, and the old timestamp is not carried over.
    expect(Object.keys(file).sort()).toEqual(['service_id', 'trees', 'version']);
  });

  it('replaces a producer-owned hierarchical sitemap and does not promote v1 enrichments', () => {
    const v1 = v1File([{
      tree_id: 'web-sitemap',
      type: 'sitemap',
      platform: 'all',
      source: 'auto',
      nodes: [{
        path: '/auth',
        label: 'Curated auth area',
        dok_ref: null,
        children: [
          {
            path: '/auth/signin',
            label: 'Curated sign in',
            dok_ref: 'AUTH-SIGNIN',
            platform: 'mobile',
            tags: ['featured'],
            children: [],
          },
          { path: '/auth/[token]', label: 'Curated token', children: [] },
        ],
      }],
    }]);

    const file = expectOk(migrate(v1));
    const signIn = destinationAt(treeById(file, 'web-routes'), '/auth/signin');

    expect(file.trees.map((tree) => tree.tree_id)).toEqual(['web-routes']);
    // v1 has no curation evidence, so every enriched field is re-derived and
    // nothing is promoted into curated_fields.
    expect(signIn).toEqual(
      findNode(derivedRoutes().trees[0]!.nodes, '/auth/signin'),
    );
    expect(signIn.label).toBe('Sign in');
    expect(signIn.curated_fields).toEqual([]);
    expect(signIn.tags).toEqual([]);
    expect('platform' in signIn).toBe(false);
  });

  it('converts a curated navigation tree and moves its dok_ref into the derived destination', () => {
    const file = expectOk(migrate(v1File([curatedNavTree('manual')])));
    const nav = treeById(file, 'web-main-nav');

    expect(nav).toEqual({
      tree_id: 'web-main-nav',
      type: 'navigation',
      source: 'manual',
      platform: 'all',
      nodes: [{
        kind: 'group',
        label: 'Account',
        curated_fields: [],
        tags: ['curated'],
        children: [{
          path: '/auth/signin',
          kind: 'destination',
          label: 'Sign in entry',
          curated_fields: [],
          bindings: [],
          tags: [],
          children: [],
        }],
      }],
    });
    // A placement carries a label, never bindings or producer evidence.
    const group = nav.nodes[0]!;
    expect('bindings' in group).toBe(false);
    expect('evidence' in group).toBe(false);
    expect('evidence' in group.children[0]!).toBe(false);

    expect(destinationAt(treeById(file, 'web-routes'), '/auth/signin').bindings).toEqual([
      { dok_ref: 'AUTH-SIGNIN', source: 'auto' },
      { dok_ref: 'BOOKMARK', source: 'manual' },
    ]);
  });

  it('keeps a single auto binding when a curated placement repeats a derived dok_ref', () => {
    const v1 = v1File([{
      tree_id: 'web-main-nav',
      type: 'navigation',
      platform: 'all',
      source: 'manual',
      nodes: [{
        path: '/auth/signin',
        label: 'Sign in entry',
        dok_ref: 'AUTH-SIGNIN',
        children: [],
      }],
    }]);

    const file = expectOk(migrate(v1));

    expect(destinationAt(treeById(file, 'web-routes'), '/auth/signin').bindings).toEqual([
      { dok_ref: 'AUTH-SIGNIN', source: 'auto' },
    ]);
  });

  it('converts a feature_group tree into a curated organization tree', () => {
    const v1 = v1File([{
      tree_id: 'web-areas',
      type: 'feature_group',
      platform: 'all',
      source: 'manual',
      nodes: [{
        label: 'Growth',
        children: [{
          path: '/auth/signin',
          label: 'Sign in entry',
          dok_ref: 'BOOKMARK',
          children: [],
        }],
      }],
    }]);

    const file = expectOk(migrate(v1));

    expect(treeById(file, 'web-areas')).toMatchObject({
      type: 'organization',
      source: 'manual',
    });
    expect(destinationAt(treeById(file, 'web-routes'), '/auth/signin').bindings).toContainEqual({
      dok_ref: 'BOOKMARK',
      source: 'manual',
    });
  });

  it.each(['manual', 'auto+manual'] as const)(
    'accepts a v1 tree with source %s and never emits auto+manual',
    (source) => {
      const file = expectOk(migrate(v1File([curatedNavTree(source)])));

      expect(treeById(file, 'web-main-nav').source).toBe('manual');
      expect(file.trees.every((tree) => tree.source === 'auto' || tree.source === 'manual'))
        .toBe(true);
    },
  );

  it('appends the derived route hierarchy last when no producer-owned tree exists', () => {
    const file = expectOk(migrate(v1File([curatedNavTree('manual')])));

    expect(file.trees.map((tree) => tree.tree_id)).toEqual(['web-main-nav', 'web-routes']);
  });

  it('inserts the derived route hierarchy where the first producer-owned tree was', () => {
    const v1 = v1File([
      curatedNavTree('manual'),
      legacyFlatNavTree(),
      {
        tree_id: 'web-areas',
        type: 'feature_group',
        platform: 'all',
        source: 'manual',
        nodes: [],
      },
    ]);

    const file = expectOk(migrate(v1));

    expect(file.trees.map((tree) => tree.tree_id)).toEqual([
      'web-main-nav',
      'web-routes',
      'web-areas',
    ]);
  });

  it('R9 renames the derived route hierarchy when a curated tree holds the canonical id', () => {
    const v1 = v1File([{ ...curatedNavTree('manual'), tree_id: 'web-routes' }]);

    const file = expectOk(migrate(v1));

    expect(file.trees.map((tree) => tree.tree_id)).toEqual([
      'web-routes',
      'web-generated-routes',
    ]);
    expect(treeById(file, 'web-routes').type).toBe('navigation');
    expect(treeById(file, 'web-generated-routes')).toMatchObject({
      type: 'route_hierarchy',
      source: 'auto',
    });
    // The moved binding still lands on the derived destination, renamed or not.
    expect(destinationAt(treeById(file, 'web-generated-routes'), '/auth/signin').bindings)
      .toContainEqual({ dok_ref: 'BOOKMARK', source: 'manual' });
  });

  it('R9 fails closed when curated trees hold both the canonical and fallback ids', () => {
    const v1 = v1File([
      { ...curatedNavTree('manual'), tree_id: 'web-routes' },
      {
        tree_id: 'web-generated-routes',
        type: 'feature_group',
        platform: 'all',
        source: 'manual',
        nodes: [],
      },
    ]);

    expect(expectFailures(migrate(v1))).toEqual([{
      tree_id: 'web-routes',
      reason: 'route_tree_id_conflict',
      guidance:
        'both the canonical and fallback route tree ids are taken by curated trees; rename one',
    }]);
  });

  it('throws when the derived file is not exactly one automatic route hierarchy', () => {
    const derived = IaFileV2Schema.parse({ service_id: 'web', version: 2, trees: [] });

    expect(() => migrateIaV1ToV2({
      v1: v1File([]),
      derived,
      availableDokIds: AVAILABLE_DOK_IDS,
    })).toThrow(/exactly one/i);
  });

  it('throws when the derived route hierarchy belongs to another service', () => {
    const derived = IaFileV2Schema.parse({ ...derivedRoutes(), service_id: 'admin' });

    expect(() => migrateIaV1ToV2({
      v1: v1File([]),
      derived,
      availableDokIds: AVAILABLE_DOK_IDS,
    })).toThrow(/admin/);
  });
});

describe('migrateIaV1ToV2 — fail-closed cases', () => {
  it('FC1 reports a pathless node that still carries a dok_ref', () => {
    const v1 = v1File([{
      tree_id: 'web-main-nav',
      type: 'navigation',
      platform: 'all',
      source: 'manual',
      nodes: [{ label: 'Saved items', dok_ref: 'BOOKMARK', children: [] }],
    }]);

    expect(expectFailures(migrate(v1))).toEqual([{
      tree_id: 'web-main-nav',
      node_label: 'Saved items',
      reason: 'pathless_dok_ref',
      guidance: 'assign a path or move the binding manually',
    }]);
  });

  it('FC1 reports a pathless node whose label is a term ref', () => {
    const v1 = v1File([{
      tree_id: 'web-main-nav',
      type: 'navigation',
      platform: 'all',
      source: 'manual',
      nodes: [{
        label: { term_ref: 'TERM-SAVED-ITEMS' },
        dok_ref: 'BOOKMARK',
        children: [],
      }],
    }]);

    expect(expectFailures(migrate(v1))).toEqual([{
      tree_id: 'web-main-nav',
      node_label: 'TERM-SAVED-ITEMS',
      reason: 'pathless_dok_ref',
      guidance: 'assign a path or move the binding manually',
    }]);
  });

  it('FC2 reports a dok_ref whose path is not a derived route destination', () => {
    const v1 = v1File([{
      tree_id: 'web-main-nav',
      type: 'navigation',
      platform: 'all',
      source: 'manual',
      // "/auth" exists in the derived tree, but only as a synthetic prefix group.
      nodes: [{ path: '/auth', label: 'Auth area', dok_ref: 'BOOKMARK', children: [] }],
    }]);

    expect(expectFailures(migrate(v1))).toEqual([{
      tree_id: 'web-main-nav',
      node_path: '/auth',
      reason: 'unmatched_path_dok_ref',
      guidance: 'path is not a route destination; fix the route or remove dok_ref',
    }]);
  });

  it.each(['manual', 'auto+manual', 'auto'] as const)(
    'FC3 reports a sitemap tree with source %s that no producer owns',
    (source) => {
      const v1 = v1File([{
        tree_id: 'web-legacy-map',
        type: 'sitemap',
        platform: 'all',
        source,
        nodes: [{ path: '/auth/signin', label: 'Sign in', children: [] }],
      }]);

      expect(expectFailures(migrate(v1))).toEqual([{
        tree_id: 'web-legacy-map',
        reason: 'ambiguous_sitemap',
        guidance: 'reclassify this tree as organization or navigation',
      }]);
    },
  );

  it('FC4 reports a destination that would keep more than one provenance for a Dok', () => {
    // IaFileV2Schema rejects duplicate dok_refs, so only a producer regression can
    // reach the post-condition — hand-build the tree to exercise the guard.
    const derived: IaFileV2 = {
      service_id: 'web',
      version: 2,
      trees: [{
        tree_id: 'web-routes',
        type: 'route_hierarchy',
        source: 'auto',
        producer: 'doklo-route-hierarchy@1',
        platform: 'all',
        nodes: [{
          path: '/auth/signin',
          kind: 'destination',
          label: 'Sign in',
          curated_fields: [],
          bindings: [
            { dok_ref: 'AUTH-SIGNIN', source: 'auto' },
            { dok_ref: 'AUTH-SIGNIN', source: 'manual' },
          ],
          evidence: [{ kind: 'route_source', file: 'app/auth/signin/page.tsx' }],
          tags: [],
          children: [],
        }],
      }],
    };

    expect(expectFailures(migrate(v1File([]), { derived }))).toEqual([{
      tree_id: 'web-routes',
      node_path: '/auth/signin',
      reason: 'conflicting_binding',
      guidance: 'conflicting bindings for the same path; resolve manually',
    }]);
  });

  it('FC5 reports a dok_ref with no Dok file', () => {
    const v1 = v1File([{
      tree_id: 'web-main-nav',
      type: 'navigation',
      platform: 'all',
      source: 'manual',
      nodes: [{
        path: '/auth/signin',
        label: 'Sign in entry',
        dok_ref: 'GHOST',
        children: [],
      }],
    }]);

    expect(expectFailures(migrate(v1))).toEqual([{
      tree_id: 'web-main-nav',
      node_path: '/auth/signin',
      reason: 'dangling_dok_ref',
      guidance: 'remove dok_ref or restore the missing Dok file',
    }]);
  });

  it('FC6 reports non-empty edges against the <file> sentinel tree id', () => {
    const v1 = v1File(
      [curatedNavTree('manual')],
      [{ from: 'AUTH-SIGNIN', to: 'BOOKMARK', type: 'navigates_to' }],
    );

    expect(expectFailures(migrate(v1))).toEqual([{
      tree_id: '<file>',
      reason: 'nonempty_edges',
      guidance: 'edges are retired in v2; back up manually then remove',
    }]);
  });

  it('reports an auto navigation tree that no producer owns', () => {
    const v1 = v1File([{
      tree_id: 'web-main-nav',
      type: 'navigation',
      platform: 'all',
      source: 'auto',
      nodes: [{
        label: 'Account',
        children: [{ path: '/auth/signin', label: 'Sign in', children: [] }],
      }],
    }]);

    expect(expectFailures(migrate(v1))).toEqual([{
      tree_id: 'web-main-nav',
      reason: 'ambiguous_auto_navigation',
      guidance:
        'source says auto but no producer owns this tree; set source to manual or remove it',
    }]);
  });

  it('collects every failure in one result instead of stopping at the first', () => {
    const v1 = v1File(
      [
        {
          tree_id: 'web-legacy-map',
          type: 'sitemap',
          platform: 'all',
          source: 'manual',
          nodes: [],
        },
        {
          tree_id: 'web-main-nav',
          type: 'navigation',
          platform: 'all',
          source: 'manual',
          nodes: [
            { label: 'Saved items', dok_ref: 'BOOKMARK', children: [] },
            { path: '/missing', label: 'Missing', dok_ref: 'BOOKMARK', children: [] },
          ],
        },
      ],
      [{ from: 'AUTH-SIGNIN', to: 'BOOKMARK', type: 'navigates_to' }],
    );

    expect(expectFailures(migrate(v1)).map(
      (failure) => `${failure.tree_id}:${failure.reason}`,
    )).toEqual([
      'web-legacy-map:ambiguous_sitemap',
      'web-main-nav:pathless_dok_ref',
      'web-main-nav:unmatched_path_dok_ref',
      '<file>:nonempty_edges',
    ]);
  });
});
