// Studio-local zod schema for the derived consolidated cache
// (<svc>.consolidated.json). Mirrors generator's ConsolidatedFeatureConfig
// (packages/generator/src/legacy-types.ts). Kept in Studio — it validates
// on save and is not part of the v5 core schema surface.
import { z } from 'zod';
import { DokIdSchema } from '@doklo-beta/core';

export const ConsolidationDecisionSchema = z.enum(['merge', 'keep', 'exclude']);

export const ConsolidatedFeatureSchema = z.strictObject({
  canonical_id: z.string().min(1),
  label: z.string(),
  decision: ConsolidationDecisionSchema,
  /** Studio-only: the decision before exclude, so a re-include restores it
   *  losslessly instead of re-deriving keep/merge from members.length. */
  prev_decision: ConsolidationDecisionSchema.optional(),
  members: z.array(z.string()),
  primary_route: z.string(),
  reason: z.string(),
  user_reviewed: z.boolean(),
  // dok_id_prefix becomes the final dok_id verbatim (no numeric serial is
  // appended) — share the exact core grammar, reserved-segment refine
  // included, so a user-entered prefix can never collide with BR/AC ids.
  dok_id_prefix: DokIdSchema.optional(),
  source_files: z.array(z.string().min(1)).optional(),
  logic_files: z.array(z.string().min(1)).optional(),
  metadata: z
    .strictObject({
      locales: z.array(z.string()).optional(),
      variant_type: z
        .enum(['i18n', 'experiment', 'ab_test', 'role_split', 'other'])
        .optional(),
      note: z.string().optional(),
    })
    .optional(),
});

export const ExcludedFeatureSchema = z.strictObject({
  id: z.string(),
  reason: z.string(),
});

export const ConsolidatedFeatureGroupSchema = z.strictObject({
  group_id: z.string().min(1),
  label: z.string(),
  features: z.array(ConsolidatedFeatureSchema),
  excluded: z.array(ExcludedFeatureSchema),
});

export const ConsolidatedFeatureConfigSchema = z.strictObject({
  projectName: z.string(),
  basedOnFeaturesAt: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  groups: z.array(ConsolidatedFeatureGroupSchema),
  /** Immutable pre-consolidation source inventory used by generation accounting. */
  originalFeatureIds: z.array(z.string().min(1)),
  userReviewed: z.boolean(),
  notes: z.string().optional(),
  stats: z.strictObject({
    originalFeatures: z.number().int().nonnegative(),
    consolidatedFeatures: z.number().int().nonnegative(),
    merges: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
}).superRefine((config, ctx) => {
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

export type ConsolidatedFeature = z.infer<typeof ConsolidatedFeatureSchema>;
export type ExcludedFeature = z.infer<typeof ExcludedFeatureSchema>;
export type ConsolidatedFeatureGroup = z.infer<typeof ConsolidatedFeatureGroupSchema>;
export type ConsolidatedFeatureConfig = z.infer<typeof ConsolidatedFeatureConfigSchema>;

const DUPLICATE_CANONICAL_ID = 'duplicate consolidated canonical_id:';

/**
 * Parse a persisted cache for display, repairing only the legacy collision
 * produced when distinct route paths collapsed to the same feature id.
 * Saving still uses ConsolidatedFeatureConfigSchema directly, so every write
 * remains subject to the unchanged strict contract.
 */
export function parseConsolidatedFeatureConfig(value: unknown): ConsolidatedFeatureConfig {
  const direct = ConsolidatedFeatureConfigSchema.safeParse(value);
  if (direct.success) return direct.data;
  if (
    direct.error.issues.length === 0
    || direct.error.issues.some((issue) => (
      issue.code !== 'custom' || !issue.message.startsWith(DUPLICATE_CANONICAL_ID)
    ))
  ) {
    throw direct.error;
  }

  const repaired = repairLegacyRouteSlugCollisions(value as ConsolidatedFeatureConfig);
  if (repaired === null) throw direct.error;
  return ConsolidatedFeatureConfigSchema.parse(repaired);
}

function repairLegacyRouteSlugCollisions(
  value: ConsolidatedFeatureConfig,
): ConsolidatedFeatureConfig | null {
  const repaired = structuredClone(value);
  const features = repaired.groups.flatMap((group) => group.features);
  const counts = new Map<string, number>();
  for (const feature of features) {
    counts.set(feature.canonical_id, (counts.get(feature.canonical_id) ?? 0) + 1);
  }
  const duplicateIds = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateIds.length === 0) return null;

  const used = new Set(features.map((feature) => feature.canonical_id));
  for (const duplicateId of duplicateIds) {
    const colliding = features.filter((feature) => feature.canonical_id === duplicateId);
    const routes = colliding.map((feature) => feature.primary_route);
    const inventoryCount = repaired.originalFeatureIds
      .filter((id) => id === duplicateId).length;
    if (
      inventoryCount !== colliding.length
      || new Set(routes).size !== routes.length
      || colliding.some((feature) => !isLegacyRouteSlugCollision(feature, duplicateId))
    ) {
      return null;
    }

    used.delete(duplicateId);
    const replacements = uniqueFeatureIdsForRoutes(routes).map((routeId) => {
      if (!used.has(routeId)) {
        used.add(routeId);
        return routeId;
      }
      let suffix = 2;
      let candidate = `${duplicateId}-path${suffix}`;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `${duplicateId}-path${suffix}`;
      }
      used.add(candidate);
      return candidate;
    });

    colliding.forEach((feature, index) => {
      const replacement = replacements[index]!;
      feature.canonical_id = replacement;
      feature.members = [replacement];
      delete feature.source_files;
      delete feature.logic_files;
    });

    let inventoryIndex = 0;
    repaired.originalFeatureIds = repaired.originalFeatureIds.map((id) => (
      id === duplicateId ? replacements[inventoryIndex++]! : id
    ));
  }

  return repaired;
}

function isLegacyRouteSlugCollision(
  feature: ConsolidatedFeature,
  duplicateId: string,
): boolean {
  return feature.decision === 'keep'
    && feature.members.length === 1
    && feature.members[0] === duplicateId
    && feature.primary_route.length > 0
    && featureIdFromRoute(feature.primary_route) === duplicateId;
}

function featureIdFromRoute(path: string): string {
  const cleaned = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\[\.\.\.([^\]]+)\]/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned === '' ? 'home' : cleaned;
}

function uniqueFeatureIdsForRoutes(routes: readonly string[]): string[] {
  const bases = routes.map(featureIdFromRoute);
  const reserved = new Set(bases);
  const assigned = new Set<string>();
  const result = new Array<string>(routes.length);
  const indexesByBase = new Map<string, number[]>();

  for (let index = 0; index < bases.length; index += 1) {
    const base = bases[index]!;
    const indexes = indexesByBase.get(base) ?? [];
    indexes.push(index);
    indexesByBase.set(base, indexes);
  }

  for (const [base, indexes] of indexesByBase) {
    indexes.sort((left, right) => {
      const leftRoute = routes[left]!;
      const rightRoute = routes[right]!;
      const depth = routeDepth(leftRoute) - routeDepth(rightRoute);
      return depth || leftRoute.localeCompare(rightRoute) || left - right;
    });

    for (const [position, index] of indexes.entries()) {
      if (position === 0 && !assigned.has(base)) {
        result[index] = base;
        assigned.add(base);
        continue;
      }

      let suffix = 2;
      let candidate = `${base}-path${suffix}`;
      while (reserved.has(candidate) || assigned.has(candidate)) {
        suffix += 1;
        candidate = `${base}-path${suffix}`;
      }
      result[index] = candidate;
      assigned.add(candidate);
    }
  }

  return result;
}

function routeDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}
