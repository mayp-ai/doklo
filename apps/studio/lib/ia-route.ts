/** Studio's presentation-safe view of a typed IA catalog. */

export type Platform = 'both' | 'desktop-only' | 'mobile-only';
/** v2 structure types first, then the two frozen v1 types Studio still reads. */
export type StudioIaTreeType =
  | 'route_hierarchy'
  | 'organization'
  | 'navigation'
  | 'sitemap'
  | 'feature_group';
export type StudioIaSource = 'auto' | 'manual' | 'auto+manual';

/** v2 only — a Dok bound to a destination, with the provenance of the claim. */
export interface StudioIaBinding {
  dokRef: string;
  source: 'auto' | 'manual';
}

/** v2 only — producer-written proof that a destination exists in code. */
export interface StudioIaEvidence {
  file: string;
}

export interface StudioIaNode {
  /** Stable identity scoped by service, tree, and ancestry. */
  key: string;
  /** Canonical route path. Undefined for grouping nodes. */
  path?: string;
  /** Last non-empty route segment, or an empty string for grouping nodes. */
  seg: string;
  /** Resolved display label. */
  title: string;
  /** Dok mapping tri-state: string=mapped, null=container, absent=unmapped.
   *  v1 carries the mapping here; v2 destinations use `bindings` instead and
   *  v2 groups reuse the `null` container marker. */
  dok_ref?: string | null;
  /** v2 only — destinations are reachable surfaces, groups are containers. */
  kind?: 'destination' | 'group';
  /** v2 destinations only. Empty means the surface has no Dok yet. */
  bindings?: StudioIaBinding[];
  /** v2 auto route_hierarchy destinations only. */
  evidence?: StudioIaEvidence[];
  /** v2 only — fields a person froze against the next producer run. */
  curatedFields?: string[];
  /** Effective reach after inheriting tree/ancestor platform. */
  platform: Platform;
  tags: string[];
  /** True only for routable nodes whose Dok mapping is absent. */
  unmapped: boolean;
  children: StudioIaNode[];
}

/**
 * Dok ids a node claims. v2 reads `bindings` (a set with provenance), v1 reads
 * the single `dok_ref`. Containers in either version claim nothing.
 */
export function iaNodeDokRefs(node: StudioIaNode): string[] {
  if (node.bindings !== undefined) {
    return node.bindings.map((binding) => binding.dokRef);
  }
  return typeof node.dok_ref === 'string' ? [node.dok_ref] : [];
}

export interface StudioIaTree {
  /** Stable service/tree identity. */
  key: string;
  serviceId: string;
  treeId: string;
  type: StudioIaTreeType;
  source: StudioIaSource;
  platform: Platform;
  nodes: StudioIaNode[];
}

export interface IaJumpTarget {
  serviceId: string;
  treeId: string;
  nodeKey: string;
  path?: string;
}

/**
 * Split a segment into its static prefix and dynamic [param] markers.
 * "signup" → [{ text: 'signup', dynamic: false }]
 * "[token]" → [{ text: 'token', dynamic: true }] (brackets recreated in render)
 * "legacy/redirect-old" stays as a single static part for legacy paths.
 *
 * Returns an array so the renderer can colorise dynamic chunks
 * independently of the static surround (DESIGN.md: amber draft token).
 */
export function splitSegment(
  seg: string,
): Array<{ text: string; dynamic: boolean }> {
  if (!seg) return [{ text: '', dynamic: false }];
  if (seg.startsWith(':')) {
    return [{ text: seg.slice(1), dynamic: true }];
  }
  if (seg.startsWith('[') && seg.endsWith(']')) {
    return [{
      text: seg.replace(/^\[{1,2}(?:\.\.\.)?/, '').replace(/\]{1,2}$/, ''),
      dynamic: true,
    }];
  }
  return [{ text: seg, dynamic: false }];
}
