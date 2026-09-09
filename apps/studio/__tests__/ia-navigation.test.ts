import { describe, expect, it } from 'vitest';
import type { StudioIaNode, StudioIaTree } from '../lib/ia-route.js';
import {
  findIaNode,
  iaNodeMatches,
  iaStats,
  iaSubtreeMatches,
  resolveIaDeepLink,
  selectDefaultIaTree,
} from '../lib/ia-presentation.js';
import {
  hierarchicalTree,
  manualNavigationTree,
  routeHierarchyTree,
  treeFixture,
} from './helpers/ia-fixture.js';

function node(
  key: string,
  options: Partial<StudioIaNode> = {},
): StudioIaNode {
  return {
    key,
    path: `/${key}`,
    seg: key,
    title: key,
    platform: 'both',
    tags: [],
    unmapped: false,
    children: [],
    ...options,
  };
}

function tree(nodes: StudioIaNode[]): StudioIaTree {
  return {
    key: 'web::stats',
    serviceId: 'web',
    treeId: 'stats',
    type: 'sitemap',
    source: 'auto',
    platform: 'both',
    nodes,
  };
}

describe('selectDefaultIaTree', () => {
  it('selects the auto route hierarchy before any legacy structure', () => {
    const routes = routeHierarchyTree();
    const legacyAutoSitemap = treeFixture({
      key: 'web::legacy-map',
      type: 'sitemap',
      source: 'auto',
    });

    expect(
      selectDefaultIaTree([
        manualNavigationTree(),
        legacyAutoSitemap,
        routes,
      ])?.key,
    ).toBe(routes.key);
  });

  it('falls back to curated v2 structures when no route hierarchy exists', () => {
    const organization = treeFixture({
      key: 'web::areas',
      type: 'organization',
      source: 'manual',
    });
    const navigation = manualNavigationTree();

    expect(selectDefaultIaTree([organization, navigation])?.key).toBe(
      navigation.key,
    );
    expect(selectDefaultIaTree([organization])?.key).toBe('web::areas');
  });

  it('selects the first auto sitemap before navigation', () => {
    const navigation = treeFixture({
      key: 'web::nav',
      type: 'navigation',
      source: 'manual',
    });
    const manualSitemap = treeFixture({
      key: 'web::manual-map',
      type: 'sitemap',
      source: 'manual',
    });
    const firstSitemap = treeFixture({
      key: 'web::first-map',
      type: 'sitemap',
      source: 'auto',
    });
    const secondSitemap = treeFixture({
      key: 'web::second-map',
      type: 'sitemap',
      source: 'auto',
    });

    expect(
      selectDefaultIaTree([
        navigation,
        manualSitemap,
        firstSitemap,
        secondSitemap,
      ])?.key,
    ).toBe('web::first-map');
  });

  it('falls back by tree semantics when no auto sitemap exists', () => {
    const featureGroup = treeFixture({
      key: 'web::features',
      type: 'feature_group',
      source: 'manual',
    });
    const navigation = treeFixture({
      key: 'web::nav',
      type: 'navigation',
      source: 'manual',
    });
    const manualSitemap = treeFixture({
      key: 'web::map',
      type: 'sitemap',
      source: 'manual',
    });

    expect(
      selectDefaultIaTree([featureGroup, navigation, manualSitemap])?.key,
    ).toBe('web::map');
    expect(selectDefaultIaTree([featureGroup, navigation])?.key).toBe(
      'web::nav',
    );
    expect(selectDefaultIaTree([featureGroup])?.key).toBe('web::features');
    expect(selectDefaultIaTree([])).toBeNull();
  });
});

describe('IA deep links', () => {
  it('resolves identical paths with service and tree identity', () => {
    const web = treeFixture({
      key: 'web::map',
      serviceId: 'web',
      path: '/',
    });
    const admin = treeFixture({
      key: 'admin::map',
      serviceId: 'admin',
      path: '/',
    });

    expect(
      resolveIaDeepLink([web, admin], {
        serviceId: 'admin',
        treeId: 'map',
        path: '/',
      }),
    ).toEqual({
      treeKey: 'admin::map',
      nodeKey: admin.nodes[0]!.key,
    });
  });

  it('resolves a fully valid typed node inside the exact tree', () => {
    const selected = hierarchicalTree();

    expect(
      resolveIaDeepLink([selected], {
        serviceId: 'web',
        treeId: 'web-sitemap',
        nodeKey: selected.nodes[0]!.key,
        path: selected.nodes[0]!.path,
      }),
    ).toEqual({
      treeKey: selected.key,
      nodeKey: selected.nodes[0]!.key,
    });
  });

  it('rejects invalid or contradictory typed identity without fallback', () => {
    const selected = hierarchicalTree();
    const other = treeFixture({
      key: 'admin::web-sitemap',
      serviceId: 'admin',
      path: '/programs',
    });

    expect(
      resolveIaDeepLink([selected, other], {
        serviceId: 'web',
        treeId: 'web-sitemap',
        nodeKey: 'missing',
        path: '/programs',
      }),
    ).toBeNull();
    expect(
      resolveIaDeepLink([selected, other], {
        serviceId: 'missing',
        treeId: 'web-sitemap',
        path: '/programs',
      }),
    ).toBeNull();
    expect(
      resolveIaDeepLink([selected], {
        serviceId: 'web',
        nodeKey: selected.nodes[0]!.key,
      }),
    ).toBeNull();
    expect(
      resolveIaDeepLink([selected], {
        serviceId: 'web',
        treeId: 'web-sitemap',
        nodeKey: selected.nodes[0]!.key,
        path: '/programs',
      }),
    ).toBeNull();
    expect(
      resolveIaDeepLink([selected], {
        serviceId: 'web',
        treeId: 'web-sitemap',
        nodeKey: '',
        path: '/programs',
      }),
    ).toBeNull();
    expect(
      resolveIaDeepLink([selected], {
        serviceId: 'web',
        treeId: 'web-sitemap',
        nodeKey: '',
      }),
    ).toBeNull();
  });

  it('uses deterministic cross-tree path fallback for legacy links', () => {
    const defaultTree = treeFixture({ key: 'web::map' });
    const legacyTree = treeFixture({
      key: 'admin::map',
      serviceId: 'admin',
      path: '/legacy',
    });

    expect(
      resolveIaDeepLink([defaultTree, legacyTree], { path: '/legacy' }),
    ).toEqual({
      treeKey: legacyTree.key,
      nodeKey: legacyTree.nodes[0]!.key,
    });
    expect(resolveIaDeepLink([defaultTree], { nodeKey: 'missing' })).toBeNull();
    expect(resolveIaDeepLink([defaultTree], { path: '/missing' })).toBeNull();
    expect(resolveIaDeepLink([], { path: '/' })).toBeNull();
  });

  it('resolves ambiguous legacy paths in the default tree before catalog order', () => {
    const manualNavigation = treeFixture({
      key: 'web::manual-navigation',
      type: 'navigation',
      source: 'manual',
      path: '/shared',
    });
    const autoSitemap = treeFixture({
      key: 'web::auto-sitemap',
      type: 'sitemap',
      source: 'auto',
      path: '/shared',
    });

    expect(
      resolveIaDeepLink(
        [manualNavigation, autoSitemap],
        { path: '/shared' },
      ),
    ).toEqual({
      treeKey: autoSitemap.key,
      nodeKey: autoSitemap.nodes[0]!.key,
    });
  });

  it('finds nested and pathless nodes by opaque key', () => {
    const catalog = hierarchicalTree();
    const pathless = tree([
      node('pathless', { path: undefined, dok_ref: null }),
    ]);

    expect(findIaNode(catalog.nodes, catalog.nodes[0]!.children[0]!.key)).toBe(
      catalog.nodes[0]!.children[0],
    );
    expect(
      resolveIaDeepLink([pathless], {
        serviceId: 'web',
        treeId: 'stats',
        nodeKey: 'pathless',
      }),
    ).toEqual({ treeKey: pathless.key, nodeKey: 'pathless' });
    expect(findIaNode(catalog.nodes, 'missing')).toBeNull();
  });
});

describe('IA filters', () => {
  it('keeps ancestor context for an unmapped descendant', () => {
    const catalog = treeFixture({
      key: 'web::map',
      nestedUnmapped: true,
    });

    expect(iaSubtreeMatches(catalog.nodes[0]!, 'unmapped')).toBe(true);
    expect(iaStats(catalog)).toMatchObject({
      total: 2,
      mapped: 1,
      unmapped: 1,
    });
  });

  it('distinguishes mapping tri-state and exact platform filters', () => {
    const mapped = node('mapped', { dok_ref: 'AUTH-SIGNIN' });
    const container = node('container', {
      path: undefined,
      dok_ref: null,
      children: [
        node('desktop', {
          platform: 'desktop-only',
          dok_ref: 'DESK',
        }),
      ],
    });
    const unmapped = node('unmapped', { unmapped: true });
    const mobile = node('mobile', {
      platform: 'mobile-only',
      dok_ref: 'MOB',
    });

    expect(iaNodeMatches(mapped, 'mapped')).toBe(true);
    expect(iaNodeMatches(container, 'mapped')).toBe(false);
    expect(iaNodeMatches(container, 'unmapped')).toBe(false);
    expect(iaNodeMatches(unmapped, 'unmapped')).toBe(true);
    expect(iaNodeMatches(mapped, 'unmapped')).toBe(false);
    expect(iaNodeMatches(mapped, 'all')).toBe(true);
    expect(iaSubtreeMatches(container, 'desktop')).toBe(true);
    expect(iaNodeMatches(mobile, 'mobile')).toBe(true);
    expect(iaNodeMatches(mapped, 'desktop')).toBe(false);
    expect(iaNodeMatches(mapped, 'mobile')).toBe(false);
  });
});

describe('IA v2 mapping state', () => {
  it('reads mapping from bindings and keeps groups out of the page count', () => {
    const routes = routeHierarchyTree();
    const group = routes.nodes[0]!;
    const signin = group.children[0]!;
    const unmapped = group.children[2]!;

    expect(iaNodeMatches(signin, 'mapped')).toBe(true);
    expect(iaNodeMatches(unmapped, 'mapped')).toBe(false);
    expect(iaNodeMatches(unmapped, 'unmapped')).toBe(true);
    expect(iaNodeMatches(group, 'mapped')).toBe(false);
    expect(iaNodeMatches(group, 'unmapped')).toBe(false);
    expect(iaSubtreeMatches(group, 'unmapped')).toBe(true);
    expect(iaStats(routes)).toEqual({
      total: 4,
      mapped: 3,
      unmapped: 1,
      dynamic: 1,
      bothPlatforms: 4,
      desktopOnly: 0,
      mobileOnly: 0,
    });
  });
});

describe('iaStats', () => {
  it('excludes pathless and null containers while traversing descendants', () => {
    const catalog = hierarchicalTree();

    expect(iaStats(catalog)).toEqual({
      total: 3,
      mapped: 2,
      unmapped: 1,
      dynamic: 1,
      bothPlatforms: 3,
      desktopOnly: 0,
      mobileOnly: 0,
    });
  });

  it('recognizes all supported dynamic forms and counts platform reach', () => {
    const catalog = tree([
      node('colon', {
        path: '/users/:id',
        dok_ref: 'USER-DETAIL',
        platform: 'desktop-only',
      }),
      node('bracket', {
        path: '/users/[id]',
        dok_ref: 'USER-PROFILE',
        platform: 'mobile-only',
      }),
      node('catch-all', {
        path: '/docs/[...slug]',
        dok_ref: 'DOC',
      }),
      node('optional-catch-all', {
        path: '/docs/[[...slug]]',
        unmapped: true,
      }),
      node('static', { path: '/users/settings', dok_ref: 'USER-SETTINGS' }),
      node('pathless', {
        path: undefined,
        dok_ref: 'IGNORED',
        children: [
          node('synthetic', {
            path: '/synthetic',
            dok_ref: null,
            children: [
              node('nested', {
                path: '/synthetic/nested',
                dok_ref: 'NEST',
              }),
            ],
          }),
        ],
      }),
    ]);

    expect(iaStats(catalog)).toEqual({
      total: 6,
      mapped: 5,
      unmapped: 1,
      dynamic: 4,
      bothPlatforms: 4,
      desktopOnly: 1,
      mobileOnly: 1,
    });
  });
});
