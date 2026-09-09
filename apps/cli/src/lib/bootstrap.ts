// Workspace bootstrap — writes workspace.json + .doklo/hub skeleton.
//
// This is the first thing `doklo init` does after gathering input. Every
// downstream command assumes the layout produced here.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import {
  WorkspaceSchema,
  RolesFileSchema,
  LexiconFileSchema,
  type Service,
} from '@doklo-beta/core';
import { workspacePaths } from './paths.js';

export interface BootstrapOptions {
  root: string;
  workspaceId: string;
  name: string;
  defaultLocale: string;
  supportedLocales: string[];
  services: Service[];
  recordingBranch?: string;
}

export class WorkspaceAlreadyInitializedError extends Error {
  constructor(public readonly path: string) {
    super(`workspace.json already exists at ${path}`);
    this.name = 'WorkspaceAlreadyInitializedError';
  }
}

export async function bootstrapWorkspace(opts: BootstrapOptions): Promise<void> {
  const paths = workspacePaths(opts.root);
  if (await exists(paths.workspaceFile)) {
    throw new WorkspaceAlreadyInitializedError(paths.workspaceFile);
  }

  const now = new Date().toISOString();

  const workspace = WorkspaceSchema.parse({
    workspace_id: opts.workspaceId,
    name: opts.name,
    services: opts.services,
    ...(opts.recordingBranch ? { recording_branch: opts.recordingBranch } : {}),
    default_locale: opts.defaultLocale,
    supported_locales: opts.supportedLocales,
    created_at: now,
    updated_at: now,
  });

  // Directories first — services subdirs need workspace knowledge.
  await mkdir(paths.doksDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
  await mkdir(paths.debugDir, { recursive: true });
  for (const svc of workspace.services) {
    await mkdir(paths.serviceDir(svc.service_id), { recursive: true });
  }

  // Allowlist .gitignore — the Hub and Publication definitions are committed.
  await writeGitignoreIfAbsent(paths.gitignoreFile);

  // Empty registries — validated against schema so they're loadable on day 1.
  const roles = RolesFileSchema.parse({ roles: [], version: 1, updated_at: now });
  const lexicon = LexiconFileSchema.parse({ terms: [], version: 1, updated_at: now });

  await writeJson(paths.rolesFile, roles);
  await writeJson(paths.lexiconFile, lexicon);
  await writeJson(paths.workspaceFile, workspace);
}

// `.doklo/.gitignore` — allowlist policy. Everything under .doklo/ is ignored
// except the Hub (hub/), Publication definitions (livedocs/), and this file.
// Derived output (renders, caches, debug, screenshots) is regenerable and stays
// out of version control. Built from an array so the 7 core lines stay verbatim.
const DOKLO_GITIGNORE = [
  '# .doklo/ — Doklo workspace.',
  '# The Hub (hub/) and Publication definitions (livedocs/) are source: commit them.',
  '# Everything else (renders, caches, debug, screenshots) is derived — regenerate it.',
  '/*',
  '!/.gitignore',
  '!/hub/',
  '!/livedocs/',
  '',
  '# Want to publish your rendered Live Docs (e.g. GitHub Pages)? Un-ignore the',
  '# derived output you want to commit by adding an allow line below, e.g. !/output/',
  '',
].join('\n');

/** Writes `.doklo/.gitignore` unless it already exists. Never clobbers a
 * user-customized file — it can exist even when workspace.json does not
 * (partial/re-init), so this guard is independent of the
 * WorkspaceAlreadyInitializedError check above. */
async function writeGitignoreIfAbsent(path: string): Promise<void> {
  if (await exists(path)) return;
  await writeFile(path, DOKLO_GITIGNORE, 'utf-8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
