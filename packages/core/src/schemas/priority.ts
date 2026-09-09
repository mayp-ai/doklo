import { z } from 'zod';
import { SourceAnchorSchema } from './code-anchor.js';

// Dok priority — a two-axis business judgment, not a single grade.
//
// A single importance number cannot place sign-in: it is low on the value
// axis and highest on the blockage axis, so one number forces the two into
// an unanswerable "is it 2 or 3?". Two axes place it exactly, and the tier
// consumers actually gate on is derived (see derivePriorityTier), never
// stored — a stored grade can drift out of agreement with its own axes.

/** What the business loses when this Dok breaks. */
export const BusinessImpactSchema = z.enum([
  'revenue',      // money moves directly — checkout, subscription, settlement, credits
  'core_value',   // the output the product exists to produce
  'compliance',   // a legal or contractual obligation
  'enabling',     // produces no value alone, but the three above are unreachable without it
  'supporting',   // the three above stay reachable without it
]);
export type BusinessImpact = z.infer<typeof BusinessImpactSchema>;

/** How many users are stopped when this Dok breaks. */
export const BlastRadiusSchema = z.enum([
  'blocking',     // every user is stopped
  'degrading',    // some features or some users
  'cosmetic',     // inconvenient, still passable
]);
export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

// Generator-written proof for an axis value. Same contract as SourceAnchor:
// injected deterministically from the code, never authored by the LLM, so it
// stays a fact. A signal justifies an axis; it never sets one.
export const PrioritySignalSchema = SourceAnchorSchema.extend({
  detector: z.string().min(1),
});
export type PrioritySignal = z.infer<typeof PrioritySignalSchema>;

// Why a person pinned an axis. `reason` is required: a pin changes pipeline
// behavior, and an unexplained pin becomes a fossil nobody dares touch. It
// also doubles as the acknowledgment that the pin was considered, which is
// why no separate mute token exists.
export const PriorityCurationSchema = z.object({
  reason: z.string().min(1),
  by: z.string().optional(),
  at: z.string().datetime().optional(),
}).passthrough();
export type PriorityCuration = z.infer<typeof PriorityCurationSchema>;

// Exactly two pinnable keys, enforced strictly. `signals` is deliberately
// absent: evidence must be re-derived on every run, or a file that moved
// leaves a dead anchor pinned forever. Same reason IA v2 keeps `evidence`
// out of IaCuratedFieldSchema.
export const DokPriorityCuratedSchema = z.strictObject({
  impact: PriorityCurationSchema.optional(),
  blast_radius: PriorityCurationSchema.optional(),
});
export type DokPriorityCurated = z.infer<typeof DokPriorityCuratedSchema>;

export const PRIORITY_CURATABLE_FIELDS = ['impact', 'blast_radius'] as const;
export type DokPriorityField = (typeof PRIORITY_CURATABLE_FIELDS)[number];

export const DokPrioritySchema = z.object({
  impact: BusinessImpactSchema,
  blast_radius: BlastRadiusSchema,
  signals: z.array(PrioritySignalSchema).default([]),
  curated: DokPriorityCuratedSchema.default({}),
}).passthrough();
export type DokPriority = z.infer<typeof DokPrioritySchema>;

export const PriorityTierSchema = z.enum(['critical', 'standard', 'peripheral']);
export type PriorityTier = z.infer<typeof PriorityTierSchema>;

const CRITICAL_IMPACTS: ReadonlySet<BusinessImpact> = new Set<BusinessImpact>([
  'revenue',
  'core_value',
  'compliance',
]);

/**
 * The tier consumers gate on. Rules are ORDERED — the first match wins.
 *
 *   1. critical    impact is revenue/core_value/compliance, OR blast is blocking
 *   2. peripheral  otherwise, impact is supporting
 *   3. standard    everything else (impact is enabling)
 *
 * Without the ordering, `enabling / blocking` (sign-in) matches both rule 1
 * and rule 3. An absent priority means "not judged", which reads as standard:
 * we do not guess high, and we do not guess low.
 */
export function derivePriorityTier(priority: DokPriority | undefined): PriorityTier {
  if (priority === undefined) return 'standard';
  if (CRITICAL_IMPACTS.has(priority.impact)) return 'critical';
  if (priority.blast_radius === 'blocking') return 'critical';
  if (priority.impact === 'supporting') return 'peripheral';
  return 'standard';
}

/**
 * The axes a person has pinned on this Dok, in the stable order declared by
 * PRIORITY_CURATABLE_FIELDS. The generator reads this to decide which axes to
 * leave out of the prompt entirely.
 */
export function lockedPriorityFields(
  priority: DokPriority | undefined,
): DokPriorityField[] {
  if (priority === undefined) return [];
  return PRIORITY_CURATABLE_FIELDS.filter(
    (field) => priority.curated[field] !== undefined,
  );
}
