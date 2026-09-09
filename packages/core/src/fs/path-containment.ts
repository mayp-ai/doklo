import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';

export type ContainedPathOptions = {
  allowMissingLeaf?: boolean;
  rejectSymlinkLeaf?: boolean;
};

/** Raised when an untrusted project-relative path cannot be proven to stay under its root. */
export class PathOutsideRootError extends Error {
  readonly root: string;
  readonly candidate: string;

  constructor(root: string, candidate: string) {
    super(`Path "${candidate}" is outside service root "${root}".`);
    this.name = 'PathOutsideRootError';
    this.root = root;
    this.candidate = candidate;
  }
}

export type ConfinedMutationOperation =
  | 'write'
  | 'unlink'
  | 'remove'
  | 'publish-directory';

/** Raised when a path no longer names the entry that a confined mutation authorized. */
export class PathIdentityChangedError extends Error {
  readonly code = 'PATH_IDENTITY_CHANGED' as const;
  readonly path: string;
  readonly operation: ConfinedMutationOperation;
  readonly retryable = true;

  constructor(path: string, operation: ConfinedMutationOperation) {
    super(`Path identity changed before ${operation}: "${path}".`);
    this.name = 'PathIdentityChangedError';
    this.path = path;
    this.operation = operation;
  }
}

export async function resolveContainedPath(
  root: string,
  relativePath: string,
  options?: ContainedPathOptions,
): Promise<string> {
  const lexicalRoot = resolve(root);
  if (
    relativePath.includes('\0')
    || isAbsolute(relativePath)
    || win32.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/u).includes('..')
  ) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }

  const lexicalTarget = resolve(lexicalRoot, relativePath);
  if (!isContained(lexicalRoot, lexicalTarget)) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }

  await rejectSymlinkedParentSegments(
    lexicalRoot,
    lexicalTarget,
    relativePath,
  );

  try {
    const leafIsSymlink = (await lstat(lexicalTarget)).isSymbolicLink();
    if (options?.rejectSymlinkLeaf !== false && leafIsSymlink) {
      throw new PathOutsideRootError(lexicalRoot, relativePath);
    }
  } catch (error) {
    if (!options?.allowMissingLeaf && isMissingPathError(error)) throw error;
    if (!isMissingPathError(error)) throw error;
  }

  const realRoot = await realpath(lexicalRoot);
  const realTarget = await resolveExistingAncestor(
    lexicalTarget,
    lexicalRoot,
    relativePath,
  );
  if (!isContained(realRoot, realTarget)) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }

  return realTarget;
}

/**
 * Synchronous counterpart of {@link resolveContainedPath}, fixed to the one mode
 * anchor reads use: **the leaf must exist and must not be a symlink**, and no
 * options are accepted (that mode is the async resolver's default — no
 * `allowMissingLeaf`, `rejectSymlinkLeaf` left on). It exists because drift
 * verification is consumed by the MCP server on a synchronous path and cannot
 * await; it lives here, beside the async form, so the containment rule stays in
 * one file and the two can be read against each other.
 *
 * Their verdicts must agree on every input. Drift compares a hash generate
 * computed over the anchors the *async* resolver admitted against a hash verify
 * recomputes over the anchors *this* one admits — so any disagreement makes a
 * Dok that nobody touched hash differently on the two sides and go permanently,
 * structurally stale. Parity is pinned by `__tests__/fs/path-containment.test.ts`
 * (and end-to-end by apps/cli/__tests__/anchor-read-contract.test.ts).
 *
 * A missing leaf throws (ENOENT/ENOTDIR) rather than resolving, matching the
 * async default; callers reading anchors treat that as "unreadable".
 */
export function resolveContainedPathSync(
  root: string,
  relativePath: string,
): string {
  const lexicalRoot = resolve(root);
  if (
    relativePath.includes('\0')
    || isAbsolute(relativePath)
    || win32.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/u).includes('..')
  ) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }

  const lexicalTarget = resolve(lexicalRoot, relativePath);
  if (!isContained(lexicalRoot, lexicalTarget)) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }

  rejectSymlinkedParentSegmentsSync(lexicalRoot, lexicalTarget, relativePath);

  // A symlinked leaf could point anywhere, so it is refused outright.
  if (lstatSync(lexicalTarget).isSymbolicLink()) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }

  // Realpath both sides: a symlink *above* the root (macOS /var → /private/var,
  // say) then resolves identically on both and cannot fake an escape. The async
  // form's missing-ancestor walk is unreachable in this mode — the leaf was just
  // proven to exist and not be a symlink — so a plain realpath suffices.
  const realTarget = realpathSync(lexicalTarget);
  if (!isContained(realpathSync(lexicalRoot), realTarget)) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }

  return realTarget;
}

async function rejectSymlinkedParentSegments(
  root: string,
  target: string,
  candidate: string,
): Promise<void> {
  if (target === root) return;

  const parents: string[] = [];
  let probe = dirname(target);

  while (probe !== root) {
    parents.unshift(probe);
    probe = dirname(probe);
  }

  for (const parent of parents) {
    try {
      if ((await lstat(parent)).isSymbolicLink()) {
        throw new PathOutsideRootError(root, candidate);
      }
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

/** Sync counterpart of {@link rejectSymlinkedParentSegments} — same walk, same verdicts. */
function rejectSymlinkedParentSegmentsSync(
  root: string,
  target: string,
  candidate: string,
): void {
  if (target === root) return;

  const parents: string[] = [];
  let probe = dirname(target);

  while (probe !== root) {
    parents.unshift(probe);
    probe = dirname(probe);
  }

  for (const parent of parents) {
    try {
      if (lstatSync(parent).isSymbolicLink()) {
        throw new PathOutsideRootError(root, candidate);
      }
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

async function resolveExistingAncestor(
  target: string,
  root: string,
  candidate: string,
): Promise<string> {
  let probe = target;
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const resolvedProbe = await realpath(probe);
      return resolve(resolvedProbe, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;

      // A filesystem entry that exists but cannot be realpathed is a dangling
      // symlink (or crosses one). It is not equivalent to a plain missing file.
      try {
        await lstat(probe);
        throw new PathOutsideRootError(root, candidate);
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }

      const parent = dirname(probe);
      if (parent === probe) throw error;
      missingSegments.unshift(basename(probe));
      probe = parent;
    }
  }
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (
    fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
