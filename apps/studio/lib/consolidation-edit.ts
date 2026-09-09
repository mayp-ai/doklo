// Pure structural reducers over a ConsolidatedFeatureConfig. No IO. Every
// function returns a new config and never mutates its input, so the board
// can drive them from useReducer and tests can assert immutability.
import type {
  ConsolidatedFeatureConfig,
  ConsolidatedFeatureGroup,
  ConsolidatedFeature,
} from './consolidation';

function mapGroups(
  cfg: ConsolidatedFeatureConfig,
  fn: (g: ConsolidatedFeatureGroup) => ConsolidatedFeatureGroup,
): ConsolidatedFeatureConfig {
  return { ...cfg, groups: cfg.groups.map(fn) };
}

export function renameGroup(
  cfg: ConsolidatedFeatureConfig,
  groupId: string,
  label: string,
): ConsolidatedFeatureConfig {
  return mapGroups(cfg, (g) => (g.group_id === groupId ? { ...g, label } : g));
}

/** Merge 2+ groups into the first-listed one (features + excluded concat). */
export function mergeGroups(
  cfg: ConsolidatedFeatureConfig,
  groupIds: string[],
  label?: string,
): ConsolidatedFeatureConfig {
  if (groupIds.length < 2) return cfg;
  const targetId = cfg.groups.find((g) => groupIds.includes(g.group_id))?.group_id;
  if (!targetId) return cfg;
  const merged = groupIds.filter((id) => id !== targetId);
  const absorbed = cfg.groups.filter((g) => merged.includes(g.group_id));
  const groups: ConsolidatedFeatureGroup[] = [];
  for (const g of cfg.groups) {
    if (merged.includes(g.group_id)) continue;
    if (g.group_id === targetId) {
      groups.push({
        ...g,
        label: label ?? g.label,
        features: [...g.features, ...absorbed.flatMap((a) => a.features)],
        excluded: [...g.excluded, ...absorbed.flatMap((a) => a.excluded)],
      });
    } else {
      groups.push(g);
    }
  }
  return { ...cfg, groups };
}

/** Move `canonicalIds` out of `groupId` into a new group. Origin group is
 *  dropped if it becomes empty. */
export function splitGroup(
  cfg: ConsolidatedFeatureConfig,
  groupId: string,
  canonicalIds: string[],
  newGroup: { group_id: string; label: string },
): ConsolidatedFeatureConfig {
  const source = cfg.groups.find((g) => g.group_id === groupId);
  if (!source) return cfg;
  const moving = source.features.filter((f) => canonicalIds.includes(f.canonical_id));
  if (moving.length === 0) return cfg;
  const remaining = source.features.filter((f) => !canonicalIds.includes(f.canonical_id));

  const groups: ConsolidatedFeatureGroup[] = [];
  for (const g of cfg.groups) {
    if (g.group_id !== groupId) {
      groups.push(g);
      continue;
    }
    if (remaining.length > 0) groups.push({ ...g, features: remaining });
    groups.push({
      group_id: newGroup.group_id,
      label: newGroup.label,
      features: moving,
      excluded: [],
    });
  }
  return { ...cfg, groups };
}

/** Set a feature's dok_id_prefix from a Studio edit. Grammar/collision
 *  validation is the caller's job (client-side DokIdSchema styling in
 *  FeatureRow, server-side schema + same-cache duplicate guard in
 *  saveConsolidatedAction) — this just records the typed value verbatim,
 *  including a momentarily-invalid one, so the row can show live feedback
 *  without the reducer silently discarding what the user typed. */
export function setDokIdPrefix(
  cfg: ConsolidatedFeatureConfig,
  canonicalId: string,
  dokIdPrefix: string,
): ConsolidatedFeatureConfig {
  return mapGroups(cfg, (g) => ({
    ...g,
    features: g.features.map((f) =>
      f.canonical_id === canonicalId ? { ...f, dok_id_prefix: dokIdPrefix } : f,
    ),
  }));
}

export function moveFeature(
  cfg: ConsolidatedFeatureConfig,
  canonicalId: string,
  toGroupId: string,
): ConsolidatedFeatureConfig {
  const home = cfg.groups.find((g) => g.features.some((f) => f.canonical_id === canonicalId));
  const feature = home?.features.find((f) => f.canonical_id === canonicalId);
  // No-op when the feature doesn't exist or is already in the target group —
  // otherwise the remove-branch below would drop it without re-adding.
  if (!feature || !home || home.group_id === toGroupId) return cfg;
  return mapGroups(cfg, (g) => {
    if (g.features.some((f) => f.canonical_id === canonicalId)) {
      return { ...g, features: g.features.filter((f) => f.canonical_id !== canonicalId) };
    }
    if (g.group_id === toGroupId) {
      return { ...g, features: [...g.features, feature] };
    }
    return g;
  });
}

/** A `group-N` id not already in use. */
export function newGroupId(cfg: ConsolidatedFeatureConfig): string {
  const used = new Set(cfg.groups.map((g) => g.group_id));
  let n = cfg.groups.length + 1;
  while (used.has(`group-${n}`)) n += 1;
  return `group-${n}`;
}

/** Fallback restore for features excluded before prev_decision existed
 *  (legacy caches / consolidator-authored excludes). */
function restoredDecision(members: string[]): 'merge' | 'keep' {
  return members.length > 1 ? 'merge' : 'keep';
}

/** Set decision:'exclude', remembering the prior decision so re-include is
 *  lossless (a keep-with-many-members must not become a merge). */
function excludeFeature(f: ConsolidatedFeature): ConsolidatedFeature {
  if (f.decision === 'exclude') return f;
  return { ...f, prev_decision: f.decision, decision: 'exclude' };
}

/** Restore a feature's decision from prev_decision (fallback to member count). */
function includeFeature(f: ConsolidatedFeature): ConsolidatedFeature {
  if (f.decision !== 'exclude') return f;
  const { prev_decision, ...rest } = f;
  return { ...rest, decision: prev_decision ?? restoredDecision(f.members) };
}

export function toggleExcludeFeature(
  cfg: ConsolidatedFeatureConfig,
  canonicalId: string,
): ConsolidatedFeatureConfig {
  return mapGroups(cfg, (g) => ({
    ...g,
    features: g.features.map((f) =>
      f.canonical_id === canonicalId
        ? f.decision === 'exclude'
          ? includeFeature(f)
          : excludeFeature(f)
        : f,
    ),
  }));
}

export function excludeGroup(
  cfg: ConsolidatedFeatureConfig,
  groupId: string,
  exclude: boolean,
): ConsolidatedFeatureConfig {
  return mapGroups(cfg, (g) =>
    g.group_id === groupId
      ? {
          ...g,
          features: g.features.map((f) => (exclude ? excludeFeature(f) : includeFeature(f))),
        }
      : g,
  );
}

const liveFeatures = (cfg: ConsolidatedFeatureConfig) =>
  cfg.groups.flatMap((g) => g.features).filter((f) => f.decision !== 'exclude');

export function countDoks(cfg: ConsolidatedFeatureConfig): number {
  return liveFeatures(cfg).length;
}

export function countExcluded(cfg: ConsolidatedFeatureConfig): number {
  return cfg.groups.flatMap((g) => g.features).filter((f) => f.decision === 'exclude').length;
}

export function countDomains(cfg: ConsolidatedFeatureConfig): number {
  return cfg.groups.length;
}

/** Recompute the stats block from the current edited state. originalFeatures
 *  is preserved (it describes the pre-consolidation source count). */
export function recomputeStats(cfg: ConsolidatedFeatureConfig): ConsolidatedFeatureConfig {
  const live = liveFeatures(cfg);
  return {
    ...cfg,
    stats: {
      originalFeatures: cfg.stats.originalFeatures,
      consolidatedFeatures: live.length,
      merges: live.filter((f) => f.decision === 'merge').length,
      excluded: countExcluded(cfg),
    },
  };
}
