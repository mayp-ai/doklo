// Fail-closed IA v1 → v2 migration.
//
// A legacy `ia.json` is converted entirely in memory and written only when every
// tree and every node has a deterministic v2 meaning. Anything the contract
// cannot decide is reported instead of guessed, and the caller leaves the file
// untouched: a silent drop would break the no-data-loss promise, and a silent
// guess would seed v2 with curation nobody authored.
//
// The v1 shape predicates below live here because migration is the only place
// left that must recognise a legacy producer-owned tree.
import {
  IaFileV2Schema,
  type IaBinding,
  type IaCuratedField,
  type IaDestinationNodeV2,
  type IaFileV1,
  type IaFileV2,
  type IaGroupNodeV2,
  type IaLabelV1,
  type IaNodeV1,
  type IaNodeV2,
  type IaTreeV1,
  type IaTreeV2,
} from '@doklo-beta/core';
import { routeTreeIds } from './ia-sitemap.js';

export interface IaMigrationInput {
  v1: IaFileV1;
  /** Freshly derived route hierarchy — exactly one auto `route_hierarchy` tree. */
  derived: IaFileV2;
  /** Dok ids that exist on disk right now; a binding to anything else is dangling. */
  availableDokIds: ReadonlySet<string>;
}

export type IaMigrationFailureReason =
  | 'pathless_dok_ref'           // FC1
  | 'unmatched_path_dok_ref'     // FC2
  | 'ambiguous_sitemap'          // FC3
  | 'conflicting_binding'        // FC4
  | 'dangling_dok_ref'           // FC5
  | 'nonempty_edges'             // FC6
  | 'ambiguous_auto_navigation'  // auto tree that no producer owns
  | 'route_tree_id_conflict';    // rule 9: no id left for the derived hierarchy

export interface IaMigrationFailure {
  tree_id: string;
  /** Set when the offending node has a path; otherwise `node_label` locates it. */
  node_path?: string;
  node_label?: string;
  reason: IaMigrationFailureReason;
  guidance: string;
}

export type IaMigrationResult =
  | { ok: true; file: IaFileV2 }
  // One failure fails the whole file — partial conversion is never written.
  | { ok: false; failures: IaMigrationFailure[] };

/** `edges` is a file-level field, so its failure has no tree to point at. */
const FILE_LEVEL_TREE_ID = '<file>';

const GUIDANCE: Record<IaMigrationFailureReason, string> = {
  pathless_dok_ref: 'assign a path or move the binding manually',
  unmatched_path_dok_ref: 'path is not a route destination; fix the route or remove dok_ref',
  ambiguous_sitemap: 'reclassify this tree as organization or navigation',
  conflicting_binding: 'conflicting bindings for the same path; resolve manually',
  dangling_dok_ref: 'remove dok_ref or restore the missing Dok file',
  nonempty_edges: 'edges are retired in v2; back up manually then remove',
  ambiguous_auto_navigation:
    'source says auto but no producer owns this tree; set source to manual or remove it',
  route_tree_id_conflict:
    'both the canonical and fallback route tree ids are taken by curated trees; rename one',
};

export function everyNodeHasPath(nodes: readonly IaNodeV1[]): boolean {
  return nodes.every((node) => (
    node.path !== undefined && everyNodeHasPath(node.children)
  ));
}

/** The flat `${serviceId}-nav` tree the first route producer wrote. */
export function isLegacyFlatAutoTree(
  tree: IaTreeV1,
  serviceId: string,
): boolean {
  if (
    tree.tree_id !== `${serviceId}-nav`
    || tree.type !== 'navigation'
    || tree.source !== 'auto'
  ) {
    return false;
  }

  const paths = new Set<string>();
  return tree.nodes.every((node) => {
    if (
      node.path === undefined
      || node.children.length !== 0
      || paths.has(node.path)
    ) {
      return false;
    }
    paths.add(node.path);
    return true;
  });
}

/** The hierarchical `${serviceId}-sitemap` tree the later route producer wrote. */
export function isProducerOwnedAutoSitemap(
  tree: IaTreeV1,
  serviceId: string,
): boolean {
  return (
    tree.source === 'auto'
    && tree.type === 'sitemap'
    && (
      tree.tree_id === `${serviceId}-sitemap`
      || tree.tree_id === `${serviceId}-generated-sitemap`
    )
    && everyNodeHasPath(tree.nodes)
  );
}

type TreePlan =
  // Re-derived from code: dropped and replaced by the derived route hierarchy.
  | { kind: 'route_producer' }
  | { kind: 'curated'; tree: IaTreeV1; type: 'navigation' | 'organization' }
  // Classification failed; the whole migration fails, so it is never assembled.
  | { kind: 'unconvertible' };

interface ScanContext {
  treeId: string;
  destinationPaths: ReadonlySet<string>;
  availableDokIds: ReadonlySet<string>;
  movedByPath: Map<string, string[]>;
  failures: IaMigrationFailure[];
}

/**
 * Converts a v1 IA file onto the derived v2 route hierarchy.
 *
 * Pure: neither `input.v1` nor `input.derived` is mutated, and the returned file
 * is a fresh object validated against `IaFileV2Schema`.
 */
export function migrateIaV1ToV2(input: IaMigrationInput): IaMigrationResult {
  const { v1, derived, availableDokIds } = input;
  const derivedTree = requireDerivedRouteHierarchy(derived);
  if (derived.service_id !== v1.service_id) {
    throw new Error(
      `Cannot migrate IA for service ${v1.service_id} with a route hierarchy derived for ${derived.service_id}`,
    );
  }

  const failures: IaMigrationFailure[] = [];
  const destinationPaths = collectDestinationPaths(derivedTree.nodes);
  const movedByPath = new Map<string, string[]>();

  // 1. Tree classification — which trees are re-derived, curated, or ambiguous.
  const plans = v1.trees.map((tree) => classifyTree(tree, v1.service_id, failures));

  // 1b. Rule 9 — the derived hierarchy takes the canonical id, or the single
  //     reserved fallback when a curated tree already answers to it. A v1 file
  //     may legitimately contain a hand-written tree named `<service>-routes`,
  //     and colliding on it would fail late with a duplicate-id parse error.
  const routeTreeId = chooseRouteTreeId(plans, v1.service_id, failures);

  // 2. Node scan of the curated trees, collecting the bindings to move. Trees
  //    that failed classification are not scanned: their nodes have no settled
  //    meaning, so node-level reports about them would be speculation.
  const curatedTrees = plans.map((plan) => (
    plan.kind === 'curated'
      ? convertCuratedTree(plan.tree, plan.type, {
        treeId: plan.tree.tree_id,
        destinationPaths,
        availableDokIds,
        movedByPath,
        failures,
      })
      : undefined
  ));

  // 3. File-level fields v2 retires.
  if (v1.edges.length > 0) {
    failures.push(buildFailure(FILE_LEVEL_TREE_ID, 'nonempty_edges'));
  }

  // 4. Merge post-condition on the assembled route hierarchy.
  const routeTree: IaTreeV2 = {
    ...derivedTree,
    tree_id: routeTreeId ?? derivedTree.tree_id,
    nodes: applyMovedBindings(derivedTree.nodes, movedByPath),
  };
  collectProvenanceConflicts(routeTree, failures);

  if (failures.length > 0) return { ok: false, failures };

  return {
    ok: true,
    file: IaFileV2Schema.parse({
      service_id: v1.service_id,
      version: 2,
      // v1's `updated_at` is deliberately dropped: the writer stamps the file.
      trees: assembleTrees(plans, curatedTrees, routeTree),
    }),
  };
}

function requireDerivedRouteHierarchy(derived: IaFileV2): IaTreeV2 {
  const tree = derived.trees[0];
  if (
    derived.trees.length !== 1
    || tree === undefined
    || tree.type !== 'route_hierarchy'
    || tree.source !== 'auto'
  ) {
    throw new Error('Derived IA must contain exactly one automatic route hierarchy tree');
  }
  return tree;
}

function classifyTree(
  tree: IaTreeV1,
  serviceId: string,
  failures: IaMigrationFailure[],
): TreePlan {
  if (
    isLegacyFlatAutoTree(tree, serviceId)
    || isProducerOwnedAutoSitemap(tree, serviceId)
  ) {
    return { kind: 'route_producer' };
  }

  // FC3 — a sitemap nobody produced could be a route hierarchy or a product
  // organization; the two carry different meaning, so it is not guessed.
  if (tree.type === 'sitemap') {
    failures.push(buildFailure(tree.tree_id, 'ambiguous_sitemap'));
    return { kind: 'unconvertible' };
  }

  // An auto navigation tree that is not the legacy flat fingerprint claims a
  // producer that does not exist; restating it as manual would forge provenance.
  if (tree.type === 'navigation' && tree.source === 'auto') {
    failures.push(buildFailure(tree.tree_id, 'ambiguous_auto_navigation'));
    return { kind: 'unconvertible' };
  }

  // feature_group is absorbed by organization. No producer ever wrote a
  // feature_group tree, so its `source` is a hand-written value with no producer
  // behind it and `manual` is the only honest — and only representable — v2 form.
  return {
    kind: 'curated',
    tree,
    type: tree.type === 'feature_group' ? 'organization' : 'navigation',
  };
}

/**
 * Rule 9 for the migration: the ids curated trees keep are off limits, so the
 * derived hierarchy takes the canonical id, then the one reserved fallback, and
 * otherwise the whole migration fails rather than dropping or renaming a tree a
 * person wrote. Returns `undefined` only when it has reported that failure.
 */
function chooseRouteTreeId(
  plans: readonly TreePlan[],
  serviceId: string,
  failures: IaMigrationFailure[],
): string | undefined {
  const preserved = new Set(
    plans.flatMap((plan) => (plan.kind === 'curated' ? [plan.tree.tree_id] : [])),
  );
  const { canonical, fallback } = routeTreeIds(serviceId);

  if (!preserved.has(canonical)) return canonical;
  if (!preserved.has(fallback)) return fallback;

  failures.push(buildFailure(canonical, 'route_tree_id_conflict'));
  return undefined;
}

function convertCuratedTree(
  tree: IaTreeV1,
  type: 'navigation' | 'organization',
  ctx: ScanContext,
): IaTreeV2 {
  return {
    tree_id: tree.tree_id,
    type,
    // v2 writers never emit auto+manual: a curated tree's structure is manual.
    source: 'manual',
    platform: tree.platform,
    nodes: tree.nodes.map((node) => convertNode(node, ctx)),
  };
}

function convertNode(node: IaNodeV1, ctx: ScanContext): IaNodeV2 {
  resolveBindingMove(node, ctx);

  const children = node.children.map((child) => convertNode(child, ctx));
  const tags = node.tags ?? [];
  // v1 carries no curation markers, so nothing is frozen against the producer.
  const curatedFields: IaCuratedField[] = [];

  if (node.path === undefined) {
    const group: IaGroupNodeV2 = {
      kind: 'group',
      label: node.label,
      curated_fields: curatedFields,
      tags,
      children,
    };
    if (node.platform !== undefined) group.platform = node.platform;
    return group;
  }

  // A placement keeps its own label; its bindings live on the route destination.
  const destination: IaDestinationNodeV2 = {
    path: node.path,
    kind: 'destination',
    label: node.label,
    curated_fields: curatedFields,
    bindings: [],
    tags,
    children,
  };
  if (node.platform !== undefined) destination.platform = node.platform;
  return destination;
}

function resolveBindingMove(node: IaNodeV1, ctx: ScanContext): void {
  // `dok_ref: null` is the v1 container marker, not a binding.
  const dokRef = node.dok_ref ?? undefined;
  if (dokRef === undefined) return;

  if (node.path === undefined) {
    // FC1 — no path means no destination to move the binding onto.
    ctx.failures.push(buildFailure(ctx.treeId, 'pathless_dok_ref', node));
  } else if (!ctx.destinationPaths.has(node.path)) {
    // FC2 — the path names no route destination (a synthetic prefix group counts
    // as no destination: it is a container, not a reachable surface).
    ctx.failures.push(buildFailure(ctx.treeId, 'unmatched_path_dok_ref', node));
  } else {
    const claimed = ctx.movedByPath.get(node.path);
    if (claimed === undefined) ctx.movedByPath.set(node.path, [dokRef]);
    else claimed.push(dokRef);
  }

  // FC5 — checked independently: a binding pointing at a missing Dok must not be
  // moved or dropped silently, wherever it sits.
  if (!ctx.availableDokIds.has(dokRef)) {
    ctx.failures.push(buildFailure(ctx.treeId, 'dangling_dok_ref', node));
  }
}

function applyMovedBindings(
  nodes: readonly IaNodeV2[],
  movedByPath: ReadonlyMap<string, readonly string[]>,
): IaNodeV2[] {
  return nodes.map((node) => {
    const children = applyMovedBindings(node.children, movedByPath);
    if (node.kind !== 'destination') return { ...node, children };
    return {
      ...node,
      bindings: mergeBindings(node.bindings ?? [], movedByPath.get(node.path) ?? []),
      children,
    };
  });
}

function mergeBindings(
  existing: readonly IaBinding[],
  moved: readonly string[],
): IaBinding[] {
  const merged = [...existing];
  const claimed = new Set(existing.map((binding) => binding.dok_ref));
  for (const dokRef of moved) {
    // Rule 4: bindings are a set keyed by dok_ref with a single provenance and
    // auto wins, so a manual claim the producer already proves collapses into
    // the existing auto entry, and a repeated manual claim collapses into one.
    if (claimed.has(dokRef)) continue;
    claimed.add(dokRef);
    merged.push({ dok_ref: dokRef, source: 'manual' });
  }
  return merged;
}

/**
 * FC4 post-condition: every (destination path, dok_ref) ends with exactly one
 * provenance entry. Rule 4 collapses every duplicate a v1 file can produce, so
 * this only fires if the derived hierarchy itself arrives with two claims for
 * one Dok — and the migrator refuses to pick a winner.
 */
function collectProvenanceConflicts(
  tree: IaTreeV2,
  failures: IaMigrationFailure[],
): void {
  walkNodesV2(tree.nodes, (node) => {
    if (node.kind !== 'destination') return;
    const seen = new Set<string>();
    for (const binding of node.bindings ?? []) {
      if (seen.has(binding.dok_ref)) {
        failures.push({
          tree_id: tree.tree_id,
          node_path: node.path,
          reason: 'conflicting_binding',
          guidance: GUIDANCE.conflicting_binding,
        });
        return;
      }
      seen.add(binding.dok_ref);
    }
  });
}

function assembleTrees(
  plans: readonly TreePlan[],
  curatedTrees: readonly (IaTreeV2 | undefined)[],
  routeTree: IaTreeV2,
): IaTreeV2[] {
  const trees: IaTreeV2[] = [];
  let placed = false;

  plans.forEach((plan, index) => {
    // The derived tree takes the position of the first tree it replaces.
    if (plan.kind === 'route_producer') {
      if (!placed) {
        trees.push(routeTree);
        placed = true;
      }
      return;
    }
    const curated = curatedTrees[index];
    if (curated !== undefined) trees.push(curated);
  });

  if (!placed) trees.push(routeTree);
  return trees;
}

function collectDestinationPaths(nodes: readonly IaNodeV2[]): Set<string> {
  const paths = new Set<string>();
  walkNodesV2(nodes, (node) => {
    if (node.kind === 'destination') paths.add(node.path);
  });
  return paths;
}

function walkNodesV2(
  nodes: readonly IaNodeV2[],
  visit: (node: IaNodeV2) => void,
): void {
  for (const node of nodes) {
    visit(node);
    walkNodesV2(node.children, visit);
  }
}

function buildFailure(
  treeId: string,
  reason: IaMigrationFailureReason,
  node?: IaNodeV1,
): IaMigrationFailure {
  const failure: IaMigrationFailure = {
    tree_id: treeId,
    reason,
    guidance: GUIDANCE[reason],
  };
  if (node === undefined) return failure;
  if (node.path !== undefined) return { ...failure, node_path: node.path };
  return { ...failure, node_label: labelText(node.label) };
}

function labelText(label: IaLabelV1): string {
  return typeof label === 'string' ? label : label.term_ref;
}
