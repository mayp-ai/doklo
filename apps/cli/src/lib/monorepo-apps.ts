// Find Next.js apps inside a monorepo.
//
// `doklo init` runs the adapter's support check against one directory. In a
// monorepo the root carries no `next` dependency, so the check fails and the
// user is told the framework is "unknown" — true but useless, since the app is
// one directory down. This module turns that dead end into a pointer.
//
// Deliberately synchronous and dependency-free: it runs on an error path where
// the command is already about to fail, and reading a handful of package.json
// files does not justify pulling in a glob library.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** App-router roots the nextjs adapter accepts, mirroring NEXTJS_SUPPORT.appRoots. */
const APP_ROOTS = ['app', 'src/app'] as const;

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.doklo']);

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // missing or malformed — this package is simply not a candidate
  }
}

/**
 * Workspace globs from package.json `workspaces` (array or {packages}) and
 * pnpm-workspace.yaml. The YAML is read with a line matcher rather than a
 * parser: the file's shape is a fixed `packages:` list in every real repo, and
 * a wrong read here costs a missed suggestion, not a wrong action.
 */
function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];

  const pkg = readJson(join(root, 'package.json'));
  const workspaces = pkg?.['workspaces'];
  if (Array.isArray(workspaces)) {
    globs.push(...workspaces.filter((w): w is string => typeof w === 'string'));
  } else if (typeof workspaces === 'object' && workspaces !== null) {
    const packages = (workspaces as Record<string, unknown>)['packages'];
    if (Array.isArray(packages)) {
      globs.push(...packages.filter((p): p is string => typeof p === 'string'));
    }
  }

  try {
    for (const line of readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8').split('\n')) {
      const match = /^\s*-\s*["']?([^"'#\s]+)["']?\s*$/.exec(line);
      if (match?.[1]) globs.push(match[1]);
    }
  } catch {
    // no pnpm workspace file — fine
  }

  return [...new Set(globs)];
}

/** Expand one workspace glob into candidate directories, relative to root. */
function expand(root: string, glob: string): string[] {
  const trimmed = glob.replace(/\/+$/, '');
  const star = trimmed.indexOf('*');
  if (star === -1) return [trimmed];

  // Only the common `prefix/*` (and bare `*`) shapes are expanded; deeper
  // patterns like `a/**/b` are rare in practice and are skipped rather than
  // half-matched.
  const prefix = trimmed.slice(0, star).replace(/\/+$/, '');
  if (trimmed.slice(star) !== '*') return [];

  const dir = prefix === '' ? root : join(root, prefix);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !IGNORED_DIRS.has(name) && !name.startsWith('.'))
    .map((name) => (prefix === '' ? name : `${prefix}/${name}`))
    .filter((rel) => {
      try {
        return statSync(join(root, rel)).isDirectory();
      } catch {
        return false;
      }
    });
}

function isNextjsApp(root: string, rel: string): boolean {
  const pkg = readJson(join(root, rel, 'package.json'));
  if (!pkg) return false;
  const deps = {
    ...(typeof pkg['dependencies'] === 'object' ? pkg['dependencies'] : {}),
    ...(typeof pkg['devDependencies'] === 'object' ? pkg['devDependencies'] : {}),
  } as Record<string, unknown>;
  if (typeof deps['next'] !== 'string') return false;
  // An app-router directory is required by the adapter; suggesting a
  // pages-only app would just move the failure to the next command.
  return APP_ROOTS.some((appRoot) => existsSync(join(root, rel, appRoot)));
}

/**
 * Next.js app-router packages inside `root`, as paths relative to it.
 * Empty when `root` is not a monorepo or holds no such app.
 */
export function findNextjsApps(root: string): string[] {
  const candidates = new Set<string>();
  for (const glob of workspaceGlobs(root)) {
    for (const rel of expand(root, glob)) {
      if (!rel.split('/').some((segment) => IGNORED_DIRS.has(segment))) candidates.add(rel);
    }
  }
  return [...candidates].filter((rel) => isNextjsApp(root, rel)).sort();
}
