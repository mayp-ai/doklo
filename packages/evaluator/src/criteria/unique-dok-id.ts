// Criterion: unique-dok-id (Tier 1, structural)
//
// Every dok_id must appear exactly once. Duplicates corrupt the per-Dok
// file model: two doks sharing one dok_id both serialize to the same
// `.doklo/hub/doks/{dok_id}.json` path, so writing them silently
// overwrites one with the other. They would also collide on the same
// BR-{DOK_ID}-NN / AC-{DOK_ID}-NN business-rule / acceptance-criteria
// id space.
//
// No autoFix. Before the -NNN serial was removed, a duplicate could be
// resolved by bumping the loser to the next free number in its prefix —
// but a semantic dok_id has no "next slot" to renumber into, and minting
// one would mean guessing what the duplicate should have been called
// (human judgment, not a mechanical transform). Silently picking a new
// id would also violate this project's collision policy: duplicates are
// surfaced as errors, never quietly transformed. This mirrors
// `ExistingDokIdConflictError` in
// packages/generator/src/id-reconciliation.ts, which fails the same way
// for the analogous cross-regeneration collision.

import type { Dok } from '@doklo-beta/core';
import type { Criterion, Violation } from '../types.js';

export interface UniqueDokIdViolationData {
  /** The duplicated dok_id shared by every occurrence in this group. */
  dokId: string;
  /** Total number of doks sharing this dok_id. */
  occurrenceCount: number;
  /** Zero-based indexes into the evaluated doks[] for every occurrence. */
  occurrenceIndexes: number[];
}

/** Where this dok_id would serialize to, per the per-Dok file convention. */
function impliedFilePath(dokId: string): string {
  return `.doklo/hub/doks/${dokId}.json`;
}

/**
 * Best-effort disambiguator for one colliding occurrence: prefer recorded
 * provenance (service + source feature) when available, otherwise fall
 * back to the occurrence's position in the evaluated list.
 */
function describeOccurrence(dok: Dok, index: number): string {
  const origin = dok._meta?.origins?.[0];
  if (origin) {
    return `doks[${index}] (service=${origin.service_id}, feature=${origin.canonical_feature_id})`;
  }
  return `doks[${index}]`;
}

export const uniqueDokId: Criterion<UniqueDokIdViolationData> = {
  id: 'unique-dok-id',
  description: 'dok_id는 모든 doks에서 유일해야 함',
  category: 'structural',
  tier: 1,
  manualOnly: true,

  evaluate(input) {
    const violations: Violation<UniqueDokIdViolationData>[] = [];
    const indexesByDokId = new Map<string, number[]>();
    input.doks.forEach((dok, index) => {
      const indexes = indexesByDokId.get(dok.dok_id);
      if (indexes) indexes.push(index);
      else indexesByDokId.set(dok.dok_id, [index]);
    });

    for (const [dokId, indexes] of indexesByDokId) {
      if (indexes.length < 2) continue;
      const occurrences = indexes
        .map((index) => describeOccurrence(input.doks[index]!, index))
        .join(', ');
      violations.push({
        dokId,
        message:
          `duplicate dok_id "${dokId}" found in ${indexes.length} doks (${occurrences}) `
          + `— all would collide on ${impliedFilePath(dokId)}. `
          + 'Rename one in Studio\'s consolidation screen, or edit it directly in the consolidated '
          + 'cache (`.doklo/cache/<service>.consolidated.json`), and re-run generate.',
        severity: 'error',
        data: { dokId, occurrenceCount: indexes.length, occurrenceIndexes: indexes },
      });
    }
    return violations;
  },
};
