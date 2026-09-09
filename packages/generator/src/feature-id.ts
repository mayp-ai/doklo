/** Build the legacy feature id derived from a route path. */
export function featureIdFromRoute(path: string): string {
  const cleaned = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\[\.\.\.([^\]]+)\]/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned === '' ? 'home' : cleaned;
}

/**
 * Return one stable, workspace-unique feature id per route.
 *
 * The legacy slugging rule intentionally collapses path separators and
 * punctuation. When distinct routes collapse to the same slug, the shortest
 * route keeps the historic id and the remaining routes receive a `pathN`
 * suffix. Existing base ids are reserved before suffixes are assigned so a
 * real `/feature-path2` route can never be shadowed by a collision fallback.
 */
export function uniqueFeatureIdsForRoutes(routes: readonly string[]): string[] {
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
