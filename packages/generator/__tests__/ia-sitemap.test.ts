import { describe, expect, it } from 'vitest';
import { IaTreeV2Schema, type IaNodeV2, type ProjectIR } from '@doklo-beta/core';
import {
  assertSitemapCoverage,
  buildSitemapNodes,
  ROUTE_HIERARCHY_PRODUCER,
  routeTreeIds,
  SitemapCoverageError,
  type SitemapPresentation,
} from '../src/ia-sitemap.js';

function page(
  path: string,
  file: string,
  layoutChain: string[] = [],
): ProjectIR['routes'][number] {
  return {
    path,
    kind: 'page',
    file,
    dynamic_params: [],
    layout_chain: layoutChain,
  };
}

function find(nodes: readonly IaNodeV2[], path: string): IaNodeV2 | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const nested = find(node.children, path);
    if (nested) return nested;
  }
  return undefined;
}

function destinationPaths(nodes: readonly IaNodeV2[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.kind === 'destination' ? [node.path] : []),
    ...destinationPaths(node.children),
  ]);
}

describe('buildSitemapNodes', () => {
  it('builds synthetic prefixes and keeps a routable parent with children', () => {
    const routes = [
      page('/auth/signin', 'app/auth/signin/page.tsx'),
      page('/auth/term', 'app/auth/term/page.tsx'),
      page('/auth/recover-pw', 'app/auth/recover-pw/page.tsx'),
      page('/auth/recover-pw/:token', 'app/auth/recover-pw/[token]/page.tsx'),
    ];
    const presentation = new Map<string, SitemapPresentation>([
      ['/auth/signin', { featureLabel: '로그인', dokRef: 'AUTH-SIGNIN' }],
      ['/auth/recover-pw', { featureLabel: '비밀번호 찾기', dokRef: 'AUTH-RECOVER' }],
      ['/auth/recover-pw/:token', { featureLabel: '비밀번호 재설정', dokRef: 'AUTH-RESET' }],
    ]);

    const nodes = buildSitemapNodes(routes, presentation);
    expect(nodes).toHaveLength(1);
    expect(find(nodes, '/auth')).toMatchObject({ label: 'Auth', kind: 'group' });
    expect(find(nodes, '/auth/recover-pw')).toMatchObject({
      label: '비밀번호 찾기',
      kind: 'destination',
      bindings: [{ dok_ref: 'AUTH-RECOVER', source: 'auto' }],
    });
    expect(find(nodes, '/auth/recover-pw')?.children.map((node) => node.path)).toEqual([
      '/auth/recover-pw/:token',
    ]);
    expect(find(nodes, '/auth/recover-pw/:token')?.label).toBe('비밀번호 재설정');
    assertSitemapCoverage(routes, nodes);
  });

  it('emits a group without binding or evidence keys and a destination with both', () => {
    const routes = [page('/auth/signin', 'app/auth/signin/page.tsx')];
    const presentation = new Map<string, SitemapPresentation>([
      ['/auth/signin', { dokRef: 'AUTH-SIGNIN' }],
    ]);

    const nodes = buildSitemapNodes(routes, presentation);
    const group = find(nodes, '/auth')!;
    const destination = find(nodes, '/auth/signin')!;

    expect(group).toEqual({
      path: '/auth',
      kind: 'group',
      label: 'Auth',
      curated_fields: [],
      tags: [],
      children: [destination],
    });
    expect('bindings' in group).toBe(false);
    expect('evidence' in group).toBe(false);
    expect(destination).toEqual({
      path: '/auth/signin',
      kind: 'destination',
      label: 'Signin',
      curated_fields: [],
      bindings: [{ dok_ref: 'AUTH-SIGNIN', source: 'auto' }],
      evidence: [{ kind: 'route_source', file: 'app/auth/signin/page.tsx' }],
      tags: [],
      children: [],
    });
  });

  it('leaves an unmapped destination with no bindings but keeps its evidence', () => {
    const routes = [page('/labs/test', './app/labs/test/page.tsx')];

    const nodes = buildSitemapNodes(routes, new Map());

    expect(find(nodes, '/labs/test')).toMatchObject({
      kind: 'destination',
      bindings: [],
      evidence: [{ kind: 'route_source', file: 'app/labs/test/page.tsx' }],
    });
  });

  it('records the canonical route file as evidence when a path has duplicates', () => {
    const routes = [
      page('/users/:id', 'legacy/users/[id]/page.tsx'),
      page('/users/:id', 'app/users/[id]/page.tsx', ['app/layout.tsx']),
    ];

    const nodes = buildSitemapNodes(routes, new Map());

    expect(find(nodes, '/users/:id')).toMatchObject({
      evidence: [{ kind: 'route_source', file: 'app/users/[id]/page.tsx' }],
    });
  });

  it('produces nodes a route_hierarchy tree accepts', () => {
    const routes = [
      page('/', 'app/page.tsx'),
      page('/auth/signin', 'app/auth/signin/page.tsx'),
    ];

    const tree = IaTreeV2Schema.parse({
      tree_id: routeTreeIds('web').canonical,
      type: 'route_hierarchy',
      source: 'auto',
      producer: ROUTE_HIERARCHY_PRODUCER,
      platform: 'all',
      nodes: buildSitemapNodes(routes, new Map()),
    });

    expect(tree.tree_id).toBe('web-routes');
    expect(routeTreeIds('web').fallback).toBe('web-generated-routes');
  });

  it('dedupes paths, prefers richer layout evidence, and orders static before dynamic', () => {
    const routes = [
      page('/users/:id', 'app/users/[id]/page.tsx', ['app/layout.tsx']),
      page('/users/settings', 'app/users/settings/page.tsx', ['app/layout.tsx']),
      page('/users/:id', 'legacy/users/[id]/page.tsx'),
    ];
    const nodes = buildSitemapNodes(routes, new Map());
    expect(find(nodes, '/users')?.children.map((node) => node.path)).toEqual([
      '/users/settings',
      '/users/:id',
    ]);
    expect(find(nodes, '/users/:id')?.label).toBe('Users details');
    assertSitemapCoverage(routes, nodes);
  });

  it('ignores a raw dynamic feature label and uses a normal Dok name', () => {
    const routes = [
      page('/users/:id', 'app/users/[id]/page.tsx'),
    ];
    const presentation = new Map<string, SitemapPresentation>([
      ['/users/:id', { featureLabel: ':id', dokName: 'User profile' }],
    ]);

    const nodes = buildSitemapNodes(routes, presentation);

    expect(find(nodes, '/users/:id')?.label).toBe('User profile');
  });

  it('ignores a raw dynamic string Dok name and uses the contextual fallback', () => {
    const routes = [
      page('/users/:id', 'app/users/[id]/page.tsx'),
    ];
    const presentation = new Map<string, SitemapPresentation>([
      ['/users/:id', { dokName: '[id]' }],
    ]);

    const nodes = buildSitemapNodes(routes, presentation);

    expect(find(nodes, '/users/:id')?.label).toBe('Users details');
  });

  it('ignores adapter-emitted catch-all tokens in presentation labels', () => {
    const routes = [
      page('/docs/:...slug', 'app/docs/[...slug]/page.tsx'),
      page('/docs/:[...slug]', 'app/docs/[[...slug]]/page.tsx'),
    ];
    const presentation = new Map<string, SitemapPresentation>([
      ['/docs/:...slug', { featureLabel: ':...slug' }],
      ['/docs/:[...slug]', { dokName: ':[...slug]' }],
    ]);

    const nodes = buildSitemapNodes(routes, presentation);

    expect(find(nodes, '/docs/:...slug')?.label).toBe('Docs details');
    expect(find(nodes, '/docs/:[...slug]')?.label).toBe('Docs details');
  });

  it('orders adapter-emitted catch-all forms after a single dynamic segment', () => {
    const routes = [
      page('/docs/:...slug', 'app/docs/[...slug]/page.tsx'),
      page('/docs/:[...slug]', 'app/docs/[[...slug]]/page.tsx'),
      page('/docs/:id', 'app/docs/[id]/page.tsx'),
    ];

    const nodes = buildSitemapNodes(routes, new Map());

    expect(find(nodes, '/docs')?.children.map((node) => node.path)).toEqual([
      '/docs/:id',
      '/docs/:...slug',
      '/docs/:[...slug]',
    ]);
  });

  it('keeps root, error, test, and all 62 page routes exactly once', () => {
    const routes = [
      page('/', 'app/page.tsx'),
      page('/auth/error', 'app/auth/error/page.tsx'),
      page('/labs/test', 'app/labs/test/page.tsx'),
      ...Array.from({ length: 59 }, (_, index) =>
        page(`/catalog/item-${index + 1}`, `app/catalog/item-${index + 1}/page.tsx`)),
    ];
    const nodes = buildSitemapNodes(routes, new Map());
    expect(destinationPaths(nodes)).toHaveLength(62);
    expect(new Set(destinationPaths(nodes))).toHaveLength(62);
    expect(find(nodes, '/')).toBeDefined();
    expect(find(nodes, '/auth/error')).toBeDefined();
    expect(find(nodes, '/labs/test')).toBeDefined();
    assertSitemapCoverage(routes, nodes);
  });
});

describe('assertSitemapCoverage', () => {
  it('counts destinations only and reports a page route with no destination', () => {
    const routes = [
      page('/auth/signin', 'app/auth/signin/page.tsx'),
      page('/auth/term', 'app/auth/term/page.tsx'),
    ];
    const nodes = buildSitemapNodes([routes[0]!], new Map());

    expect(() => assertSitemapCoverage(routes, nodes)).toThrow(SitemapCoverageError);
    expect(() => assertSitemapCoverage(routes, nodes)).toThrow(/\/auth\/term/);
  });

  it('rejects a duplicated destination and an unexpected one', () => {
    const routes = [page('/auth/signin', 'app/auth/signin/page.tsx')];
    const nodes = buildSitemapNodes(routes, new Map());
    const duplicated = [...nodes, ...structuredClone(nodes)];

    expect(() => assertSitemapCoverage(routes, duplicated)).toThrow(/duplicate/);

    const unexpected = buildSitemapNodes(
      [...routes, page('/ghost', 'app/ghost/page.tsx')],
      new Map(),
    );
    expect(() => assertSitemapCoverage(routes, unexpected)).toThrow(/unexpected/);
  });
});
