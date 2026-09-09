import type { Dok } from '@doklo-beta/core';
import {
  derivePriorityTier,
  type BlastRadius,
  type BusinessImpact,
  type PriorityTier,
} from '@doklo-beta/core/schemas';

// Priority ordering and row presentation, shared by the catalog and the
// editor rail so the two lists cannot drift apart.
//
// Impact is compared on the ENUM, not on the derived tier: revenue,
// core_value and compliance all derive to `critical`, so the tier cannot tell
// them apart. revenue leads because a broken money path loses something
// unrecoverable, while a broken generation path can be retried.

export const IMPACT_RANK: Record<BusinessImpact, number> = {
  revenue: 0,
  core_value: 1,
  compliance: 2,
  enabling: 3,
  supporting: 4,
};

export const BLAST_RANK: Record<BlastRadius, number> = {
  blocking: 0,
  degrading: 1,
  cosmetic: 2,
};

// An unjudged Dok sorts as enabling/degrading — mid-pack. Ranking it first
// makes "not judged" look important; ranking it last makes it vanish. The
// same reasoning derivePriorityTier uses when it reads absent as `standard`.
const UNJUDGED_IMPACT = IMPACT_RANK.enabling;
const UNJUDGED_BLAST = BLAST_RANK.degrading;

/**
 * Sort comparator: impact, then blast radius, then dok_id.
 *
 * Feeding this to a global sort is also what produces the domain ordering the
 * catalog shows — `useDoksByDomain` groups by first appearance, so a domain
 * lands wherever its highest-priority Dok does, children intact.
 */
export function comparePriority(a: Dok, b: Dok): number {
  const impactA = a.priority ? IMPACT_RANK[a.priority.impact] : UNJUDGED_IMPACT;
  const impactB = b.priority ? IMPACT_RANK[b.priority.impact] : UNJUDGED_IMPACT;
  if (impactA !== impactB) return impactA - impactB;

  const blastA = a.priority ? BLAST_RANK[a.priority.blast_radius] : UNJUDGED_BLAST;
  const blastB = b.priority ? BLAST_RANK[b.priority.blast_radius] : UNJUDGED_BLAST;
  if (blastA !== blastB) return blastA - blastB;

  return a.dok_id.localeCompare(b.dok_id);
}

export const IMPACT_LABEL: Record<BusinessImpact, string> = {
  revenue: 'revenue',
  core_value: 'core value',
  compliance: 'compliance',
  enabling: 'enabling',
  supporting: 'supporting',
};

export const BLAST_LABEL: Record<BlastRadius, string> = {
  blocking: 'blocking',
  degrading: 'degrading',
  cosmetic: 'cosmetic',
};

export const TIER_CHIP: Record<PriorityTier, string> = {
  critical: 'bg-status-deprecated-bg text-status-deprecated-fg',
  standard: 'bg-surface-2 text-ink-secondary',
  peripheral: 'bg-transparent text-ink-faint',
};

/**
 * One word naming why a Dok is critical, or null when it is not.
 *
 * A list only marks the Doks that need attention — labelling every row states
 * the obvious for `standard` and buries the few rows that matter. One word is
 * enough because the question a reader has is "why is this one flagged", and
 * the answer is always a single axis value: the qualifying impact, or
 * `blocking` when the blast radius is what earned it. Sign-in is the case that
 * forces this — it is `enabling`, so printing its impact would read as a
 * contradiction rather than an explanation.
 */
export function criticalReason(dok: Dok): string | null {
  const priority = dok.priority;
  if (priority === undefined) return null;
  if (derivePriorityTier(priority) !== 'critical') return null;
  if (priority.impact !== 'enabling' && priority.impact !== 'supporting') {
    return IMPACT_LABEL[priority.impact];
  }
  return BLAST_LABEL.blocking;
}

/**
 * The label a list row shows, or null when the Dok has not been judged.
 *
 * A coloured bar alone is not self-explanatory — nothing on screen says what
 * it means — so every list surface that marks a row also names the axes that
 * earned the mark.
 */
export function priorityLabels(dok: Dok): {
  tier: PriorityTier;
  impact: string;
  blast: string;
} | null {
  if (dok.priority === undefined) return null;
  return {
    tier: derivePriorityTier(dok.priority),
    impact: IMPACT_LABEL[dok.priority.impact],
    blast: BLAST_LABEL[dok.priority.blast_radius],
  };
}

/**
 * Row presentation for a Dok's tier.
 *
 * Only `critical` is marked and only `peripheral` is dimmed. Giving all three
 * tiers a colour would put two colour axes on one row alongside the status
 * pip, and priority exists to concentrate attention rather than to classify.
 * `marker` is empty when the row should carry no bar, `text` empty when the
 * row keeps default emphasis.
 */
export function tierRowTokens(dok: Dok): { marker: string; text: string } {
  const tier = derivePriorityTier(dok.priority);
  if (tier === 'critical') {
    return {
      marker: 'shadow-[inset_3px_0_0_var(--color-status-deprecated-fg)]',
      text: '',
    };
  }
  if (tier === 'peripheral') return { marker: '', text: 'text-ink-faint' };
  return { marker: '', text: '' };
}
