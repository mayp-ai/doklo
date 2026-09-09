// Hub loader — promoted from preserved-branch packages/spoke-user-guide/src/load.ts.
// Adapted to v5 schema (current) and extended with services slice loading
// (per-service ia + code-mapping) which the original spoke loader skipped.

import { readFile, readdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join } from 'node:path';
import {
  DokSchema,
  LexiconFileSchema,
  RolesFileSchema,
  ServiceCodeMappingFileSchema,
  WorkspaceSchema,
  parseIaFileAnyVersion,
  type Dok,
  type IaFileV1,
  type IaFileV2,
  type LexiconFile,
  type RolesFile,
  type ServiceCodeMappingFile,
  type Workspace,
} from '../schemas/index.js';
import type { HubModel, ServiceHubSlice } from './hub-model.js';

export class MissingHubError extends Error {
  constructor(public path: string, message?: string) {
    super(message ?? `Missing workspace.json at ${path}`);
    this.name = 'MissingHubError';
  }
}

/** Matches the pre-migration `DOMAIN-NNN` / `DOMAIN-SUB-NNN` per-Dok filename stem. */
const LEGACY_NUMBERED_DOK_ID_RE = /-\d{3}$/;

/**
 * Thrown when a `.doklo/hub/doks/*.json` filename still uses the pre-migration
 * `-NNN` numbered scheme (e.g. `AUTH-001.json`). Raised before `DokSchema` parsing
 * so the workspace owner sees actionable regeneration guidance instead of the
 * generic zod grammar error that `dok_id` would otherwise fail with.
 */
export class LegacyDokIdSchemeError extends Error {
  constructor(readonly file: string) {
    super(`"${file}" uses the legacy numbered Dok ID scheme (e.g. AUTH-SIGNIN-001). ` +
      'This workspace predates semantic Dok IDs. Re-generate it: `doklo generate --force` ' +
      '(hand-edited content should be reviewed from git history afterwards).');
    this.name = 'LegacyDokIdSchemeError';
  }
}

export interface LoadHubOptions {
  /**
   * Which Dok storage layout to prefer.
   * - 'auto' (default): probe per-Dok first, fall back to legacy single-array.
   * - 'per-dok': use `.doklo/hub/doks/<DOK>.json` only.
   * - 'legacy': use `<root>/doks.json` only.
   */
  preferLayout?: 'auto' | 'per-dok' | 'legacy';
}

/**
 * Loads the entire Hub for a workspace root.
 *
 * Tolerates missing optional layers (lexicon, roles, services) — returns empty defaults.
 * Throws `MissingHubError` when `workspace.json` is absent or unparseable.
 * Skips individual Dok files that fail Zod parse (warns to stderr).
 */
export async function loadHubModel(
  root: string,
  opts: LoadHubOptions = {},
): Promise<HubModel> {
  const preferLayout = opts.preferLayout ?? 'auto';
  const workspace = await loadWorkspace(root);
  const roles = await loadRoles(root);
  const lexicon = await loadLexicon(root);
  const { doks, layout } = await loadDoks(root, preferLayout);
  const services = await loadServiceSlices(root, workspace.services.map((s) => s.service_id));

  return { workspace, doks, lexicon, roles, services, layout };
}

async function loadWorkspace(root: string): Promise<Workspace> {
  const candidates = [
    join(root, '.doklo', 'hub', 'workspace.json'),
    join(root, 'workspace.json'),
  ];
  for (const p of candidates) {
    if (await exists(p)) {
      try {
        const raw = await readFile(p, 'utf-8');
        return WorkspaceSchema.parse(JSON.parse(raw));
      } catch (e) {
        throw new MissingHubError(
          p,
          `Failed to parse workspace.json at ${p}: ${(e as Error).message}`,
        );
      }
    }
  }
  throw new MissingHubError(candidates[0]!, `workspace.json not found in ${root}`);
}

async function loadRoles(root: string): Promise<RolesFile> {
  return readJsonWithDefault(
    [join(root, '.doklo', 'hub', 'roles.json'), join(root, 'roles.json')],
    RolesFileSchema,
    { roles: [], version: 1 },
  );
}

async function loadLexicon(root: string): Promise<LexiconFile> {
  return readJsonWithDefault(
    [join(root, '.doklo', 'hub', 'lexicon.json'), join(root, 'lexicon.json')],
    LexiconFileSchema,
    { terms: [], version: 1 },
  );
}

async function loadDoks(
  root: string,
  preferLayout: 'auto' | 'per-dok' | 'legacy',
): Promise<{ doks: Dok[]; layout: 'per-dok' | 'legacy' }> {
  if (preferLayout === 'legacy') {
    return { doks: await loadLegacyDoks(root), layout: 'legacy' };
  }

  // Try per-Dok layout first.
  const doksDir = join(root, '.doklo', 'hub', 'doks');
  if (await exists(doksDir)) {
    const entries = await readdir(doksDir);
    const out: Dok[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      const stem = e.slice(0, -'.json'.length);
      if (LEGACY_NUMBERED_DOK_ID_RE.test(stem)) {
        throw new LegacyDokIdSchemeError(e);
      }
      try {
        const raw = await readFile(join(doksDir, e), 'utf-8');
        const parsed = DokSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          out.push(parsed.data);
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `[livedoc-engine/hub] skipping malformed Dok ${e}: ${parsed.error.message}`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[livedoc-engine/hub] failed to read ${e}: ${(err as Error).message}`);
      }
    }
    if (out.length > 0) {
      return { doks: out, layout: 'per-dok' };
    }
    if (preferLayout === 'per-dok') {
      return { doks: [], layout: 'per-dok' };
    }
  }

  // Auto: fall through to legacy.
  return { doks: await loadLegacyDoks(root), layout: 'legacy' };
}

async function loadLegacyDoks(root: string): Promise<Dok[]> {
  const legacy = join(root, 'doks.json');
  if (!(await exists(legacy))) return [];
  const raw = await readFile(legacy, 'utf-8');
  const arr = JSON.parse(raw) as unknown;
  if (!Array.isArray(arr)) return [];
  const out: Dok[] = [];
  for (const item of arr) {
    const parsed = DokSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[livedoc-engine/hub] skipping malformed legacy Dok: ${parsed.error.message}`);
    }
  }
  return out;
}

async function loadServiceSlices(
  root: string,
  serviceIds: string[],
): Promise<ServiceHubSlice[]> {
  const out: ServiceHubSlice[] = [];
  for (const sid of serviceIds) {
    const ia = await readIaFile(join(root, '.doklo', 'hub', 'services', sid, 'ia.json'));
    const codeMapping = await readJsonOrUndefined(
      join(root, '.doklo', 'hub', 'services', sid, 'code-mapping.json'),
      ServiceCodeMappingFileSchema,
    );
    if (ia || codeMapping) {
      out.push({ service_id: sid, ia, codeMapping });
    } else {
      out.push({ service_id: sid });
    }
  }
  return out;
}

/**
 * Reads one service's ia.json under both IA contracts. Read-only: a v1 file is
 * kept as v1 and a v2 file as v2, never migrated — migration needs the RouteIR
 * that only the generate pipeline has, so converting here would mean guessing.
 *
 * A file that satisfies neither contract is dropped with a warning rather than
 * thrown, matching how this loader already skips malformed Doks: one broken
 * optional layer must not make the whole Hub unreadable.
 */
async function readIaFile(path: string): Promise<IaFileV1 | IaFileV2 | undefined> {
  if (!(await exists(path))) return undefined;
  try {
    const raw = await readFile(path, 'utf-8');
    return parseIaFileAnyVersion(JSON.parse(raw)).file;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[livedoc-engine/hub] skipping malformed ia.json at ${path}: ${(err as Error).message}`,
    );
    return undefined;
  }
}

async function readJsonWithDefault<T>(
  candidates: string[],
  schema: { parse: (x: unknown) => T },
  fallback: T,
): Promise<T> {
  for (const p of candidates) {
    if (await exists(p)) {
      try {
        const raw = await readFile(p, 'utf-8');
        return schema.parse(JSON.parse(raw));
      } catch {
        // try next or fall back
      }
    }
  }
  return fallback;
}

async function readJsonOrUndefined<T>(
  path: string,
  schema: { parse: (x: unknown) => T },
): Promise<T | undefined> {
  if (!(await exists(path))) return undefined;
  try {
    const raw = await readFile(path, 'utf-8');
    return schema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Re-export helper types for type-only consumers.
export type { IaFileV1, IaFileV2, ServiceCodeMappingFile };
