// Runtime version sourcing for the CLI.
//
// The bin's `.version()` must reflect the *package it was installed from*, not
// a hardcoded literal. We can't `import ../package.json` because the dev tsc
// layout (dist/lib/version.js) and the bundled release layout (dist/index.js)
// sit at different depths, and the two manifests carry different versions on
// purpose (dev = 0.0.0, published @mayp/doklo = 0.1.0).
//
// So we walk up from *this module's* directory to the nearest package.json and
// read its `version`. Resolution per layout:
//   dev (tsc):      dist/lib/version.js  → …/apps/cli/package.json      → 0.0.0
//   release bundle: dist/index.js        → …/@mayp/doklo/package.json    → 0.1.0
// Both correct in context. esbuild rewrites `import.meta.url` to the emitted
// file's location, and every emitted chunk lives in `dist/`, so `dirname`
// lands on `dist` regardless of code-splitting.

import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from `startDir` to the first package.json with a non-empty string
 * `version` and return it. Falls back to '0.0.0' if none is found (should only
 * happen in a broken checkout). Synchronous by design — commander's
 * `.version()` is called while the Command is built, before any await.
 */
export function resolveVersion(startDir: string = MODULE_DIR): string {
  let dir = startDir;
  const root = parse(dir).root;
  // Bounded walk: at most until the filesystem root.
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
      // package.json without a usable version → keep walking up.
    } catch {
      // no package.json here (or unreadable/invalid) → keep walking up.
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return '0.0.0';
}
