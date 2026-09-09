import {
  lstat,
  mkdir,
  readFile,
  readdir,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import {
  captureContainedPathIdentity,
  resolveContainedPath,
  unlinkContained,
  writeFileAtomicContained,
} from '@doklo-beta/core';
import {
  OutputExistsError,
  parsePublication,
  publicationDigest,
  PublicationNameSchema,
  serializePublication,
  type PublicationV1,
} from '@doklo-beta/livedoc-engine';
import { workspacePaths } from './paths.js';

export class PublicationNotFoundError extends Error {
  readonly code = 'PUBLICATION_NOT_FOUND';

  constructor(readonly path: string) {
    super(`Publication definition not found: ${path}`);
    this.name = 'PublicationNotFoundError';
  }
}

export class InvalidPublicationFileError extends Error {
  readonly code = 'PUBLICATION_INVALID';

  constructor(readonly path: string, cause: unknown) {
    const detail = cause instanceof Error ? ` (${cause.message})` : '';
    super(`Publication definition is invalid: ${path}${detail}`, { cause });
    this.name = 'InvalidPublicationFileError';
  }
}

export class UnreadablePublicationFileError extends Error {
  readonly code = 'PUBLICATION_UNREADABLE';

  constructor(readonly path: string, cause: unknown) {
    const detail = cause instanceof Error ? ` (${cause.message})` : '';
    super(`Publication definition is unreadable: ${path}${detail}`, { cause });
    this.name = 'UnreadablePublicationFileError';
  }
}

export class PublicationCreatedAtImmutableError extends Error {
  readonly code = 'PUBLICATION_CREATED_AT_IMMUTABLE';

  constructor(readonly path: string) {
    super(`Publication created_at is immutable: ${path}`);
    this.name = 'PublicationCreatedAtImmutableError';
  }
}

export async function createPublication(
  workspaceRoot: string,
  value: PublicationV1,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  const publication = parsePublication(value);
  const directory = await ensurePublicationsDirectory(workspaceRoot);
  const paths = workspacePaths(workspaceRoot);
  const mutationRoot = await resolveContainedPath(paths.root, '.', {
    rejectSymlinkLeaf: true,
  });
  const target = await resolvePublicationTarget(directory, publication.name);
  const relativePath = relative(mutationRoot, target);
  let expectedIdentity: Awaited<ReturnType<typeof captureContainedPathIdentity>> | undefined;

  if (options.overwrite === true) {
    expectedIdentity = await captureContainedPathIdentity(mutationRoot, relativePath);
    const existing = await loadPublicationFromRegistry(directory, publication.name);
    if (existing.created_at !== publication.created_at) {
      throw new PublicationCreatedAtImmutableError(target);
    }
  }

  try {
    await writeFileAtomicContained(
      mutationRoot,
      relativePath,
      serializePublication(publication),
      { replace: options.overwrite === true, expectedIdentity },
    );
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new OutputExistsError(relativePath);
    }
    throw error;
  }
}

export async function loadPublication(
  workspaceRoot: string,
  name: string,
): Promise<PublicationV1> {
  PublicationNameSchema.parse(name);
  const registry = await resolvePublicationsRegistry(workspaceRoot);
  if (!registry.exists) {
    throw new PublicationNotFoundError(join(registry.path, `${name}.json`));
  }
  return loadPublicationFromRegistry(registry.path, name);
}

export async function loadPublicationDefinition(
  workspaceRoot: string,
  name: string,
): Promise<{ publication: PublicationV1; path: string; sha256: string }> {
  PublicationNameSchema.parse(name);
  const registry = await resolvePublicationsRegistry(workspaceRoot);
  if (!registry.exists) {
    throw new PublicationNotFoundError(join(registry.path, `${name}.json`));
  }
  const publication = await loadPublicationFromRegistry(registry.path, name);
  return {
    publication,
    path: await resolvePublicationTarget(registry.path, name),
    sha256: publicationDigest(publication),
  };
}

async function loadPublicationFromRegistry(
  publicationsDir: string,
  name: string,
): Promise<PublicationV1> {
  const path = await resolvePublicationTarget(publicationsDir, name);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (cause) {
    if (isMissingError(cause)) throw new PublicationNotFoundError(path);
    throw new UnreadablePublicationFileError(path, cause);
  }
  if (!stat.isFile()) {
    throw new InvalidPublicationFileError(path, new Error('expected a regular JSON file'));
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if (isMissingError(cause)) throw new PublicationNotFoundError(path);
    throw new UnreadablePublicationFileError(path, cause);
  }

  try {
    const publication = parsePublication(JSON.parse(raw) as unknown);
    if (publication.name !== name) {
      throw new Error(`file name requires Publication name "${name}"`);
    }
    return publication;
  } catch (cause) {
    throw new InvalidPublicationFileError(path, cause);
  }
}

export async function listPublications(workspaceRoot: string): Promise<PublicationV1[]> {
  const registry = await resolvePublicationsRegistry(workspaceRoot);
  if (!registry.exists) return [];
  const directory = registry.path;

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (isMissingError(cause)) return [];
    throw new UnreadablePublicationFileError(directory, cause);
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort(compareText);
  const publications: PublicationV1[] = [];
  for (const name of names) {
    try {
      PublicationNameSchema.parse(name);
    } catch (cause) {
      throw new InvalidPublicationFileError(join(directory, `${name}.json`), cause);
    }
    publications.push(await loadPublicationFromRegistry(directory, name));
  }
  return publications.sort((a, b) => compareText(a.name, b.name));
}

export async function removePublication(workspaceRoot: string, name: string): Promise<void> {
  PublicationNameSchema.parse(name);
  const registry = await resolvePublicationsRegistry(workspaceRoot);
  if (!registry.exists) {
    throw new PublicationNotFoundError(join(registry.path, `${name}.json`));
  }
  const path = await resolvePublicationTarget(registry.path, name);
  const paths = workspacePaths(workspaceRoot);
  const mutationRoot = await resolveContainedPath(paths.root, '.', {
    rejectSymlinkLeaf: true,
  });
  const relativePath = relative(mutationRoot, path);
  let expectedIdentity: Awaited<ReturnType<typeof captureContainedPathIdentity>>;
  try {
    expectedIdentity = await captureContainedPathIdentity(mutationRoot, relativePath);
  } catch (cause) {
    if (isMissingError(cause)) throw new PublicationNotFoundError(path);
    throw new UnreadablePublicationFileError(path, cause);
  }
  await loadPublicationFromRegistry(registry.path, name);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) {
      throw new InvalidPublicationFileError(path, new Error('expected a regular JSON file'));
    }
    await unlinkContained(mutationRoot, relativePath, { expectedIdentity });
  } catch (cause) {
    if (cause instanceof InvalidPublicationFileError) throw cause;
    if (isPathIdentityChangedError(cause)) throw cause;
    if (isMissingError(cause)) throw new PublicationNotFoundError(path);
    throw new UnreadablePublicationFileError(path, cause);
  }
}

async function ensurePublicationsDirectory(workspaceRoot: string): Promise<string> {
  const registry = await resolvePublicationsRegistry(workspaceRoot);
  if (registry.exists) return registry.path;
  await mkdir(registry.path, { recursive: true });
  const created = await resolvePublicationsRegistry(workspaceRoot);
  if (!created.exists) {
    throw new UnreadablePublicationFileError(
      registry.path,
      new Error('Publication registry was not created'),
    );
  }
  return created.path;
}

type ResolvedPublicationsRegistry =
  | { exists: true; path: string }
  | { exists: false; path: string };

async function resolvePublicationsRegistry(
  workspaceRoot: string,
): Promise<ResolvedPublicationsRegistry> {
  const paths = workspacePaths(workspaceRoot);
  const path = await resolveContainedPath(paths.root, relative(paths.root, paths.publicationsDir), {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (cause) {
    if (isMissingError(cause)) return { exists: false, path };
    throw new UnreadablePublicationFileError(path, cause);
  }
  if (!stat.isDirectory()) {
    throw new InvalidPublicationFileError(path, new Error('expected a directory'));
  }
  return { exists: true, path };
}

async function resolvePublicationTarget(publicationsDir: string, name: string): Promise<string> {
  return resolveContainedPath(publicationsDir, `${name}.json`, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
}

function isMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isPathIdentityChangedError(
  error: unknown,
): error is Error & { code: 'PATH_IDENTITY_CHANGED'; retryable: true } {
  return error instanceof Error
    && 'code' in error
    && error.code === 'PATH_IDENTITY_CHANGED'
    && 'retryable' in error
    && error.retryable === true;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
