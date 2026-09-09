import { z } from 'zod';
import {
  DokIdSchema,
  RoleIdSchema,
  ServiceIdSchema,
  TermRefSchema,
  BusinessRuleIdSchema,
  AcceptanceCriteriaIdSchema,
} from './ids.js';
import { CodeAnchorSchema, SourceAnchorSchema } from './code-anchor.js';
import { DokPrioritySchema } from './priority.js';

// Translatable text — inline string or Lexicon-referenced term
export const TranslatableSchema = z.union([z.string().min(1), TermRefSchema]);

// Actor performing a step
export const ActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), role_ref: RoleIdSchema }).passthrough(),
  z.object({ kind: z.literal('system') }).passthrough(),
  z.object({ kind: z.literal('external'), label: z.string().min(1) }).passthrough(),
]);

// Platform a variant targets. 'all' = platform-agnostic.
export const PlatformSchema = z.enum([
  'desktop',
  'mobile',
  'tablet',
  'tv',
  'cli',
  'voice',
  'all',
]);

// Interaction type within a variant
export const InteractionSchema = z.enum([
  'click',
  'tap',
  'swipe-left',
  'swipe-right',
  'swipe-up',
  'swipe-down',
  'long-press',
  'hover',
  'keyboard',
  'voice',
  'drag',
  'scroll',
  'input',
  'submit',
  'navigate',
  'auto', // system-initiated
]);

// One device/platform-specific way to perform the step's intent
export const ActionVariantSchema = z.object({
  platform: PlatformSchema,
  interaction: InteractionSchema,
  // Target UI element — usually a TermRef
  target: TranslatableSchema.optional(),
  code_anchor: CodeAnchorSchema.optional(),
  // Override outcome only when it differs per variant (rare)
  outcome_override: TranslatableSchema.optional(),
}).passthrough();

// A user action step.
// intent / outcome are platform-agnostic business invariants.
// variants[] expresses how that intent is realized per platform/interaction.
export const UserActionStepSchema = z.object({
  order: z.number().int().positive(),
  actor: ActorSchema,
  intent: TranslatableSchema,
  outcome: TranslatableSchema,
  variants: z.array(ActionVariantSchema).default([]),
  preconditions: z.array(z.string()).optional(),
}).passthrough();

export const BusinessRuleTypeSchema = z.enum([
  'restriction',
  'policy',
  'validation',
  'calculation',
  'permission',
]);

export const BusinessRuleSchema = z.object({
  id: BusinessRuleIdSchema,
  description: TranslatableSchema,
  type: BusinessRuleTypeSchema,
  applies_to_roles: z.array(RoleIdSchema).optional(),
  code_anchor: CodeAnchorSchema.optional(),
}).passthrough();

// Structured acceptance criterion with ID and rule traceability
export const AcceptanceCriterionSchema = z.object({
  id: AcceptanceCriteriaIdSchema,
  statement: TranslatableSchema,
  related_rules: z.array(BusinessRuleIdSchema).default([]),
  // Optional Given-When-Then structure
  given: z.string().optional(),
  when: z.string().optional(),
  then: z.string().optional(),
}).passthrough();

export const DokStatusSchema = z.enum([
  'draft',       // LLM-generated, awaiting human review (low confidence)
  'review',      // pending human approval
  'active',      // verified and in production
  'planned',     // designed but not implemented
  'deprecated',  // being removed
  'archived',    // historical
]);

export const DokHistoryKindSchema = z.enum([
  'edited',       // a person saved a change note (Studio) — the note is `change`
  'status',       // a person moved the lifecycle status — `change` is the canonical marker; see `from`/`to`
  'regenerated',  // a regeneration proposal confirmed by a person's activation approval
  'baseline',     // synthetic: the Dok was already active before history tracking began
]);
// Keep a Changelog 1.1.0 sections.
export const DokHistoryCategorySchema = z.enum([
  'added', 'changed', 'deprecated', 'removed', 'fixed', 'security',
]);

export const DokHistoryEntrySchema = z.object({
  version: z.number().int().positive(),
  // ISO date (YYYY-MM-DD) — not full datetime, keeps PR diffs stable
  date: z.string(),
  change: z.string().min(1),
  author: z.string().optional(),
  // v2 (2026-08-16): all optional so pre-existing files and hand-written
  // entries keep parsing. A missing kind reads as 'edited'.
  kind: DokHistoryKindSchema.optional(),
  from: DokStatusSchema.optional(),
  to: DokStatusSchema.optional(),
  category: DokHistoryCategorySchema.optional(),
}).passthrough();

export const DokPendingChangeSourceSchema = z.enum([
  'diff',   // deterministic structural comparison of the previous vs regenerated Dok
  'human',  // `doklo sync --note`
  'model',  // LLM-proposed summary (schema slot; not wired in v1)
]);

// A staged change summary awaiting a person's activation approval. Regeneration
// sets it; approving the Dok turns it into a `regenerated` history entry and
// deletes it. Deliberately carries no date or author — it is not a record yet,
// and the deterministic pipeline that writes it must not read a clock.
export const DokPendingChangeSchema = z.object({
  summary: z.string().min(1),
  source: DokPendingChangeSourceSchema,
  // `_meta.version` of the file the proposal compared against.
  base_version: z.number().int().positive(),
  // Status of the file just before regeneration — approval uses it to decide
  // the lazy baseline for a legacy active Dok the regeneration demoted.
  previous_status: DokStatusSchema,
  category: DokHistoryCategorySchema.optional(),
}).passthrough();

// External system identifiers — Jira, Linear, Notion, etc.
export const ExternalIdsSchema = z.record(z.string(), z.string());

// Where this Dok was grounded when it surfaces across services — semantic
// dok_ids no longer encode a domain/service hint on their own, so this is
// the traceable link back to the concrete feature/route per service.
export const DokOriginSchema = z.object({
  service_id: z.string(),
  canonical_feature_id: z.string(),
  primary_route: z.string().optional(),
}).passthrough();

// Operational meta — separated from the business definition.
export const DokMetaSchema = z.object({
  // Fingerprint of the deterministic source-input paths and bytes used for
  // drift detection. Human prose/status edits do not calculate or lock it.
  logic_hash: z.string().optional(),
  // Deterministic dependency-tracking contract used at generation. Legacy
  // documents remain readable, but cannot establish freshness without version 2.
  tracking_version: z.number().int().positive().optional(),
  // A scan recovered source dependencies after generation. Keep the old hash
  // and require regeneration/review before declaring the document fresh.
  tracking_review_required: z.boolean().optional(),
  // Source files this Dok was derived from. Deterministically injected by the
  // generator (never LLM-authored). The basis for coverage maps / Studio source
  // jump, and the display attribution shown to consumers. See SourceAnchorSchema.
  source_anchors: z.array(SourceAnchorSchema).optional(),
  // The exact file set `logic_hash` was computed over — the full reachable
  // closure incl. shared infra (a superset of `source_anchors`, which stays
  // display-oriented with shared infra excluded). Deterministically injected by
  // the generator. Drift recomputes the hash over this set so a change to a
  // shared dependency is caught. Absent on pre-B1 Doks: drift then falls back to
  // `source_anchors`. See SourceAnchorSchema.
  logic_files: z.array(SourceAnchorSchema).optional(),
  // Set when a human edits this Dok (Studio save). `doklo sync` skips marked
  // Doks unless --force, so regeneration never silently destroys human work.
  edited_by_human: z.boolean().optional(),
  // The service whose `code_root` the source_anchors paths are resolved against,
  // stamped deterministically at generate time. Drift resolves anchor paths via
  // this — NOT the LLM-authored `surfaces` — so path resolution can't be thrown
  // off by a hallucinated, empty, or enum-mismatched surface. Optional: Doks
  // generated before this field fall back to surfaces[0] (see dokProjectRoot).
  anchor_service_id: z.string().optional(),
  version: z.number().int().positive().default(1),
  history: z.array(DokHistoryEntrySchema).default([]),
  // Staged regeneration proposal awaiting approval — see DokPendingChangeSchema.
  pending_change: DokPendingChangeSchema.optional(),
  external_ids: ExternalIdsSchema.optional(),
  // Per-service provenance for this Dok. Maintained by upsertOriginsByService
  // on every regeneration: it replaces the stamping service's entry (a renamed
  // feature must not leave its old canonical id behind as a live reconciliation
  // key) and leaves other services' entries alone, which in practice keeps this
  // to one entry per service_id. Not a schema constraint — nothing rejects a
  // hand-written file that carries more. See DokOriginSchema.
  origins: z.array(DokOriginSchema).optional(),
  // Prior dok_id values this Dok has held (e.g., pre-migration serial ids),
  // oldest first — lets links/anchors/external refs to the old id resolve
  // after a rename.
  previous_ids: z.array(z.string()).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  // LLM self-reported confidence at generation time, 0..1
  generation_confidence: z.number().min(0).max(1).optional(),
}).passthrough();

// Dok — single source of truth for a business feature.
// Service-agnostic: a dok represents a business intent that may surface across services.
export const DokSchema = z.object({
  dok_id: DokIdSchema,

  name: TranslatableSchema,
  status: DokStatusSchema.default('draft'),
  tags: z.array(z.string()).default([]),

  // Which services expose this dok (web, api, admin, ...)
  surfaces: z.array(ServiceIdSchema).default([]),

  // Two-axis business priority — what breaks for the business, and how many
  // users are stopped. Optional: absent means "not judged yet", which
  // derivePriorityTier reads as `standard` rather than guessing either way.
  priority: DokPrioritySchema.optional(),

  description: TranslatableSchema,
  user_actions: z.object({ steps: z.array(UserActionStepSchema) }).passthrough().optional(),
  business_rules: z.object({ rules: z.array(BusinessRuleSchema) }).passthrough().optional(),
  acceptance_criteria: z
    .object({ criteria: z.array(AcceptanceCriterionSchema) })
    .passthrough()
    .optional(),

  _meta: DokMetaSchema.default({ version: 1, history: [] }),
}).passthrough().superRefine((dok, ctx) => {
  const rules = dok.business_rules?.rules ?? [];
  const criteria = dok.acceptance_criteria?.criteria ?? [];
  const ruleIds = new Set<string>();
  const criterionIds = new Set<string>();

  for (const [index, rule] of rules.entries()) {
    const brPrefix = `BR-${dok.dok_id}-`;
    const brTail = rule.id.slice(brPrefix.length);
    if (!rule.id.startsWith(brPrefix) || !/^\d{2}$/.test(brTail)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['business_rules', 'rules', index, 'id'],
        message: `RULE_ID_DOK_MISMATCH: ${rule.id} must belong to ${dok.dok_id}`,
      });
    }
    if (ruleIds.has(rule.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['business_rules', 'rules', index, 'id'],
        message: `DUPLICATE_RULE_ID: ${rule.id}`,
      });
    }
    ruleIds.add(rule.id);
  }

  for (const [index, criterion] of criteria.entries()) {
    const acPrefix = `AC-${dok.dok_id}-`;
    const acTail = criterion.id.slice(acPrefix.length);
    if (!criterion.id.startsWith(acPrefix) || !/^\d{2}$/.test(acTail)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptance_criteria', 'criteria', index, 'id'],
        message: `AC_ID_DOK_MISMATCH: ${criterion.id} must belong to ${dok.dok_id}`,
      });
    }
    if (criterionIds.has(criterion.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptance_criteria', 'criteria', index, 'id'],
        message: `DUPLICATE_AC_ID: ${criterion.id}`,
      });
    }
    criterionIds.add(criterion.id);
    for (const ruleId of criterion.related_rules) {
      if (!ruleIds.has(ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acceptance_criteria', 'criteria', index, 'related_rules'],
          message: `UNKNOWN_RELATED_RULE: ${ruleId}`,
        });
      }
    }
  }
});

export type Translatable = z.infer<typeof TranslatableSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type Platform = z.infer<typeof PlatformSchema>;
export type Interaction = z.infer<typeof InteractionSchema>;
export type ActionVariant = z.infer<typeof ActionVariantSchema>;
export type UserActionStep = z.infer<typeof UserActionStepSchema>;
export type BusinessRuleType = z.infer<typeof BusinessRuleTypeSchema>;
export type BusinessRule = z.infer<typeof BusinessRuleSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type DokStatus = z.infer<typeof DokStatusSchema>;
export type DokHistoryKind = z.infer<typeof DokHistoryKindSchema>;
export type DokHistoryCategory = z.infer<typeof DokHistoryCategorySchema>;
export type DokHistoryEntry = z.infer<typeof DokHistoryEntrySchema>;
export type DokPendingChangeSource = z.infer<typeof DokPendingChangeSourceSchema>;
export type DokPendingChange = z.infer<typeof DokPendingChangeSchema>;
export type DokOrigin = z.infer<typeof DokOriginSchema>;
export type DokMeta = z.infer<typeof DokMetaSchema>;
export type Dok = z.infer<typeof DokSchema>;
