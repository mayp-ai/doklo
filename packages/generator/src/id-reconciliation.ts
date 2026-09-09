// Dok ID reconciliation across regenerations.
//
// Semantic dok_ids (AUTH-SIGNIN, not AUTH-001) are stable names, so a
// re-consolidation must not silently rename them: an LLM that answers
// `AUTH-LOGIN` this run would orphan `AUTH-SIGNIN.json` and every link,
// anchor and external reference pointing at it.
//
// This module is the memory that makes regeneration idempotent:
//   - `pinExistingDokIds` replaces LLM-proposed prefixes with the ids the
//     workspace already uses, matching on recorded provenance.
//   - `carryForwardMeta` keeps the identity/audit half of `_meta` alive across
//     a forced regeneration, while the evidence half comes from the fresh run.
//   - `upsertOriginsByService` maintains the per-service provenance those
//     matches read — one entry per service, always the latest run's.
//
// Pure functions only — all file I/O lives in the CLI commands that call them.

import type { DokMeta, DokOrigin } from '@doklo-beta/core';
import type { ConsolidatedFeatureConfig } from './legacy-types.js';

/**
 * What we know about one Dok that already exists in the workspace, projected
 * into the fields the matching ladder can compare against. One existing Dok
 * yields one identity per `_meta.origins` entry (a Dok can surface in several
 * services), or a single field-poor identity when it has no origins yet.
 */
export interface ExistingDokIdentity {
  dok_id: string;
  /** Owning service. Undefined = unscoped: matchable from any service. */
  service_id?: string;
  /** Consolidated feature this Dok was generated from. */
  canonical_feature_id?: string;
  primary_route?: string;
}

export interface PinnedDokId {
  canonical_id: string;
  dok_id: string;
}

export interface PinExistingDokIdsResult {
  /** Structural copy of the input with pinned `dok_id_prefix` values. */
  config: ConsolidatedFeatureConfig;
  /** Features bound to an existing id, including ids the LLM already got right. */
  pinned: PinnedDokId[];
  /**
   * Ids of this service's existing Doks that no surviving feature holds,
   * first-seen order. Their files are still on disk — the caller reserves them
   * so nothing else takes the id, and warns the user. Never deleted
   * automatically. Doks owned by another service are out of scope, not orphans.
   *
   * "Holds", not "was pinned to": an id can end up on a feature without a pin
   * (the model proposed it, or a pin was dropped by the swap guard). That file
   * is about to be rewritten, which is the opposite of abandoned.
   */
  orphans: string[];
}

const UNSCOPED = '*';

/**
 * Pin LLM-proposed prefixes to the ids this workspace already uses.
 *
 * Matching ladder, applied per feature in stored order:
 *   ① `service_id` + `canonical_feature_id` exact — the feature is the same one.
 *   ② `primary_route` exact within the same service — the feature was renamed
 *      but still owns the route.
 *
 * An existing id is consumed by its first match, so two features can never
 * collapse onto one id; the loser keeps its LLM proposal. A pin is also skipped
 * whenever any other feature currently proposes that id — reusing it would
 * produce two features with the same id, which `assignDokIds` rejects. That
 * check is deliberately blunt: it holds even when the other feature is itself
 * pinned elsewhere and would vacate the id, so a model that swaps two ids ends
 * up with neither pinned (exactly what happened before pinning existed) rather
 * than with a resolution order that could cascade into a duplicate.
 *
 * Identities owned by another service are ignored outright: this call neither
 * pins them nor reports them as orphans, so the caller may hand over the whole
 * workspace's identities without pre-filtering.
 */
export function pinExistingDokIds(
  config: ConsolidatedFeatureConfig,
  existing: readonly ExistingDokIdentity[],
  serviceId: string,
): PinExistingDokIdsResult {
  const inScope = existing.filter(
    (identity) => identity.service_id === undefined || identity.service_id === serviceId,
  );

  const byCanonical = new Map<string, string>();
  const byRoute = new Map<string, string>();
  for (const identity of inScope) {
    const scope = identity.service_id ?? UNSCOPED;
    if (identity.canonical_feature_id) {
      const key = `${scope}::${identity.canonical_feature_id}`;
      if (!byCanonical.has(key)) byCanonical.set(key, identity.dok_id);
    }
    if (identity.primary_route) {
      const key = `${scope}::${identity.primary_route}`;
      if (!byRoute.has(key)) byRoute.set(key, identity.dok_id);
    }
  }

  const features = config.groups.flatMap((group) => group.features);
  // Ids the LLM already proposed. A pin onto one of these is dropped unless the
  // proposing feature is itself pinned elsewhere (it then vacates the id).
  const proposals = new Map<string, number>();
  for (const feature of features) {
    if (feature.decision === 'exclude' || !feature.dok_id_prefix) continue;
    proposals.set(feature.dok_id_prefix, (proposals.get(feature.dok_id_prefix) ?? 0) + 1);
  }

  // Pass 1 — ladder match. `consumed` keeps one existing id from pinning twice.
  const consumed = new Set<string>();
  const targets = new Map<string, string>();
  for (const feature of features) {
    if (feature.decision === 'exclude') continue;
    const hit =
      lookup(byCanonical, serviceId, feature.canonical_id)
      ?? lookup(byRoute, serviceId, feature.primary_route);
    if (hit === undefined || consumed.has(hit)) continue;
    consumed.add(hit);
    targets.set(feature.canonical_id, hit);
  }

  // Pass 2 — drop pins that would duplicate an id another feature keeps.
  const pinned: PinnedDokId[] = [];
  const applied = new Map<string, string>();
  for (const feature of features) {
    const target = targets.get(feature.canonical_id);
    if (target === undefined) continue;
    const claimants = proposals.get(target) ?? 0;
    const claimedByThisFeature = feature.dok_id_prefix === target ? 1 : 0;
    // Dropped: the id stays with whichever feature proposed it, which is also
    // why nothing needs to un-consume it — `consumed` has done its job (pass 1
    // is over) and orphans are counted from what the features end up holding.
    if (claimants - claimedByThisFeature > 0) continue;
    applied.set(feature.canonical_id, target);
    pinned.push({ canonical_id: feature.canonical_id, dok_id: target });
  }

  // Ids the run ends up holding — pinned or simply proposed and kept. An id in
  // here still has a feature writing to it, so it is not an orphan even though
  // the pin that would have claimed it may have been dropped above.
  const assigned = new Set<string>();
  for (const feature of features) {
    if (feature.decision === 'exclude') continue;
    const id = applied.get(feature.canonical_id) ?? feature.dok_id_prefix;
    if (id) assigned.add(id);
  }

  const orphans: string[] = [];
  const seen = new Set<string>();
  for (const identity of inScope) {
    if (assigned.has(identity.dok_id) || seen.has(identity.dok_id)) continue;
    seen.add(identity.dok_id);
    orphans.push(identity.dok_id);
  }

  return {
    config: {
      ...config,
      groups: config.groups.map((group) => ({
        ...group,
        features: group.features.map((feature) => {
          const target = applied.get(feature.canonical_id);
          return target === undefined
            ? { ...feature }
            : { ...feature, dok_id_prefix: target };
        }),
      })),
    },
    pinned,
    orphans,
  };
}

/**
 * A feature was assigned an id that provably belongs to a different Dok.
 *
 * Not recoverable in code: only the user knows whether the old Dok should be
 * deleted or the new feature renamed, and guessing either way silently rewrites
 * documentation — the failure mode this whole module exists to prevent.
 */
export class ExistingDokIdConflictError extends Error {
  constructor(
    readonly dokId: string,
    readonly canonicalId: string,
    readonly ownerFeatureId: string,
  ) {
    super(
      `Dok id "${dokId}" was assigned to feature "${canonicalId}", but it already `
      + `documents feature "${ownerFeatureId}". Reusing it would overwrite that Dok `
      + '(and graft its version, history and external ids onto different content). '
      + `Rename this feature's dok_id_prefix in Studio's consolidation screen, or edit it `
      + 'directly in the consolidated cache (`.doklo/cache/<service>.consolidated.json`), '
      + `or delete the stale .doklo/hub/doks/${dokId}.json, then retry.`,
    );
    this.name = 'ExistingDokIdConflictError';
  }
}

/**
 * A feature took over an existing Dok whose ownership nothing could confirm.
 *
 * Not an error (see `assertNoUnpinnedIdCapture`), but not a non-event either:
 * that Dok file keeps its id and inherits its version, history and external ids
 * while its content is rewritten from a feature nobody proved is the same one.
 */
export interface UnverifiedIdReuse {
  dok_id: string;
  canonical_id: string;
}

/**
 * Fail closed on an id that reached a feature without evidence it belongs there.
 *
 * `pinExistingDokIds` binds a feature to an existing id only on a ladder match.
 * An id can still arrive unmatched — the prompt advertises the workspace's ids,
 * so a model can apply one to a feature whose provenance says otherwise (a
 * deleted feature's id landing on a new one, or two features swapping ids).
 * Nothing downstream catches that: `assignDokIds` only sees intra-run
 * duplicates, and the write path accepts the file because its `dok_id` matches.
 *
 * Only identities carrying provenance are enforced. An existing Dok with no
 * `canonical_feature_id` or `primary_route` (generated before origins existed)
 * cannot be matched — and cannot be contradicted either, so reuse is allowed and
 * the run seeds its origins. Blocking there would fail the first regeneration of
 * every pre-origins workspace.
 *
 * Allowed is not the same as unremarkable: every such takeover is returned so
 * the caller can tell the user which file changed hands. Keeping the exemption
 * and the notice in one pass is deliberate — a separate detector would be free
 * to drift out of step with the condition it is supposed to be reporting.
 */
export function assertNoUnpinnedIdCapture(
  config: ConsolidatedFeatureConfig,
  existing: readonly ExistingDokIdentity[],
  serviceId: string,
  pinned: readonly PinnedDokId[],
): UnverifiedIdReuse[] {
  const owners = new Map<string, string>();
  const inScopeIds = new Set<string>();
  for (const identity of existing) {
    if (identity.service_id !== undefined && identity.service_id !== serviceId) continue;
    inScopeIds.add(identity.dok_id);
    const owner = identity.canonical_feature_id ?? identity.primary_route;
    if (owner === undefined || owners.has(identity.dok_id)) continue;
    owners.set(identity.dok_id, owner);
  }
  if (inScopeIds.size === 0) return [];

  const unverified: UnverifiedIdReuse[] = [];
  const pinnedIds = new Map(pinned.map((entry) => [entry.canonical_id, entry.dok_id]));
  for (const group of config.groups) {
    for (const feature of group.features) {
      if (feature.decision === 'exclude' || !feature.dok_id_prefix) continue;
      const claimIsPinned = pinnedIds.get(feature.canonical_id) === feature.dok_id_prefix;
      const owner = owners.get(feature.dok_id_prefix);
      if (owner === undefined) {
        // No provenance to contradict — the exemption. Report the takeover of
        // an id that is nonetheless a file on disk; ids nobody holds yet are
        // simply new and say nothing. A pin is evidence in itself, so anything
        // the ladder matched is verified and stays quiet.
        if (inScopeIds.has(feature.dok_id_prefix) && !claimIsPinned) {
          unverified.push({
            dok_id: feature.dok_id_prefix,
            canonical_id: feature.canonical_id,
          });
        }
        continue;
      }
      if (claimIsPinned) continue;
      throw new ExistingDokIdConflictError(
        feature.dok_id_prefix,
        feature.canonical_id,
        owner,
      );
    }
  }
  return unverified;
}

/** Service-scoped lookup first, then the unscoped fallback. */
function lookup(
  index: Map<string, string>,
  serviceId: string,
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return index.get(`${serviceId}::${value}`) ?? index.get(`${UNSCOPED}::${value}`);
}

/**
 * Merge the on-disk `_meta` into a freshly generated one.
 *
 * Two halves, split by who is authoritative:
 *   - identity/audit (`version`, `history`, `external_ids`, `created_at`,
 *     `origins`, `previous_ids`) belongs to the file's life story → the
 *     existing values survive, with `version` bumped for this regeneration.
 *   - evidence (`source_anchors`, `logic_hash`, `logic_files`,
 *     `anchor_service_id`, `generation_confidence`, `updated_at`) describes the
 *     code as of *now* → the fresh values win.
 *
 * `edited_by_human` is deliberately dropped: a regeneration replaces the human
 * prose it marked, so re-stamping it would make `doklo sync` skip a Dok whose
 * edits are already gone (same policy as sync's forced regeneration).
 */
export function carryForwardMeta(existing: DokMeta | undefined, fresh: DokMeta): DokMeta {
  if (existing === undefined) return fresh;

  const merged: DokMeta = { ...fresh };
  merged.version = (existing.version ?? 0) + 1;
  merged.history = existing.history ?? fresh.history ?? [];
  if (existing.external_ids !== undefined) merged.external_ids = existing.external_ids;
  if (existing.created_at !== undefined) merged.created_at = existing.created_at;
  if (existing.previous_ids !== undefined) merged.previous_ids = existing.previous_ids;

  const origins = upsertOriginsByService(existing.origins, fresh.origins);
  if (origins.length > 0) merged.origins = origins;

  delete merged.edited_by_human;
  return merged;
}

/**
 * Fold this run's provenance into a Dok's origins — **one entry per service**.
 *
 * A service produces a given Dok from exactly one consolidated feature per run,
 * so its origin entry is a current fact, not a log: the incoming entry replaces
 * the one already recorded for that `service_id` (keeping its position, so the
 * array stays diff-stable), and entries belonging to other services are left
 * exactly as they were. A service not represented in `incoming` is untouched —
 * `doklo generate --service web` must not disturb what admin recorded.
 *
 * Accumulating instead would be actively unsafe. Every `canonical_feature_id`
 * in origins is a live matching key for `pinExistingDokIds` rung ①, so a
 * renamed feature's superseded id would keep answering to this Dok forever, and
 * an unrelated future feature that happened to take that name would be pinned
 * onto — and overwrite — a Dok it has nothing to do with. Replacement makes the
 * keys self-healing and bounds origins to the number of services.
 */
export function upsertOriginsByService(
  existing: readonly DokOrigin[] | undefined,
  incoming: readonly DokOrigin[] | undefined,
): DokOrigin[] {
  const order: string[] = [];
  const byService = new Map<string, DokOrigin>();
  for (const origin of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!byService.has(origin.service_id)) order.push(origin.service_id);
    byService.set(origin.service_id, origin);
  }
  return order.map((serviceId) => byService.get(serviceId)!);
}
