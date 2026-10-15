'use server';

import { execFile } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  DokHistoryCategorySchema,
  DokIdSchema,
  DokPrioritySchema,
  DokSchema,
  DokStatusSchema,
  LexiconCategorySchema,
  LexiconFileSchema,
  LexiconTermSchema,
  RoleIdSchema,
  RoleKindSchema,
  RoleNameSchema,
  RoleSchema,
  RoleScopeSchema,
  RolesFileSchema,
  ServiceIdSchema,
  TermIdSchema,
  TranslatableSchema,
  appendHistoryEntry,
  bumpVersion,
  canonicalStatusChange,
  dokProjectRoot,
  resolveHistoryAuthor,
  type Dok,
  type DokHistoryCategory,
  type DokMeta,
  type DokStatus,
  type LexiconFile,
  type LexiconTerm,
  type Role,
  type RolesFile,
  type Workspace,
} from '@doklo-beta/core';
import type { DriftConfirmation } from '@doklo-beta/cli/api';
import { z } from 'zod';
import {
  findWorkspaceFile,
  loadDoksState,
  loadWorkspaceState,
  workspaceRoot,
} from './data';
import {
  applyDriftConfirmation,
  driftRefusalMessage,
  inspectDokDrift,
  removeConfirmedJudgeVerdict,
  viewDokDrift,
  type DokDriftRefusal,
  type DokDriftState,
  type DokDriftView,
} from './dok-drift';
import { historyClock } from './history-clock';
import {
  ConsolidatedFeatureConfigSchema,
  parseConsolidatedFeatureConfig,
  type ConsolidatedFeatureConfig,
} from './consolidation';
import { recomputeStats } from './consolidation-edit';
import {
  formatZodError,
  readJsonForMutation,
  saveFailure,
  writeJsonForMutation,
  type SaveErrorCode,
  type SaveResult,
} from './persistence';

export type { SaveErrorCode, SaveResult } from './persistence';

export type DokEditPatch = Partial<
  Pick<Dok, 'name' | 'description' | 'status' | 'priority'>
>;

/**
 * The patch fields that count as authoring. Touching one of these revises the
 * Dok: the save bumps `_meta.version` even when it records no history entry
 * (D5). Whether it also marks the Dok `_meta.edited_by_human` is a narrower
 * question — see `marksHumanEdit`.
 *
 * `priority` is deliberately NOT here, and `marksHumanEdit` ignores it too. It
 * is a field a person edits across dozens of Doks at a time, and flagging or
 * versioning each one would churn `_meta` and quietly freeze most of the Hub
 * out of regeneration. The per-axis pins in `priority.curated` already protect
 * that judgment, at the granularity the judgment was actually made — so a
 * priority-only save leaves the Dok fully regenerable.
 */
const AUTHORED_PATCH_FIELDS = ['name', 'description', 'status'] as const;

/**
 * The statuses a Dok moves through while a person reviews generated content.
 * Regeneration sends a Dok back to `draft`, so the loop expects a reviewed Dok
 * to pass through these again. `planned`, `deprecated` and `archived` are
 * lifecycle judgments a regenerated draft cannot reproduce.
 */
const REVIEW_STATUSES: ReadonlySet<DokStatus> = new Set(['draft', 'review', 'active']);

/**
 * Whether a save marks the Dok `_meta.edited_by_human`, which makes `doklo sync`
 * skip it entirely. The flag means a person changed what a regeneration would
 * silently overwrite: the prose, or a lifecycle status. Moving a Dok through
 * review is neither — approval is recorded in `_meta.history`, and an approved
 * Dok has to stay regenerable for the next code change to reach it as a
 * proposal.
 */
function marksHumanEdit(patch: DokEditPatch, persistedStatus: DokStatus): boolean {
  if (patch.name !== undefined || patch.description !== undefined) return true;
  if (patch.status === undefined) return false;
  return !REVIEW_STATUSES.has(persistedStatus) || !REVIEW_STATUSES.has(patch.status);
}

export type RoleEditPatch = Partial<
  Pick<Role, 'name' | 'description' | 'kind' | 'scope'>
>;

type WorkspaceTarget = {
  root: string;
  relativePath: string;
  path: string;
};

const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'expectedRevision must be a SHA-256 hash');
const DokEditPatchSchema = z.strictObject({
  name: TranslatableSchema.optional(),
  description: TranslatableSchema.optional(),
  status: DokStatusSchema.optional(),
  priority: DokPrioritySchema.optional(),
});
/** Trim first, then require content: a whitespace-only note is not a note. */
const HistoryNoteSchema = z.string().trim().min(1).max(500);
const SaveDokInputSchema = z.strictObject({
  dokId: DokIdSchema,
  patch: DokEditPatchSchema,
  expectedRevision: RevisionSchema,
  note: HistoryNoteSchema.optional(),
  category: DokHistoryCategorySchema.optional(),
});
const BulkActivateTargetSchema = z.strictObject({
  dokId: DokIdSchema,
  expectedRevision: RevisionSchema,
});
/** A bulk Dok write names each Dok once: a repeated target is a client bug, not a retry. */
function rejectDuplicateTargets(
  targets: ReadonlyArray<{ dokId: string }>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  targets.forEach((target, index) => {
    if (seen.has(target.dokId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets', index, 'dokId'],
        message: `Duplicate Dok target ${target.dokId}.`,
      });
    }
    seen.add(target.dokId);
  });
}
const BulkActivateDoksInputSchema = z.strictObject({
  mode: z.enum(['selected', 'all_drafts']),
  targets: z.array(BulkActivateTargetSchema).min(1).max(500),
}).superRefine((value, ctx) => rejectDuplicateTargets(value.targets, ctx));
const RoleEditPatchSchema = z.strictObject({
  name: RoleNameSchema.optional(),
  description: z.string().optional(),
  kind: RoleKindSchema.optional(),
  scope: RoleScopeSchema.optional(),
});

const SuggestionSchema = z.object({
  text: z.string().min(1),
  category: z.unknown().optional(),
  reason: z.string().optional(),
  dok_refs: z.array(DokIdSchema).optional(),
}).passthrough();

const LexiconSuggestionsFileSchema = z.object({
  generated_at: z.string(),
  corpus_size: z.number().nonnegative(),
  suggestions: z.array(SuggestionSchema),
}).passthrough();

type LexiconSuggestionsFile = z.infer<typeof LexiconSuggestionsFileSchema>;

async function workspaceTarget(relativePath: string): Promise<
  WorkspaceTarget | Extract<SaveResult, { ok: false }>
> {
  const start = resolve(workspaceRoot());
  const workspacePath = await findWorkspaceFile(start);
  if (!workspacePath) {
    return saveFailure(
      'MISSING',
      resolve(start, relativePath),
      'workspace.json not found',
    );
  }
  const root = dirname(workspacePath);
  return { root, relativePath, path: resolve(root, relativePath) };
}

function invalidInput(
  path: string,
  label: string,
  error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> },
): Extract<SaveResult, { ok: false }> {
  return saveFailure('INVALID', path, `${label} is invalid: ${formatZodError(error)}`);
}

async function invalidLegacyCall(
  relativePath: string,
  action: string,
): Promise<SaveResult> {
  const target = await workspaceTarget(relativePath);
  if (!('root' in target)) return target;
  return saveFailure(
    'INVALID',
    target.path,
    `${action} requires an expectedRevision and a narrow server-side patch.`,
  );
}

// ─── Dok history (design §0b propose-and-approve) ─────────────

const execFileAsync = promisify(execFile);

/**
 * The only I/O `resolveHistoryAuthor` is allowed: a bounded `git config`
 * lookup. Failures (no git, no repo, timeout) throw and are swallowed by the
 * resolver, which then reports "no author" rather than blocking the save.
 */
function gitStdout(cwd: string): (args: string[]) => Promise<string | undefined> {
  return async (args) => {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 2000 });
    return stdout;
  };
}

/** Best-effort `DOKLO_AUTHOR` → `git config user.name`. Never throws. */
function historyAuthor(cwd: string): Promise<string | undefined> {
  return resolveHistoryAuthor({ env: process.env, git: gitStdout(cwd) });
}

/**
 * `readJsonForMutation` deliberately returns the raw tree so extension fields
 * survive, which means Zod's `_meta` default was never materialized: a file
 * without `_meta` reads as undefined here despite the type.
 */
function metaOf(dok: Dok): DokMeta {
  return dok._meta ?? { version: 1, history: [] };
}

function persistedOf(dok: Dok): { status: DokStatus; version: number } {
  const meta = metaOf(dok);
  return {
    status: dok.status ?? 'draft',
    version: typeof meta.version === 'number' ? meta.version : 1,
  };
}

type HistoryPlan =
  | {
      kind: 'regenerated';
      change: string;
      category?: DokHistoryCategory;
    }
  | { kind: 'edited'; change: string; category?: DokHistoryCategory }
  | { kind: 'status'; change: string }
  /** Authored prose with no note: bump the version, record nothing (D5). */
  | { kind: 'bump' }
  /** Priority-only save: `_meta` is left byte-identical. */
  | { kind: 'none' };

/**
 * The design §7.2 decision table, in priority order. Kept separate from the
 * write so the author lookup only runs when an entry will actually exist.
 */
function planDokHistory(input: {
  meta: DokMeta;
  persistedStatus: DokStatus;
  nextStatus: DokStatus;
  authored: boolean;
  note?: string;
  category?: DokHistoryCategory;
}): HistoryPlan {
  const pending = input.meta.pending_change;
  const activating =
    input.nextStatus === 'active' && input.persistedStatus !== 'active';
  // Approval is the confirmation point of the propose-and-approve model: a
  // staged proposal becomes history only because a person activated the Dok.
  if (activating && pending !== undefined) {
    return {
      kind: 'regenerated',
      change: input.note ?? pending.summary,
      category: input.category ?? pending.category,
    };
  }
  if (input.note !== undefined) {
    return { kind: 'edited', change: input.note, category: input.category };
  }
  if (input.nextStatus !== input.persistedStatus) {
    return { kind: 'status', change: canonicalStatusChange(input.nextStatus) };
  }
  return input.authored ? { kind: 'bump' } : { kind: 'none' };
}

function applyHistoryPlan(input: {
  plan: HistoryPlan;
  meta: DokMeta;
  persisted: { status: DokStatus; version: number };
  nextStatus: DokStatus;
  author: string | undefined;
}): DokMeta {
  const plan = input.plan;
  if (plan.kind === 'none') return input.meta;
  if (plan.kind === 'bump') {
    return { ...input.meta, version: bumpVersion(input.meta) };
  }
  // While a proposal is staged the file holds the draft its regeneration
  // demoted; the state before that is what the proposal remembers. Every entry
  // recorded meanwhile — a note or a review move before approval, and the
  // approval itself — judges the lazy baseline from that state, so a legacy
  // Dok keeps its baseline whichever entry comes first.
  const staged = input.meta.pending_change;
  const appended = appendHistoryEntry({
    meta: input.meta,
    persisted: input.persisted,
    nextStatus: input.nextStatus,
    entry: {
      kind: plan.kind,
      change: plan.change,
      category: plan.kind === 'status' ? undefined : plan.category,
      author: input.author,
    },
    versionPolicy: 'bump',
    now: historyClock.now,
    ...(staged === undefined
      ? {}
      : { baselineFrom: { status: staged.previous_status, version: staged.base_version } }),
  });
  if (plan.kind !== 'regenerated') return appended.meta;
  // The proposal has been recorded, so it is no longer pending. Rebuild the
  // object without the key rather than setting it undefined — an `undefined`
  // property would still serialize away, but only by accident.
  const { pending_change: _confirmed, ...confirmed } = appended.meta;
  return confirmed;
}

type NextMetaResult = { ok: true; meta: DokMeta } | { ok: false; error: string };

/** Plans and applies in one step for callers that always need an author. */
function nextDokMeta(input: {
  meta: DokMeta;
  persisted: { status: DokStatus; version: number };
  nextStatus: DokStatus;
  authored: boolean;
  author: string | undefined;
  note?: string;
  category?: DokHistoryCategory;
}): NextMetaResult {
  const plan = planDokHistory({
    meta: input.meta,
    persistedStatus: input.persisted.status,
    nextStatus: input.nextStatus,
    authored: input.authored,
    note: input.note,
    category: input.category,
  });
  try {
    return { ok: true, meta: applyHistoryPlan({ ...input, plan }) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Doks ─────────────────────────────────────────────────────

type SaveDokInput = {
  dokId: string;
  patch: DokEditPatch;
  expectedRevision: string;
  /** Change note. Recorded verbatim as the history entry's `change`. */
  note?: string;
  /** Keep a Changelog section for the note. */
  category?: DokHistoryCategory;
};

export type BulkActivateDoksInput = {
  mode: 'selected' | 'all_drafts';
  targets: Array<{
    dokId: string;
    expectedRevision: string;
  }>;
};

export type BulkActivateDokFailure = {
  dokId: string;
  code: SaveErrorCode | 'NOT_DRAFT';
  error: string;
  preserved: true;
};

export type BulkActivateDoksResult =
  | {
      ok: true;
      activated: Array<{ dokId: string; revision: string }>;
    }
  | {
      ok: false;
      code: 'INVALID' | 'PREFLIGHT_FAILED';
      error: string;
      activated: [];
      failures: BulkActivateDokFailure[];
    }
  | {
      ok: false;
      code: 'PARTIAL_FAILURE';
      error: string;
      activated: Array<{ dokId: string; revision: string }>;
      failures: BulkActivateDokFailure[];
    };

/** Whether a catalog path, taken relative to the workspace root, leaves it. */
function escapesWorkspace(relativePath: string): boolean {
  return (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

/**
 * Resolve the on-disk target for a Dok write: catalog lookup, revision CAS,
 * and workspace containment. Shared by every Dok write path so the containment
 * guard cannot drift apart between them.
 */
async function resolveDokWriteTarget(
  dokId: string,
  expectedRevision: string,
): Promise<{ target: WorkspaceTarget } | Extract<SaveResult, { ok: false }>> {
  const catalog = await loadDoksState();
  if (catalog.kind === 'invalid' || catalog.kind === 'unreadable') {
    return saveFailure(
      catalog.kind === 'invalid' ? 'INVALID' : 'UNREADABLE',
      catalog.path,
      catalog.message,
    );
  }
  const exactPath = catalog.kind === 'missing'
    ? null
    : catalog.data.paths[dokId] ?? null;
  if (exactPath === null) {
    return saveFailure(
      'MISSING',
      catalog.path,
      `Dok ${dokId} was not found in the loaded catalog.`,
    );
  }
  const exactRevision = catalog.kind === 'missing'
    ? null
    : catalog.data.revisions[dokId] ?? null;
  if (exactRevision === null) {
    return saveFailure(
      'INVALID',
      exactPath,
      `Loaded Dok ${dokId} has no source revision.`,
    );
  }
  if (expectedRevision !== exactRevision) {
    return saveFailure(
      'CONFLICT',
      exactPath,
      'Dok changed outside Studio. Reload before saving again.',
    );
  }

  const workspace = await workspaceTarget('.doklo/hub/doks');
  if (!('root' in workspace)) return workspace;
  const relativePath = relative(workspace.root, exactPath);
  if (escapesWorkspace(relativePath)) {
    return saveFailure(
      'INVALID',
      exactPath,
      `Loaded Dok path escapes the workspace: ${exactPath}`,
    );
  }
  return {
    target: { root: workspace.root, relativePath, path: exactPath },
  };
}

export function saveDokAction(input: SaveDokInput): Promise<SaveResult>;
/** @deprecated Full-object calls are rejected; use the narrow CAS overload. */
export function saveDokAction(input: Dok): Promise<SaveResult>;
export async function saveDokAction(input: SaveDokInput | Dok): Promise<SaveResult> {
  const parsed = SaveDokInputSchema.safeParse(input);
  if (!parsed.success) {
    const legacyRecord = isRecord(input)
      ? input as Record<string, unknown>
      : undefined;
    // A rejected note/category is a current Studio call, not a legacy
    // full-object one: reporting "needs an expectedRevision and a narrow
    // patch" there would name the wrong problem.
    if (
      legacyRecord !== undefined &&
      typeof legacyRecord.dokId === 'string' &&
      ('note' in legacyRecord || 'category' in legacyRecord)
    ) {
      const dokId = DokIdSchema.safeParse(legacyRecord.dokId).success
        ? legacyRecord.dokId
        : 'INVALID';
      const target = await workspaceTarget(`.doklo/hub/doks/${dokId}.json`);
      if (!('root' in target)) return target;
      return invalidInput(target.path, 'Dok save', parsed.error);
    }
    const legacyCandidate = legacyRecord?.dok_id;
    const legacyId = DokIdSchema.safeParse(legacyCandidate).success
      ? String(legacyCandidate)
      : 'INVALID';
    return invalidLegacyCall(
      `.doklo/hub/doks/${legacyId}.json`,
      'saveDokAction',
    );
  }

  const resolved = await resolveDokWriteTarget(
    parsed.data.dokId,
    parsed.data.expectedRevision,
  );
  if (!('target' in resolved)) return resolved;
  const target = resolved.target;

  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: DokSchema,
    label: 'Dok',
  });
  if (!current.ok) return current;
  if (current.data.dok_id !== parsed.data.dokId) {
    return saveFailure(
      'INVALID',
      current.path,
      `Loaded Dok identity changed to ${current.data.dok_id}.`,
    );
  }

  const patch = parsed.data.patch;
  const authored = AUTHORED_PATCH_FIELDS.some((field) => patch[field] !== undefined);
  const persisted = persistedOf(current.data);
  const nextStatus: DokStatus = patch.status ?? persisted.status;
  // Neither a note-only save nor a review move is a content edit:
  // `edited_by_human` makes `doklo sync` skip the whole Dok, and writing down
  // what a regeneration did, or approving it, must not freeze that Dok out of
  // the next regeneration. A flag the Dok already carries is kept.
  const baseMeta: DokMeta = marksHumanEdit(patch, persisted.status)
    ? { ...metaOf(current.data), edited_by_human: true }
    : metaOf(current.data);
  const plan = planDokHistory({
    meta: baseMeta,
    persistedStatus: persisted.status,
    nextStatus,
    authored,
    note: parsed.data.note,
    category: parsed.data.category,
  });
  const author = plan.kind === 'none' || plan.kind === 'bump'
    ? undefined
    : await historyAuthor(target.root);
  let meta: DokMeta;
  try {
    meta = applyHistoryPlan({ plan, meta: baseMeta, persisted, nextStatus, author });
  } catch (error) {
    return saveFailure('INVALID', current.path, error);
  }

  const next: Dok = {
    ...current.data,
    ...patch,
    // Signals are generator-authored evidence: a person edits axes, never the
    // proof. Keep whatever the last generate stamped rather than trusting the
    // client to round-trip it.
    ...(patch.priority === undefined
      ? {}
      : {
          priority: {
            ...patch.priority,
            signals: current.data.priority?.signals ?? [],
          },
        }),
    // A priority-only save writes `_meta` back exactly as it was read, down to
    // an absent one — no bump, no entry, nothing for a Hub-wide priority sweep
    // to churn.
    _meta: plan.kind === 'none' ? current.data._meta : meta,
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: DokSchema,
    label: 'Dok',
  });
}

export async function bulkActivateDoksAction(
  input: BulkActivateDoksInput,
): Promise<BulkActivateDoksResult> {
  const parsed = BulkActivateDoksInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID',
      error: `Bulk Dok activation is invalid: ${formatZodError(parsed.error)}`,
      activated: [],
      failures: [],
    };
  }

  const catalog = await loadDoksState();
  if (catalog.kind === 'invalid' || catalog.kind === 'unreadable') {
    return {
      ok: false,
      code: 'PREFLIGHT_FAILED',
      error: catalog.message,
      activated: [],
      failures: parsed.data.targets.map((target) => ({
        dokId: target.dokId,
        code: catalog.kind === 'invalid' ? 'INVALID' : 'UNREADABLE',
        error: catalog.message,
        preserved: true,
      })),
    };
  }
  if (catalog.kind === 'missing' || catalog.kind === 'empty') {
    const error = catalog.kind === 'missing'
      ? 'The Dok catalog is missing.'
      : 'The Dok catalog is empty.';
    return {
      ok: false,
      code: 'PREFLIGHT_FAILED',
      error,
      activated: [],
      failures: parsed.data.targets.map((target) => ({
        dokId: target.dokId,
        code: 'MISSING',
        error,
        preserved: true,
      })),
    };
  }

  if (parsed.data.mode === 'all_drafts') {
    const currentDraftIds = catalog.data.doks
      .filter((dok) => dok.status === 'draft')
      .map((dok) => dok.dok_id);
    const requestedIds = parsed.data.targets.map((target) => target.dokId);
    if (!sameIdentityList(currentDraftIds, requestedIds)) {
      return {
        ok: false,
        code: 'PREFLIGHT_FAILED',
        error: 'The complete Draft set changed. Reload Studio and confirm the new scope.',
        activated: [],
        failures: [],
      };
    }
  }

  const workspace = await workspaceTarget('.doklo/hub/doks');
  if (!('root' in workspace)) {
    return {
      ok: false,
      code: 'PREFLIGHT_FAILED',
      error: workspace.error,
      activated: [],
      failures: parsed.data.targets.map((target) => ({
        dokId: target.dokId,
        code: workspace.code,
        error: workspace.error,
        preserved: true,
      })),
    };
  }

  const preflighted: Array<{
    dokId: string;
    root: string;
    relativePath: string;
    path: string;
    revision: string;
    data: Dok;
  }> = [];
  const failures: BulkActivateDokFailure[] = [];

  for (const target of parsed.data.targets) {
    const exactPath = catalog.data.paths[target.dokId];
    const catalogRevision = catalog.data.revisions[target.dokId];
    const catalogDok = catalog.data.doks.find((dok) => dok.dok_id === target.dokId);
    if (exactPath === undefined || catalogRevision === undefined || catalogDok === undefined) {
      failures.push({
        dokId: target.dokId,
        code: 'MISSING',
        error: `Dok ${target.dokId} was not found in the loaded catalog.`,
        preserved: true,
      });
      continue;
    }
    if (catalogDok.status !== 'draft') {
      failures.push({
        dokId: target.dokId,
        code: 'NOT_DRAFT',
        error: `Dok ${target.dokId} is ${catalogDok.status}, not draft.`,
        preserved: true,
      });
      continue;
    }
    if (catalogRevision !== target.expectedRevision) {
      failures.push({
        dokId: target.dokId,
        code: 'CONFLICT',
        error: `Dok ${target.dokId} changed outside this review selection.`,
        preserved: true,
      });
      continue;
    }

    const relativePath = relative(workspace.root, exactPath);
    if (escapesWorkspace(relativePath)) {
      failures.push({
        dokId: target.dokId,
        code: 'INVALID',
        error: `Loaded Dok path escapes the workspace: ${exactPath}`,
        preserved: true,
      });
      continue;
    }
    const current = await readJsonForMutation({
      root: workspace.root,
      relativePath,
      expectedRevision: target.expectedRevision,
      schema: DokSchema,
      label: `Dok ${target.dokId}`,
    });
    if (!current.ok) {
      failures.push({
        dokId: target.dokId,
        code: current.code,
        error: current.error,
        preserved: true,
      });
      continue;
    }
    if (current.data.dok_id !== target.dokId) {
      failures.push({
        dokId: target.dokId,
        code: 'INVALID',
        error: `Loaded Dok identity changed to ${current.data.dok_id}.`,
        preserved: true,
      });
      continue;
    }
    if (current.data.status !== 'draft') {
      failures.push({
        dokId: target.dokId,
        code: 'NOT_DRAFT',
        error: `Dok ${target.dokId} is ${current.data.status}, not draft.`,
        preserved: true,
      });
      continue;
    }
    preflighted.push({
      dokId: target.dokId,
      root: workspace.root,
      relativePath,
      path: current.path,
      revision: current.revision,
      data: current.data,
    });
  }

  if (failures.length > 0) {
    return {
      ok: false,
      code: 'PREFLIGHT_FAILED',
      error: `${failures.length} Dok(s) failed review preflight.`,
      activated: [],
      failures,
    };
  }

  // One lookup for the whole batch: the author cannot change mid-click, and a
  // git subprocess per Dok would make a 500-Dok approval crawl.
  const author = await historyAuthor(workspace.root);

  const activated: Array<{ dokId: string; revision: string }> = [];
  for (const current of preflighted) {
    const persisted = persistedOf(current.data);
    // Bulk approval confirms every staged proposal it touches: a Dok carrying
    // one records `regenerated`, the rest record a plain activation. Draft →
    // active is a review move, so each Dok keeps whatever `edited_by_human` it
    // already had (see `marksHumanEdit`).
    const meta = nextDokMeta({
      meta: metaOf(current.data),
      persisted,
      nextStatus: 'active',
      authored: true,
      author,
    });
    if (!meta.ok) {
      failures.push({
        dokId: current.dokId,
        code: 'INVALID',
        error: meta.error,
        preserved: true,
      });
      continue;
    }
    const next: Dok = {
      ...current.data,
      status: 'active',
      _meta: meta.meta,
    };
    const result = await writeJsonForMutation({
      root: current.root,
      relativePath: current.relativePath,
      expectedRevision: current.revision,
      value: next,
      schema: DokSchema,
      label: `Dok ${current.dokId}`,
    });
    if (result.ok) {
      activated.push({ dokId: current.dokId, revision: result.revision });
    } else {
      failures.push({
        dokId: current.dokId,
        code: result.code,
        error: result.error,
        preserved: true,
      });
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      code: 'PARTIAL_FAILURE',
      error: `${failures.length} Dok(s) could not be activated.`,
      activated,
      failures,
    };
  }
  return { ok: true, activated };
}

// ─── Dok drift: "Still accurate" (judge-gated sync design §4.6, §4.7) ─────

// A person's confirmation that a stale Dok still matches the code it tracks.
// It re-stamps the drift baseline — the normalised hash, the per-file hashes
// and the diff-base commit, computed by the CLI's drift entry point exactly as
// generation computes them — and nothing else: no history entry, no version
// bump, no change to status, `edited_by_human` or `pending_change`, and never
// `logic_hash`, which stays the release digest's evidence that the code
// changed. Afterwards `doklo show`, `doklo sync`, MCP and Studio all read the
// Dok as fresh (reason `format-only`) until its sources change again, and the
// judge's next diff starts from here. Same meaning as Cloud's `drift_checked`,
// minus its audit record: locally the re-stamped hashes are the only trace.

const DriftReadInputSchema = z.strictObject({ dokId: DokIdSchema });
const ConfirmDokInputSchema = z.strictObject({
  dokId: DokIdSchema,
  expectedRevision: RevisionSchema,
});
const BulkConfirmDoksInputSchema = z.strictObject({
  targets: z.array(BulkActivateTargetSchema).min(1).max(500),
}).superRefine((value, ctx) => rejectDuplicateTargets(value.targets, ctx));

export type DokDriftReadFailure = {
  ok: false;
  code: SaveErrorCode;
  path: string;
  error: string;
};

export type DokDriftReadResult = ({ ok: true } & DokDriftView) | DokDriftReadFailure;

export type DoksDriftReadResult =
  | {
      ok: true;
      /** Every stale Dok in the catalog, in catalog order. Fresh Doks are left out. */
      stale: DokDriftView[];
    }
  | DokDriftReadFailure;

export type DokConfirmErrorCode = SaveErrorCode | DokDriftRefusal;

export type DokConfirmFailure = {
  ok: false;
  code: DokConfirmErrorCode;
  path: string;
  error: string;
  preserved: true;
  /** The drift a refusal was decided on, when it got that far. */
  drift?: DokDriftState;
};

export type ConfirmDokStillAccurateInput = {
  dokId: string;
  expectedRevision: string;
};

export type ConfirmDokStillAccurateResult =
  | {
      ok: true;
      dokId: string;
      path: string;
      revision: string;
      /**
       * The Dok as every drift reader now reads it — `{ stale: false, reason:
       * 'format-only' }` until its tracked sources change again.
       */
      drift: DokDriftState;
      /** What the confirmation re-stamped in `_meta`: the only change it made. */
      stamped: {
        logic_hash_normalized: string;
        /** The diff base now recorded; null when git could not say, and any stored one was removed. */
        source_commit: string | null;
        /** How many `logic_files` entries carry a fresh `sha256`. */
        files: number;
      };
      /** False only when the judge's cached verdict could not be removed. */
      judgeCacheRemoved: boolean;
    }
  | DokConfirmFailure;

export type BulkConfirmDoksInput = {
  targets: Array<{
    dokId: string;
    expectedRevision: string;
  }>;
};

export type BulkConfirmDokFailure = {
  dokId: string;
  code: DokConfirmErrorCode;
  error: string;
  preserved: true;
};

export type BulkConfirmDoksResult =
  | {
      ok: true;
      confirmed: Array<{ dokId: string; revision: string }>;
    }
  | {
      ok: false;
      code: 'INVALID' | 'PREFLIGHT_FAILED';
      error: string;
      confirmed: [];
      failures: BulkConfirmDokFailure[];
    }
  | {
      ok: false;
      code: 'PARTIAL_FAILURE';
      error: string;
      confirmed: Array<{ dokId: string; revision: string }>;
      failures: BulkConfirmDokFailure[];
    };

/** The parsed workspace a drift read resolves each Dok's project root against. */
async function driftWorkspace(): Promise<
  { root: string; workspace: Workspace } | Extract<SaveResult, { ok: false }>
> {
  const state = await loadWorkspaceState();
  if (state.kind === 'missing') return saveFailure('MISSING', state.path, 'workspace.json not found');
  if (state.kind === 'invalid') return saveFailure('INVALID', state.path, state.message);
  if (state.kind === 'unreadable') return saveFailure('UNREADABLE', state.path, state.message);
  return { root: dirname(state.path), workspace: state.data };
}

function driftReadFailure(
  code: SaveErrorCode,
  path: string,
  error: unknown,
): DokDriftReadFailure {
  return {
    ok: false,
    code,
    path,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * One Dok's drift for the editor: stale or not and why, the judge's
 * unconfirmed verdict while it holds, and what would block a confirmation.
 * Reads source files and the judge cache; writes nothing, calls no model.
 */
export async function readDokDriftAction(input: { dokId: string }): Promise<DokDriftReadResult> {
  const parsed = DriftReadInputSchema.safeParse(input);
  if (!parsed.success) {
    const target = await workspaceTarget('.doklo/hub/doks');
    return driftReadFailure(
      'INVALID',
      target.path,
      `Dok drift read is invalid: ${formatZodError(parsed.error)}`,
    );
  }
  const dokId = parsed.data.dokId;
  const catalog = await loadDoksState();
  if (catalog.kind === 'invalid' || catalog.kind === 'unreadable') {
    return driftReadFailure(
      catalog.kind === 'invalid' ? 'INVALID' : 'UNREADABLE',
      catalog.path,
      catalog.message,
    );
  }
  if (catalog.kind === 'missing') {
    return driftReadFailure('MISSING', catalog.path, 'The Dok catalog is missing.');
  }
  const dok = catalog.data.doks.find((item) => item.dok_id === dokId);
  const revision = catalog.data.revisions[dokId];
  if (dok === undefined || revision === undefined) {
    return driftReadFailure(
      'MISSING',
      catalog.path,
      `Dok ${dokId} was not found in the loaded catalog.`,
    );
  }
  const workspace = await driftWorkspace();
  if (!('root' in workspace)) {
    return driftReadFailure(workspace.code, workspace.path, workspace.error);
  }
  try {
    return {
      ok: true,
      ...(await viewDokDrift({
        dok,
        revision,
        root: workspace.root,
        workspace: workspace.workspace,
      })),
    };
  } catch (error) {
    return driftReadFailure('UNREADABLE', catalog.data.paths[dokId] ?? catalog.path, error);
  }
}

/**
 * Every stale Dok in the catalog, for the Doks list's bulk confirmation. The
 * same read as `readDokDriftAction`, Dok by Dok — each costs what `doklo sync
 * --check` pays for it, so the list asks only when a person opens the mode.
 */
export async function readDoksDriftAction(): Promise<DoksDriftReadResult> {
  const catalog = await loadDoksState();
  if (catalog.kind === 'invalid' || catalog.kind === 'unreadable') {
    return driftReadFailure(
      catalog.kind === 'invalid' ? 'INVALID' : 'UNREADABLE',
      catalog.path,
      catalog.message,
    );
  }
  if (catalog.kind === 'missing') return { ok: true, stale: [] };
  const workspace = await driftWorkspace();
  if (!('root' in workspace)) {
    return driftReadFailure(workspace.code, workspace.path, workspace.error);
  }
  const stale: DokDriftView[] = [];
  for (const dok of catalog.data.doks) {
    const revision = catalog.data.revisions[dok.dok_id];
    if (revision === undefined) continue;
    try {
      const view = await viewDokDrift({
        dok,
        revision,
        root: workspace.root,
        workspace: workspace.workspace,
      });
      if (view.drift.stale) stale.push(view);
    } catch {
      // A Dok whose drift cannot be read is left out of the list — the same
      // Dok's editor shows no drift panel either.
    }
  }
  return { ok: true, stale };
}

type PreparedDokConfirmation = {
  ok: true;
  dokId: string;
  root: string;
  relativePath: string;
  path: string;
  revision: string;
  projectRoot: string;
  next: Dok;
  confirmation: DriftConfirmation;
};

/**
 * Everything a confirmation decides before anything is written: the exact
 * revision, the Dok's identity, its staleness as the CLI reads it, and the
 * baseline to stamp. The single and bulk actions share it, so a refusal reads
 * the same from both.
 */
async function prepareDokConfirmation(input: {
  dokId: string;
  root: string;
  relativePath: string;
  expectedRevision: string;
  workspace: Workspace;
  label: string;
}): Promise<PreparedDokConfirmation | DokConfirmFailure> {
  const current = await readJsonForMutation({
    root: input.root,
    relativePath: input.relativePath,
    expectedRevision: input.expectedRevision,
    schema: DokSchema,
    label: input.label,
  });
  if (!current.ok) return current;
  if (current.data.dok_id !== input.dokId) {
    return saveFailure(
      'INVALID',
      current.path,
      `Loaded Dok identity changed to ${current.data.dok_id}.`,
    );
  }

  const projectRoot = dokProjectRoot(current.data, input.workspace, input.root);
  const { drift, confirmation } = await inspectDokDrift(current.data, projectRoot);
  // In the CLI's order: nothing to confirm on a Dok that is not stale; the
  // recovered-tracking review gate stays shut (only regeneration clears it);
  // and no blessing a source nobody could read.
  const refusal: DokDriftRefusal | null = !drift.stale
    ? 'NOT_STALE'
    : drift.reason === 'tracking-expanded'
      ? 'TRACKING_REVIEW_REQUIRED'
      : drift.reason !== 'changed' || !confirmation
        ? 'NOTHING_TO_CONFIRM'
        : null;
  if (refusal !== null || !confirmation) {
    const code = refusal ?? 'NOTHING_TO_CONFIRM';
    return {
      ok: false,
      code,
      path: current.path,
      error: driftRefusalMessage(input.dokId, code, drift),
      preserved: true,
      drift,
    };
  }
  return {
    ok: true,
    dokId: input.dokId,
    root: input.root,
    relativePath: input.relativePath,
    path: current.path,
    revision: current.revision,
    projectRoot,
    next: applyDriftConfirmation(current.data, confirmation),
    confirmation,
  };
}

/**
 * "Still accurate": a person read the change and the Dok still holds. Writes
 * the three drift facts the CLI's drift entry point computes now —
 * `logic_hash_normalized`, `logic_files[].sha256` and `source_commit` — under
 * the same exact-revision check as every other Dok write, then drops the
 * judge's cached verdict. Refuses a Dok that is not stale, one whose recovered
 * source tracking still needs review, and one with a tracked file it cannot
 * read.
 */
export async function confirmDokStillAccurateAction(
  input: ConfirmDokStillAccurateInput,
): Promise<ConfirmDokStillAccurateResult> {
  const parsed = ConfirmDokInputSchema.safeParse(input);
  if (!parsed.success) {
    const candidate = isRecord(input) ? input.dokId : undefined;
    const dokId = DokIdSchema.safeParse(candidate).success ? String(candidate) : 'INVALID';
    const target = await workspaceTarget(`.doklo/hub/doks/${dokId}.json`);
    if (!('root' in target)) return target;
    return invalidInput(target.path, 'Dok confirmation', parsed.error);
  }
  const { dokId, expectedRevision } = parsed.data;
  const resolved = await resolveDokWriteTarget(dokId, expectedRevision);
  if (!('target' in resolved)) return resolved;
  const { root, relativePath } = resolved.target;
  const workspace = await driftWorkspace();
  if (!('root' in workspace)) return workspace;

  const prepared = await prepareDokConfirmation({
    dokId,
    root,
    relativePath,
    expectedRevision,
    workspace: workspace.workspace,
    label: 'Dok',
  });
  if (!prepared.ok) return prepared;
  const written = await writeJsonForMutation({
    root,
    relativePath,
    expectedRevision: prepared.revision,
    value: prepared.next,
    schema: DokSchema,
    label: 'Dok',
  });
  if (!written.ok) return written;

  const judgeCacheRemoved = await removeConfirmedJudgeVerdict(root, dokId);
  // Read back through the same reader the editor uses, so the UI refreshes
  // from what was written rather than from what was intended.
  const { drift } = await inspectDokDrift(prepared.next, prepared.projectRoot);
  return {
    ok: true,
    dokId,
    path: written.path,
    revision: written.revision,
    drift,
    stamped: {
      logic_hash_normalized: prepared.confirmation.logic_hash_normalized,
      source_commit: prepared.confirmation.source_commit ?? null,
      files: prepared.confirmation.logic_files.filter((entry) => entry.sha256 !== undefined).length,
    },
    judgeCacheRemoved,
  };
}

/**
 * "Still accurate" for several stale Doks at once, with the bulk activation's
 * contract: every target is preflighted — exact revision, identity, staleness,
 * the baseline to stamp — before any file is written, so a refused target
 * leaves every Dok untouched; then each Dok is written atomically on its own
 * and a late write failure is reported Dok by Dok.
 */
export async function bulkConfirmDoksStillAccurateAction(
  input: BulkConfirmDoksInput,
): Promise<BulkConfirmDoksResult> {
  const parsed = BulkConfirmDoksInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'INVALID',
      error: `Bulk Dok confirmation is invalid: ${formatZodError(parsed.error)}`,
      confirmed: [],
      failures: [],
    };
  }
  const targets = parsed.data.targets;
  const preflightFailed = (
    error: string,
    failures: BulkConfirmDokFailure[],
  ): BulkConfirmDoksResult => ({
    ok: false,
    code: 'PREFLIGHT_FAILED',
    error,
    confirmed: [],
    failures,
  });
  const everyTarget = (code: DokConfirmErrorCode, error: string): BulkConfirmDokFailure[] =>
    targets.map((target) => ({ dokId: target.dokId, code, error, preserved: true }));

  const catalog = await loadDoksState();
  if (catalog.kind === 'invalid' || catalog.kind === 'unreadable') {
    return preflightFailed(
      catalog.message,
      everyTarget(catalog.kind === 'invalid' ? 'INVALID' : 'UNREADABLE', catalog.message),
    );
  }
  if (catalog.kind === 'missing' || catalog.kind === 'empty') {
    const error = catalog.kind === 'missing'
      ? 'The Dok catalog is missing.'
      : 'The Dok catalog is empty.';
    return preflightFailed(error, everyTarget('MISSING', error));
  }
  const hub = await workspaceTarget('.doklo/hub/doks');
  if (!('root' in hub)) return preflightFailed(hub.error, everyTarget(hub.code, hub.error));
  const workspace = await driftWorkspace();
  if (!('root' in workspace)) {
    return preflightFailed(workspace.error, everyTarget(workspace.code, workspace.error));
  }

  const prepared: PreparedDokConfirmation[] = [];
  const failures: BulkConfirmDokFailure[] = [];
  for (const target of targets) {
    const exactPath = catalog.data.paths[target.dokId];
    const catalogRevision = catalog.data.revisions[target.dokId];
    if (exactPath === undefined || catalogRevision === undefined) {
      failures.push({
        dokId: target.dokId,
        code: 'MISSING',
        error: `Dok ${target.dokId} was not found in the loaded catalog.`,
        preserved: true,
      });
      continue;
    }
    if (catalogRevision !== target.expectedRevision) {
      failures.push({
        dokId: target.dokId,
        code: 'CONFLICT',
        error: `Dok ${target.dokId} changed outside this selection.`,
        preserved: true,
      });
      continue;
    }
    const relativePath = relative(hub.root, exactPath);
    if (escapesWorkspace(relativePath)) {
      failures.push({
        dokId: target.dokId,
        code: 'INVALID',
        error: `Loaded Dok path escapes the workspace: ${exactPath}`,
        preserved: true,
      });
      continue;
    }
    const result = await prepareDokConfirmation({
      dokId: target.dokId,
      root: hub.root,
      relativePath,
      expectedRevision: target.expectedRevision,
      workspace: workspace.workspace,
      label: `Dok ${target.dokId}`,
    });
    if (!result.ok) {
      failures.push({
        dokId: target.dokId,
        code: result.code,
        error: result.error,
        preserved: true,
      });
      continue;
    }
    prepared.push(result);
  }
  if (failures.length > 0) {
    return preflightFailed(
      `${failures.length} Dok(s) failed confirmation preflight.`,
      failures,
    );
  }

  const confirmed: Array<{ dokId: string; revision: string }> = [];
  for (const item of prepared) {
    const written = await writeJsonForMutation({
      root: item.root,
      relativePath: item.relativePath,
      expectedRevision: item.revision,
      value: item.next,
      schema: DokSchema,
      label: `Dok ${item.dokId}`,
    });
    if (!written.ok) {
      failures.push({
        dokId: item.dokId,
        code: written.code,
        error: written.error,
        preserved: true,
      });
      continue;
    }
    await removeConfirmedJudgeVerdict(item.root, item.dokId);
    confirmed.push({ dokId: item.dokId, revision: written.revision });
  }
  if (failures.length > 0) {
    return {
      ok: false,
      code: 'PARTIAL_FAILURE',
      error: `${failures.length} Dok(s) could not be confirmed.`,
      confirmed,
      failures,
    };
  }
  return { ok: true, confirmed };
}

// ─── Lexicon ──────────────────────────────────────────────────

const LEXICON_PATH = '.doklo/hub/lexicon.json';

export async function saveOwnedLexiconLocaleAction(input: {
  termId: string;
  locale: string;
  text: string;
  expectedRevision: string;
}): Promise<SaveResult> {
  const target = await workspaceTarget(LEXICON_PATH);
  if (!('root' in target)) return target;
  const parsed = z.strictObject({
    termId: TermIdSchema,
    locale: z.string().min(1),
    text: z.string(),
    expectedRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(target.path, 'Lexicon locale edit', parsed.error);

  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: LexiconFileSchema,
    label: 'Lexicon',
  });
  if (!current.ok) return current;
  const index = current.data.terms.findIndex((term) => term.term_id === parsed.data.termId);
  if (index === -1) {
    return saveFailure('INVALID', current.path, `Lexicon term ${parsed.data.termId} was not found.`);
  }
  const stored = current.data.terms[index];
  if (stored.binding.type !== 'owned') {
    return {
      ok: false,
      code: 'INVALID',
      path: current.path,
      error: 'Only owned Lexicon locales are editable in Studio.',
      preserved: true,
    };
  }

  const nextTerm: LexiconTerm = {
    ...stored,
    locales: {
      ...stored.locales,
      [parsed.data.locale]: parsed.data.text,
    },
  };
  const next: LexiconFile = {
    ...current.data,
    updated_at: new Date().toISOString(),
    terms: current.data.terms.map((term, termIndex) =>
      termIndex === index ? nextTerm : term
    ),
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: LexiconFileSchema,
    label: 'Lexicon',
  });
}

type CreateLexiconTermInput = {
  term: LexiconTerm;
  expectedRevision: string;
};

function isCreateLexiconTermInput(
  input: CreateLexiconTermInput | LexiconTerm,
): input is CreateLexiconTermInput {
  return isRecord(input) && 'term' in input && 'expectedRevision' in input;
}

export async function createLexiconTermAction(
  input: CreateLexiconTermInput,
): Promise<SaveResult> {
  const target = await workspaceTarget(LEXICON_PATH);
  if (!('root' in target)) return target;
  const parsed = z.strictObject({
    term: LexiconTermSchema,
    expectedRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(target.path, 'Lexicon term creation', parsed.error);

  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: LexiconFileSchema,
    label: 'Lexicon',
  });
  if (!current.ok) return current;
  if (current.data.terms.some((term) => term.term_id === parsed.data.term.term_id)) {
    return saveFailure('INVALID', current.path, `Lexicon term ${parsed.data.term.term_id} already exists.`);
  }
  const next = {
    ...current.data,
    updated_at: new Date().toISOString(),
    terms: [...current.data.terms, parsed.data.term],
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: LexiconFileSchema,
    label: 'Lexicon',
  });
}

export function upsertLexiconTermAction(input: CreateLexiconTermInput): Promise<SaveResult>;
/** @deprecated Full-object calls are rejected; use the revision-checked overload. */
export function upsertLexiconTermAction(input: LexiconTerm): Promise<SaveResult>;
export async function upsertLexiconTermAction(
  input: CreateLexiconTermInput | LexiconTerm,
): Promise<SaveResult> {
  if (isCreateLexiconTermInput(input)) {
    return createLexiconTermAction(input);
  }
  return invalidLegacyCall(LEXICON_PATH, 'upsertLexiconTermAction');
}

type DeleteLexiconTermInput = { termId: string; expectedRevision: string };

export function deleteLexiconTermAction(input: DeleteLexiconTermInput): Promise<SaveResult>;
/** @deprecated String-only calls are rejected; include the expected revision. */
export function deleteLexiconTermAction(input: string): Promise<SaveResult>;
export async function deleteLexiconTermAction(
  input: DeleteLexiconTermInput | string,
): Promise<SaveResult> {
  if (typeof input === 'string') return invalidLegacyCall(LEXICON_PATH, 'deleteLexiconTermAction');
  const target = await workspaceTarget(LEXICON_PATH);
  if (!('root' in target)) return target;
  const parsed = z.strictObject({
    termId: TermIdSchema,
    expectedRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(target.path, 'Lexicon term deletion', parsed.error);

  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: LexiconFileSchema,
    label: 'Lexicon',
  });
  if (!current.ok) return current;
  if (!current.data.terms.some((term) => term.term_id === parsed.data.termId)) {
    return saveFailure('INVALID', current.path, `Lexicon term ${parsed.data.termId} was not found.`);
  }
  const next = {
    ...current.data,
    updated_at: new Date().toISOString(),
    terms: current.data.terms.filter((term) => term.term_id !== parsed.data.termId),
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: LexiconFileSchema,
    label: 'Lexicon',
  });
}

// ─── Roles ────────────────────────────────────────────────────

const ROLES_PATH = '.doklo/hub/roles.json';

export async function saveRoleAction(input: {
  roleId: string;
  patch: RoleEditPatch;
  expectedRevision: string;
}): Promise<SaveResult> {
  const target = await workspaceTarget(ROLES_PATH);
  if (!('root' in target)) return target;
  const parsed = z.strictObject({
    roleId: RoleIdSchema,
    patch: RoleEditPatchSchema,
    expectedRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(target.path, 'Role edit', parsed.error);

  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: RolesFileSchema,
    label: 'Roles',
  });
  if (!current.ok) return current;
  const index = current.data.roles.findIndex((role) => role.role_id === parsed.data.roleId);
  if (index === -1) return saveFailure('INVALID', current.path, `Role ${parsed.data.roleId} was not found.`);
  const nextRole: Role = {
    ...current.data.roles[index],
    ...parsed.data.patch,
  };
  const next = {
    ...current.data,
    updated_at: new Date().toISOString(),
    roles: current.data.roles.map((role, roleIndex) =>
      roleIndex === index ? nextRole : role
    ),
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: RolesFileSchema,
    label: 'Roles',
  });
}

type CreateRoleInput = { role: Role; expectedRevision: string };

function isCreateRoleInput(input: CreateRoleInput | Role): input is CreateRoleInput {
  return isRecord(input) && 'role' in input && 'expectedRevision' in input;
}

export async function createRoleAction(input: CreateRoleInput): Promise<SaveResult> {
  const target = await workspaceTarget(ROLES_PATH);
  if (!('root' in target)) return target;
  const parsed = z.strictObject({
    role: RoleSchema,
    expectedRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(target.path, 'Role creation', parsed.error);
  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: RolesFileSchema,
    label: 'Roles',
  });
  if (!current.ok) return current;
  if (current.data.roles.some((role) => role.role_id === parsed.data.role.role_id)) {
    return saveFailure('INVALID', current.path, `Role ${parsed.data.role.role_id} already exists.`);
  }
  const { _meta: _clientMeta, ...clientRole } = parsed.data.role;
  const next: RolesFile = {
    ...current.data,
    updated_at: new Date().toISOString(),
    roles: [...current.data.roles, clientRole],
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: RolesFileSchema,
    label: 'Roles',
  });
}

export function upsertRoleAction(input: CreateRoleInput): Promise<SaveResult>;
/** @deprecated Full-object calls are rejected; use the revision-checked overload. */
export function upsertRoleAction(input: Role): Promise<SaveResult>;
export async function upsertRoleAction(input: CreateRoleInput | Role): Promise<SaveResult> {
  if (isCreateRoleInput(input)) {
    return createRoleAction(input);
  }
  return invalidLegacyCall(ROLES_PATH, 'upsertRoleAction');
}

type DeleteRoleInput = { roleId: string; expectedRevision: string };

export function deleteRoleAction(input: DeleteRoleInput): Promise<SaveResult>;
/** @deprecated String-only calls are rejected; include the expected revision. */
export function deleteRoleAction(input: string): Promise<SaveResult>;
export async function deleteRoleAction(input: DeleteRoleInput | string): Promise<SaveResult> {
  if (typeof input === 'string') return invalidLegacyCall(ROLES_PATH, 'deleteRoleAction');
  const target = await workspaceTarget(ROLES_PATH);
  if (!('root' in target)) return target;
  const parsed = z.strictObject({
    roleId: RoleIdSchema,
    expectedRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(target.path, 'Role deletion', parsed.error);
  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: RolesFileSchema,
    label: 'Roles',
  });
  if (!current.ok) return current;
  if (!current.data.roles.some((role) => role.role_id === parsed.data.roleId)) {
    return saveFailure('INVALID', current.path, `Role ${parsed.data.roleId} was not found.`);
  }
  const next = {
    ...current.data,
    updated_at: new Date().toISOString(),
    roles: current.data.roles.filter((role) => role.role_id !== parsed.data.roleId),
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: RolesFileSchema,
    label: 'Roles',
  });
}

// ─── Lexicon Suggestions ──────────────────────────────────────

const SUGGESTIONS_PATH = '.doklo/cache/lexicon-suggestions.json';
const CATEGORY_TO_PREFIX: Record<LexiconTerm['category'], string> = {
  concept: 'CONCEPT',
  role: 'ROLE',
};

function allocateTermId(
  existing: LexiconTerm[],
  category: LexiconTerm['category'],
): string {
  const prefix = `TERM-${CATEGORY_TO_PREFIX[category]}-`;
  let max = 0;
  for (const term of existing) {
    if (!term.term_id.startsWith(prefix)) continue;
    const match = term.term_id.slice(prefix.length).match(/^(\d{3,})$/u);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

type AcceptSuggestionInput = {
  text: string;
  category: LexiconTerm['category'];
  reason?: string;
  dok_refs?: string[];
  defaultLocale: string;
  expectedRevision: string;
  expectedSuggestionsRevision: string;
};

type LegacyAcceptSuggestionInput = Omit<
  AcceptSuggestionInput,
  'expectedRevision' | 'expectedSuggestionsRevision'
>;

export function acceptLexiconSuggestionAction(
  input: AcceptSuggestionInput,
): Promise<SaveResult>;
/** @deprecated Calls without both source revisions are rejected. */
export function acceptLexiconSuggestionAction(
  input: LegacyAcceptSuggestionInput,
): Promise<SaveResult>;
export async function acceptLexiconSuggestionAction(
  input: AcceptSuggestionInput | LegacyAcceptSuggestionInput,
): Promise<SaveResult> {
  const lexiconTarget = await workspaceTarget(LEXICON_PATH);
  if (!('root' in lexiconTarget)) return lexiconTarget;
  const suggestionsTarget = await workspaceTarget(SUGGESTIONS_PATH);
  if (!('root' in suggestionsTarget)) return suggestionsTarget;
  const parsed = z.strictObject({
    text: z.string().min(1),
    category: z.unknown(),
    reason: z.string().optional(),
    dok_refs: z.array(DokIdSchema).optional(),
    defaultLocale: z.string().min(1),
    expectedRevision: RevisionSchema,
    expectedSuggestionsRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(lexiconTarget.path, 'Suggestion acceptance', parsed.error);

  const suggestions = await readJsonForMutation({
    ...suggestionsTarget,
    expectedRevision: parsed.data.expectedSuggestionsRevision,
    schema: LexiconSuggestionsFileSchema,
    label: 'Lexicon suggestions',
  });
  if (!suggestions.ok) return suggestions;
  if (!suggestions.data.suggestions.some((suggestion) => suggestion.text === parsed.data.text)) {
    return saveFailure('INVALID', suggestions.path, `Suggestion ${parsed.data.text} was not found.`);
  }

  let lexicon = await readJsonForMutation({
    ...lexiconTarget,
    expectedRevision: parsed.data.expectedRevision,
    schema: LexiconFileSchema,
    label: 'Lexicon',
  });
  let alreadyAccepted = false;
  if (!lexicon.ok && lexicon.code === 'CONFLICT') {
    const currentLexicon = await readJsonForMutation({
      ...lexiconTarget,
      schema: LexiconFileSchema,
      label: 'Lexicon',
    });
    if (!currentLexicon.ok) return currentLexicon;
    alreadyAccepted = currentLexicon.data.terms.some(
      (term) =>
        term.binding.type === 'owned' &&
        term.locales?.[parsed.data.defaultLocale] === parsed.data.text,
    );
    if (!alreadyAccepted) return lexicon;
    lexicon = currentLexicon;
  } else if (!lexicon.ok) {
    return lexicon;
  }

  const categoryResult = LexiconCategorySchema.safeParse(parsed.data.category);
  const category = categoryResult.success ? categoryResult.data : 'concept';
  let lexiconResult: SaveResult = {
    ok: true,
    path: lexicon.path,
    revision: lexicon.revision,
  };
  if (!alreadyAccepted) {
    const term: LexiconTerm = {
      term_id: allocateTermId(lexicon.data.terms, category),
      category,
      binding: { type: 'owned' },
      locales: { [parsed.data.defaultLocale]: parsed.data.text },
      related_doks: parsed.data.dok_refs ?? [],
    };
    const nextLexicon = {
      ...lexicon.data,
      updated_at: new Date().toISOString(),
      terms: [...lexicon.data.terms, term],
    };
    lexiconResult = await writeJsonForMutation({
      ...lexiconTarget,
      expectedRevision: lexicon.revision,
      value: nextLexicon,
      schema: LexiconFileSchema,
      label: 'Lexicon',
    });
    if (!lexiconResult.ok) return lexiconResult;
  }

  const nextSuggestions: LexiconSuggestionsFile = {
    ...suggestions.data,
    suggestions: suggestions.data.suggestions.filter(
      (suggestion) => suggestion.text !== parsed.data.text,
    ),
  };
  const suggestionResult = await writeJsonForMutation({
    ...suggestionsTarget,
    expectedRevision: suggestions.revision,
    value: nextSuggestions,
    schema: LexiconSuggestionsFileSchema,
    label: 'Lexicon suggestions',
  });
  if (!suggestionResult.ok) return suggestionResult;
  return lexiconResult;
}

type RejectSuggestionInput = { text: string; expectedRevision: string };

export function rejectLexiconSuggestionAction(input: RejectSuggestionInput): Promise<SaveResult>;
/** @deprecated String-only calls are rejected; include the expected revision. */
export function rejectLexiconSuggestionAction(input: string): Promise<SaveResult>;
export async function rejectLexiconSuggestionAction(
  input: RejectSuggestionInput | string,
): Promise<SaveResult> {
  if (typeof input === 'string') {
    return invalidLegacyCall(SUGGESTIONS_PATH, 'rejectLexiconSuggestionAction');
  }
  const target = await workspaceTarget(SUGGESTIONS_PATH);
  if (!('root' in target)) return target;
  const parsed = z.strictObject({
    text: z.string().min(1),
    expectedRevision: RevisionSchema,
  }).safeParse(input);
  if (!parsed.success) return invalidInput(target.path, 'Suggestion rejection', parsed.error);
  const current = await readJsonForMutation({
    ...target,
    expectedRevision: parsed.data.expectedRevision,
    schema: LexiconSuggestionsFileSchema,
    label: 'Lexicon suggestions',
  });
  if (!current.ok) return current;
  if (!current.data.suggestions.some((suggestion) => suggestion.text === parsed.data.text)) {
    return saveFailure('INVALID', current.path, `Suggestion ${parsed.data.text} was not found.`);
  }
  const next: LexiconSuggestionsFile = {
    ...current.data,
    suggestions: current.data.suggestions.filter(
      (suggestion) => suggestion.text !== parsed.data.text,
    ),
  };
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: LexiconSuggestionsFileSchema,
    label: 'Lexicon suggestions',
  });
}

// ─── Consolidation ────────────────────────────────────────────

type SaveConsolidatedInput = {
  serviceId: string;
  config: unknown;
  expectedRevision: string;
};

const MutationConsolidatedSchema = z.preprocess(
  stripUnknownConsolidationFields,
  ConsolidatedFeatureConfigSchema,
);

const MutationConsolidatedReadSchema = z.preprocess(
  stripUnknownConsolidationFields,
  z.custom<ConsolidatedFeatureConfig>((value) => {
    try {
      parseConsolidatedFeatureConfig(value);
      return true;
    } catch {
      return false;
    }
  }, 'invalid consolidated cache'),
);

export function saveConsolidatedAction(input: SaveConsolidatedInput): Promise<SaveResult>;
/** @deprecated Positional calls are rejected; use the revision-checked overload. */
export function saveConsolidatedAction(
  serviceId: string,
  config: unknown,
): Promise<SaveResult>;
export async function saveConsolidatedAction(
  input: SaveConsolidatedInput | string,
  legacyConfig?: unknown,
): Promise<SaveResult> {
  if (typeof input === 'string') {
    void legacyConfig;
    const legacyService = ServiceIdSchema.safeParse(input).success
      ? input
      : 'invalid';
    return invalidLegacyCall(
      `.doklo/cache/${legacyService}.consolidated.json`,
      'saveConsolidatedAction',
    );
  }
  if (!isRecord(input)) {
    return invalidLegacyCall(
      '.doklo/cache/invalid.consolidated.json',
      'saveConsolidatedAction',
    );
  }
  const identity = z.strictObject({
    serviceId: ServiceIdSchema,
    expectedRevision: RevisionSchema,
  }).safeParse({
    serviceId: input.serviceId,
    expectedRevision: input.expectedRevision,
  });
  const relativePath = `.doklo/cache/${identity.success ? identity.data.serviceId : 'invalid'}.consolidated.json`;
  const target = await workspaceTarget(relativePath);
  if (!('root' in target)) return target;
  if (!identity.success) return invalidInput(target.path, 'Consolidation save', identity.error);
  const incoming = ConsolidatedFeatureConfigSchema.safeParse(input.config);
  if (!incoming.success) return invalidInput(target.path, 'Consolidation save', incoming.error);

  const current = await readJsonForMutation({
    ...target,
    expectedRevision: identity.data.expectedRevision,
    schema: MutationConsolidatedReadSchema,
    label: 'Consolidated cache',
  });
  if (!current.ok) return current;
  const repairedCurrent = parseConsolidatedFeatureConfig(
    stripUnknownConsolidationFields(current.data),
  );
  // Preserve extension fields on already-valid caches. A legacy route-slug
  // collision must instead use the repaired strict value so identity matching
  // sees the same canonical ids that Studio displayed to the user.
  const currentForEdit = MutationConsolidatedSchema.safeParse(current.data).success
    ? current.data
    : repairedCurrent;
  const merged = applyConsolidationEdit(
    currentForEdit as unknown as Record<string, unknown>,
    incoming.data,
  );
  if (!merged.ok) {
    return saveFailure('INVALID', current.path, merged.error);
  }
  const next: ConsolidatedFeatureConfig = {
    ...merged.value,
    userReviewed: true,
    generatedAt: new Date().toISOString(),
  };
  const duplicatePrefix = findDuplicateDokIdPrefix(next);
  if (duplicatePrefix) {
    return saveFailure(
      'INVALID',
      current.path,
      `Duplicate dok_id_prefix "${duplicatePrefix.prefix}": features "${duplicatePrefix.first}" ` +
        `and "${duplicatePrefix.second}" cannot share a prefix — the generator mints exactly one ` +
        `Dok per prefix. Change one feature's dok_id_prefix in this consolidation screen and save ` +
        'again, or edit it directly in the consolidated cache ' +
        `(\`.doklo/cache/${identity.data.serviceId}.consolidated.json\`), ` +
        'or re-run `doklo consolidate` for a fresh pass.',
    );
  }
  return writeJsonForMutation({
    ...target,
    expectedRevision: current.revision,
    value: next,
    schema: MutationConsolidatedSchema,
    label: 'Consolidated cache',
  });
}

/** Same-cache guard: two live (non-excluded) features must not share a
 *  dok_id_prefix — the prefix becomes the Dok id verbatim, and
 *  assignDokIds (packages/generator) throws DuplicateDokIdPrefixError on
 *  any collision at generate time. Catching it here gives fail-closed
 *  feedback right in Studio instead of at the next `doklo generate`.
 *  Excluded features are skipped, mirroring assignDokIds exactly, so an
 *  already-excluded Dok's stale prefix never blocks an unrelated save. */
function findDuplicateDokIdPrefix(
  config: ConsolidatedFeatureConfig,
): { prefix: string; first: string; second: string } | null {
  const ownerByPrefix = new Map<string, string>();
  for (const group of config.groups) {
    for (const feature of group.features) {
      if (feature.decision === 'exclude' || !feature.dok_id_prefix) continue;
      const owner = ownerByPrefix.get(feature.dok_id_prefix);
      if (owner !== undefined) {
        return { prefix: feature.dok_id_prefix, first: owner, second: feature.canonical_id };
      }
      ownerByPrefix.set(feature.dok_id_prefix, feature.canonical_id);
    }
  }
  return null;
}

function stripUnknownConsolidationFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const groups = Array.isArray(value.groups)
    ? value.groups.map((group) => {
        if (!isRecord(group)) return group;
        const features = Array.isArray(group.features)
          ? group.features.map((feature) => {
              if (!isRecord(feature)) return feature;
              const metadata = isRecord(feature.metadata)
                ? {
                    locales: feature.metadata.locales,
                    variant_type: feature.metadata.variant_type,
                    note: feature.metadata.note,
                  }
                : feature.metadata;
              return {
                canonical_id: feature.canonical_id,
                label: feature.label,
                decision: feature.decision,
                prev_decision: feature.prev_decision,
                members: feature.members,
                primary_route: feature.primary_route,
                reason: feature.reason,
                user_reviewed: feature.user_reviewed,
                dok_id_prefix: feature.dok_id_prefix,
                source_files: feature.source_files,
                logic_files: feature.logic_files,
                metadata,
              };
            })
          : group.features;
        const excluded = Array.isArray(group.excluded)
          ? group.excluded.map((entry) => isRecord(entry)
              ? { id: entry.id, reason: entry.reason }
              : entry)
          : group.excluded;
        return {
          group_id: group.group_id,
          label: group.label,
          features,
          excluded,
        };
      })
    : value.groups;
  const stats = isRecord(value.stats)
    ? {
        originalFeatures: value.stats.originalFeatures,
        consolidatedFeatures: value.stats.consolidatedFeatures,
        merges: value.stats.merges,
        excluded: value.stats.excluded,
      }
    : value.stats;
  return {
    projectName: value.projectName,
    basedOnFeaturesAt: value.basedOnFeaturesAt,
    generatedAt: value.generatedAt,
    model: value.model,
    groups,
    originalFeatureIds: value.originalFeatureIds,
    userReviewed: value.userReviewed,
    notes: value.notes,
    stats,
  };
}

type ConsolidationEditResult =
  | { ok: true; value: ConsolidatedFeatureConfig }
  | { ok: false; error: string };

function applyConsolidationEdit(
  current: Record<string, unknown>,
  requested: ConsolidatedFeatureConfig,
): ConsolidationEditResult {
  const currentConfig = current as unknown as ConsolidatedFeatureConfig;
  const currentGroups = Array.isArray(current.groups)
    ? current.groups.filter(isRecord)
    : [];
  const groupsById = new Map(
    currentGroups
      .filter((group) => typeof group.group_id === 'string')
      .map((group) => [group.group_id as string, group]),
  );
  const featuresById = new Map<string, Record<string, unknown>>();
  const excludedById = new Map<string, Record<string, unknown>[]>();
  for (const group of currentGroups) {
    if (Array.isArray(group.features)) {
      for (const feature of group.features.filter(isRecord)) {
        if (typeof feature.canonical_id === 'string') {
          featuresById.set(feature.canonical_id, feature);
        }
      }
    }
    if (Array.isArray(group.excluded)) {
      for (const entry of group.excluded.filter(isRecord)) {
        if (typeof entry.id === 'string') {
          const occurrences = excludedById.get(entry.id);
          if (occurrences) occurrences.push(entry);
          else excludedById.set(entry.id, [entry]);
        }
      }
    }
  }

  const currentFeatureIds = currentConfig.groups.flatMap((group) =>
    group.features.map((feature) => feature.canonical_id)
  );
  const requestedFeatureIds = requested.groups.flatMap((group) =>
    group.features.map((feature) => feature.canonical_id)
  );
  if (!sameIdentityList(currentFeatureIds, requestedFeatureIds)) {
    return {
      ok: false,
      error: 'Consolidation canonical feature identities changed. Reload before saving.',
    };
  }

  const currentExcludedIds = currentConfig.groups.flatMap((group) =>
    group.excluded.map((entry) => entry.id)
  );
  const requestedExcludedIds = requested.groups.flatMap((group) =>
    group.excluded.map((entry) => entry.id)
  );
  if (!sameIdentityList(currentExcludedIds, requestedExcludedIds)) {
    return {
      ok: false,
      error: 'Consolidation excluded feature identities changed. Reload before saving.',
    };
  }

  const structurallyEdited = {
    ...current,
    groups: requested.groups.map((group) => {
      const currentGroup = groupsById.get(group.group_id) ?? {};
      return {
        ...currentGroup,
        group_id: group.group_id,
        label: group.label,
        features: group.features.map((feature) => {
          const stored = featuresById.get(feature.canonical_id);
          if (!stored) throw new Error(`Missing validated feature ${feature.canonical_id}.`);
          const edited: Record<string, unknown> = {
            ...stored,
            decision: feature.decision,
          };
          if (feature.prev_decision === undefined) {
            delete edited.prev_decision;
          } else {
            edited.prev_decision = feature.prev_decision;
          }
          // dok_id_prefix is Studio-editable (consolidation screen's inline
          // prefix input) — like decision, the client's validated value wins.
          // `incoming` was already schema-checked above, so any prefix here
          // satisfies DokIdSchema or is absent; the same-cache duplicate
          // guard below still runs on the merged result either way.
          if (feature.dok_id_prefix === undefined) {
            delete edited.dok_id_prefix;
          } else {
            edited.dok_id_prefix = feature.dok_id_prefix;
          }
          return edited;
        }),
        excluded: group.excluded.map((entry) => {
          const stored = excludedById.get(entry.id)?.shift();
          if (!stored) throw new Error(`Missing validated excluded feature ${entry.id}.`);
          return stored;
        }),
      };
    }),
  };
  const recomputed = recomputeStats(
    structurallyEdited as unknown as ConsolidatedFeatureConfig,
  );
  return {
    ok: true,
    value: {
      ...recomputed,
      stats: {
        ...(isRecord(current.stats) ? current.stats : {}),
        ...recomputed.stats,
        originalFeatures: currentConfig.stats.originalFeatures,
      },
    },
  };
}

function sameIdentityList(current: string[], requested: string[]): boolean {
  if (current.length !== requested.length) return false;
  const sortedCurrent = [...current].sort((left, right) => left.localeCompare(right));
  const sortedRequested = [...requested].sort((left, right) => left.localeCompare(right));
  return sortedCurrent.every((id, index) => id === sortedRequested[index]);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
