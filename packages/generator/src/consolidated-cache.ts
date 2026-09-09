import {
  ConsolidatedFeatureConfigSchema,
  type ConsolidatedFeature,
  type ConsolidatedFeatureConfig,
} from './legacy-types.js';
import {
  featureIdFromRoute,
  uniqueFeatureIdsForRoutes,
} from './feature-id.js';

const DUPLICATE_CANONICAL_ID = 'duplicate consolidated canonical_id:';

/**
 * Parse a persisted consolidation cache, repairing only the legacy collision
 * produced when distinct route paths collapsed to the same source feature id.
 * Every returned value still passes the unchanged strict persisted schema.
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

    // The duplicate base is owned by this collision group; every other base,
    // including one that also ends in a numeric suffix, stays reserved.
    used.delete(duplicateId);
    const routeIds = uniqueFeatureIdsForRoutes(routes);
    const replacements = routeIds.map((routeId) => {
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
      // attachSourceFiles keyed the legacy source features by their colliding
      // id, so every occurrence received the same last-writer provenance.
      // Omitting it here makes generation resolve each primary route from the
      // still-strict scan IR instead of documenting the wrong page.
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
