// Route-hierarchy producer: turns the adapter's RouteIR into the IA v2
// `route_hierarchy` tree. It owns the trie, the label priority, the sibling
// ordering, and the coverage invariant — one destination per unique page path.
//
// It also owns the tree's identity: the producer id stamped on every tree it
// writes, and the two tree ids it is allowed to claim (contract rule 9).
import type { IaLabel, IaNodeV2, RouteIR } from '@doklo-beta/core';

export interface SitemapPresentation {
  featureLabel?: string;
  dokRef?: string;
  dokName?: IaLabel;
}

/**
 * Identity of the code that owns an auto route hierarchy. Adapter-independent:
 * the trie builder belongs to the generator, whichever adapter supplies RouteIR.
 */
export const ROUTE_HIERARCHY_PRODUCER = 'doklo-route-hierarchy@1';

/**
 * Contract rule 9. The producer claims the canonical id, falls back to exactly
 * one alternative when a curated tree already holds it, and never invents a
 * fresh suffix — otherwise every rerun would add another tree.
 */
export function routeTreeIds(
  serviceId: string,
): { canonical: string; fallback: string } {
  return {
    canonical: `${serviceId}-routes`,
    fallback: `${serviceId}-generated-routes`,
  };
}

export class SitemapCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SitemapCoverageError';
  }
}

interface TrieNode {
  path: string;
  segment: string;
  route?: RouteIR;
  routesInSubtree: RouteIR[];
  children: Map<string, TrieNode>;
}

const DYNAMIC_SEGMENT = /^(?::[^/]+|\[(?:\[)?(?:\.\.\.)?[^/]+\](?:\])?)$/;

export function buildSitemapNodes(
  routes: readonly RouteIR[],
  presentationByPath: ReadonlyMap<string, SitemapPresentation>,
): IaNodeV2[] {
  const canonicalRoutes = new Map<string, RouteIR>();
  for (const route of routes) {
    if (route.kind !== 'page') continue;
    const path = normalizePath(route.path);
    canonicalRoutes.set(path, preferRoute(canonicalRoutes.get(path), route));
  }

  const roots = new Map<string, TrieNode>();
  for (const [path, route] of canonicalRoutes) {
    const segments = path === '/' ? [''] : path.slice(1).split('/');
    let parent: TrieNode | undefined;
    let prefix = '';

    for (const segment of segments) {
      prefix = segment === '' ? '/' : `${prefix}/${segment}`;
      const siblings = parent?.children ?? roots;
      let current = siblings.get(segment);
      if (current === undefined) {
        current = {
          path: prefix,
          segment,
          routesInSubtree: [],
          children: new Map(),
        };
        siblings.set(segment, current);
      }
      current.routesInSubtree.push(route);
      parent = current;
    }

    if (parent !== undefined) parent.route = route;
  }

  return emitSiblings([...roots.values()], '', presentationByPath);
}

/** Every unique page route is reachable through exactly one destination node. */
export function assertSitemapCoverage(
  routes: readonly RouteIR[],
  nodes: readonly IaNodeV2[],
): void {
  const expected = new Set(
    routes
      .filter((route) => route.kind === 'page')
      .map((route) => normalizePath(route.path)),
  );
  const counts = new Map<string, number>();
  const visit = (items: readonly IaNodeV2[]): void => {
    for (const node of items) {
      // Groups are containers, not surfaces: only destinations count.
      if (node.kind === 'destination') {
        counts.set(node.path, (counts.get(node.path) ?? 0) + 1);
      }
      visit(node.children);
    }
  };
  visit(nodes);

  const missing = [...expected].filter((path) => !counts.has(path)).sort();
  const duplicate = [...counts]
    .filter(([, count]) => count !== 1)
    .map(([path]) => path)
    .sort();
  const unexpected = [...counts]
    .filter(([path]) => !expected.has(path))
    .map(([path]) => path)
    .sort();

  if (missing.length || duplicate.length || unexpected.length) {
    throw new SitemapCoverageError(JSON.stringify({
      missing,
      duplicate,
      unexpected,
    }));
  }
}

function emitSiblings(
  siblings: TrieNode[],
  nearestStaticLabel: string,
  presentationByPath: ReadonlyMap<string, SitemapPresentation>,
): IaNodeV2[] {
  const emitted = siblings.map((trie) => {
    const presentation = trie.route
      ? presentationByPath.get(trie.path)
      : undefined;
    const label = withoutDynamicToken(nonBlank(presentation?.featureLabel))
      ?? withoutDynamicToken(presentation?.dokName)
      ?? fallbackLabel(trie.segment, nearestStaticLabel);
    const childStaticLabel = segmentRank(trie.segment) === 1
      ? typeof label === 'string'
        ? label
        : humanizeStatic(trie.segment)
      : nearestStaticLabel;
    const children = emitSiblings(
      [...trie.children.values()],
      childStaticLabel,
      presentationByPath,
    );
    // A trie node that carries a route is a reachable surface; one that only
    // exists to hold children is a synthetic prefix group. The group keeps its
    // canonical prefix path so deep-link and placement targets stay stable, but
    // it defines no surface, so it carries neither bindings nor evidence.
    const node: IaNodeV2 = trie.route
      ? {
        path: trie.path,
        kind: 'destination',
        label,
        curated_fields: [],
        bindings: presentation?.dokRef === undefined
          ? []
          : [{ dok_ref: presentation.dokRef, source: 'auto' }],
        evidence: [{ kind: 'route_source', file: normalizeFile(trie.route.file) }],
        tags: [],
        children,
      }
      : {
        path: trie.path,
        kind: 'group',
        label,
        curated_fields: [],
        tags: [],
        children,
      };
    return { trie, node };
  });

  emitted.sort((left, right) => compareTuple(
    sortTuple(left.trie, left.node.label),
    sortTuple(right.trie, right.node.label),
  ));
  return emitted.map(({ node }) => node);
}

function sortTuple(trie: TrieNode, label: IaLabel): Array<number | string> {
  return [
    segmentRank(trie.segment),
    closestLayoutKey(trie.routesInSubtree),
    normalizedLabel(label),
    trie.path,
    normalizeFile(trie.route?.file ?? ''),
  ];
}

function compareTuple(
  left: Array<number | string>,
  right: Array<number | string>,
): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function normalizePath(value: string): string {
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash === '/' ? '/' : withLeadingSlash.replace(/\/+$/, '');
}

function normalizeFile(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function segmentRank(segment: string): number {
  if (segment === '') return 0;
  if (
    /^\[\[?\.\.\./.test(segment)
    || /^:\[?\.\.\./.test(segment)
    || /^:\*/.test(segment)
  ) return 3;
  if (DYNAMIC_SEGMENT.test(segment)) return 2;
  return 1;
}

function humanizeStatic(segment: string): string {
  const spaced = segment
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.length === 0
    ? 'Home'
    : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function withoutDynamicToken(value: IaLabel | undefined): IaLabel | undefined {
  return typeof value === 'string' && DYNAMIC_SEGMENT.test(value.trim())
    ? undefined
    : value;
}

function fallbackLabel(segment: string, nearestStatic: string): string {
  return DYNAMIC_SEGMENT.test(segment)
    ? `${nearestStatic || 'Route'} details`
    : humanizeStatic(segment);
}

function closestLayoutKey(routes: readonly RouteIR[]): string {
  return routes
    .map((route) => route.layout_chain.at(-1) ?? '')
    .sort((left, right) => left.localeCompare(right))[0] ?? '';
}

function normalizedLabel(label: IaLabel): string {
  return typeof label === 'string'
    ? label.normalize('NFKC').toLocaleLowerCase()
    : label.term_ref;
}

function preferRoute(left: RouteIR | undefined, right: RouteIR): RouteIR {
  if (!left) return right;
  if (right.layout_chain.length !== left.layout_chain.length) {
    return right.layout_chain.length > left.layout_chain.length ? right : left;
  }
  return normalizeFile(right.file).localeCompare(normalizeFile(left.file)) < 0
    ? right
    : left;
}
