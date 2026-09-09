// release-prerequisites.mjs — which workspace build outputs must exist before
// `build-release.mjs` can produce a publishable tarball.
//
// `pnpm build` at the repo root only builds `packages/*`. The release build
// additionally needs `apps/cli/dist`, because `build-release.mjs` runs the
// Studio standalone build and `apps/studio/lib/wizard-actions.ts` imports the
// `@doklo-beta/cli/api` subpath — which resolves to `apps/cli/dist/api.js`.
// Without it a clean checkout fails the Studio webpack compile with
// "Module not found: Can't resolve '@doklo-beta/cli/api'".

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build units the release needs, in build order.
 * Each unit knows the command that builds it and the artifact that proves it.
 *
 * @param {string} repoRoot
 * @returns {{ id: string, dir: string, artifact: string, command: string }[]}
 */
export function releaseBuildUnits(repoRoot) {
  const packages = readdirSync(join(repoRoot, 'packages'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: `packages/${entry.name}`,
      dir: join(repoRoot, 'packages', entry.name),
      artifact: join(repoRoot, 'packages', entry.name, 'dist', 'index.js'),
      command: 'pnpm build',
    }));

  // apps/cli last: it depends on the packages above, and apps/studio depends
  // on it. `pnpm build` does not cover it.
  return [
    ...packages,
    {
      id: 'apps/cli',
      dir: join(repoRoot, 'apps', 'cli'),
      artifact: join(repoRoot, 'apps', 'cli', 'dist', 'api.js'),
      command: 'pnpm -C apps/cli build',
    },
  ];
}

/**
 * The units whose proving artifact is absent, in build order.
 *
 * @param {string} repoRoot
 * @param {(path: string) => boolean} [exists] injection seam for tests
 */
export function missingBuildOutputs(repoRoot, exists = existsSync) {
  return releaseBuildUnits(repoRoot).filter((unit) => !exists(unit.artifact));
}

/**
 * The distinct build commands needed to satisfy `missing`, in build order.
 *
 * @param {{ command: string }[]} missing
 * @returns {string[]}
 */
export function buildCommandsFor(missing) {
  const commands = [];
  for (const unit of missing) {
    if (!commands.includes(unit.command)) commands.push(unit.command);
  }
  return commands;
}
