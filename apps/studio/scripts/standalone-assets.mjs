// Next standalone deliberately omits public/ and .next/static/. Doklo serves
// the standalone server directly, so both must be copied beside server.js.
// Keep this reusable: build:standalone and release packaging must enforce the
// same asset contract even when a previously built standalone tree is reused.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  captureContainedPathIdentity,
  publishDirectoryContained,
  removeContained,
} from '@doklo-beta/core';
import { nativeStandaloneAssetFileSystem } from './standalone-assets-internal.mjs';

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertContained(base, target, description) {
  const relativePath = relative(base, target);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[copy-standalone-assets] ${description} escapes ${base}: ${target}`);
  }
}

function assertNoSymbolicLinkSegments(base, target, description) {
  const absoluteBase = resolve(base);
  const absoluteTarget = resolve(target);
  assertContained(absoluteBase, absoluteTarget, description);

  const relativePath = relative(absoluteBase, absoluteTarget);
  const segments = relativePath === '' ? [] : relativePath.split(sep);
  let current = absoluteBase;
  for (const segment of ['', ...segments]) {
    if (segment !== '') current = join(current, segment);
    if (!pathExists(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`[copy-standalone-assets] ${description} contains a symbolic link: ${current}`);
    }
  }
}

function assertExistingPathContained(baseReal, target, description) {
  const targetReal = realpathSync(target);
  assertContained(baseReal, targetReal, description);
  return targetReal;
}

function nearestExistingAncestor(path) {
  let current = path;
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`[copy-standalone-assets] no existing ancestor for ${path}`);
    }
    current = parent;
  }
  return current;
}

function assertTreeContainsNoSymbolicLinks(root, description) {
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`[copy-standalone-assets] ${description} is a symbolic link: ${root}`);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`[copy-standalone-assets] ${description} contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) assertTreeContainsNoSymbolicLinks(path, description);
  }
}

function containsFile(directory) {
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    if (entry.isFile()) return true;
    return entry.isDirectory() && containsFile(join(directory, entry.name));
  });
}

export function assertDirectoryContainsFiles(directory, description = 'required asset directory') {
  if (!existsSync(directory)) {
    throw new Error(`[copy-standalone-assets] ${description} missing: ${directory}`);
  }
  assertTreeContainsNoSymbolicLinks(directory, description);
  if (!containsFile(directory)) {
    throw new Error(`[copy-standalone-assets] ${description} does not contain files: ${directory}`);
  }
}

function assertSafeSource({ studioDir, containmentRoot, containmentReal, source, description }) {
  assertNoSymbolicLinkSegments(studioDir, containmentRoot, `${description} containment root`);
  assertNoSymbolicLinkSegments(containmentRoot, source, description);
  if (!pathExists(source)) return false;
  assertExistingPathContained(containmentReal, source, description);
  assertTreeContainsNoSymbolicLinks(source, description);
  return true;
}

function assertSafeDestination({ standaloneRoot, standaloneReal, destination, description }) {
  assertNoSymbolicLinkSegments(standaloneRoot, destination, description);
  const existingAncestor = nearestExistingAncestor(destination);
  assertExistingPathContained(standaloneReal, existingAncestor, description);
  if (pathExists(destination)) {
    assertExistingPathContained(standaloneReal, destination, description);
  }
}

export async function copyStandaloneAssets({
  studioDir,
  log = console.log,
  warn = console.warn,
}) {
  const absoluteStudioDir = resolve(studioDir);
  assertNoSymbolicLinkSegments(absoluteStudioDir, absoluteStudioDir, 'Studio directory');
  const studioReal = realpathSync(absoluteStudioDir);
  const nextRoot = join(absoluteStudioDir, '.next');
  assertNoSymbolicLinkSegments(absoluteStudioDir, nextRoot, 'Studio .next directory');
  if (!pathExists(nextRoot)) {
    throw new Error(`[copy-standalone-assets] ${nextRoot} not found. Run \`next build\` first.`);
  }
  const nextReal = assertExistingPathContained(studioReal, nextRoot, 'Studio .next directory');

  const monorepoRoot = join(absoluteStudioDir, '..', '..');
  const standaloneRoot = join(absoluteStudioDir, '.next', 'standalone');
  assertNoSymbolicLinkSegments(absoluteStudioDir, standaloneRoot, 'Studio standalone directory');
  if (!pathExists(standaloneRoot)) {
    throw new Error(
      `[copy-standalone-assets] ${standaloneRoot} not found. Run \`next build\` with output:'standalone' first.`,
    );
  }
  const standaloneReal = assertExistingPathContained(
    nextReal,
    standaloneRoot,
    'Studio standalone directory',
  );

  const relativeStudio = relative(monorepoRoot, absoluteStudioDir);
  const candidates = [join(standaloneRoot, relativeStudio), standaloneRoot];
  let serverDir;
  for (const candidate of candidates) {
    const serverFile = join(candidate, 'server.js');
    assertNoSymbolicLinkSegments(standaloneRoot, serverFile, 'Studio standalone candidate');
    if (!pathExists(serverFile)) continue;
    if (!lstatSync(serverFile).isFile()) {
      throw new Error(`[copy-standalone-assets] standalone entry is not a file: ${serverFile}`);
    }
    assertExistingPathContained(standaloneReal, candidate, 'Studio standalone candidate');
    assertExistingPathContained(standaloneReal, serverFile, 'Studio standalone entry');
    serverDir = candidate;
    break;
  }
  if (!serverDir) {
    throw new Error(
      `[copy-standalone-assets] Could not find server.js in any of:\n${candidates
        .map((directory) => `  - ${join(directory, 'server.js')}`)
        .join('\n')}`,
    );
  }

  const copies = [
    {
      from: join(absoluteStudioDir, 'public'),
      to: join(serverDir, 'public'),
      containmentRoot: absoluteStudioDir,
      containmentReal: studioReal,
      description: 'public asset source',
      required: false,
    },
    {
      from: join(absoluteStudioDir, '.next', 'static'),
      to: join(serverDir, '.next', 'static'),
      containmentRoot: nextRoot,
      containmentReal: nextReal,
      description: 'required static asset source',
      required: true,
    },
  ];

  const plans = copies.map((copy) => {
    const sourceExists = assertSafeSource({
      studioDir: absoluteStudioDir,
      containmentRoot: copy.containmentRoot,
      containmentReal: copy.containmentReal,
      source: copy.from,
      description: copy.description,
    });
    if (!sourceExists && copy.required) {
      throw new Error(`[copy-standalone-assets] required asset directory missing: ${copy.from}`);
    }
    if (sourceExists && copy.required) assertDirectoryContainsFiles(copy.from);
    assertSafeDestination({
      standaloneRoot,
      standaloneReal,
      destination: copy.to,
      description: `${copy.description} destination`,
    });
    const parent = dirname(copy.to);
    if (!pathExists(parent) || !lstatSync(parent).isDirectory()) {
      throw new Error(
        `[copy-standalone-assets] ${copy.description} destination parent missing: ${parent}`,
      );
    }
    const staged = join(
      parent,
      `.${basename(copy.to)}.stage-${process.pid}-${randomUUID()}`,
    );
    return {
      ...copy,
      sourceExists,
      staged,
      stagedRelativePath: relative(standaloneRoot, staged),
      destinationRelativePath: relative(standaloneRoot, copy.to),
    };
  });

  // Do not clean stages after a failure: a rejected identity check can mean
  // that the same lexical path now names a replacement tree. Safe abandonment
  // is preferable to freshly authorizing deletion of that untrusted tree.
  for (const plan of plans) {
    if (!plan.sourceExists) continue;
    const currentSourceExists = assertSafeSource({
      studioDir: absoluteStudioDir,
      containmentRoot: plan.containmentRoot,
      containmentReal: plan.containmentReal,
      source: plan.from,
      description: plan.description,
    });
    if (!currentSourceExists) {
      throw new Error(
        `[copy-standalone-assets] ${plan.description} changed during asset copy: ${plan.from}`,
      );
    }
    if (plan.required) assertDirectoryContainsFiles(plan.from);
    assertSafeDestination({
      standaloneRoot,
      standaloneReal,
      destination: plan.staged,
      description: `${plan.description} stage before copy`,
    });
    await removeContained(standaloneRoot, plan.stagedRelativePath, {
      recursive: true,
      force: true,
    });
    await nativeStandaloneAssetFileSystem.copyDirectory(plan.from, plan.staged, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    assertSafeDestination({
      standaloneRoot,
      standaloneReal,
      destination: plan.staged,
      description: `${plan.description} staged tree`,
    });
    assertTreeContainsNoSymbolicLinks(
      plan.staged,
      `${plan.description} staged tree`,
    );
    if (plan.required) {
      assertDirectoryContainsFiles(plan.staged, 'staged asset directory');
    }
    plan.stagedIdentity = await captureContainedPathIdentity(
      standaloneRoot,
      plan.stagedRelativePath,
    );
  }

  for (const plan of plans) {
    const currentSourceExists = assertSafeSource({
      studioDir: absoluteStudioDir,
      containmentRoot: plan.containmentRoot,
      containmentReal: plan.containmentReal,
      source: plan.from,
      description: plan.description,
    });
    if (currentSourceExists !== plan.sourceExists) {
      throw new Error(
        `[copy-standalone-assets] ${plan.description} changed during asset publish: ${plan.from}`,
      );
    }
    if (!plan.sourceExists) {
      await removeContained(
        standaloneRoot,
        plan.destinationRelativePath,
        { recursive: true, force: true },
      );
      warn(`[copy-standalone-assets] skip (missing): ${plan.from}; removed stale destination`);
      continue;
    }
    if (plan.required) assertDirectoryContainsFiles(plan.from);
    await publishDirectoryContained(
      standaloneRoot,
      plan.stagedRelativePath,
      plan.destinationRelativePath,
      { expectedStagedIdentity: plan.stagedIdentity },
    );
    assertSafeDestination({
      standaloneRoot,
      standaloneReal,
      destination: plan.to,
      description: `${plan.description} published destination`,
    });
    if (plan.required) {
      assertDirectoryContainsFiles(plan.to, 'published asset directory');
    }
    log(
      `[copy-standalone-assets] ${relative(absoluteStudioDir, plan.from)} -> ${relative(absoluteStudioDir, plan.to)}`,
    );
  }

  return { standaloneRoot, serverDir };
}
