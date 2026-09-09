import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PathOutsideRootError,
  resolveContainedPath,
  writeFileAtomic,
} from '@doklo-beta/core';
import type { ZodType } from 'zod';
import { revisionOf } from './load-state';

export type SaveErrorCode =
  | 'MISSING'
  | 'UNREADABLE'
  | 'INVALID'
  | 'CONFLICT'
  | 'WRITE_FAILED';

export type SaveResult =
  | { ok: true; path: string; revision: string }
  | {
      ok: false;
      code: SaveErrorCode;
      path: string;
      error: string;
      preserved: true;
    };

export type MutationReadResult<T> =
  | {
      ok: true;
      path: string;
      relativePath: string;
      contents: string;
      revision: string;
      data: T;
    }
  | Extract<SaveResult, { ok: false }>;

export function formatZodError(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.map((part) => String(part)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(', ');
}

export function saveFailure(
  code: SaveErrorCode,
  path: string,
  error: unknown,
): Extract<SaveResult, { ok: false }> {
  return {
    ok: false,
    code,
    path,
    error: error instanceof Error ? error.message : String(error),
    preserved: true,
  };
}

export async function readJsonForMutation<T>(input: {
  root: string;
  relativePath: string;
  expectedRevision?: string;
  schema: ZodType<T>;
  label: string;
}): Promise<MutationReadResult<T>> {
  const fallbackPath = resolve(input.root, input.relativePath);
  let path: string;
  try {
    path = await resolveContainedPath(input.root, input.relativePath, {
      allowMissingLeaf: true,
      rejectSymlinkLeaf: true,
    });
  } catch (error) {
    const code = error instanceof PathOutsideRootError
      ? 'INVALID'
      : isMissingError(error)
        ? 'MISSING'
        : 'UNREADABLE';
    return saveFailure(code, fallbackPath, error);
  }

  let contents: string;
  try {
    contents = await readFile(path, 'utf-8');
  } catch (error) {
    return saveFailure(isMissingError(error) ? 'MISSING' : 'UNREADABLE', path, error);
  }

  const revision = revisionOf(contents);
  if (
    input.expectedRevision !== undefined &&
    revision !== input.expectedRevision
  ) {
    return saveFailure(
      'CONFLICT',
      path,
      `${input.label} changed outside Studio. Reload before saving.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch (error) {
    return saveFailure('INVALID', path, `${input.label} contains invalid JSON: ${errorMessage(error)}`);
  }

  const parsed = input.schema.safeParse(raw);
  if (!parsed.success) {
    return saveFailure(
      'INVALID',
      path,
      `${input.label} is invalid: ${formatZodError(parsed.error)}`,
    );
  }

  // Keep the validated raw tree rather than Zod's normalized output. Zod
  // defaults and stripping schemas may otherwise discard extension fields.
  return {
    ok: true,
    path,
    relativePath: input.relativePath,
    contents,
    revision,
    data: raw as T,
  };
}

export async function writeJsonForMutation<T>(input: {
  root: string;
  relativePath: string;
  expectedRevision: string;
  value: T;
  schema: ZodType<T>;
  label: string;
}): Promise<SaveResult> {
  const fallbackPath = resolve(input.root, input.relativePath);
  const parsed = input.schema.safeParse(input.value);
  if (!parsed.success) {
    return saveFailure(
      'INVALID',
      fallbackPath,
      `${input.label} is invalid: ${formatZodError(parsed.error)}`,
    );
  }

  let path: string;
  try {
    path = await resolveContainedPath(input.root, input.relativePath, {
      allowMissingLeaf: true,
      rejectSymlinkLeaf: true,
    });
  } catch (error) {
    return saveFailure('WRITE_FAILED', fallbackPath, error);
  }

  // Recheck immediately before the atomic replace so validation/merge work
  // cannot silently overwrite a file changed after the first CAS read.
  let currentContents: string;
  try {
    currentContents = await readFile(path, 'utf-8');
  } catch (error) {
    return saveFailure(isMissingError(error) ? 'MISSING' : 'UNREADABLE', path, error);
  }
  if (revisionOf(currentContents) !== input.expectedRevision) {
    return saveFailure(
      'CONFLICT',
      path,
      `${input.label} changed outside Studio. Reload before saving.`,
    );
  }

  let contents: string;
  try {
    contents = JSON.stringify(input.value, null, 2) + '\n';
  } catch (error) {
    return saveFailure(
      'INVALID',
      path,
      `${input.label} cannot be serialized as JSON: ${errorMessage(error)}`,
    );
  }
  try {
    await writeFileAtomic(path, contents);
  } catch (error) {
    // The shared writer fsyncs after rename. If only the final durability
    // acknowledgement failed, the intended bytes may already be in place;
    // report that state as saved rather than falsely claiming preservation.
    try {
      const observed = await readFile(path, 'utf-8');
      if (observed === contents) {
        return { ok: true, path, revision: revisionOf(observed) };
      }
    } catch {
      // Preserve the original writer error below.
    }
    return saveFailure('WRITE_FAILED', path, error);
  }

  return { ok: true, path, revision: revisionOf(contents) };
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
