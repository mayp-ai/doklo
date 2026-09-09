// Workspace loader — finds + parses workspace.json.
//
// Walks upward from the given start directory until it locates a
// workspace.json (much like git finding .git). This lets users invoke
// commands from any subdirectory of the workspace.

import { readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { WorkspaceSchema, type Workspace } from '@doklo-beta/core';
import { workspacePaths, type WorkspacePaths } from './paths.js';

export class WorkspaceNotInitializedError extends Error {
  /** Contract code, so callers report "this directory is not a workspace"
   *  rather than a generic COMMAND_FAILED. */
  readonly code = 'WORKSPACE_NOT_INITIALIZED';

  /** `message` lets a command replace the default one-liner with guidance
   *  fitted to what the user was trying to do, without losing the code or
   *  the searched-from path. */
  constructor(
    public readonly searchedFrom: string,
    message?: string,
  ) {
    super(
      message
        ?? `No workspace.json found at or above ${searchedFrom}. Run \`doklo init\` first.`,
    );
    this.name = 'WorkspaceNotInitializedError';
  }
}

export interface LoadedWorkspace {
  workspace: Workspace;
  paths: WorkspacePaths;
}

/** Find the nearest workspace.json walking up from `start` (inclusive). */
export async function findWorkspaceFile(start: string): Promise<string | null> {
  let dir = resolve(start);
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, 'workspace.json');
    if (await exists(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

export async function loadWorkspace(start: string): Promise<Workspace> {
  const found = await findWorkspaceFile(start);
  if (!found) throw new WorkspaceNotInitializedError(resolve(start));
  const raw = await readFile(found, 'utf-8');
  const json = JSON.parse(raw) as unknown;
  return WorkspaceSchema.parse(json);
}

export async function loadWorkspaceWithPaths(start: string): Promise<LoadedWorkspace> {
  const found = await findWorkspaceFile(start);
  if (!found) throw new WorkspaceNotInitializedError(resolve(start));
  const raw = await readFile(found, 'utf-8');
  const workspace = WorkspaceSchema.parse(JSON.parse(raw) as unknown);
  return { workspace, paths: workspacePaths(dirname(found)) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}
