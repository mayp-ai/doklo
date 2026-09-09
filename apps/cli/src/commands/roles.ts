// `doklo roles`             — show role candidates from each service's scan
// `doklo roles --apply`     — merge candidates into .doklo/hub/roles.json
//
// Merge policy: existing entries in roles.json win. Candidate fields are
// only used for new entries. Re-running --apply is idempotent and never
// clobbers user-curated edits.

import type { Command } from 'commander';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, relative } from 'node:path';
import {
  extractRoleCandidates,
  mergeRoleCandidateSets,
  type RoleCandidate,
} from '@doklo-beta/adapter-nextjs';
import {
  ProjectIRSchema,
  RolesFileSchema,
  type RoleId,
  type RolesFile,
} from '@doklo-beta/core';
import {
  resolveContainedOutputPath,
  resolveContainedPath,
} from '@doklo-beta/generator';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import { scanCachePath, validateProjectIrPaths } from './scan.js';
import type { CliContext } from '../lib/context.js';
import { writeTextFileAtomic } from '../lib/atomic-file.js';

export class ScanCacheMissingError extends Error {
  constructor() {
    super('No service has a scan cache yet. Run `doklo scan` first.');
    this.name = 'ScanCacheMissingError';
  }
}

export class RolesServiceNotFoundError extends Error {
  constructor(serviceId: string) {
    super(`No service with id "${serviceId}" exists in workspace.json.`);
    this.name = 'RolesServiceNotFoundError';
  }
}

export class InvalidRolesFileError extends Error {
  readonly rolesFile: string;

  constructor(rolesFile: string, cause: unknown) {
    super(`Existing roles file is invalid: ${rolesFile}`, { cause });
    this.name = 'InvalidRolesFileError';
    this.rolesFile = rolesFile;
  }
}

export interface RunRolesRefreshOptions {
  root: string;
  apply: boolean;
  serviceId?: string;
}

export interface RolesSkip {
  serviceId: string;
  reason: string;
}

export interface RunRolesRefreshResult {
  /** All candidates seen across services (deduped by role_id). */
  candidates: RoleCandidate[];
  /** role_ids that were added to roles.json (empty when apply=false). */
  added: RoleId[];
  /** role_ids that already existed and were kept as-is. */
  kept: RoleId[];
  /** Services with no scan cache yet. */
  skipped: RolesSkip[];
  /** True only when roles.json was actually written. */
  written: boolean;
}

export interface MergeRolesResult {
  file: RolesFile;
  added: RoleId[];
  kept: RoleId[];
  changed: boolean;
}

export function mergeRolesFile(
  existing: RolesFile,
  candidates: readonly RoleCandidate[],
): MergeRolesResult {
  const existingIds = new Set(existing.roles.map((role) => role.role_id));
  const added: RoleId[] = [];
  const kept: RoleId[] = [];
  const roles = [...existing.roles];

  for (const candidate of candidates) {
    if (existingIds.has(candidate.role_id)) {
      kept.push(candidate.role_id);
      continue;
    }
    roles.push({
      role_id: candidate.role_id,
      name: candidate.name,
      description: `Auto-extracted from code (${candidate.confidence} confidence)`,
      kind: candidate.kind,
      extends: [],
      scope: 'global',
      _meta: {
        extraction: {
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        },
      },
    });
    added.push(candidate.role_id);
  }

  return {
    file: { ...existing, roles },
    added,
    kept,
    changed: added.length > 0,
  };
}

export async function runRolesRefresh(
  opts: RunRolesRefreshOptions,
): Promise<RunRolesRefreshResult> {
  const { workspace, paths } = await loadWorkspaceWithPaths(opts.root);
  const services = opts.serviceId
    ? workspace.services.filter((s) => s.service_id === opts.serviceId)
    : workspace.services;
  if (opts.serviceId && services.length === 0) {
    throw new RolesServiceNotFoundError(opts.serviceId);
  }

  const skipped: RolesSkip[] = [];
  const candidateSets: RoleCandidate[][] = [];
  const safeRolesFile = opts.apply
    ? await resolveContainedOutputPath(
        paths.root,
        relative(paths.root, paths.rolesFile),
      )
    : undefined;

  for (const svc of services) {
    const cachePath = await resolveContainedPath(
      paths.root,
      relative(paths.root, scanCachePath(paths.cacheDir, svc)),
      { allowMissingLeaf: true, rejectSymlinkLeaf: true },
    );
    if (!(await exists(cachePath))) {
      skipped.push({
        serviceId: svc.service_id,
        reason: 'no scan cache (run `doklo scan` first)',
      });
      continue;
    }

    const serviceRoot = await resolveContainedPath(paths.root, svc.code_root);
    const ir = ProjectIRSchema.parse(JSON.parse(await readFile(cachePath, 'utf-8')));
    await validateProjectIrPaths(serviceRoot, ir);
    candidateSets.push(extractRoleCandidates(ir));
  }

  if (candidateSets.length === 0 && skipped.length === services.length) {
    throw new ScanCacheMissingError();
  }

  const candidates = mergeRoleCandidateSets(candidateSets);

  if (!opts.apply) {
    return { candidates, added: [], kept: [], skipped, written: false };
  }

  const existing = await loadExistingRoles(safeRolesFile!, paths.rolesFile);
  const merged = mergeRolesFile(existing, candidates);

  if (!merged.changed) {
    return {
      candidates,
      added: merged.added,
      kept: merged.kept,
      skipped,
      written: false,
    };
  }

  const out = RolesFileSchema.parse({
    ...merged.file,
    updated_at: new Date().toISOString(),
  });
  const writePath = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.rolesFile),
  );
  await mkdir(dirname(writePath), { recursive: true });
  const safeWritePath = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.rolesFile),
  );
  await writeTextFileAtomic(safeWritePath, `${JSON.stringify(out, null, 2)}\n`);

  return {
    candidates,
    added: merged.added,
    kept: merged.kept,
    skipped,
    written: true,
  };
}

async function loadExistingRoles(
  rolesFile: string,
  errorPath = rolesFile,
): Promise<RolesFile> {
  try {
    const raw = JSON.parse(await readFile(rolesFile, 'utf-8'));
    return RolesFileSchema.parse(raw);
  } catch (cause) {
    if (isFileNotFoundError(cause)) {
      return RolesFileSchema.parse({ roles: [], version: 1 });
    }
    throw new InvalidRolesFileError(errorPath, cause);
  }
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ───────── commander wiring ─────────────────────────────────────────

export function registerRolesCommand(program: Command, ctx: CliContext): void {
  program
    .command('roles')
    .description('Suggest role candidates from scan; --apply merges into roles.json')
    .option('-r, --root <dir>', 'Workspace root', process.cwd())
    .option('--apply', 'Write merged roles into .doklo/hub/roles.json', false)
    .option('--service <id>', 'Limit to one service')
    .action(async (opts) => {
      const { default: chalk } = await import('chalk');
      const result = await runRolesRefresh({
        root: opts.root as string,
        apply: opts.apply as boolean,
        serviceId: opts.service as string | undefined,
      });

      console.log(`\n  ${chalk.cyan(`${result.candidates.length} role candidate(s)`)}\n`);
      const idWidth = Math.max(...result.candidates.map((c) => c.role_id.length));
      for (const c of result.candidates) {
        const status = result.added.includes(c.role_id)
          ? chalk.green('+ added')
          : result.kept.includes(c.role_id)
            ? chalk.dim('  kept ')
            : chalk.dim('  candidate');
        console.log(
          `    ${status}  ${chalk.bold(c.role_id.padEnd(idWidth))}  ${chalk.dim(`[${c.confidence}]`)} ${c.name}`,
        );
        for (const ev of c.evidence) {
          console.log(`              ${chalk.dim(ev)}`);
        }
      }

      for (const s of result.skipped) {
        console.log(`    ${chalk.yellow('!')} ${s.serviceId}: ${s.reason}`);
      }

      if (!opts.apply) {
        console.log(`\n  ${chalk.dim('(dry run — pass --apply to merge into roles.json)')}\n`);
      } else {
        console.log(
          `\n  ${chalk.green('✓')} ${result.added.length} added, ${result.kept.length} kept → ${chalk.dim('.doklo/hub/roles.json')}\n`,
        );
      }
      void ctx;
    });
}
