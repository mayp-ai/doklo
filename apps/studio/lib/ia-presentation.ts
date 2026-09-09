import {
  iaNodeDokRefs,
  type StudioIaNode,
  type StudioIaTree,
} from './ia-route';

export type IaFilter =
  | 'all'
  | 'mapped'
  | 'unmapped'
  | 'desktop'
  | 'mobile';

/** Slider sentinel: finite values 1–5 cap hierarchy depth; 6 means all. */
export const IA_DEPTH_ALL = 6;

export function isIaDepthAll(depth: number): boolean {
  return depth >= IA_DEPTH_ALL;
}

/**
 * Default structure by evidence class: the code-derived route hierarchy wins,
 * then the frozen v1 equivalents in their established order, then curated
 * structures. The trailing manual route_hierarchy lookup only exists so a
 * hand-authored v2 file still selects something instead of nothing.
 */
export function selectDefaultIaTree(
  trees: readonly StudioIaTree[],
): StudioIaTree | null {
  return (
    trees.find(
      (tree) => tree.type === 'route_hierarchy' && tree.source === 'auto',
    ) ??
    trees.find(
      (tree) => tree.type === 'sitemap' && tree.source === 'auto',
    ) ??
    trees.find((tree) => tree.type === 'sitemap') ??
    trees.find((tree) => tree.type === 'navigation') ??
    trees.find((tree) => tree.type === 'organization') ??
    trees.find((tree) => tree.type === 'feature_group') ??
    trees.find((tree) => tree.type === 'route_hierarchy') ??
    null
  );
}

export function findIaNode(
  nodes: readonly StudioIaNode[],
  key: string,
): StudioIaNode | null {
  for (const node of nodes) {
    if (node.key === key) return node;
    const child = findIaNode(node.children, key);
    if (child) return child;
  }
  return null;
}

export function iaNodeMatches(
  node: StudioIaNode,
  filter: IaFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'mapped') return iaNodeDokRefs(node).length > 0;
  if (filter === 'unmapped') return node.unmapped;
  if (filter === 'desktop') return node.platform === 'desktop-only';
  return node.platform === 'mobile-only';
}

export function iaSubtreeMatches(
  node: StudioIaNode,
  filter: IaFilter,
): boolean {
  return (
    iaNodeMatches(node, filter) ||
    node.children.some((child) => iaSubtreeMatches(child, filter))
  );
}

/** Deepest hierarchy level a depth-limited projection still renders. */
function iaDepthLimit(depth: number): number {
  return isIaDepthAll(depth) ? Number.POSITIVE_INFINITY : depth;
}

export interface SitemapListing {
  node: StudioIaNode;
  relativeDepth: number;
}

export interface SitemapCard {
  node: StudioIaNode;
  listings: SitemapListing[];
}

export function buildSitemapCards(
  tree: StudioIaTree,
  depth: number,
  filter: IaFilter,
): SitemapCard[] {
  const depthLimit = iaDepthLimit(depth);
  const collect = (
    node: StudioIaNode,
    remainingDepth: number,
    relativeDepth: number,
    output: SitemapListing[],
  ): void => {
    if (remainingDepth <= 0) return;
    for (const child of node.children) {
      if (!iaSubtreeMatches(child, filter)) continue;
      output.push({ node: child, relativeDepth });
      collect(child, remainingDepth - 1, relativeDepth + 1, output);
    }
  };

  return tree.nodes
    .filter((node) => iaSubtreeMatches(node, filter))
    .map((node) => {
      const listings: SitemapListing[] = [];
      collect(node, Math.max(0, depthLimit - 1), 1, listings);
      return { node, listings };
    });
}

/**
 * How many filter matches each top-level branch hides behind the depth cutoff,
 * keyed by branch node key. Only branches with at least one hidden match are
 * present, so an empty map means the depth is showing everything the filter
 * found.
 *
 * `buildSitemapCards` keeps ancestors of a match as context, which can leave a
 * branch showing nothing but context rows once the depth is shallower than the
 * matches themselves. This counts what that cutoff removed, using the same
 * per-node predicate as the filter (`iaNodeMatches`) so the hint and the filter
 * can never disagree — context ancestors are not matches and are never counted.
 * The default `all` filter narrows nothing, so it reports nothing.
 */
export function iaMatchesBelowDepth(
  tree: StudioIaTree,
  depth: number,
  filter: IaFilter,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (filter === 'all') return counts;

  const depthLimit = iaDepthLimit(depth);
  const countBelow = (node: StudioIaNode, nodeDepth: number): number => {
    let hidden = 0;
    for (const child of node.children) {
      const childDepth = nodeDepth + 1;
      if (childDepth > depthLimit && iaNodeMatches(child, filter)) hidden += 1;
      hidden += countBelow(child, childDepth);
    }
    return hidden;
  };

  for (const root of tree.nodes) {
    const hidden = countBelow(root, 1);
    if (hidden > 0) counts.set(root.key, hidden);
  }
  return counts;
}

export interface VisibleIaRow {
  node: StudioIaNode;
  depth: number;
}

export function visibleIaNodes(
  tree: StudioIaTree,
  depth: number,
  filter: IaFilter,
): VisibleIaRow[] {
  const rows: VisibleIaRow[] = [];
  const visit = (
    nodes: readonly StudioIaNode[],
    currentDepth: number,
  ): void => {
    if (!isIaDepthAll(depth) && currentDepth > depth) return;
    for (const node of nodes) {
      if (!iaSubtreeMatches(node, filter)) continue;
      rows.push({ node, depth: currentDepth });
      visit(node.children, currentDepth + 1);
    }
  };

  visit(tree.nodes, 1);
  return rows;
}

export interface IaStats {
  total: number;
  mapped: number;
  unmapped: number;
  dynamic: number;
  bothPlatforms: number;
  desktopOnly: number;
  mobileOnly: number;
}

export const EMPTY_IA_STATS: IaStats = {
  total: 0,
  mapped: 0,
  unmapped: 0,
  dynamic: 0,
  bothPlatforms: 0,
  desktopOnly: 0,
  mobileOnly: 0,
};

function isDynamicPath(path: string): boolean {
  return path.split('/').some(
    (segment) =>
      /^:[^/]+$/.test(segment) ||
      /^\[{1,2}(?:\.\.\.)?[^/]+\]{1,2}$/.test(segment),
  );
}

export function iaStats(tree: StudioIaTree): IaStats {
  const stats: IaStats = { ...EMPTY_IA_STATS };

  const visit = (node: StudioIaNode): void => {
    if (node.path !== undefined && node.dok_ref !== null) {
      stats.total += 1;
      if (iaNodeDokRefs(node).length > 0) stats.mapped += 1;
      if (node.unmapped) stats.unmapped += 1;
      if (isDynamicPath(node.path)) stats.dynamic += 1;

      if (node.platform === 'desktop-only') stats.desktopOnly += 1;
      else if (node.platform === 'mobile-only') stats.mobileOnly += 1;
      else stats.bothPlatforms += 1;
    }
    node.children.forEach(visit);
  };

  tree.nodes.forEach(visit);
  return stats;
}

export interface IaDeepLinkRequest {
  serviceId?: string;
  treeId?: string;
  nodeKey?: string;
  path?: string;
}

export interface IaDeepLinkSelection {
  treeKey: string;
  nodeKey: string | null;
}

function findIaNodeByPath(
  nodes: readonly StudioIaNode[],
  path: string,
): StudioIaNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findIaNodeByPath(node.children, path);
    if (child) return child;
  }
  return null;
}

export function resolveIaDeepLink(
  trees: readonly StudioIaTree[],
  request: IaDeepLinkRequest,
): IaDeepLinkSelection | null {
  const isTyped =
    request.serviceId !== undefined ||
    request.treeId !== undefined ||
    request.nodeKey !== undefined;

  if (isTyped) {
    if (!request.serviceId || !request.treeId) return null;
    const tree = trees.find(
      (candidate) =>
        candidate.serviceId === request.serviceId &&
        candidate.treeId === request.treeId,
    );
    if (!tree) return null;

    if (request.nodeKey !== undefined) {
      const node = findIaNode(tree.nodes, request.nodeKey);
      if (!node || (request.path !== undefined && node.path !== request.path)) {
        return null;
      }
      return { treeKey: tree.key, nodeKey: node.key };
    }

    if (request.path !== undefined) {
      const node = findIaNodeByPath(tree.nodes, request.path);
      return node ? { treeKey: tree.key, nodeKey: node.key } : null;
    }

    return { treeKey: tree.key, nodeKey: null };
  }

  if (request.path === undefined) return null;
  const defaultTree = selectDefaultIaTree(trees);
  if (defaultTree) {
    const node = findIaNodeByPath(defaultTree.nodes, request.path);
    if (node) {
      return { treeKey: defaultTree.key, nodeKey: node.key };
    }
  }
  for (const tree of trees) {
    if (tree === defaultTree) continue;
    const node = findIaNodeByPath(tree.nodes, request.path);
    if (node) return { treeKey: tree.key, nodeKey: node.key };
  }
  return null;
}
