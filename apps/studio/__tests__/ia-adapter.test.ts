import { describe, expect, it } from 'vitest';
import type {
  IaNodeV1,
  IaNodeV2,
  IaTreeV1,
  IaTreeV2,
  LexiconTerm,
} from '@doklo-beta/core';
import {
  countIaPageNodes,
  iaFilesToTrees,
  type StudioIaDocument,
} from '../lib/ia-adapter';
import { splitSegment } from '../lib/ia-route';

function fileWith(
  serviceId: string,
  treeId: string,
  type: IaTreeV1['type'],
  nodes: IaNodeV1[],
  platform: IaTreeV1['platform'] = 'all',
): StudioIaDocument {
  return {
    version: 1,
    file: {
      service_id: serviceId,
      version: 1,
      trees: [{
        tree_id: treeId,
        type,
        platform,
        source: type === 'sitemap' ? 'auto' : 'manual',
        nodes,
      }],
      edges: [],
    },
  };
}

function v2FileWith(
  serviceId: string,
  treeId: string,
  type: IaTreeV2['type'],
  nodes: IaNodeV2[],
  platform: IaTreeV2['platform'] = 'all',
): StudioIaDocument {
  const source = type === 'route_hierarchy' ? 'auto' : 'manual';
  return {
    version: 2,
    file: {
      service_id: serviceId,
      version: 2,
      trees: [{
        tree_id: treeId,
        type,
        platform,
        source,
        ...(source === 'auto' ? { producer: 'doklo-route-hierarchy@1' } : {}),
        nodes,
      }],
    },
  };
}

describe('iaFilesToTrees', () => {
  it('preserves workspace, tree, and pathless hierarchy identity', () => {
    const trees = iaFilesToTrees({
      web: fileWith('web', 'web-sitemap', 'sitemap', [{
        label: 'Group',
        children: [
          { path: '/a', label: 'A', dok_ref: 'AUTH-SIGNIN', children: [] },
        ],
      }]),
      admin: fileWith('admin', 'admin-nav', 'navigation', [{
        path: '/a',
        label: 'Admin A',
        children: [],
      }]),
    });

    expect(trees.map((tree) => ({
      serviceId: tree.serviceId,
      treeId: tree.treeId,
      type: tree.type,
    }))).toEqual([
      { serviceId: 'web', treeId: 'web-sitemap', type: 'sitemap' },
      { serviceId: 'admin', treeId: 'admin-nav', type: 'navigation' },
    ]);
    expect(trees[0]!.nodes[0]).toMatchObject({
      title: 'Group',
      path: undefined,
    });
    expect(trees[0]!.nodes[0]!.children[0]?.path).toBe('/a');
    expect(trees[0]!.nodes[0]!.key).not.toBe(trees[1]!.nodes[0]!.key);
    expect(trees[0]!.nodes[0]!.children[0]!.key).not.toBe(
      trees[1]!.nodes[0]!.key,
    );
    expect(countIaPageNodes(trees)).toBe(2);
  });

  it('creates deterministic unique keys for same-label pathless siblings', () => {
    const files = {
      web: fileWith('web', 'web-nav', 'navigation', [
        { label: 'Account Settings', children: [] },
        { label: 'Account settings', children: [] },
        { label: '!!!', children: [] },
        { label: '???', children: [] },
      ]),
    };

    const first = iaFilesToTrees(files);
    const second = iaFilesToTrees(files);
    const keys = first[0]!.nodes.map((node) => node.key);

    expect(keys).toEqual([
      'web::web-nav/group%3Aaccount-settings%231',
      'web::web-nav/group%3Aaccount-settings%232',
      'web::web-nav/group%3Agroup%231',
      'web::web-nav/group%3Agroup%232',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(second[0]!.nodes.map((node) => node.key)).toEqual(keys);
  });

  it('keeps route paths and pathless groups in separate identity namespaces', () => {
    const trees = iaFilesToTrees({
      web: fileWith('web', 'web-nav', 'navigation', [
        { path: '@group#1', label: 'Group', children: [] },
        { label: 'Group', children: [] },
      ]),
    });
    const keys = trees[0]!.nodes.map((node) => node.key);

    expect(keys).toEqual([
      'web::web-nav/path%3A%40group%231',
      'web::web-nav/group%3Agroup%231',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves TermRef labels and inherits or narrows platform reach', () => {
    const lexicon = [
      {
        term_id: 'TERM-NAV-HOME',
        category: 'concept',
        binding: { type: 'owned' },
        locales: { en: 'Home', ko: '홈' },
        related_doks: [],
      },
    ] as unknown as LexiconTerm[];
    const trees = iaFilesToTrees(
      {
        web: fileWith(
          'web',
          'web-sitemap',
          'sitemap',
          [
            {
              path: '/home',
              label: { term_ref: 'TERM-NAV-HOME' },
              children: [
                {
                  path: '/home/mobile',
                  label: { term_ref: 'TERM-GONE' },
                  platform: 'mobile',
                  children: [
                    {
                      path: '/home/mobile/details',
                      label: 'Details',
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
          'desktop',
        ),
      },
      lexicon,
    );

    expect(trees[0]).toMatchObject({ platform: 'desktop-only' });
    expect(trees[0]!.nodes[0]).toMatchObject({
      title: 'Home',
      platform: 'desktop-only',
    });
    expect(trees[0]!.nodes[0]!.children[0]).toMatchObject({
      title: '{TERM-GONE}',
      platform: 'mobile-only',
    });
    expect(
      trees[0]!.nodes[0]!.children[0]!.children[0],
    ).toMatchObject({ platform: 'mobile-only' });
  });

  it('counts mapped and unmapped pages but not pathless or null containers', () => {
    const trees = iaFilesToTrees({
      web: fileWith('web', 'web-sitemap', 'sitemap', [{
        label: 'Pathless',
        children: [
          {
            path: '/container',
            label: 'Container',
            dok_ref: null,
            children: [
              {
                path: '/container/mapped',
                label: 'Mapped',
                dok_ref: 'AUTH-SIGNIN',
                children: [],
              },
              {
                path: '/container/unmapped',
                label: 'Unmapped',
                children: [],
              },
            ],
          },
        ],
      }]),
    });

    expect(countIaPageNodes(trees)).toBe(2);
    expect(countIaPageNodes([])).toBe(0);
  });
});

describe('iaFilesToTrees — v2 documents', () => {
  const routeNodes: IaNodeV2[] = [{
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
        curated_fields: ['label'],
        bindings: [
          { dok_ref: 'AUTH-SIGNIN', source: 'auto' },
          { dok_ref: 'AUTH-SIGNUP', source: 'manual' },
        ],
        evidence: [{
          kind: 'route_source',
          file: 'app/auth/signin/page.tsx',
        }],
        tags: [],
        children: [],
      },
      {
        path: '/auth/unmapped',
        kind: 'destination',
        label: 'Unmapped',
        curated_fields: [],
        bindings: [],
        evidence: [{
          kind: 'route_source',
          file: 'app/auth/unmapped/page.tsx',
        }],
        tags: [],
        children: [],
      },
    ],
  }];

  it('converts bindings, evidence, and curated fields on the v2 path', () => {
    const trees = iaFilesToTrees({
      web: v2FileWith('web', 'web-routes', 'route_hierarchy', routeNodes),
    });
    const group = trees[0]!.nodes[0]!;
    const [signin, unmapped] = group.children;

    expect(trees[0]).toMatchObject({
      serviceId: 'web',
      treeId: 'web-routes',
      type: 'route_hierarchy',
      source: 'auto',
    });
    expect(group).toMatchObject({
      kind: 'group',
      path: '/auth',
      dok_ref: null,
      unmapped: false,
      curatedFields: [],
    });
    expect(group.bindings).toBeUndefined();
    expect(signin).toMatchObject({
      kind: 'destination',
      path: '/auth/signin',
      title: 'Sign in',
      unmapped: false,
      curatedFields: ['label'],
      bindings: [
        { dokRef: 'AUTH-SIGNIN', source: 'auto' },
        { dokRef: 'AUTH-SIGNUP', source: 'manual' },
      ],
      evidence: [{ file: 'app/auth/signin/page.tsx' }],
    });
    expect(signin!.dok_ref).toBeUndefined();
    expect(unmapped).toMatchObject({
      kind: 'destination',
      unmapped: true,
      bindings: [],
    });
  });

  it('counts v2 destinations as pages and never counts groups', () => {
    const trees = iaFilesToTrees({
      web: v2FileWith('web', 'web-routes', 'route_hierarchy', routeNodes),
    });

    expect(countIaPageNodes(trees)).toBe(2);
  });

  it('renders a curated v2 placement without inventing evidence or bindings', () => {
    const trees = iaFilesToTrees({
      web: v2FileWith('web', 'web-nav', 'navigation', [{
        kind: 'group',
        label: 'Primary menu',
        curated_fields: ['label'],
        tags: [],
        children: [{
          path: '/auth/signin',
          kind: 'destination',
          label: 'Sign in entry',
          curated_fields: [],
          bindings: [],
          tags: [],
          children: [],
        }],
      }]),
    });
    const placement = trees[0]!.nodes[0]!.children[0]!;

    expect(trees[0]).toMatchObject({ type: 'navigation', source: 'manual' });
    expect(placement).toMatchObject({
      kind: 'destination',
      path: '/auth/signin',
      bindings: [],
      unmapped: true,
    });
    expect(placement.evidence).toBeUndefined();
  });

  it('keeps v1 and v2 documents independent inside one catalog', () => {
    const trees = iaFilesToTrees({
      web: v2FileWith('web', 'web-routes', 'route_hierarchy', routeNodes),
      admin: fileWith('admin', 'admin-nav', 'navigation', [{
        path: '/a',
        label: 'Admin A',
        dok_ref: 'ADMIN',
        children: [],
      }]),
    });
    const legacy = trees[1]!.nodes[0]!;

    expect(trees.map((tree) => tree.type)).toEqual([
      'route_hierarchy',
      'navigation',
    ]);
    expect(legacy.kind).toBeUndefined();
    expect(legacy.bindings).toBeUndefined();
    expect(legacy.dok_ref).toBe('ADMIN');
    expect(countIaPageNodes(trees)).toBe(3);
  });

  it('resolves v2 TermRef labels and narrows inherited platform', () => {
    const lexicon = [
      {
        term_id: 'TERM-NAV-HOME',
        category: 'concept',
        binding: { type: 'owned' },
        locales: { en: 'Home', ko: '홈' },
        related_doks: [],
      },
    ] as unknown as LexiconTerm[];
    const trees = iaFilesToTrees(
      {
        web: v2FileWith(
          'web',
          'web-routes',
          'route_hierarchy',
          [{
            path: '/home',
            kind: 'destination',
            label: { term_ref: 'TERM-NAV-HOME' },
            curated_fields: [],
            bindings: [],
            evidence: [{ kind: 'route_source', file: 'app/home/page.tsx' }],
            platform: 'mobile',
            tags: [],
            children: [],
          }],
          'desktop',
        ),
      },
      lexicon,
    );

    expect(trees[0]).toMatchObject({ platform: 'desktop-only' });
    expect(trees[0]!.nodes[0]).toMatchObject({
      title: 'Home',
      platform: 'mobile-only',
    });
  });
});

describe('splitSegment', () => {
  it.each([
    [':token', 'token'],
    ['[id]', 'id'],
    ['[...slug]', 'slug'],
    ['[[...slug]]', 'slug'],
  ])('recognizes %s as a dynamic segment', (segment, text) => {
    expect(splitSegment(segment)).toEqual([{ text, dynamic: true }]);
  });

  it('keeps a static segment static', () => {
    expect(splitSegment('account-settings')).toEqual([
      { text: 'account-settings', dynamic: false },
    ]);
  });
});
