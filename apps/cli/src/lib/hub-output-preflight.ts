import { access, readdir, readFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join, relative } from 'node:path';
import {
  RolesFileSchema,
  resolveContainedPath,
  type Dok,
  type Service,
} from '@doklo-beta/core';
import {
  validateDokForWrite,
  type DokWriteTrustContext,
  resolveContainedOutputPath,
} from '@doklo-beta/generator';
import { loadWorkspaceWithPaths } from './workspace.js';

export interface HubOutputPreflightOptions {
  root: string;
  services?: readonly Service[];
}

export interface HubOutputPreflightResult {
  doks: ReadonlyMap<string, Dok>;
  knownRoleIds: ReadonlySet<string>;
  serviceRoots: ReadonlyMap<string, string>;
}

/**
 * Validate every committed Hub Dok before scan, paid generation, or any
 * deterministic layer write. This intentionally examines files unrelated to
 * the current generation plan: one invalid Dok makes the Hub untrustworthy.
 */
export async function preflightExistingHubOutputs(
  options: HubOutputPreflightOptions,
): Promise<HubOutputPreflightResult> {
  const { workspace, paths } = await loadWorkspaceWithPaths(options.root);
  const services = options.services ?? workspace.services;
  const serviceRoots = new Map<string, string>();
  for (const service of services) {
    serviceRoots.set(
      service.service_id,
      await resolveContainedPath(paths.root, service.code_root),
    );
  }

  const safeRolesPath = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.rolesFile),
  );
  const knownRoleIds = await readRoleIds(safeRolesPath);
  const context: DokWriteTrustContext = {
    expectedDokId: '',
    serviceRoots,
    knownRoleIds,
  };
  const doks = new Map<string, Dok>();
  const doksDir = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.doksDir),
  );
  let entries;
  try {
    entries = await readdir(doksDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { doks, knownRoleIds, serviceRoots };
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(paths.doksDir, entry.name);
    await resolveContainedOutputPath(paths.root, relative(paths.root, entryPath));
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile()) continue;
    const dokId = entry.name.slice(0, -'.json'.length);
    const dokFile = await resolveContainedOutputPath(
      paths.root,
      relative(paths.root, entryPath),
    );
    const raw = JSON.parse(await readFile(dokFile, 'utf8')) as unknown;
    const parsed = await validateDokForWrite(raw, { ...context, expectedDokId: dokId });
    doks.set(dokId, parsed);
  }
  return { doks, knownRoleIds, serviceRoots };
}

async function readRoleIds(path: string): Promise<Set<string>> {
  try {
    await access(path, FS.R_OK);
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw error;
  }
  const parsed = RolesFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return new Set(parsed.roles.map((role) => role.role_id));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ((error as { code?: unknown }).code === 'ENOENT'
      || (error as { code?: unknown }).code === 'ENOTDIR');
}
