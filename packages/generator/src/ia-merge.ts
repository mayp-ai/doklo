// Contract merge for IA v2.
//
// Everything this file used to guess is now written down in the data: a tree
// says who produced it, a node says which fields a person froze, and a binding
// says who claimed it. So the merge is two rules and no heuristics —
//   rule 6: fields listed in `curated_fields` survive, the rest are re-derived
//   rule 4: derived bindings are `auto`, and only manual claims the producer
//           does not prove survive alongside them
// plus rule 9 for which tree id the producer may claim.
import { isDeepStrictEqual } from 'node:util';
import {
  IaFileV2Schema,
  type IaBinding,
  type IaCuratedField,
  type IaFileV2,
  type IaLabel,
  type IaNodeV2,
  type IaTreeV2,
  type Platform,
} from '@doklo-beta/core';
import type { MergeResult } from './derive-service-meta.js';
import { routeTreeIds, ROUTE_HIERARCHY_PRODUCER } from './ia-sitemap.js';

export function mergeDerivedIA(
  existing: IaFileV2 | null,
  derived: IaFileV2,
  now: string,
): MergeResult<IaFileV2> {
  const parsedExisting = existing === null ? null : IaFileV2Schema.parse(existing);
  const parsedDerived = IaFileV2Schema.parse(derived);
  const derivedTree = parsedDerived.trees[0];

  if (
    parsedDerived.trees.length !== 1
    || derivedTree === undefined
    || derivedTree.type !== 'route_hierarchy'
    || derivedTree.source !== 'auto'
    || derivedTree.producer !== ROUTE_HIERARCHY_PRODUCER
  ) {
    throw new Error(
      `Derived IA must contain exactly one automatic route hierarchy produced by ${ROUTE_HIERARCHY_PRODUCER}`,
    );
  }
  if (
    parsedExisting !== null
    && parsedExisting.service_id !== parsedDerived.service_id
  ) {
    throw new Error(
      `Cannot merge IA for service ${parsedDerived.service_id} into ${parsedExisting.service_id}`,
    );
  }

  const serviceId = parsedDerived.service_id;
  const { canonical, fallback } = routeTreeIds(serviceId);
  const existingTrees = parsedExisting?.trees ?? [];
  const ownedIndexes = new Set<number>();

  existingTrees.forEach((tree, index) => {
    if (isOwnedRouteTree(tree, serviceId)) ownedIndexes.add(index);
  });

  const canonicalIndex = existingTrees.findIndex((tree) => tree.tree_id === canonical);
  const fallbackIndex = existingTrees.findIndex((tree) => tree.tree_id === fallback);
  const canonicalAvailable = canonicalIndex < 0 || ownedIndexes.has(canonicalIndex);
  const fallbackAvailable = fallbackIndex < 0 || ownedIndexes.has(fallbackIndex);

  // Rule 9 — never invent a third id: a rerun that cannot claim either of the
  // two reserved ids stops instead of growing the file by one tree per run.
  if (!canonicalAvailable && !fallbackAvailable) {
    throw new Error(
      'Cannot generate IA route hierarchy: canonical and fallback tree IDs are both preserved',
    );
  }

  const targetId = canonicalAvailable ? canonical : fallback;
  const previousByPath = collectOwnedNodes(existingTrees, ownedIndexes, targetId);
  const regeneratedTree: IaTreeV2 = {
    ...derivedTree,
    tree_id: targetId,
    nodes: derivedTree.nodes.map((node) => mergeNode(node, previousByPath)),
  };
  const trees = insertRegeneratedTree(existingTrees, ownedIndexes, regeneratedTree);
  const nextFile = IaFileV2Schema.parse({
    ...(parsedExisting ?? parsedDerived),
    trees,
  });

  if (
    parsedExisting !== null
    && isDeepStrictEqual(
      withoutIaTimestamp(nextFile),
      withoutIaTimestamp(parsedExisting),
    )
  ) {
    return { file: existing!, changed: false };
  }

  return {
    file: IaFileV2Schema.parse({ ...nextFile, updated_at: now }),
    changed: true,
  };
}

/**
 * Ownership is read off explicit fields only — never inferred from a tree's
 * shape or labels. A tree this producer did not sign is somebody else's data.
 */
function isOwnedRouteTree(tree: IaTreeV2, serviceId: string): boolean {
  const { canonical, fallback } = routeTreeIds(serviceId);
  return (
    tree.source === 'auto'
    && tree.type === 'route_hierarchy'
    && tree.producer === ROUTE_HIERARCHY_PRODUCER
    && (tree.tree_id === canonical || tree.tree_id === fallback)
  );
}

function mergeNode(
  node: IaNodeV2,
  previousByPath: ReadonlyMap<string, IaNodeV2>,
): IaNodeV2 {
  const previous = node.path === undefined
    ? undefined
    : previousByPath.get(node.path);
  const children = node.children.map((child) => mergeNode(child, previousByPath));
  const curated = curatedOverlay(node, previous);

  if (node.kind !== 'destination') {
    return { ...node, ...curated, children };
  }
  // `evidence` is never overlaid: it is producer-only, so the derived anchor
  // always wins and a stale file path cannot survive a route move.
  return {
    ...node,
    ...curated,
    bindings: mergeBindings(node.bindings, previous),
    children,
  };
}

interface CuratedOverlay {
  curated_fields: IaCuratedField[];
  label?: IaLabel;
  tags?: string[];
  platform?: Platform;
}

/**
 * Rule 6. `curated_fields` is the whole record of what a person decided; a
 * field it does not list is the producer's to rewrite on every run.
 */
function curatedOverlay(
  node: IaNodeV2,
  previous: IaNodeV2 | undefined,
): CuratedOverlay {
  if (previous === undefined) return { curated_fields: node.curated_fields };

  const overlay: CuratedOverlay = { curated_fields: previous.curated_fields };
  if (previous.curated_fields.includes('label')) overlay.label = previous.label;
  if (previous.curated_fields.includes('tags')) overlay.tags = previous.tags;
  if (
    previous.curated_fields.includes('platform')
    && previous.platform !== undefined
  ) {
    overlay.platform = previous.platform;
  }
  return overlay;
}

/**
 * Rule 4. Bindings are a set keyed by `dok_ref` with exactly one provenance and
 * auto wins. A previous `auto` claim that code stopped proving simply dies; a
 * person who still claims it re-adds it in Studio.
 */
function mergeBindings(
  derived: readonly IaBinding[],
  previous: IaNodeV2 | undefined,
): IaBinding[] {
  const merged = [...derived];
  if (previous === undefined || previous.kind !== 'destination') return merged;

  const claimed = new Set(derived.map((binding) => binding.dok_ref));
  for (const binding of previous.bindings) {
    if (binding.source !== 'manual') continue;
    if (claimed.has(binding.dok_ref)) continue;
    claimed.add(binding.dok_ref);
    merged.push({ dok_ref: binding.dok_ref, source: 'manual' });
  }
  return merged;
}

/**
 * Indexes every node of the trees about to be replaced — groups included, since
 * a synthetic prefix can carry a curated label too. When two owned trees hold
 * the same path, the one keeping the target id wins.
 */
function collectOwnedNodes(
  trees: readonly IaTreeV2[],
  ownedIndexes: ReadonlySet<number>,
  targetId: string,
): Map<string, IaNodeV2> {
  const ordered = trees
    .map((tree, index) => ({ tree, index }))
    .filter(({ index }) => ownedIndexes.has(index))
    .sort((left, right) => {
      const leftPriority = left.tree.tree_id === targetId ? 1 : 0;
      const rightPriority = right.tree.tree_id === targetId ? 1 : 0;
      return leftPriority - rightPriority || left.index - right.index;
    });

  const values = new Map<string, IaNodeV2>();
  const visit = (node: IaNodeV2): void => {
    if (node.path !== undefined) values.set(node.path, node);
    node.children.forEach(visit);
  };
  for (const { tree } of ordered) tree.nodes.forEach(visit);
  return values;
}

function insertRegeneratedTree(
  existingTrees: readonly IaTreeV2[],
  ownedIndexes: ReadonlySet<number>,
  regeneratedTree: IaTreeV2,
): IaTreeV2[] {
  const firstRemovedIndex = existingTrees.findIndex((_, index) => (
    ownedIndexes.has(index)
  ));
  const preservedTrees = existingTrees.filter((_, index) => (
    !ownedIndexes.has(index)
  ));
  if (firstRemovedIndex < 0) return [...preservedTrees, regeneratedTree];

  const insertionIndex = existingTrees
    .slice(0, firstRemovedIndex)
    .filter((_, index) => !ownedIndexes.has(index))
    .length;
  preservedTrees.splice(insertionIndex, 0, regeneratedTree);
  return preservedTrees;
}

function withoutIaTimestamp(file: IaFileV2): Omit<IaFileV2, 'updated_at'> {
  const { updated_at: _updatedAt, ...semantic } = file;
  return semantic;
}
