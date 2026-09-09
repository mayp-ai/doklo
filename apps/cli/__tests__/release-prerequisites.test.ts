// Regression: `pnpm release:pack` on a clean checkout used to fail because the
// release build only verified `packages/*/dist/index.js`. The Studio standalone
// build it drives imports `@doklo-beta/cli/api` (apps/cli/dist/api.js), so a
// checkout where only `pnpm build` ran died with
// "Module not found: Can't resolve '@doklo-beta/cli/api'".

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandsFor,
  missingBuildOutputs,
  releaseBuildUnits,
} from '../scripts/release-prerequisites.mjs';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CLI_DIR, '..', '..');

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

/** A checkout shaped like the real repo: packages/* built, apps/cli not. */
async function createCheckoutWithOnlyPackagesBuilt(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-release-prereq-'));
  temporaryRoots.push(root);
  for (const name of ['core', 'generator']) {
    await mkdir(join(root, 'packages', name, 'dist'), { recursive: true });
    await writeFile(join(root, 'packages', name, 'dist', 'index.js'), '', 'utf8');
  }
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  return root;
}

describe('release build prerequisites', () => {
  it('treats apps/cli as a release prerequisite, built after packages/*', () => {
    const ids = releaseBuildUnits(REPO_ROOT).map((unit) => unit.id);
    expect(ids).toContain('apps/cli');
    expect(ids.at(-1)).toBe('apps/cli');
    expect(ids.filter((id) => id.startsWith('packages/')).length).toBeGreaterThan(0);
  });

  it('reports apps/cli missing when only `pnpm build` has run', async () => {
    const root = await createCheckoutWithOnlyPackagesBuilt();
    const missing = missingBuildOutputs(root);
    expect(missing.map((unit) => unit.id)).toEqual(['apps/cli']);
    expect(buildCommandsFor(missing)).toEqual(['pnpm -C apps/cli build']);
  });

  it('reports nothing missing once apps/cli/dist/api.js exists', async () => {
    const root = await createCheckoutWithOnlyPackagesBuilt();
    await mkdir(join(root, 'apps', 'cli', 'dist'), { recursive: true });
    await writeFile(join(root, 'apps', 'cli', 'dist', 'api.js'), '', 'utf8');
    expect(missingBuildOutputs(root)).toEqual([]);
  });

  it('orders both build commands when nothing has been built', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-release-prereq-empty-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'packages', 'core'), { recursive: true });
    expect(buildCommandsFor(missingBuildOutputs(root))).toEqual([
      'pnpm build',
      'pnpm -C apps/cli build',
    ]);
  });

  it('stays justified: Studio still imports the @doklo-beta/cli/api subpath', () => {
    const wizardActions = join(REPO_ROOT, 'apps', 'studio', 'lib', 'wizard-actions.ts');
    expect(existsSync(wizardActions)).toBe(true);
    expect(readFileSync(wizardActions, 'utf8')).toContain("from '@doklo-beta/cli/api'");
  });

  it('build-release.mjs asks release-prerequisites instead of hand-rolling the check', () => {
    const source = readFileSync(join(CLI_DIR, 'scripts', 'build-release.mjs'), 'utf8');
    expect(source).toContain('release-prerequisites.mjs');
    expect(source).toContain('missingBuildOutputs');
  });

  // Second half of the same clean-clone failure: build-release.mjs used to
  // `import ... from '@doklo-beta/core'` (and from studio/scripts/
  // standalone-assets.mjs, which imports core too) at module scope. On a fresh
  // clone those dist/ files do not exist yet, so the script died with
  // ERR_MODULE_NOT_FOUND before ensureWorkspaceBuilt() could build them.
  it('build-release.mjs does not statically import workspace dist code', () => {
    const source = readFileSync(join(CLI_DIR, 'scripts', 'build-release.mjs'), 'utf8');
    const staticImports = [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';$/gm)].map(
      (match) => match[1],
    );
    const buildTimeOnly = staticImports.filter(
      (specifier) =>
        specifier.startsWith('@doklo-beta/') ||
        specifier.includes('standalone-assets.mjs'),
    );
    expect(buildTimeOnly).toEqual([]);
    expect(source).toContain("await import('@doklo-beta/core')");
  });

  it('build-release.mjs loads workspace modules only after building them', () => {
    const source = readFileSync(join(CLI_DIR, 'scripts', 'build-release.mjs'), 'utf8');
    const ensureAt = source.indexOf('  ensureWorkspaceBuilt();');
    const loadAt = source.indexOf('  await loadBuiltWorkspaceModules();');
    expect(ensureAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(ensureAt);
  });
});
