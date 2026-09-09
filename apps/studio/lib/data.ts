// Filesystem readers used by every Studio page (server side).
//
// Source of truth: env var DOKLO_WORKSPACE_ROOT. The CLI's `serve` command
// sets this when launching `next dev`. When Studio is started standalone
// (e.g., `pnpm dev` from inside apps/studio for development), it falls
// back to the current working directory.

import { readFile, readdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import {
  DokSchema,
  LexiconFileSchema,
  RolesFileSchema,
  WorkspaceSchema,
  parseIaFileAnyVersion,
  type Dok,
  type LexiconFile,
  type LexiconTerm,
  type Role,
  type RolesFile,
  type Workspace,
} from '@doklo-beta/core';
import {
  parseConsolidatedFeatureConfig,
  type ConsolidatedFeatureConfig,
} from './consolidation';
import type { StudioIaDocument } from './ia-adapter';
import {
  errorMessage,
  isMissingError,
  revisionOf,
  type DokCatalogData,
  type LoadState,
} from './load-state';

export function workspaceRoot(): string {
  return process.env.DOKLO_WORKSPACE_ROOT ?? process.cwd();
}

export interface LoadStateReader {
  readFile(path: string): Promise<string>;
}

const defaultLoadStateReader: LoadStateReader = {
  readFile: (path) => readFile(path, 'utf-8'),
};

/**
 * Parse one JSON file into typed state. Takes a parse *function*, not a
 * schema, so a layer with more than one accepted contract (IA v1/v2) can
 * discriminate before parsing while every other layer keeps a single schema.
 */
async function loadJsonState<T>(
  path: string,
  parse: (value: unknown) => T,
  isEmpty: (data: T) => boolean,
  reader: LoadStateReader,
): Promise<LoadState<T>> {
  let contents: string;
  try {
    contents = await reader.readFile(path);
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing', path };
    return { kind: 'unreadable', path, message: errorMessage(error) };
  }

  let data: T;
  try {
    data = parse(JSON.parse(contents));
  } catch (error) {
    return { kind: 'invalid', path, message: errorMessage(error) };
  }

  const revision = revisionOf(contents);
  return isEmpty(data)
    ? { kind: 'empty', path, data, revision }
    : { kind: 'ready', path, data, revision };
}

export async function loadWorkspaceState(
  reader: LoadStateReader = defaultLoadStateReader,
): Promise<LoadState<Workspace>> {
  const found = await findWorkspaceFile(workspaceRoot());
  const path = found ?? join(resolve(workspaceRoot()), 'workspace.json');
  return loadJsonState(
    path,
    (value) => WorkspaceSchema.parse(value),
    (workspace) => workspace.services.length === 0,
    reader,
  );
}

export async function loadDoksState(
  reader: LoadStateReader = defaultLoadStateReader,
): Promise<LoadState<DokCatalogData>> {
  const found = await findWorkspaceFile(workspaceRoot());
  const path = join(
    found ? dirname(found) : resolve(workspaceRoot()),
    '.doklo',
    'hub',
    'doks',
  );

  let entries: string[];
  try {
    entries = (await readdir(path))
      .filter((entry) => entry.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing', path };
    return { kind: 'unreadable', path, message: errorMessage(error) };
  }

  const data: DokCatalogData = { doks: [], revisions: {}, paths: {} };
  const catalogRevisionParts: string[] = [];

  for (const entry of entries) {
    const filePath = join(path, entry);
    let contents: string;
    try {
      contents = await reader.readFile(filePath);
    } catch (error) {
      if (isMissingError(error)) {
        return {
          kind: 'invalid',
          path: filePath,
          message: `Dok file disappeared while reading catalog: ${filePath}.`,
        };
      }
      return { kind: 'unreadable', path: filePath, message: errorMessage(error) };
    }

    let dok: Dok;
    try {
      dok = DokSchema.parse(JSON.parse(contents));
    } catch (error) {
      return { kind: 'invalid', path: filePath, message: errorMessage(error) };
    }

    const existingPath = data.paths[dok.dok_id];
    if (existingPath !== undefined) {
      return {
        kind: 'invalid',
        path: filePath,
        message: `Duplicate dok_id ${dok.dok_id}: ${filePath} conflicts with ${existingPath}.`,
      };
    }

    data.doks.push(dok);
    data.paths[dok.dok_id] = filePath;
    data.revisions[dok.dok_id] = revisionOf(contents);
    catalogRevisionParts.push(`${entry}\0${contents.length}\0${contents}`);
  }

  const revision = revisionOf(catalogRevisionParts.join(''));
  return data.doks.length === 0
    ? { kind: 'empty', path, data, revision }
    : { kind: 'ready', path, data, revision };
}

export async function loadLexiconState(
  reader: LoadStateReader = defaultLoadStateReader,
): Promise<LoadState<LexiconFile>> {
  const found = await findWorkspaceFile(workspaceRoot());
  const path = join(
    found ? dirname(found) : resolve(workspaceRoot()),
    '.doklo',
    'hub',
    'lexicon.json',
  );
  return loadJsonState(
    path,
    (value) => LexiconFileSchema.parse(value),
    (lexicon) => lexicon.terms.length === 0,
    reader,
  );
}

export async function loadRolesState(
  reader: LoadStateReader = defaultLoadStateReader,
): Promise<LoadState<RolesFile>> {
  const found = await findWorkspaceFile(workspaceRoot());
  const path = join(
    found ? dirname(found) : resolve(workspaceRoot()),
    '.doklo',
    'hub',
    'roles.json',
  );
  return loadJsonState(
    path,
    (value) => RolesFileSchema.parse(value),
    (roles) => roles.roles.length === 0,
    reader,
  );
}

export async function loadWorkspace(): Promise<Workspace | null> {
  const found = await findWorkspaceFile(workspaceRoot());
  if (!found) return null;
  try {
    const raw = JSON.parse(await readFile(found, 'utf-8'));
    return WorkspaceSchema.parse(raw);
  } catch {
    return null;
  }
}

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DokSummary {
  dok_id: string;
  name: string;
  status: Dok['status'];
  /** Source provenance (code_anchor) — repo-relative files this Dok was
   *  derived from. Empty when the Hub predates anchor injection. */
  anchorFiles: string[];
}

export function summarizeDoks(
  doks: Dok[],
  opts?: { lexicon?: LexiconFile | null; locale?: string },
): DokSummary[] {
  const lexicon = opts?.lexicon ?? null;
  const locale = opts?.locale ?? 'en';
  return doks
    .map((dok) => ({
      dok_id: dok.dok_id,
      name: renderTranslatable(dok.name, lexicon, locale),
      status: dok.status,
      anchorFiles: dok._meta?.source_anchors?.map((anchor) => anchor.file) ?? [],
    }))
    .sort((a, b) => a.dok_id.localeCompare(b.dok_id));
}

async function doksDir(): Promise<string | null> {
  const found = await findWorkspaceFile(workspaceRoot());
  if (!found) return null;
  return join(dirname(found), '.doklo', 'hub', 'doks');
}

function translatable(t: unknown): string {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && t && 'term_ref' in (t as object)) {
    return `{${(t as { term_ref: string }).term_ref}}`;
  }
  return '';
}

export async function listDoks(opts?: {
  lexicon?: LexiconFile;
  locale?: string;
}): Promise<DokSummary[]> {
  const dir = await doksDir();
  if (!dir || !(await exists(dir))) return [];
  const entries = await readdir(dir);
  const doks: Dok[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, entry), 'utf-8'));
      const parsed = DokSchema.safeParse(raw);
      if (parsed.success) {
        doks.push(parsed.data);
      }
    } catch {
      // Skip unreadable files silently.
    }
  }
  return summarizeDoks(doks, opts);
}

// Render a Translatable (string | TermRef) as plain text. When a lexicon is
// supplied, TermRef pointers resolve to the locale-specific term text; without
// a lexicon, falls back to a "{TERM-XXX}" placeholder.
function renderTranslatable(
  t: unknown,
  lexicon: LexiconFile | null,
  locale: string,
): string {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && t && 'term_ref' in (t as object)) {
    const ref = (t as { term_ref: string }).term_ref;
    if (lexicon) {
      const term = lexicon.terms.find((tt) => tt.term_id === ref);
      const resolved = resolveTermText(term, locale);
      if (resolved) return resolved;
    }
    return `{${ref}}`;
  }
  return '';
}

export async function loadAllDoks(): Promise<Dok[]> {
  const dir = await doksDir();
  if (!dir || !(await exists(dir))) return [];
  const entries = await readdir(dir);
  const out: Dok[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, entry), 'utf-8'));
      const parsed = DokSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    } catch {
      // skip unreadable files
    }
  }
  out.sort((a, b) => a.dok_id.localeCompare(b.dok_id));
  return out;
}

export async function loadDok(dokId: string): Promise<Dok | null> {
  const dir = await doksDir();
  if (!dir) return null;
  const candidates = [dokId, dokId.toUpperCase(), dokId.toLowerCase()];
  for (const id of candidates) {
    const file = join(dir, `${id}.json`);
    if (await exists(file)) {
      try {
        const raw = JSON.parse(await readFile(file, 'utf-8'));
        return DokSchema.parse(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export { translatable };

// ─── Lexicon ───────────────────────────────────────────────────

async function hubDir(): Promise<string | null> {
  const found = await findWorkspaceFile(workspaceRoot());
  if (!found) return null;
  return join(dirname(found), '.doklo', 'hub');
}

export async function lexiconFilePath(): Promise<string | null> {
  const hub = await hubDir();
  return hub ? join(hub, 'lexicon.json') : null;
}

export async function rolesFilePath(): Promise<string | null> {
  const hub = await hubDir();
  return hub ? join(hub, 'roles.json') : null;
}

export async function loadLexicon(): Promise<LexiconFile> {
  const empty: LexiconFile = { terms: [], version: 1 };
  const file = await lexiconFilePath();
  if (!file || !(await exists(file))) return empty;
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8'));
    return LexiconFileSchema.parse(raw);
  } catch {
    return empty;
  }
}

export async function loadRoles(): Promise<RolesFile> {
  const empty: RolesFile = { roles: [], version: 1 };
  const file = await rolesFilePath();
  if (!file || !(await exists(file))) return empty;
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8'));
    return RolesFileSchema.parse(raw);
  } catch {
    return empty;
  }
}

export async function loadLexiconTerm(termId: string): Promise<LexiconTerm | null> {
  const lex = await loadLexicon();
  return lex.terms.find((t) => t.term_id === termId) ?? null;
}

export async function loadRole(roleId: string): Promise<Role | null> {
  const file = await loadRoles();
  return file.roles.find((r) => r.role_id === roleId) ?? null;
}

// Resolve a TermRef into display text for a given locale, falling back to
// any defined locale, then to the term_id itself. Used everywhere a
// Translatable / RoleName must be rendered as plain text.
export function resolveTermText(
  term: LexiconTerm | undefined | null,
  locale: string,
): string | null {
  if (!term) return null;
  // Prefer snapshot (constant binding) before authoritative locales (owned)
  const map =
    term.binding.type === 'constant'
      ? term.snapshot
      : term.locales;
  if (!map) return null;
  return map[locale] ?? Object.values(map)[0] ?? null;
}

export interface LexiconSummary {
  term_id: string;
  category: LexiconTerm['category'];
  preview: string;
  binding_type: LexiconTerm['binding']['type'];
  related_count: number;
}

export function summarizeLexicon(
  file: LexiconFile,
  locale: string,
): LexiconSummary[] {
  return file.terms
    .map((t) => ({
      term_id: t.term_id,
      category: t.category,
      preview: resolveTermText(t, locale) ?? '',
      binding_type: t.binding.type,
      related_count: t.related_doks.length,
    }))
    .sort((a, b) => a.term_id.localeCompare(b.term_id));
}

export interface RoleSummary {
  role_id: string;
  name: string;
  scope: Role['scope'];
  extends_count: number;
}

export function summarizeRoles(
  file: RolesFile,
  locale: string,
  lexicon: LexiconFile,
): RoleSummary[] {
  return file.roles
    .map((r) => ({
      role_id: r.role_id,
      name: roleDisplayName(r, locale, lexicon),
      scope: r.scope,
      extends_count: r.extends.length,
    }))
    .sort((a, b) => a.role_id.localeCompare(b.role_id));
}

// Role name may be a plain string or a TermRef into the lexicon.
export function roleDisplayName(
  role: Role,
  locale: string,
  lexicon: LexiconFile,
): string {
  const name = role.name;
  if (typeof name === 'string') return name;
  const term = lexicon.terms.find((t) => t.term_id === name.term_ref);
  return resolveTermText(term, locale) ?? role.role_id;
}

// ─── LLM Lexicon suggestions (cache file from `doklo lexicon-suggest`) ──

export interface LexiconSuggestion {
  text: string;
  category: LexiconTerm['category'];
  reason: string;
  dok_refs: string[];
}

export interface LexiconSuggestionsFile {
  path: string;
  revision: string;
  generated_at: string;
  corpus_size: number;
  suggestions: LexiconSuggestion[];
}

export async function lexiconSuggestionsPath(): Promise<string | null> {
  const hub = await hubDir();
  if (!hub) return null;
  return join(dirname(hub), 'cache', 'lexicon-suggestions.json');
}

export async function loadLexiconSuggestions(): Promise<LexiconSuggestionsFile | null> {
  const file = await lexiconSuggestionsPath();
  if (!file || !(await exists(file))) return null;
  try {
    const contents = await readFile(file, 'utf-8');
    const raw = JSON.parse(contents);
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !Array.isArray((raw as { suggestions?: unknown }).suggestions)
    ) {
      return null;
    }
    const s = raw as LexiconSuggestionsFile;
    return {
      path: file,
      revision: revisionOf(contents),
      generated_at: typeof s.generated_at === 'string' ? s.generated_at : '',
      corpus_size: typeof s.corpus_size === 'number' ? s.corpus_size : 0,
      suggestions: s.suggestions.filter(
        (x): x is LexiconSuggestion =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as LexiconSuggestion).text === 'string',
      ),
    };
  } catch {
    return null;
  }
}

// ─── Consolidated cache (per-service, from `doklo consolidate`) ──

async function cacheDir(): Promise<string | null> {
  const hub = await hubDir();
  return hub ? join(dirname(hub), 'cache') : null;
}

export async function consolidatedPath(serviceId: string): Promise<string | null> {
  const dir = await cacheDir();
  return dir ? join(dir, `${serviceId}.consolidated.json`) : null;
}

export async function loadConsolidated(
  serviceId: string,
): Promise<ConsolidatedFeatureConfig | null> {
  const state = await loadConsolidatedState(serviceId);
  return state.kind === 'ready' || state.kind === 'empty' ? state.data : null;
}

export async function loadConsolidatedState(
  serviceId: string,
  reader: LoadStateReader = defaultLoadStateReader,
): Promise<LoadState<ConsolidatedFeatureConfig>> {
  const file = await consolidatedPath(serviceId);
  const path = file ?? join(
    resolve(workspaceRoot()),
    '.doklo',
    'cache',
    `${serviceId}.consolidated.json`,
  );
  return loadJsonState(
    path,
    parseConsolidatedFeatureConfig,
    (config) => config.groups.length === 0,
    reader,
  );
}

/**
 * Workspace service ids in persisted order.
 *
 * Cache availability is deliberately not discovered with `access()`: EACCES
 * and ENOTDIR must reach `loadConsolidatedState` as `unreadable`, rather than
 * disappearing as an apparently empty service list.
 */
export async function listConsolidatedServices(): Promise<string[]> {
  const workspace = await loadWorkspace();
  if (!workspace) return [];
  return workspace.services.map((service) => service.service_id);
}

// ─── IA (per-service) ──────────────────────────────────────────

/**
 * Read one service's ia.json under whichever contract it declares. Studio is
 * a read-only consumer: a v1 file stays v1 (no migration, no guessing) and a
 * file that satisfies neither contract stays `invalid`, which the root load
 * boundary turns into the unchanged-files recovery screen.
 */
export async function loadIaFile(
  serviceId: string,
  reader: LoadStateReader = defaultLoadStateReader,
): Promise<LoadState<StudioIaDocument>> {
  const found = await findWorkspaceFile(workspaceRoot());
  const path = join(
    found ? dirname(found) : resolve(workspaceRoot()),
    '.doklo',
    'hub',
    'services',
    serviceId,
    'ia.json',
  );
  const state = await loadJsonState<StudioIaDocument>(
    path,
    (value) => parseIaFileAnyVersion(value),
    (document) => document.file.trees.length === 0,
    reader,
  );
  if (
    (state.kind === 'ready' || state.kind === 'empty') &&
    state.data.file.service_id !== serviceId
  ) {
    return {
      kind: 'invalid',
      path,
      message:
        `IA service_id mismatch: expected "${serviceId}", ` +
        `received "${state.data.file.service_id}".`,
    };
  }
  return state;
}

export async function loadAllIa(
  serviceIds: string[],
): Promise<Record<string, LoadState<StudioIaDocument>>> {
  const states = await Promise.all(
    serviceIds.map(async (id) => [id, await loadIaFile(id)] as const),
  );
  return Object.fromEntries(states);
}
