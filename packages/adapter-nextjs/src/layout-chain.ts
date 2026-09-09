import { posix } from 'node:path';
import type { AppRoute } from './routing.js';

function normalize(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function appRoot(filePath: string): string | null {
  const match = normalize(filePath).match(/^(src\/app|app)(?:\/|$)/);
  return match?.[1] ?? null;
}

export function buildLayoutChains(
  appRoutes: readonly AppRoute[],
): ReadonlyMap<string, readonly string[]> {
  const layoutsByDirectory = new Map<string, string>();
  for (const route of appRoutes) {
    if (route.type !== 'layout') continue;
    const file = normalize(route.filePath);
    const directory = posix.dirname(file);
    const previous = layoutsByDirectory.get(directory);
    if (previous === undefined || file.localeCompare(previous) < 0) {
      layoutsByDirectory.set(directory, file);
    }
  }

  const chains = new Map<string, readonly string[]>();
  for (const route of appRoutes) {
    if (route.type !== 'page') continue;
    const file = normalize(route.filePath);
    const root = appRoot(file);
    if (root === null) {
      chains.set(file, []);
      continue;
    }

    const leafToRoot: string[] = [];
    let directory = posix.dirname(file);
    while (directory === root || directory.startsWith(`${root}/`)) {
      const layout = layoutsByDirectory.get(directory);
      if (layout !== undefined) leafToRoot.push(layout);
      if (directory === root) break;
      directory = posix.dirname(directory);
    }
    chains.set(file, leafToRoot.reverse());
  }
  return chains;
}
