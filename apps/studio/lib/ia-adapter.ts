import type {
  IaFileV1,
  IaFileV2,
  IaLabel,
  IaNodeV1,
  IaNodeV2,
  IaTreeV1,
  IaTreeV2,
  LexiconTerm,
} from '@doklo-beta/core';
import type {
  Platform,
  StudioIaNode,
  StudioIaTree,
} from './ia-route';

/**
 * Adapter: real per-service IA data to Studio's typed tree catalog.
 * Kept dependency-free so RootLayout can run it server-side and tests can
 * verify identity and semantic preservation without a DOM.
 *
 * Studio is a read-only consumer: it never migrates a v1 file. Each version
 * gets its own explicit conversion path, so v1 data renders as v1 data and
 * only v2 data can show bindings, evidence, and curation.
 */

/** A parsed ia.json plus the contract it was parsed with. */
export type StudioIaDocument =
  | { version: 1; file: IaFileV1 }
  | { version: 2; file: IaFileV2 };

/** Last non-empty path segment. '/a/b/c' → 'c', '/' → ''. */
function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Map core platform values onto Studio's compact three-way reach. */
function mapPlatform(
  platform: IaNodeV1['platform'] | IaTreeV1['platform'],
): Platform {
  if (platform === 'desktop') return 'desktop-only';
  if (platform === 'mobile') return 'mobile-only';
  return 'both';
}

/** Resolve an IA label to display text. Plain strings pass through; a
 *  TermRef resolves against the lexicon (first available locale text),
 *  falling back to a `{TERM-ID}` placeholder when unresolved. */
function resolveLabel(label: IaLabel, lexicon?: LexiconTerm[]): string {
  if (typeof label === 'string') return label;
  const ref = label.term_ref;
  const term = lexicon?.find((t) => t.term_id === ref);
  const map = term?.locales ?? term?.snapshot;
  const text = map ? Object.values(map)[0] : undefined;
  return text ?? `{${ref}}`;
}

/** Normalize a resolved grouping label into a stable identity component. */
function slug(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'group';
}

/**
 * Node identity: a path owns its own namespace, a pathless container is
 * numbered per resolved label. Shared by both versions so a deep link stays
 * valid when a service moves from v1 to v2.
 */
function nodeIdentity(
  path: string | undefined,
  title: string,
  occurrences: Map<string, number>,
): string {
  if (path !== undefined) return `path:${path}`;
  const labelSlug = slug(title);
  const occurrence = (occurrences.get(labelSlug) ?? 0) + 1;
  occurrences.set(labelSlug, occurrence);
  return `group:${labelSlug}#${occurrence}`;
}

/** Convert a v1 sibling group without flattening pathless IA containers. */
function convertV1Siblings(
  nodes: readonly IaNodeV1[],
  parentKey: string,
  inheritedPlatform: IaTreeV1['platform'],
  lexicon?: LexiconTerm[],
): StudioIaNode[] {
  const occurrences = new Map<string, number>();
  return nodes.map((node) => {
    const title = resolveLabel(node.label, lexicon);
    const identity = nodeIdentity(node.path, title, occurrences);
    const key = `${parentKey}/${encodeURIComponent(identity)}`;
    const effectivePlatform = node.platform ?? inheritedPlatform;
    return {
      key,
      path: node.path,
      seg: node.path ? lastSegment(node.path) : '',
      title,
      ...(node.dok_ref === undefined ? {} : { dok_ref: node.dok_ref }),
      platform: mapPlatform(effectivePlatform),
      tags: node.tags ?? [],
      unmapped: node.path !== undefined && node.dok_ref === undefined,
      children: convertV1Siblings(
        node.children,
        key,
        effectivePlatform,
        lexicon,
      ),
    };
  });
}

/**
 * Convert a v2 sibling group. A destination surfaces its bindings, evidence,
 * and curated fields verbatim; a group reuses the v1 container marker
 * (`dok_ref: null`) so page counting and filters stay version agnostic.
 */
function convertV2Siblings(
  nodes: readonly IaNodeV2[],
  parentKey: string,
  inheritedPlatform: IaTreeV2['platform'],
  lexicon?: LexiconTerm[],
): StudioIaNode[] {
  const occurrences = new Map<string, number>();
  return nodes.map((node) => {
    const title = resolveLabel(node.label, lexicon);
    const identity = nodeIdentity(node.path, title, occurrences);
    const key = `${parentKey}/${encodeURIComponent(identity)}`;
    const effectivePlatform = node.platform ?? inheritedPlatform;
    const common = {
      key,
      path: node.path,
      seg: node.path ? lastSegment(node.path) : '',
      title,
      kind: node.kind,
      curatedFields: [...node.curated_fields],
      platform: mapPlatform(effectivePlatform),
      tags: node.tags,
      children: convertV2Siblings(
        node.children,
        key,
        effectivePlatform,
        lexicon,
      ),
    };

    if (node.kind === 'group') {
      return { ...common, dok_ref: null, unmapped: false };
    }
    return {
      ...common,
      bindings: node.bindings.map((binding) => ({
        dokRef: binding.dok_ref,
        source: binding.source,
      })),
      ...(node.evidence === undefined
        ? {}
        : { evidence: node.evidence.map((item) => ({ file: item.file })) }),
      unmapped: node.bindings.length === 0,
    };
  });
}

/**
 * Preserve every service IA tree as an independent Studio catalog entry.
 * File and tree iteration retain workspace/storage order for deterministic
 * initial selection.
 */
export function iaFilesToTrees(
  documents: Record<string, StudioIaDocument | null>,
  lexicon?: LexiconTerm[],
): StudioIaTree[] {
  const trees: StudioIaTree[] = [];
  for (const serviceId of Object.keys(documents)) {
    const document = documents[serviceId];
    if (!document) continue;
    const { service_id: fileServiceId } = document.file;

    if (document.version === 2) {
      for (const tree of document.file.trees) {
        const treeKey = `${fileServiceId}::${tree.tree_id}`;
        trees.push({
          key: treeKey,
          serviceId: fileServiceId,
          treeId: tree.tree_id,
          type: tree.type,
          source: tree.source,
          platform: mapPlatform(tree.platform),
          nodes: convertV2Siblings(
            tree.nodes,
            treeKey,
            tree.platform,
            lexicon,
          ),
        });
      }
      continue;
    }

    for (const tree of document.file.trees) {
      const treeKey = `${fileServiceId}::${tree.tree_id}`;
      trees.push({
        key: treeKey,
        serviceId: fileServiceId,
        treeId: tree.tree_id,
        type: tree.type,
        source: tree.source,
        platform: mapPlatform(tree.platform),
        nodes: convertV1Siblings(tree.nodes, treeKey, tree.platform, lexicon),
      });
    }
  }
  return trees;
}

/** Count routable page nodes, including unmapped pages and excluding
 *  containers — v1 pathless/synthetic containers and v2 groups alike. */
export function countIaPageNodes(trees: readonly StudioIaTree[]): number {
  let count = 0;
  const visit = (nodes: readonly StudioIaNode[]): void => {
    for (const node of nodes) {
      if (node.path !== undefined && node.dok_ref !== null) count += 1;
      visit(node.children);
    }
  };
  trees.forEach((tree) => visit(tree.nodes));
  return count;
}
