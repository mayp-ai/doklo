// Legacy v4 feature/consolidation types vendored from doklo-cli.
//
// These are the *internal contract* between feature extraction and
// consolidation in the legacy CLI. v5 will eventually replace them with
// IR-driven equivalents, but for now the consolidator works on these
// shapes — so we vendor them faithfully.

import { z } from 'zod';
import { DokIdSchema } from '@doklo-beta/core';

// ───────── Feature extraction types ────────────────────────────────

export type FeatureFileRole =
  | 'entry'
  | 'api'
  | 'component'
  | 'store'
  | 'util'
  | 'type'
  | 'hook'
  | 'action';

export interface FeatureFile {
  path: string;
  role: FeatureFileRole;
  /** Import depth from the entry point. */
  depth: number;
  /** True if used by 3+ features. */
  isShared: boolean;
}

export interface Feature {
  /** e.g., "auth-signin", "catalog-detail" */
  id: string;
  /** Korean label (or whatever default_locale of the project). */
  label: string;
  /** e.g., "/auth/signin", "/program/[programId]" */
  routePath: string;
  /** Entry point file (page.tsx). */
  entryPoint: string;
  files: FeatureFile[];
  /**
   * Drift-only file set — the full reachable closure incl. shared infra.
   * `files` (and the consolidated `source_files` derived from it) stay
   * display-oriented, with shared infra excluded; `logic_files` is what drift
   * detection hashes, so a change to a shared utility this feature depends on is
   * still caught. Optional for caches written before this field existed.
   */
  logic_files?: string[];
  apiRoutes: string[];
  components: string[];
  stores: string[];
  /** Whether this feature is selected for Dok generation. */
  enabled: boolean;
  /**
   * Semantic dok_id prefix assigned by consolidation. As of v5 this IS the
   * dok_id verbatim — there is no serial suffix (e.g., "PROG-MILE" is a
   * complete, final dok_id, not a template for PROG-MILE-001, -002, ...).
   */
  dok_id_prefix?: string;
}

export interface FeatureGroup {
  /** e.g., "auth", "admin", "program" */
  id: string;
  label: string;
  /** e.g., "/auth", "/admin", "/program" */
  routePrefix: string;
  description: string;
  features: Feature[];
  totalFileCount: number;
  enabled: boolean;
}

export interface SharedInfrastructure {
  sharedComponents: string[];
  sharedUtils: string[];
  sharedHooks: string[];
  sharedTypes: string[];
  sharedStores: string[];
}

export interface FeatureConfig {
  projectName: string;
  projectRoot: string;
  featureGroups: FeatureGroup[];
  sharedInfrastructure: SharedInfrastructure;
  /** Word translations (English → display locale). */
  terminology: Record<string, string>;
  generatedAt: string;
  totalFiles: number;
  /** Source files that didn't end up under any feature. */
  unmappedFiles: string[];
}

// ───────── Consolidation types (LLM-aided grouping) ────────────────

export type ConsolidationDecision = 'merge' | 'keep' | 'exclude';

export interface ConsolidatedFeature {
  /** Canonical id — the merged group's representative identifier. */
  canonical_id: string;
  label: string;
  decision: ConsolidationDecision;
  /** Studio-authored prior decision used to restore an excluded feature. */
  prev_decision?: ConsolidationDecision;
  /** Original feature.id list (>=2 for merge, 1 for keep). */
  members: string[];
  primary_route: string;
  /** LLM-authored rationale. */
  reason: string;
  user_reviewed: boolean;
  /**
   * Semantic dok_id prefix — this IS the dok_id verbatim (see
   * @doklo-beta/core's DOK_ID_RE: 1-3 UPPERCASE segments, e.g. AUTH-SIGNIN).
   * No serial suffix is appended. Project-wide unique — a duplicate is a
   * hard error at assignment time (assignDokIds), not silently renumbered.
   */
  dok_id_prefix?: string;
  /**
   * Deterministic source provenance: the deduped union of this feature's
   * member files (entry page + reachable components/hooks/stores/apis, shared
   * infra excluded), carried over from the source FeatureConfig. The
   * generator injects these into `Dok._meta.source_anchors`. Optional for
   * backward compat with consolidated caches written before this field
   * existed — `generate` then falls back to IR primary-route resolution.
   */
  source_files?: string[];
  /**
   * Drift-only file set — the full reachable closure incl. shared infra, the
   * deduped union of this feature's member `logic_files`. Unlike `source_files`
   * (display-oriented, shared infra excluded), this is what drift detection
   * hashes, so a change to a shared utility a member depends on is still caught.
   * The generator injects it into `Dok._meta.logic_files`. Optional for
   * backward compat with consolidated caches written before this field existed —
   * `generate` then falls back to hashing `files` (== the display set).
   */
  logic_files?: string[];
  metadata?: {
    locales?: string[];
    variant_type?: 'i18n' | 'experiment' | 'ab_test' | 'role_split' | 'other';
    note?: string;
  };
}

export interface ExcludedFeature {
  id: string;
  reason: string;
}

export interface ConsolidatedFeatureGroup {
  group_id: string;
  label: string;
  features: ConsolidatedFeature[];
  excluded: ExcludedFeature[];
}

export interface ConsolidatedFeatureConfig {
  projectName: string;
  /** Source features.json's generatedAt — for staleness tracking. */
  basedOnFeaturesAt: string;
  generatedAt: string;
  model: string;
  groups: ConsolidatedFeatureGroup[];
  /** Immutable inventory captured before consolidation; used to detect dropped source features. */
  originalFeatureIds: string[];
  userReviewed: boolean;
  notes?: string;
  stats: {
    originalFeatures: number;
    consolidatedFeatures: number;
    merges: number;
    excluded: number;
  };
}

const ConsolidatedFeatureMetadataSchema = z.strictObject({
  locales: z.array(z.string()).optional(),
  variant_type: z.enum(['i18n', 'experiment', 'ab_test', 'role_split', 'other']).optional(),
  note: z.string().optional(),
});

const ConsolidatedFeatureSchema = z.strictObject({
  canonical_id: z.string().min(1),
  label: z.string(),
  decision: z.enum(['merge', 'keep', 'exclude']),
  prev_decision: z.enum(['merge', 'keep', 'exclude']).optional(),
  members: z.array(z.string()),
  primary_route: z.string(),
  reason: z.string(),
  user_reviewed: z.boolean(),
  dok_id_prefix: DokIdSchema.optional(),
  source_files: z.array(z.string().min(1)).optional(),
  logic_files: z.array(z.string().min(1)).optional(),
  metadata: ConsolidatedFeatureMetadataSchema.optional(),
});

const ExcludedFeatureSchema = z.strictObject({
  id: z.string(),
  reason: z.string(),
});

const ConsolidatedFeatureGroupSchema = z.strictObject({
  group_id: z.string().min(1),
  label: z.string(),
  features: z.array(ConsolidatedFeatureSchema),
  excluded: z.array(ExcludedFeatureSchema),
});

/** Strict runtime boundary for persisted consolidated feature caches. */
export const ConsolidatedFeatureConfigSchema: z.ZodType<ConsolidatedFeatureConfig> = z
  .strictObject({
    projectName: z.string(),
    basedOnFeaturesAt: z.string(),
    generatedAt: z.string(),
    model: z.string(),
    groups: z.array(ConsolidatedFeatureGroupSchema),
    originalFeatureIds: z.array(z.string().min(1)),
    userReviewed: z.boolean(),
    notes: z.string().optional(),
    stats: z.strictObject({
      originalFeatures: z.number().int().nonnegative(),
      consolidatedFeatures: z.number().int().nonnegative(),
      merges: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
    }),
  })
  .superRefine((config, ctx) => {
    const groupIds = new Set<string>();
    const canonicalIds = new Set<string>();

    config.groups.forEach((group, groupIndex) => {
      if (groupIds.has(group.group_id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate consolidated group_id: ${group.group_id}`,
          path: ['groups', groupIndex, 'group_id'],
        });
      }
      groupIds.add(group.group_id);

      group.features.forEach((feature, featureIndex) => {
        if (canonicalIds.has(feature.canonical_id)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate consolidated canonical_id: ${feature.canonical_id}`,
            path: ['groups', groupIndex, 'features', featureIndex, 'canonical_id'],
          });
        }
        canonicalIds.add(feature.canonical_id);
      });
    });
  });
