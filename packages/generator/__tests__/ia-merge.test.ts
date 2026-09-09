import { describe, expect, it } from 'vitest';
import {
  IaFileV2Schema,
  type IaBinding,
  type IaDestinationNodeV2,
  type IaFileV2,
  type IaNodeV2,
} from '@doklo-beta/core';
import { ROUTE_HIERARCHY_PRODUCER } from '../src/ia-sitemap.js';
import { mergeDerivedIA } from '../src/ia-merge.js';

const OLD_TIME = '2026-07-15T00:00:00.000Z';
const NOW = '2026-07-16T00:00:00.000Z';

function fileWithTrees(trees: unknown[]): IaFileV2 {
  return IaFileV2Schema.parse({
    service_id: 'web',
    version: 2,
    trees,
    updated_at: OLD_TIME,
  });
}

function find(nodes: readonly IaNodeV2[], path: string): IaNodeV2 | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = find(node.children, path);
    if (child) return child;
  }
  return undefined;
}

function destinationAt(file: IaFileV2, treeId: string, path: string): IaDestinationNodeV2 {
  const tree = file.trees.find((candidate) => candidate.tree_id === treeId);
  const node = tree === undefined ? undefined : find(tree.nodes, path);
  if (node === undefined || node.kind !== 'destination') {
    throw new Error(`no destination at ${treeId}${path}`);
  }
  return node;
}

/**
 * The producer's output: /auth is a synthetic prefix group, /auth/signin is a
 * mapped destination, /auth/[token] is an unmapped one.
 */
function derivedRoutes(): IaFileV2 {
  return IaFileV2Schema.parse({
    service_id: 'web',
    version: 2,
    trees: [{
      tree_id: 'web-routes',
      type: 'route_hierarchy',
      source: 'auto',
      producer: ROUTE_HIERARCHY_PRODUCER,
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
            label: '로그인',
            curated_fields: [],
            bindings: [{ dok_ref: 'AUTH-SIGNIN', source: 'auto' }],
            evidence: [{ kind: 'route_source', file: 'app/auth/signin/page.tsx' }],
            tags: [],
            children: [],
          },
          {
            path: '/auth/[token]',
            kind: 'destination',
            label: 'Auth details',
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

/** A previous run's output, ready to be given curated markers by a test. */
function ownedTree(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(derivedRoutes().trees[0]! as unknown as Record<string, unknown>),
    ...overrides,
  };
}

function curatedTree(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

describe('mergeDerivedIA — tree ownership', () => {
  it('replaces the tree it owns instead of appending a second route hierarchy', () => {
    const existing = fileWithTrees([ownedTree({
      nodes: [{
        path: '/gone',
        kind: 'destination',
        label: 'Gone',
        curated_fields: [],
        bindings: [{ dok_ref: 'GONE', source: 'auto' }],
        evidence: [{ kind: 'route_source', file: 'app/gone/page.tsx' }],
        tags: [],
        children: [],
      }],
    })]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(result.changed).toBe(true);
    expect(result.file.trees.map((tree) => tree.tree_id)).toEqual(['web-routes']);
    expect(find(result.file.trees[0]!.nodes, '/gone')).toBeUndefined();
    expect(result.file.updated_at).toBe(NOW);
  });

  it.each([
    { name: 'a curated navigation', tree: curatedTree() },
    { name: 'a curated organization', tree: curatedTree({ tree_id: 'web-areas', type: 'organization' }) },
  ])('preserves $name tree byte-identically and adds the route hierarchy', ({ tree }) => {
    const existing = fileWithTrees([tree]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(result.file.trees[0]).toEqual(existing.trees[0]);
    expect(result.file.trees[1]?.tree_id).toBe('web-routes');
  });

  it.each([
    {
      name: 'a foreign producer',
      tree: ownedTree({ tree_id: 'web-routes', producer: 'someone-elses-producer@2' }),
    },
    {
      name: 'an unclaimed tree id',
      tree: ownedTree({ tree_id: 'web-legacy-routes' }),
    },
  ])('never replaces an auto route hierarchy with $name', ({ tree }) => {
    const existing = fileWithTrees([tree]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(result.file.trees[0]).toEqual(existing.trees[0]);
    expect(result.file.trees).toHaveLength(2);
  });

  it('keeps preserved trees in order and inserts at the first replaced position', () => {
    const existing = fileWithTrees([
      curatedTree(),
      ownedTree({ tree_id: 'web-generated-routes' }),
      curatedTree({ tree_id: 'web-areas', type: 'organization' }),
    ]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(result.file.trees.map((tree) => tree.tree_id)).toEqual([
      'web-main-nav',
      'web-routes',
      'web-areas',
    ]);
  });
});

describe('mergeDerivedIA — R9 route tree identity', () => {
  it('R9 claims the canonical id when nothing holds it', () => {
    const result = mergeDerivedIA(fileWithTrees([curatedTree()]), derivedRoutes(), NOW);

    expect(result.file.trees.map((tree) => tree.tree_id)).toEqual([
      'web-main-nav',
      'web-routes',
    ]);
  });

  it('R9 falls back to the generated id when a curated tree holds the canonical one', () => {
    const existing = fileWithTrees([curatedTree({ tree_id: 'web-routes' })]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(result.file.trees.map((tree) => tree.tree_id)).toEqual([
      'web-routes',
      'web-generated-routes',
    ]);
    expect(result.file.trees[0]).toEqual(existing.trees[0]);
  });

  it('R9 moves an owned fallback tree back onto the canonical id once it is free', () => {
    const existing = fileWithTrees([ownedTree({ tree_id: 'web-generated-routes' })]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(result.file.trees.map((tree) => tree.tree_id)).toEqual(['web-routes']);
  });

  it('R9 fails closed when both the canonical and fallback ids are preserved', () => {
    const existing = fileWithTrees([
      curatedTree({ tree_id: 'web-routes' }),
      curatedTree({ tree_id: 'web-generated-routes', type: 'organization' }),
    ]);

    expect(() => mergeDerivedIA(existing, derivedRoutes(), NOW))
      .toThrow(/canonical and fallback/i);
  });
});

describe('mergeDerivedIA — R6 curated fields', () => {
  it('R6 keeps only the fields the previous node froze and re-derives the rest', () => {
    const existing = fileWithTrees([ownedTree({
      nodes: [{
        path: '/auth',
        kind: 'group',
        label: 'Curated auth area',
        curated_fields: ['label'],
        tags: ['stale-group-tag'],
        children: [{
          path: '/auth/signin',
          kind: 'destination',
          label: 'Curated sign in',
          curated_fields: ['label', 'tags'],
          bindings: [],
          evidence: [{ kind: 'route_source', file: 'stale/page.tsx' }],
          platform: 'mobile',
          tags: ['featured'],
          children: [{
            path: '/stale',
            kind: 'destination',
            label: 'Stale child',
            curated_fields: [],
            bindings: [],
            evidence: [{ kind: 'route_source', file: 'app/stale/page.tsx' }],
            tags: [],
            children: [],
          }],
        }, {
          // Same path as a derived node, but nothing is frozen on it.
          path: '/auth/[token]',
          kind: 'destination',
          label: 'Stale token label',
          curated_fields: [],
          bindings: [],
          evidence: [{ kind: 'route_source', file: 'app/auth/[token]/page.tsx' }],
          tags: ['stale-tag'],
          children: [],
        }],
      }],
    })]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);
    const group = find(result.file.trees[0]!.nodes, '/auth')!;
    const signIn = destinationAt(result.file, 'web-routes', '/auth/signin');

    // label was frozen; tags were not, so the derived (empty) value wins.
    expect(group).toMatchObject({ label: 'Curated auth area', curated_fields: ['label'], tags: [] });
    expect(signIn).toMatchObject({
      label: 'Curated sign in',
      curated_fields: ['label', 'tags'],
      tags: ['featured'],
    });
    // platform was never frozen, so the producer's absence of it wins.
    expect('platform' in signIn).toBe(false);
    // Evidence is producer-only: always the freshly derived anchor.
    expect(signIn.evidence).toEqual([
      { kind: 'route_source', file: 'app/auth/signin/page.tsx' },
    ]);
    // Structure is the producer's: a stale child does not survive.
    expect(find(result.file.trees[0]!.nodes, '/stale')).toBeUndefined();
    // Nothing frozen on this one, so both its label and its tags are re-derived.
    expect(find(result.file.trees[0]!.nodes, '/auth/[token]')).toMatchObject({
      label: 'Auth details',
      curated_fields: [],
      tags: [],
    });
  });

  it('R6 keeps a curated platform on the node that froze it', () => {
    const existing = fileWithTrees([ownedTree({
      nodes: [{
        path: '/auth',
        kind: 'group',
        label: 'Auth',
        curated_fields: ['platform'],
        platform: 'mobile',
        tags: [],
        children: [],
      }],
    })]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(find(result.file.trees[0]!.nodes, '/auth')).toMatchObject({
      platform: 'mobile',
      curated_fields: ['platform'],
    });
  });
});

describe('mergeDerivedIA — R4 binding provenance', () => {
  function mergedBindings(previous: IaBinding[]): IaBinding[] {
    const existing = fileWithTrees([ownedTree({
      nodes: [{
        path: '/auth/signin',
        kind: 'destination',
        label: 'Sign in',
        curated_fields: [],
        bindings: previous,
        evidence: [{ kind: 'route_source', file: 'app/auth/signin/page.tsx' }],
        tags: [],
        children: [],
      }],
    })]);

    return destinationAt(
      mergeDerivedIA(existing, derivedRoutes(), NOW).file,
      'web-routes',
      '/auth/signin',
    ).bindings;
  }

  it('R4 keeps manual claims the producer does not prove, in their previous order', () => {
    expect(mergedBindings([
      { dok_ref: 'ZED', source: 'manual' },
      { dok_ref: 'BOOKMARK', source: 'manual' },
    ])).toEqual([
      { dok_ref: 'AUTH-SIGNIN', source: 'auto' },
      { dok_ref: 'ZED', source: 'manual' },
      { dok_ref: 'BOOKMARK', source: 'manual' },
    ]);
  });

  it('R4 collapses a manual claim the producer now proves into the single auto entry', () => {
    expect(mergedBindings([{ dok_ref: 'AUTH-SIGNIN', source: 'manual' }])).toEqual([
      { dok_ref: 'AUTH-SIGNIN', source: 'auto' },
    ]);
  });

  it('R4 drops a previous auto binding the producer no longer derives', () => {
    expect(mergedBindings([
      { dok_ref: 'STALE', source: 'auto' },
      { dok_ref: 'BOOKMARK', source: 'manual' },
    ])).toEqual([
      { dok_ref: 'AUTH-SIGNIN', source: 'auto' },
      { dok_ref: 'BOOKMARK', source: 'manual' },
    ]);
  });

  it('R4 never moves bindings from a preserved curated placement', () => {
    const existing = fileWithTrees([curatedTree()]);

    const result = mergeDerivedIA(existing, derivedRoutes(), NOW);

    expect(destinationAt(result.file, 'web-routes', '/auth/[token]').bindings).toEqual([]);
    expect(result.file.trees[0]).toEqual(existing.trees[0]);
  });
});

describe('mergeDerivedIA — contract guards', () => {
  it('is a timestamp-stable semantic no-op on the second merge', () => {
    const first = mergeDerivedIA(null, derivedRoutes(), OLD_TIME);
    const second = mergeDerivedIA(first.file, derivedRoutes(), NOW);

    expect(second).toEqual({ file: first.file, changed: false });
    expect(second.file).toBe(first.file);
  });

  it('rejects a derived file that is not exactly one automatic route hierarchy', () => {
    const first = derivedRoutes().trees[0]!;
    const twoTrees = IaFileV2Schema.parse({
      ...derivedRoutes(),
      trees: [first, { ...first, tree_id: 'web-generated-routes' }],
    });

    expect(() => mergeDerivedIA(null, twoTrees, NOW)).toThrow(/exactly one/i);
  });

  it('rejects a derived route hierarchy signed by another producer', () => {
    const foreign = IaFileV2Schema.parse({
      ...derivedRoutes(),
      trees: [{ ...derivedRoutes().trees[0]!, producer: 'someone-elses-producer@2' }],
    });

    expect(() => mergeDerivedIA(null, foreign, NOW)).toThrow(/exactly one/i);
  });

  it('rejects an existing file that belongs to another service', () => {
    const other = IaFileV2Schema.parse({ service_id: 'admin', version: 2, trees: [] });

    expect(() => mergeDerivedIA(other, derivedRoutes(), NOW)).toThrow(/admin/);
  });

  it('strict-parses duplicate existing input before mutation', () => {
    const rawExisting = {
      service_id: 'web',
      version: 2,
      trees: [curatedTree(), curatedTree()],
      updated_at: OLD_TIME,
    };
    const before = structuredClone(rawExisting);

    expect(() => mergeDerivedIA(
      rawExisting as unknown as IaFileV2,
      derivedRoutes(),
      NOW,
    )).toThrow(/duplicate IA tree_id/);
    expect(rawExisting).toEqual(before);
  });

  it('strict-parses invalid derived input before mutation', () => {
    const existing = fileWithTrees([curatedTree()]);
    const before = structuredClone(existing);
    const rawDerived = { ...derivedRoutes(), unexpected: true };

    expect(() => mergeDerivedIA(
      existing,
      rawDerived as unknown as IaFileV2,
      NOW,
    )).toThrow();
    expect(existing).toEqual(before);
  });
});
