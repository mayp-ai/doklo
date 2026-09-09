import {
  PRIORITY_CURATABLE_FIELDS,
  type DokPriority,
  type DokPriorityCurated,
} from '@doklo-beta/core';

/**
 * Merge a freshly derived priority over the one already on disk.
 *
 * Two rules, no heuristics:
 *
 *   1. `curated` comes from `previous`, always. A producer can never unpin
 *      what a person pinned — otherwise a regeneration silently reopens every
 *      judgment a human already settled.
 *   2. `signals` come from `derived`, always. Evidence is re-derived every
 *      run, so a file that moved leaves no dead anchor behind. This is why
 *      `signals` is not a pinnable key in the first place.
 *
 * A pinned axis keeps its previous value; an unpinned axis takes the derived
 * one. When this run produced no judgment at all, the previous one survives
 * untouched — dropping a human's call because the model stayed quiet would be
 * the worst of both behaviors.
 *
 * Same shape as `curatedOverlay` in ia-merge.ts, which solves the identical
 * problem for IA nodes.
 */
export function mergePriority(
  derived: DokPriority | undefined,
  previous: DokPriority | undefined,
): DokPriority | undefined {
  if (derived === undefined) return previous;
  if (previous === undefined) return derived;

  const curated: DokPriorityCurated = { ...previous.curated };
  const merged: DokPriority = {
    ...derived,
    curated,
    signals: derived.signals,
  };

  for (const field of PRIORITY_CURATABLE_FIELDS) {
    if (curated[field] === undefined) continue;
    if (field === 'impact') merged.impact = previous.impact;
    else merged.blast_radius = previous.blast_radius;
  }

  return merged;
}
