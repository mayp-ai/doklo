#!/usr/bin/env node
// build-release.mjs — produce a self-contained, publishable `@mayp/doklo`
// package under apps/cli/release/.
//
// What it does, in order:
//   1. Ensure every workspace package is built (esbuild inlines their dist/).
//   2. Bundle src/index.ts (bin) + src/api.ts (./api export) with esbuild.
//      Selective externals: everything that is NOT `@doklo-beta/*` and not a
//      relative/absolute path stays an external import (npm deps resolve at
//      runtime from the published `dependencies`); workspace code is inlined
//      from the packages' built dist. The optional heavy HWPX dependency
//      (kordoc) is external too and is declared as an optional peerDependency.
//   3. Copy runtime assets to <pkgRoot> so the `dirname(import.meta.url)`-based
//      resolvers in the bundle find them: templates/, css/, i18n/, studio/.
//   4. Copy root README/AGENT_GUIDE/LICENSE/CHANGELOG when present (a parallel
//      task may be writing them — absence is a warning, not a failure).
//   5. Generate release/package.json with a computed dependency union.
//
// Usage:  node scripts/build-release.mjs [--with-studio]
//   --with-studio  always rebuild the Studio standalone tree (slow Next build).
//                  Otherwise an existing apps/studio/.next/standalone is reused,
//                  and only built if missing.

import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  buildCommandsFor,
  missingBuildOutputs,
  releaseBuildUnits,
} from './release-prerequisites.mjs';
import { RELEASE_NODE_ENGINE } from './release-node-support.mjs';
import { hoistStudioTree } from './release-studio-tree.mjs';
// The content guard imports only node builtins, so it is safe at module scope
// even on a checkout where nothing has been built yet.
import { assertPublishableReleaseContent } from './release-content-guard.mjs';

// `@doklo-beta/core` (directly, and transitively via studio/scripts/
// standalone-assets.mjs) only exists once `packages/core` is built. Importing
// either at module scope makes this script unloadable on a fresh clone —
// ERR_MODULE_NOT_FOUND fires before ensureWorkspaceBuilt() can fix it. So they
// are loaded lazily, after the prerequisites are built.
let assertContainedPathIdentity;
let captureContainedPathIdentity;
let publishDirectoryContained;
let removeContained;
let assertDirectoryContainsFiles;
let copyStandaloneAssets;

async function loadBuiltWorkspaceModules() {
  const core = await import('@doklo-beta/core');
  ({
    assertContainedPathIdentity,
    captureContainedPathIdentity,
    publishDirectoryContained,
    removeContained,
  } = core);
  ({ assertDirectoryContainsFiles, copyStandaloneAssets } = await import(
    '../../studio/scripts/standalone-assets.mjs'
  ));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(HERE, '..'); // apps/cli
const REPO_ROOT = resolve(CLI_DIR, '..', '..');
const PUBLISHED_RELEASE_DIR = join(CLI_DIR, 'release');
const RELEASE_DIR = join(
  CLI_DIR,
  `.release.stage-${process.pid}-${randomUUID()}`,
);
const PKG_NAME = '@mayp/doklo';
const PKG_VERSION = '0.3.0';
const RELEASE_LICENSE = 'Apache-2.0';

const argv = process.argv.slice(2);
const WITH_STUDIO = argv.includes('--with-studio');

const log = (m) => process.stdout.write(`  ${m}\n`);
const warn = (m) => process.stdout.write(`  ⚠ ${m}\n`);

// ───────────────────────── 1. workspace deps built ──────────────────────────

/** All workspace package dirs whose deps feed the union + whose dist the
 *  bundler inlines. */
const PACKAGE_DIRS = readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(REPO_ROOT, 'packages', d.name));

/**
 * Build every unit the release needs, not just `packages/*`. `pnpm build` skips
 * `apps/cli`, but the Studio standalone build below imports the
 * `@doklo-beta/cli/api` subpath (apps/cli/dist/api.js) — so a clean checkout that
 * only ran `pnpm build` used to die on
 * "Module not found: Can't resolve '@doklo-beta/cli/api'".
 * The unit list and its artifacts live in release-prerequisites.mjs so the
 * contract is testable without running a build.
 */
function ensureWorkspaceBuilt() {
  const missing = missingBuildOutputs(REPO_ROOT);
  if (missing.length === 0) {
    log(`release prerequisites already built (${releaseBuildUnits(REPO_ROOT).length} units).`);
    return;
  }
  log(`building release prerequisites (missing: ${missing.map((u) => u.id).join(', ')})…`);
  for (const command of buildCommandsFor(missing)) {
    log(`  $ ${command}`);
    execSync(command, { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  const stillMissing = missingBuildOutputs(REPO_ROOT);
  if (stillMissing.length > 0) {
    throw new Error(
      `release prerequisites still missing after build: ${stillMissing
        .map((u) => `${u.id} (${relative(REPO_ROOT, u.artifact)})`)
        .join(', ')}`,
    );
  }
}

// ───────────────────────── 2. esbuild bundle ────────────────────────────────

/** External-everything-except-workspace plugin: workspace code (`@doklo-beta/*`)
 *  and relative/absolute paths are bundled; every bare specifier (npm dep or
 *  node: builtin) stays an external runtime import. ~10 lines by design. */
const externalizeNonWorkspace = {
  name: 'externalize-non-workspace',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      const p = args.path;
      if (p.startsWith('.') || p.startsWith('/')) return null; // relative/abs → bundle
      if (p.startsWith('@doklo-beta/')) return null; // workspace → inline from dist
      return { path: p, external: true }; // npm dep / node: builtin → external
    });
  },
};

async function bundle() {
  const outdir = join(RELEASE_DIR, 'dist');
  await build({
    entryPoints: {
      index: join(CLI_DIR, 'src', 'index.ts'),
      api: join(CLI_DIR, 'src', 'api.ts'),
    },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    splitting: true, // keep independently loaded command paths split
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
    plugins: [externalizeNonWorkspace],
  });

  // Preserve the bin shebang. esbuild usually keeps the entry hashbang, but
  // code-splitting can move it; ensure it deterministically, then chmod +x.
  const binPath = join(outdir, 'index.js');
  let src = readFileSync(binPath, 'utf-8');
  if (!src.startsWith('#!')) {
    src = `#!/usr/bin/env node\n${src}`;
    writeFileSync(binPath, src);
    log('prepended missing shebang to dist/index.js');
  } else {
    log('shebang preserved on dist/index.js');
  }
  chmodSync(binPath, 0o755);

  if (!existsSync(join(outdir, 'api.js'))) {
    throw new Error('esbuild did not emit dist/api.js');
  }
}

// ───────────────────────── 3. runtime assets ────────────────────────────────

function copyAssets() {
  const copies = [
    // livedoc templates:  dist/index.js → ../templates
    [join(REPO_ROOT, 'packages', 'livedoc-engine', 'templates'), join(RELEASE_DIR, 'templates')],
    // default CSS:        dist/index.js → ../css/default.css
    [join(REPO_ROOT, 'packages', 'livedoc-engine', 'src', 'css'), join(RELEASE_DIR, 'css')],
    // CLI i18n:           dist/index.js → ../i18n
    [join(CLI_DIR, 'src', 'i18n'), join(RELEASE_DIR, 'i18n')],
  ];
  for (const [from, to] of copies) {
    if (!existsSync(from)) throw new Error(`missing required asset source: ${from}`);
    cpSync(from, to, { recursive: true });
    log(`copied ${to.replace(RELEASE_DIR + '/', '')}/`);
  }
}

async function copyStudio() {
  const studioDir = join(REPO_ROOT, 'apps', 'studio');
  const standalone = join(studioDir, '.next', 'standalone');
  if (WITH_STUDIO || !existsSync(standalone)) {
    log(`building Studio standalone (${WITH_STUDIO ? '--with-studio' : 'missing'})…`);
    execSync('pnpm -C apps/studio build:standalone', { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    log('reusing existing Studio standalone build.');
  }
  await copyStandaloneAssets({ studioDir, log, warn });
  if (!existsSync(join(standalone, 'apps', 'studio', 'server.js'))) {
    throw new Error(`Studio standalone entry not found under ${standalone}`);
  }
  const studioDst = join(RELEASE_DIR, 'studio');
  const { hoisted, workspace } = hoistStudioTree(standalone, studioDst, { log, warn });

  // Publishability guard: any surviving symlink would be dropped by npm pack.
  const stragglers = countSymlinks(studioDst);
  if (stragglers > 0) {
    throw new Error(
      `studio/ still has ${stragglers} symlink(s); npm pack would strip them and break the studio.`,
    );
  }
  if (!existsSync(join(studioDst, 'apps', 'studio', 'server.js'))) {
    throw new Error('studio/ copy is missing apps/studio/server.js');
  }
  assertDirectoryContainsFiles(
    join(studioDst, 'apps', 'studio', '.next', 'static'),
    'release Studio static asset directory',
  );
  log(`copied studio/ (symlink-free dependencies with version overrides: ${hoisted} root pkgs + ${workspace} workspace)`);
}

/** Count symlinks anywhere under `dir` (recursive). */
function countSymlinks(dir) {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const ls = lstatSync(p);
    if (ls.isSymbolicLink()) n += 1;
    else if (ls.isDirectory()) n += countSymlinks(p);
  }
  return n;
}

function copyDocs() {
  // Root public docs — a parallel task may still be writing these.
  for (const f of ['README.md', 'README.ko.md', 'AGENT_GUIDE.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md']) {
    const from = join(REPO_ROOT, f);
    if (existsSync(from)) {
      cpSync(from, join(RELEASE_DIR, f));
      log(`copied ${f}`);
    } else {
      warn(`${f} not present at repo root — skipped (will be re-verified by the coordinator).`);
    }
  }
}

// ───────────────────────── 4. dependency union ──────────────────────────────

const DROP_TO_PEER = new Set(['kordoc']);

function minVer(range) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
function cmp(a, bb) {
  for (let i = 0; i < 3; i++) if (a[i] !== bb[i]) return a[i] - bb[i];
  return 0;
}
/** Higher minimum wins on a version-range conflict. */
function pickHigher(r1, r2) {
  return cmp(minVer(r1), minVer(r2)) >= 0 ? r1 : r2;
}

function computeDependencies() {
  const manifests = [join(CLI_DIR, 'package.json'), ...PACKAGE_DIRS.map((d) => join(d, 'package.json'))];
  const deps = {};
  const peers = {}; // name → highest range seen (currently kordoc)
  const conflicts = [];

  for (const mp of manifests) {
    const m = JSON.parse(readFileSync(mp, 'utf-8'));
    for (const [name, range] of Object.entries(m.dependencies ?? {})) {
      if (name.startsWith('@doklo-beta/')) continue; // workspace → inlined, not shipped
      if (DROP_TO_PEER.has(name)) {
        peers[name] = peers[name] ? pickHigher(peers[name], range) : range;
        continue;
      }
      if (deps[name] && deps[name] !== range) {
        const chosen = pickHigher(deps[name], range);
        conflicts.push({ name, a: deps[name], b: range, chosen, from: mp.replace(REPO_ROOT + '/', '') });
        deps[name] = chosen;
      } else {
        deps[name] = range;
      }
    }
  }

  const sorted = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
  return { dependencies: sorted, peers, conflicts };
}

// ───────────────────────── 5. publish manifest ──────────────────────────────

function writeManifest() {
  const cli = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf-8'));
  const { dependencies, peers, conflicts } = computeDependencies();

  const peerDependencies = Object.fromEntries(Object.keys(peers).sort().map((k) => [k, peers[k]]));
  const peerDependenciesMeta = Object.fromEntries(
    Object.keys(peers).sort().map((k) => [k, { optional: true }]),
  );

  const manifest = {
    name: PKG_NAME,
    version: PKG_VERSION,
    description: cli.description,
    keywords: cli.keywords,
    type: 'module',
    bin: { doklo: './dist/index.js' },
    exports: {
      '.': './dist/index.js',
      './api': './dist/api.js',
    },
    // npm auto-includes README.md + LICENSE, but not README.ko.md or (on this
    // npm) CHANGELOG.md — list the docs explicitly so the pack is version-proof.
    files: [
      'dist',
      'templates',
      'css',
      'i18n',
      'studio',
      'README.md',
      'README.ko.md',
      'AGENT_GUIDE.md',
      'LICENSE',
      'NOTICE',
      'CHANGELOG.md',
    ],
    engines: { node: RELEASE_NODE_ENGINE },
    repository: { type: 'git', url: 'git+https://github.com/mayp-ai/doklo.git' },
    homepage: 'https://doklo.io',
    bugs: { url: 'https://github.com/mayp-ai/doklo/issues' },
    license: RELEASE_LICENSE,
    author: 'MAYP',
    // provenance needs an OIDC issuer, so this package can only be published
    // from .github/workflows/release.yml (id-token: write). A manual
    // `npm publish` from a developer machine fails on this field.
    publishConfig: { access: 'public', provenance: true },
    dependencies,
    peerDependencies,
    peerDependenciesMeta,
  };

  writeFileSync(join(RELEASE_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  log(`wrote release/package.json (${Object.keys(dependencies).length} deps, ${Object.keys(peerDependencies).length} optional peers)`);
  if (conflicts.length) {
    for (const c of conflicts) {
      warn(`dep conflict: ${c.name} ${c.a} vs ${c.b} → chose ${c.chosen} (${c.from})`);
    }
  } else {
    log('no dependency-range conflicts.');
  }
  return manifest;
}

async function runBoundReleaseStagePhase(expectedStagedIdentity, phase) {
  const stagedRelease = relative(REPO_ROOT, RELEASE_DIR);
  await assertContainedPathIdentity(
    REPO_ROOT,
    stagedRelease,
    expectedStagedIdentity,
  );
  const result = await phase();
  await assertContainedPathIdentity(
    REPO_ROOT,
    stagedRelease,
    expectedStagedIdentity,
  );
  return result;
}

// ───────────────────────── run ──────────────────────────────────────────────

async function main() {
  log(`building ${PKG_NAME}@${PKG_VERSION} → ${PUBLISHED_RELEASE_DIR}`);
  ensureWorkspaceBuilt();
  await loadBuiltWorkspaceModules();

  const stagedRelease = relative(REPO_ROOT, RELEASE_DIR);
  const publishedRelease = relative(REPO_ROOT, PUBLISHED_RELEASE_DIR);
  await removeContained(REPO_ROOT, stagedRelease, {
    recursive: true,
    force: true,
  });
  mkdirSync(RELEASE_DIR, { recursive: true });
  const expectedStagedIdentity = await captureContainedPathIdentity(
    REPO_ROOT,
    stagedRelease,
  );

  // A failure can mean RELEASE_DIR was replaced after authorization. Leave an
  // unsuccessful stage for explicit recovery instead of reauthorizing cleanup
  // against a path that may now name an unrelated same-type directory.
  await runBoundReleaseStagePhase(expectedStagedIdentity, bundle);
  await runBoundReleaseStagePhase(expectedStagedIdentity, copyAssets);
  await runBoundReleaseStagePhase(expectedStagedIdentity, copyStudio);
  await runBoundReleaseStagePhase(expectedStagedIdentity, copyDocs);
  const manifest = await runBoundReleaseStagePhase(
    expectedStagedIdentity,
    writeManifest,
  );
  // Last gate before this tree becomes the published artefact.
  await runBoundReleaseStagePhase(expectedStagedIdentity, async () => {
    await assertPublishableReleaseContent(RELEASE_DIR);
    log('release content guard: clean.');
  });
  await publishDirectoryContained(
    REPO_ROOT,
    stagedRelease,
    publishedRelease,
    { expectedStagedIdentity },
  );

  log('');
  log('done. Next: (cd apps/cli/release && npm pack --dry-run)');
  // Surface the manifest on stdout for logs/reports.
  process.stdout.write('\n----- release/package.json -----\n');
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`\n✗ build-release failed: ${err?.stack || err}\n`);
  process.exit(1);
});
