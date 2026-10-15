import { readLlmTokenBudget } from '../lib/llm-cost-cap.js';
// `doklo sync` — drift-driven Dok regeneration.
//
// Loads the Hub, judges every Dok (or one, via --dok) against the current
// source with the CLI's drift entry point (lib/drift.ts: core's isDokStale with
// the format-only layer on), and regenerates the drifted ones
// through runGenerate (force + onlyDokIds). Human-edited Doks are protected
// unless --force; --check previews without regenerating (and exits 1 when any
// Dok is stale, for CI). runGenerate re-stamps _meta.logic_hash on each
// regenerated Dok, so a synced Dok returns to fresh on the next judgment.
// Regeneration always writes `draft`, so an approved Dok it regenerates leaves
// stable Live Docs until re-approved; sync names those before consent and in
// its summary (plannedReturnToDraft / returnedToDraft). A Dok whose sources
// changed in form only (comments, whitespace, line endings) is not stale and
// is never regenerated; sync only counts it (formatOnly).
//
// Regeneration reuses the consolidated plan already on disk (consolidate is
// paid + consent-gated, so sync never chains it). When that plan predates the
// edit that made a Dok stale, sync says so — see detectPlanOutdated — without
// blocking the regeneration.
//
// `--judge` (judge-gated sync, design 2026-10-06 §4): before regenerating, an
// LLM judge reads each stale (`changed`) non-draft Dok with the diff since its
// `source_commit` and says whether the Dok still holds. Three steps, two
// consents: a mutation-free preview prepares every judge prompt (lib/judge);
// the judge plan is approved and run (`authorizedJudgeRun`), which returns the
// post-judge preview; the regeneration plan for the Doks still needing it is
// approved and run as before. A Dok judged `accurate` is not regenerated and
// stays stale until a person confirms it (its verdict lives only in
// `.doklo/cache/judge/`); a `needs_update` Dok is regenerated with the judge's
// sentence staged as its proposal (`source: 'model'`); `uncertain` and every
// failure regenerate as without `--judge`.

import { assertRecordingSource } from '../lib/recording-branch.js';
import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { isDokStale } from '../lib/drift.js';
import {
  derivePriorityTier,
  dokProjectRoot,
  loadHubModel,
  type Dok,
  type HubModel,
  type PriorityTier,
  type Workspace,
  DokHistoryCategorySchema,
  type DokHistoryCategory,
} from '@doklo-beta/core';
import {
  resolveContainedOutputPath,
  type LLMBackend,
  type ProviderKind,
} from '@doklo-beta/generator';
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { consolidatedCachePath } from './consolidate.js';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import { addLlmOptions, resolveLlmForRole } from '../lib/llm-options.js';
import { readCurrentJudgeVerdict } from '../lib/judge/cache.js';
import {
  emptyJudgeSkipped,
  judgePlanInput,
  judgeProposalsOf,
  prepareSyncJudge,
  runJudgeCalls,
  type JudgeDokFn,
  type PrepareSyncJudgeDeps,
  type PreparedJudgePayload,
  type SyncJudgedDok,
  type SyncJudgeSkipped,
} from '../lib/judge/judge.js';
import { JUDGE_INPUT_BUDGET_CHARS } from '../lib/judge/request.js';
import type { I18nT } from '../lib/i18n.js';
import {
  runGenerate,
  type PreparedGenerationPayload,
  type GenerateDeps,
  type GenerateProgressEvent,
  type GenerateOneFailure,
  type RunGenerateResult,
} from './generate.js';
import type { ProposalNote } from './generate.js';
import type { CliContext } from '../lib/context.js';
import {
  CommandContractError,
  recordCommandResult,
  requireExplicitApproval,
  type CommandDiagnostic,
  type CommandStatus,
} from '../lib/command-result.js';
import {
  authorizeLlmRun,
  buildLlmRunPlan,
  emitLlmRunPlan,
  type AuthorizedLlmRun,
  type LlmAuthSource,
  type LlmCandidateFile,
} from '../lib/llm-preflight.js';

export interface SyncCommandDeps {
  runSync: typeof runSync;
  resolveLlmForRole: typeof resolveLlmForRole;
  authorizeLlmRun: typeof authorizeLlmRun;
}

/** `--note` annotates a regeneration; `--check` never regenerates, so the pair is a usage error. */
export class SyncNoteRequiresRegenerationError extends Error {
  readonly code = 'SYNC_NOTE_WITH_CHECK';
  constructor() {
    super('--note annotates a regeneration; drop --check to regenerate.');
    this.name = 'SyncNoteRequiresRegenerationError';
  }
}

/** `--judge` calls a model before regenerating; `--check` never calls one, so the pair is a usage error. */
export class SyncJudgeRequiresRegenerationError extends Error {
  readonly code = 'SYNC_JUDGE_WITH_CHECK';
  constructor() {
    super('--judge asks a model before regenerating; --check never calls a model. Drop one of them.');
    this.name = 'SyncJudgeRequiresRegenerationError';
  }
}

/** `doklo sync --judge [--judge-max <n>]`. */
export interface SyncJudgeOptions {
  /** Judge at most this many Doks; the rest regenerate without the judge. Reused verdicts do not count. */
  max?: number;
}

export interface RunSyncOptions {
  root: string;
  /** List stale Doks only; never regenerates (and never touches the LLM). */
  check?: boolean;
  /** Regenerate even human-edited Doks (overwrites their edits). */
  force?: boolean;
  /** Limit judgment + regeneration to a single Dok (case-insensitive id). */
  dokId?: string;
  /** Streaming lifecycle events from the underlying regeneration pass. */
  onProgress?: (event: GenerateProgressEvent) => void;
  /** Reconcile stale Doks against the generate plan without paid work. */
  previewOnly?: boolean;
  authorizedRun?: AuthorizedLlmRun;
  /** Prior mutation-free sync preview reused after consent. */
  prepared?: RunSyncResult;
  /** Person's proposal staged on every Dok this run regenerates (`--note`). Incompatible with `check`. */
  proposalNote?: ProposalNote;
  /**
   * `--judge`: with `previewOnly`, prepare a judge call for every stale
   * (`changed`) non-draft Dok that would be regenerated and carries the change
   * facts (`preparedJudge`), reusing cached `accurate` verdicts. Incompatible
   * with `check`.
   */
  judge?: SyncJudgeOptions;
  /**
   * The approved judge plan's run. With `prepared` (a judge preview), runs the
   * prepared judge calls and returns the post-judge preview: Doks judged
   * accurate leave `plannedRegeneration`.
   */
  authorizedJudgeRun?: AuthorizedLlmRun;
}

export type RunSyncDeps = Partial<GenerateDeps> & PrepareSyncJudgeDeps & {
  /** Injection seam for asserting preview/actual regeneration options. */
  runGenerate?: typeof runGenerate;
  /** One judge call (default: the generator's `callModel` on the authorized route). */
  judgeDok?: JudgeDokFn;
};

/** A Dok that drifted from its anchored source. */
export interface StaleDokEntry {
  dokId: string;
  reason: 'changed' | 'missing-file' | 'tracking-expanded';
  /** True when a human edited this Dok (Studio marks _meta.edited_by_human). */
  humanEdited: boolean;
  /**
   * Derived at judgment time, never stored. An unjudged Dok lands on
   * `standard`: drift output must not go quiet on a Dok merely because nobody
   * has judged it yet.
   */
  tier: PriorityTier;
}

const IMPACT_REASON: Record<string, string> = {
  revenue: 'revenue',
  core_value: 'core value',
  compliance: 'compliance',
};

/**
 * One word naming why a Dok is critical, or null when it is not.
 *
 * Not always the impact: a sign-in screen is `enabling` and earns the tier on
 * blast radius alone, so printing its impact would read as a contradiction
 * rather than an explanation. Studio's catalog chip applies the same rule, so
 * both surfaces explain a Dok the same way.
 */
export function criticalDriftReason(dok: Dok): string | null {
  const priority = dok.priority;
  if (priority === undefined) return null;
  if (derivePriorityTier(priority) !== 'critical') return null;
  return IMPACT_REASON[priority.impact] ?? 'blocking';
}

export interface RunSyncResult {
  tokenCapFailure?: RunGenerateResult['tokenCapFailure'];
  tokenUsage?: RunGenerateResult['tokenUsage'];
  recordingSource?: { branch: string; commit: string };
  /** Number of Doks judged this run. */
  checked: number;
  /** Every stale Dok (human-edited ones included). */
  stale: StaleDokEntry[];
  /** Doks without a stored hash or verified tracking — drift is undecidable. */
  unknown: string[];
  /**
   * Doks whose tracked sources changed in form only (comments, whitespace,
   * line endings) since their baseline: not stale, never regenerated, listed
   * so the change is not silent. In neither `stale` nor `unknown`.
   */
  formatOnly?: string[];
  /** Doks actually regenerated (always empty in --check mode). */
  regenerated: string[];
  /**
   * Regenerated Doks that were approved (`status: active`) before this run.
   * Regeneration always writes `draft`, so each one is out of stable Live Docs
   * — and fails a saved Publication that names it — until a person approves it
   * again. Empty whenever nothing was regenerated (--check, preview).
   */
  returnedToDraft: string[];
  /** Stale but protected because a human edited them and --force was absent. */
  skippedHumanEdit: string[];
  /** Stale but absent from the consolidated plan (cache changed / manual Dok). */
  notInPlan: string[];
  /**
   * Stale Doks whose source changed *after* the consolidated plan that would
   * drive their regeneration was built — the plan is outdated (see
   * `detectPlanOutdated`). Advisory only; regeneration still proceeds.
   */
  planOutdated: string[];
  /**
   * dokId → the `generatedAt` of the outdated plan, so diagnostics can name the
   * moment the plan was built. Keyed alongside `planOutdated` rather than
   * folded into it, because that list is the stable machine-readable shape.
   */
  planOutdatedAt: Record<string, string>;
  /**
   * dokId → the one word explaining why that Dok is critical. Only critical
   * Doks appear. Derived at judgment time so renderers do not need the Doks.
   */
  criticalReasons: Record<string, string>;
  /** LLM failures forwarded from runGenerate. */
  failures: GenerateOneFailure[];
  plannedRegeneration: string[];
  /**
   * The approved (`status: active`) Doks among `plannedRegeneration`: what
   * `returnedToDraft` will list if every planned regeneration succeeds. Known
   * before consent, so approving the plan never demotes a Dok unannounced.
   */
  plannedReturnToDraft: string[];
  transmissions: LlmCandidateFile[];
  preparedGeneration?: PreparedGenerationPayload;
  /**
   * `--judge`: one entry per verdict this run used — called now or reused from
   * the cache. With `--check`: the stale Doks whose cached `accurate` verdict
   * still holds (stale, judged accurate, unconfirmed). Doks judged `accurate`
   * are not regenerated.
   */
  judged?: SyncJudgedDok[];
  /** `--judge`: stale Doks regenerated without the judge, by reason. */
  judgeSkipped?: SyncJudgeSkipped;
  /**
   * `--judge`: Doks the judge said need an update whose regeneration came out
   * the same as before — no proposal could describe a change, so a person has
   * to edit them.
   */
  regeneratedUnchanged?: string[];
  /** The judge preview's prepared, frozen judge calls (consumed by the judge step). */
  preparedJudge?: PreparedJudgePayload;
}

export class DokNotFoundError extends Error {
  constructor(dokId: string) {
    super(
      `No Dok with id "${dokId}" found in the hub. ` +
        'Run `doklo show` to list available Doks.',
    );
    this.name = 'DokNotFoundError';
  }
}

export async function runSync(
  opts: RunSyncOptions,
  deps: RunSyncDeps = {},
): Promise<RunSyncResult> {
  const {
    runGenerate: generateRunner = runGenerate,
    judgeDok,
    seamsFor,
    ...generateDeps
  } = deps;
  if (opts.check === true && opts.proposalNote !== undefined) {
    throw new SyncNoteRequiresRegenerationError();
  }
  if (opts.check === true && (opts.judge !== undefined || opts.authorizedJudgeRun !== undefined)) {
    throw new SyncJudgeRequiresRegenerationError();
  }
  const { paths } = await loadWorkspaceWithPaths(opts.root);
  const recordingSource = await assertRecordingSource(paths.root);
  const hub = await loadHubModel(paths.root);

  // ── Target Doks: one (--dok, case-insensitive) or the whole hub. ──
  let targets = hub.doks;
  if (opts.dokId) {
    const wanted = opts.dokId.toLowerCase();
    const match = hub.doks.find((d) => d.dok_id.toLowerCase() === wanted);
    if (!match) throw new DokNotFoundError(opts.dokId);
    targets = [match];
  }

  // ── Judge each Dok against its source on disk. ──
  const stale: StaleDokEntry[] = [];
  const staleDoks: Dok[] = [];
  const unknown: string[] = [];
  const formatOnly: string[] = [];
  const staleById = new Map<string, { entry: StaleDokEntry; dok: Dok }>();
  // dokId → the word explaining why it is critical. Filled here because this is
  // the only point holding both the entry and the Dok it came from.
  const criticalReasons: Record<string, string> = {};
  for (const dok of targets) {
    const projectRoot = dokProjectRoot(dok, hub.workspace, paths.root);
    const result = isDokStale(dok, projectRoot);
    if (result.stale) {
      const reason = result.reason === 'tracking-expanded'
        ? 'tracking-expanded'
        : result.reason === 'missing-file' ? 'missing-file' : 'changed';
      const entry: StaleDokEntry = {
        dokId: dok.dok_id,
        reason,
        humanEdited: dok._meta?.edited_by_human === true,
        tier: derivePriorityTier(dok.priority),
      };
      stale.push(entry);
      staleById.set(dok.dok_id, { entry, dok });
      const reasonWord = criticalDriftReason(dok);
      if (reasonWord !== null) criticalReasons[dok.dok_id] = reasonWord;
      staleDoks.push(dok);
    } else if (result.reason === 'no-hash' || result.reason === 'unverified-tracking') {
      unknown.push(dok.dok_id);
    } else if (result.reason === 'format-only') {
      formatOnly.push(dok.dok_id);
    }
    // else: fresh — nothing to do.
  }
  const checked = targets.length;

  // Approved stale Doks, read before anything is regenerated. Regeneration
  // always writes `draft`, so each of these that a run regenerates leaves
  // stable Live Docs until someone approves it again.
  const approvedStale = new Set(
    staleDoks.filter((dok) => dok.status === 'active').map((dok) => dok.dok_id),
  );
  const approvedAmong = (dokIds: string[]): string[] =>
    dokIds.filter((dokId) => approvedStale.has(dokId));

  // Deterministic and free (mtime + one JSON read per service), so it is
  // computed once here and reported on every path — --check, preview, and the
  // paid run alike.
  const outdatedPlan = await detectPlanOutdated(
    staleDoks,
    hub.workspace,
    paths.root,
    paths.cacheDir,
  );

  const empty = (): RunSyncResult => ({
    ...(recordingSource ? { recordingSource: { branch: recordingSource.branch, commit: recordingSource.commit } } : {}),
    checked,
    stale,
    unknown,
    formatOnly,
    regenerated: [],
    returnedToDraft: [],
    skippedHumanEdit: [],
    notInPlan: [],
    planOutdated: outdatedPlan.dokIds,
    planOutdatedAt: outdatedPlan.generatedAt,
    criticalReasons,
    failures: [],
    plannedRegeneration: [],
    plannedReturnToDraft: [],
    transmissions: [],
  });

  // ── --check: report only, no regeneration, no LLM. A stale Dok the judge
  //    called accurate (and nobody has confirmed since) says so. ──
  if (opts.check) {
    const judged = await unconfirmedJudgeVerdicts(stale, staleById, hub, paths.root);
    return { ...empty(), ...(judged.length > 0 ? { judged } : {}) };
  }

  // ── Regeneration candidates = stale minus human-edited (unless --force). ──
  const force = opts.force ?? false;
  const skippedHumanEdit: string[] = [];
  const candidates: string[] = [];
  for (const s of stale) {
    if (s.humanEdited && !force) skippedHumanEdit.push(s.dokId);
    else candidates.push(s.dokId);
  }

  if (candidates.length === 0) {
    return { ...empty(), skippedHumanEdit };
  }

  // ── Reconcile candidates against the consolidated plan. ──
  // A stale Dok is only regenerable if the current consolidated cache still
  // plans it under the same deterministic id. Anything else (a stale cache, or
  // a hand-authored Dok) can't be regenerated by generate — surface it instead
  // of silently dropping it.
  const generationPreview = opts.prepared === undefined
    ? await generateRunner(
        {
          root: paths.root,
          dryRun: true,
          force: true,
          noRoles: true,
          noLexicon: true,
          noIa: true,
          noCodeMapping: true,
        },
        generateDeps,
      )
    : undefined;
  const planned = generationPreview === undefined
    ? new Set(opts.prepared!.plannedRegeneration)
    : new Set(generationPreview.plan.map((p) => p.dokId));
  const regenTargets = candidates.filter((id) => planned.has(id));
  const notInPlan = generationPreview === undefined
    ? opts.prepared!.notInPlan.filter((id) => candidates.includes(id))
    : candidates.filter((id) => !planned.has(id));

  if (regenTargets.length === 0) {
    return { ...empty(), skippedHumanEdit, notInPlan };
  }

  // ── Judge-gated sync. The preview prepares the judge (cached `accurate`
  //    verdicts are reused at once); the judge step runs the approved calls;
  //    the regeneration step carries the verdicts into its result. A Dok judged
  //    accurate leaves the regeneration targets. ──
  let toRegenerate = regenTargets;
  let judgeOutcome: { judged: SyncJudgedDok[]; judgeSkipped: SyncJudgeSkipped } | undefined;
  let preparedJudge: PreparedJudgePayload | undefined;
  if (opts.authorizedJudgeRun !== undefined) {
    const payload = opts.prepared?.preparedJudge;
    if (payload === undefined) {
      throw new CommandContractError({
        schema_version: 1,
        command: 'llm',
        status: 'cancelled',
        data: null,
        diagnostics: [{
          code: 'LLM_PREPARED_PAYLOAD_REQUIRED',
          message: 'The judge step requires the immutable judge calls its preview prepared.',
        }],
      }, 2);
    }
    const run = await runJudgeCalls(
      {
        root: paths.root,
        authorizedRun: opts.authorizedJudgeRun,
        payload,
        debugDir: await resolveContainedOutputPath(paths.root, relative(paths.root, paths.debugDir)),
      },
      judgeDok === undefined ? {} : { judgeDok },
    );
    judgeOutcome = {
      judged: [...(opts.prepared?.judged ?? []), ...run.judged],
      judgeSkipped: opts.prepared?.judgeSkipped ?? emptyJudgeSkipped(),
    };
  } else if (opts.judge !== undefined && opts.previewOnly && opts.prepared === undefined) {
    const translate = {
      locale: hub.workspace.default_locale,
      primaryLocale: hub.workspace.default_locale,
      lexicon: hub.lexicon,
      roles: hub.roles,
    };
    const preparation = await prepareSyncJudge(
      {
        root: paths.root,
        targets: judgeTargets(regenTargets, staleById, hub, paths.root),
        translate,
        locale: hub.workspace.default_locale,
        ...(opts.judge.max !== undefined ? { max: opts.judge.max } : {}),
      },
      seamsFor === undefined ? {} : { seamsFor },
    );
    judgeOutcome = { judged: preparation.judged, judgeSkipped: preparation.judgeSkipped };
    preparedJudge = preparation.payload;
  } else if (opts.prepared?.judged !== undefined) {
    judgeOutcome = {
      judged: opts.prepared.judged,
      judgeSkipped: opts.prepared.judgeSkipped ?? emptyJudgeSkipped(),
    };
  }
  if (judgeOutcome !== undefined) {
    const kept = new Set(judgeOutcome.judged
      .filter((entry) => entry.verdict === 'accurate')
      .map((entry) => entry.dokId));
    toRegenerate = regenTargets.filter((dokId) => !kept.has(dokId));
  }
  const judgeFields = judgeOutcome === undefined
    ? {}
    : {
        judged: judgeOutcome.judged,
        judgeSkipped: judgeOutcome.judgeSkipped,
        ...(preparedJudge === undefined ? {} : { preparedJudge }),
      };

  const transmissions = (generationPreview?.transmissions ?? opts.prepared?.transmissions ?? []).filter((item) =>
    item.dokId !== undefined && toRegenerate.includes(item.dokId));
  const sourcePrepared = generationPreview?.preparedGeneration ?? opts.prepared?.preparedGeneration;
  const preparedGeneration = sourcePrepared === undefined
    ? undefined
    : Object.freeze({
        items: Object.freeze(
          sourcePrepared.items.filter((item) => toRegenerate.includes(item.dokId)),
        ),
      });
  if (opts.previewOnly || opts.authorizedJudgeRun !== undefined) {
    return {
      ...empty(),
      skippedHumanEdit,
      notInPlan,
      plannedRegeneration: toRegenerate,
      plannedReturnToDraft: approvedAmong(toRegenerate),
      transmissions,
      preparedGeneration,
      ...judgeFields,
    };
  }
  if (toRegenerate.length === 0) {
    return { ...empty(), skippedHumanEdit, notInPlan, ...judgeFields };
  }

  if (opts.authorizedRun === undefined || preparedGeneration === undefined) {
    throw new CommandContractError({
      schema_version: 1,
      command: 'llm',
      status: 'cancelled',
      data: null,
      diagnostics: [{
        code: 'LLM_CONSENT_REQUIRED',
        message: 'Paid sync requires an authorized run and immutable prepared payload.',
      }],
    }, 2);
  }

  // ── Regenerate the drifted Doks. force overwrites the on-disk files;
  //    runGenerate re-stamps source_anchors + logic_hash (and drops the
  //    edited_by_human marker, since the LLM produces a fresh Dok). ──
  // The judge's sentence for each Dok it said needs an update becomes that
  // Dok's staged proposal (`source: 'model'`); generate keeps the approved base
  // and a person's note over it, and proposes nothing for identical content.
  const judgeProposals = judgeOutcome === undefined ? {} : judgeProposalsOf(judgeOutcome.judged);
  const modelProposals = Object.fromEntries(
    Object.entries(judgeProposals).filter(([dokId]) => toRegenerate.includes(dokId)),
  );
  const result = await generateRunner(
    {
      root: paths.root,
      force: true,
      onlyDokIds: toRegenerate,
      noRoles: true,
      noLexicon: true,
      noIa: true,
      noCodeMapping: true,
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.proposalNote !== undefined ? { proposalNote: opts.proposalNote } : {}),
      ...(Object.keys(modelProposals).length > 0 ? { modelProposals } : {}),
      authorizedRun: opts.authorizedRun,
      preparedGeneration,
    },
    generateDeps,
  );

  // `results` holds only Doks actually written, so a Dok whose regeneration
  // failed keeps its approval and is not reported as returned.
  const regenerated = result.results.map((r) => r.dokId);
  return {
    ...(recordingSource ? { recordingSource: { branch: recordingSource.branch, commit: recordingSource.commit } } : {}),
    checked,
    stale,
    unknown,
    formatOnly,
    criticalReasons,
    regenerated,
    returnedToDraft: approvedAmong(regenerated),
    skippedHumanEdit,
    notInPlan,
    planOutdated: outdatedPlan.dokIds,
    planOutdatedAt: outdatedPlan.generatedAt,
    failures: result.failures,
    ...(result.tokenCapFailure === undefined ? {} : { tokenCapFailure: result.tokenCapFailure }),
    ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
    plannedRegeneration: toRegenerate,
    plannedReturnToDraft: approvedAmong(toRegenerate),
    transmissions,
    preparedGeneration,
    ...judgeFields,
    ...((result.unappliedModelProposals?.length ?? 0) > 0
      ? { regeneratedUnchanged: result.unappliedModelProposals }
      : {}),
  };
}

// ───────── judge targets and unconfirmed verdicts ────────────────────

/**
 * The Doks the judge may read, in regeneration order: stale because their
 * tracked code changed (`changed` — not a deleted file, not recovered
 * tracking) and not a `draft` (a draft already awaits review, so there is no
 * review time to save). Whether each carries the change facts is decided when
 * the judge is prepared (`noFacts`).
 */
function judgeTargets(
  regenTargets: readonly string[],
  staleById: ReadonlyMap<string, { entry: StaleDokEntry; dok: Dok }>,
  hub: HubModel,
  workspaceRoot: string,
): Array<{ dok: Dok; projectRoot: string; serviceId: string }> {
  const out: Array<{ dok: Dok; projectRoot: string; serviceId: string }> = [];
  for (const dokId of regenTargets) {
    const found = staleById.get(dokId);
    if (found === undefined || found.entry.reason !== 'changed' || found.dok.status === 'draft') continue;
    out.push({
      dok: found.dok,
      projectRoot: dokProjectRoot(found.dok, hub.workspace, workspaceRoot),
      serviceId: resolveAnchorServiceId(found.dok, hub.workspace) ?? 'workspace',
    });
  }
  return out;
}

/**
 * Stale (`changed`) Doks whose cached `accurate` verdict still holds for their
 * code, base and text: stale, judged accurate, unconfirmed. Read-only; no model.
 */
async function unconfirmedJudgeVerdicts(
  stale: readonly StaleDokEntry[],
  staleById: ReadonlyMap<string, { entry: StaleDokEntry; dok: Dok }>,
  hub: HubModel,
  workspaceRoot: string,
): Promise<SyncJudgedDok[]> {
  const out: SyncJudgedDok[] = [];
  for (const entry of stale) {
    if (entry.reason !== 'changed') continue;
    const dok = staleById.get(entry.dokId)?.dok;
    if (dok === undefined) continue;
    const record = await readCurrentJudgeVerdict(
      workspaceRoot,
      dok,
      dokProjectRoot(dok, hub.workspace, workspaceRoot),
    );
    if (record === null) continue;
    const summary = record.summary.trim();
    out.push({
      dokId: entry.dokId,
      verdict: 'accurate',
      cached: true,
      model: record.model,
      ...(summary.length > 0 ? { summary } : {}),
    });
  }
  return out;
}

// ───────── outdated-plan detection ──────────────────────────────────

/**
 * Stale Doks whose source changed *after* the consolidated plan was built.
 *
 * `sync` never re-runs scan/consolidate — consolidate is paid and consent-gated,
 * so chaining it here would duplicate the pipeline — and instead regenerates
 * from the plan already on disk. When a Dok's newest drift file is younger than
 * that plan's `generatedAt`, the plan predates the edit: regeneration runs
 * against an outdated feature structure and file list, and re-stamps
 * `_meta.logic_files` from that outdated reachable set, which can hide a
 * *future* drift (a newly imported file nobody tracks). Conversely, a user who
 * re-ran scan + consolidate after editing gets a newer `generatedAt` and no
 * warning — which is what makes the timestamp the precise discriminator.
 *
 * Deliberately conservative: anything undecidable (no resolvable service, no
 * cache, unparsable cache, no readable drift file) yields no warning. A false
 * alarm on a healthy pipeline costs more trust than a missed advisory.
 */
async function detectPlanOutdated(
  staleDoks: Dok[],
  workspace: Workspace,
  workspaceRoot: string,
  cacheDir: string,
): Promise<{ dokIds: string[]; generatedAt: Record<string, string> }> {
  const dokIds: string[] = [];
  const generatedAt: Record<string, string> = {};
  // One read per service no matter how many stale Doks share it. A cached
  // `null` records the decision "no usable timestamp", so it is not re-read.
  const planTimes = new Map<string, string | null>();

  for (const dok of staleDoks) {
    const serviceId = resolveAnchorServiceId(dok, workspace);
    if (serviceId === undefined) continue;

    let planTime = planTimes.get(serviceId);
    if (planTime === undefined) {
      planTime = await readPlanGeneratedAt(cacheDir, serviceId);
      planTimes.set(serviceId, planTime);
    }
    if (planTime === null) continue;
    const planMs = Date.parse(planTime);
    if (Number.isNaN(planMs)) continue;

    const newestEdit = await newestDriftFileMtime(dok, workspace, workspaceRoot);
    if (newestEdit === undefined) continue;

    if (newestEdit > planMs) {
      dokIds.push(dok.dok_id);
      generatedAt[dok.dok_id] = planTime;
    }
  }

  return { dokIds, generatedAt };
}

/**
 * The service whose consolidated cache holds this Dok's plan — the same chain
 * `dokProjectRoot` walks, but yielding the *id* (a cache file is per-service).
 * Undefined when nothing resolves: `dokProjectRoot`'s last-resort "." fallback
 * names no service, so there is no cache to compare against.
 */
function resolveAnchorServiceId(dok: Dok, workspace: Workspace): string | undefined {
  const svcId = dok._meta?.anchor_service_id ?? dok.surfaces?.[0];
  const svc =
    (svcId ? workspace.services.find((s) => s.service_id === svcId) : undefined)
    ?? (workspace.services.length === 1 ? workspace.services[0] : undefined);
  return svc?.service_id;
}

/**
 * When the service's consolidated plan was built, or null when that cannot be
 * established. Read as plain JSON rather than through
 * `ConsolidatedFeatureConfigSchema`: only one timestamp is consumed, and a
 * cache that fails full schema validation must not turn this advisory check
 * into a hard failure (generate reports that problem on its own path).
 */
async function readPlanGeneratedAt(
  cacheDir: string,
  serviceId: string,
): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await readFile(consolidatedCachePath(cacheDir, serviceId), 'utf-8'),
    ) as { generatedAt?: unknown };
    return typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null;
  } catch {
    return null;
  }
}

/**
 * Newest mtime across the exact file set drift hashes for this Dok
 * (`logic_files`, falling back to `source_anchors` for pre-B1 Doks), resolved
 * against the same project root drift judgment uses. Undefined when no file
 * could be stat'd — a deleted source dates nothing.
 */
async function newestDriftFileMtime(
  dok: Dok,
  workspace: Workspace,
  workspaceRoot: string,
): Promise<number | undefined> {
  const projectRoot = dokProjectRoot(dok, workspace, workspaceRoot);
  const files = (dok._meta?.logic_files ?? dok._meta?.source_anchors ?? [])
    .map((a) => a.file);
  let newest: number | undefined;
  for (const file of files) {
    try {
      const { mtimeMs } = await stat(join(projectRoot, file));
      if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
    } catch {
      // Unreadable/deleted source: it cannot date the edit. Skip it.
    }
  }
  return newest;
}

// ───────── commander wiring ─────────────────────────────────────────

export function registerSyncCommand(
  program: Command,
  ctx: CliContext,
  deps: Partial<SyncCommandDeps> = {},
): void {
  const executeSync = deps.runSync ?? runSync;
  const resolveSyncLlm = deps.resolveLlmForRole ?? resolveLlmForRole;
  const authorizeRun = deps.authorizeLlmRun ?? authorizeLlmRun;
  addLlmOptions(
    program
      .command('sync')
      .description('Regenerate Doks whose anchored source files drifted (use --check to preview)')
      .option('-r, --root <dir>', 'Workspace root', process.cwd())
      .option(
        '--check',
        'List stale Doks without regenerating; exits 1 when any are stale (CI-friendly)',
        false,
      )
      .option('--force', 'Also regenerate human-edited Doks (overwrites their edits)', false)
      .option('--dok <ID>', 'Limit to one Dok')
      .option('--note <text>', 'Stage a change proposal on every regenerated Dok (recorded to _meta.history when a person approves the draft)')
      .option(
        '--category <category>',
        'Keep a Changelog category for --note: added|changed|deprecated|removed|fixed|security',
      )
      .option(
        '--judge',
        'Before regenerating, ask an LLM judge (Sonnet 5, or GPT-6 Luna with an OpenAI API key or the ChatGPT (Codex) login; `doklo model --task judge`) whether each stale Dok still holds; Doks it judges accurate are not regenerated (two consents: the judge, then the regeneration)',
        false,
      )
      .option(
        '--judge-max <n>',
        'Judge at most n Doks; the rest regenerate without the judge',
        parseJudgeMax,
      )
      .option('-y, --yes', 'Approve the displayed immutable plan', false)
      .option('--json', 'Emit JSONL only', false),
  ).action(async (opts) => {
    const { default: chalk } = await import('chalk');
    const root = opts.root as string;
    const check = opts.check as boolean;
    const machine = opts.json === true;

    let proposalNote: ProposalNote | undefined;
    if (opts.note !== undefined) {
      const change = String(opts.note).trim();
      if (change.length === 0) throw new InvalidArgumentError('--note must not be empty');
      let category: DokHistoryCategory | undefined;
      if (opts.category !== undefined) {
        const parsedCategory = DokHistoryCategorySchema.safeParse(String(opts.category));
        if (!parsedCategory.success) {
          throw new InvalidArgumentError(
            '--category must be one of: added, changed, deprecated, removed, fixed, security',
          );
        }
        category = parsedCategory.data;
      }
      proposalNote = { change, ...(category !== undefined ? { category } : {}) };
    } else if (opts.category !== undefined) {
      throw new InvalidArgumentError('--category requires --note');
    }

    if (opts.judgeMax !== undefined && opts.judge !== true) {
      throw new InvalidArgumentError('--judge-max requires --judge');
    }
    const judge: SyncJudgeOptions | undefined = opts.judge === true
      ? { ...(opts.judgeMax !== undefined ? { max: opts.judgeMax as number } : {}) }
      : undefined;

    if (!check) {
      requireExplicitApproval({
        command: 'doklo sync',
        yes: opts.yes === true,
        isTTY: !machine && process.stdin.isTTY === true,
      });
    }

    const preview = await executeSync({
      root,
      check,
      ...(check ? {} : { previewOnly: true }),
      force: opts.force as boolean,
      dokId: opts.dok as string | undefined,
      ...(proposalNote !== undefined ? { proposalNote } : {}),
      ...(judge !== undefined ? { judge } : {}),
    });

    // ── Judge-gated sync, consent one of two: the judge plan. Every judge
    //    prompt was prepared by the preview; approving runs them, and the
    //    judge step returns the post-judge preview the regeneration plan below
    //    is built from. `--yes` approves both plans. ──
    let staged = preview;
    if (!check && judge !== undefined) {
      const judgeCalls = preview.preparedJudge?.calls.length ?? 0;
      if (judgeCalls > 0) {
        const judgeLlm = await resolveSyncLlm('judge', {
          profile: opts.profile as string | undefined,
          ...(opts.model !== undefined ? { followModel: opts.model as string } : {}),
        });
        const { paths } = await loadWorkspaceWithPaths(root);
        const judgePlan = buildLlmRunPlan({
          llm: {
            ...judgeLlm,
            authSource: judgeLlm.authSource ?? inferAuthSource(judgeLlm),
          },
          ...judgePlanInput(preview.preparedJudge!),
          debugDir: await resolveContainedOutputPath(
            paths.root,
            relative(paths.root, paths.debugDir),
          ),
        });
        if (!machine) {
          console.log('\n  ' + chalk.cyan(ctx.t('sync.judge_plan', { count: judgeCalls })));
        }
        emitLlmRunPlan(judgePlan, { machine, budget: await readLlmTokenBudget(root) });
        const authorizedJudgeRun = await authorizeRun(
          root,
          judgePlan,
          judgeLlm,
          {
            yes: opts.yes === true,
            isTTY: !machine && process.stdin.isTTY === true,
          },
        );
        staged = await executeSync({
          root,
          force: opts.force as boolean,
          dokId: opts.dok as string | undefined,
          ...(proposalNote !== undefined ? { proposalNote } : {}),
          judge,
          prepared: preview,
          authorizedJudgeRun,
        });
      }
      if (!machine) printJudgeOutcome(staged, ctx.t, chalk);
    }

    // ── The regeneration plan (consent two of two with --judge). ──
    const resolved = check || staged.plannedRegeneration.length === 0
      ? undefined
      : await resolveSyncLlm('generate', {
          model: opts.model as string | undefined,
          profile: opts.profile as string | undefined,
        });
    let result = withoutJudgeHandoff(staged);
    if (resolved !== undefined) {
      const { paths } = await loadWorkspaceWithPaths(root);
      const generateMax = staged.plannedRegeneration.length;
      const plan = buildLlmRunPlan({
        llm: {
          ...resolved,
          authSource: resolved.authSource ?? inferAuthSource(resolved),
        },
        candidateFiles: staged.transmissions,
        workItems: staged.plannedRegeneration.map((dokId) => {
          const serviceId = staged.transmissions.find((item) => item.dokId === dokId)?.serviceId
            ?? 'workspace';
          return { phase: 'generate' as const, serviceId, id: dokId };
        }),
        calls: { consolidate: 0, lexicon: 0, generateMax, judgeMax: 0 },
        preparedCalls: (staged.preparedGeneration?.items ?? []).map((item) => ({
          phase: 'generate' as const,
          workItem: {
            phase: 'generate' as const,
            serviceId: item.serviceId,
            id: item.dokId,
          },
          prompt: item.prompt,
          maxOutputTokens: 8_192,
        })),
        debugDir: await resolveContainedOutputPath(
          paths.root,
          relative(paths.root, paths.debugDir),
        ),
      });
      emitLlmRunPlan(plan, { machine, budget: await readLlmTokenBudget(root) });
      // Approving this plan takes every approved Dok in it back to draft, so
      // say how many before consent is asked for.
      if (!machine && staged.plannedReturnToDraft.length > 0) {
        console.log('  ' + chalk.yellow('⚠ ' + ctx.t('sync.approved_in_plan', {
          count: staged.plannedReturnToDraft.length,
        })));
      }
      const authorizedRun = await authorizeRun(
        root,
        plan,
        resolved,
        {
          yes: opts.yes === true,
          isTTY: !machine && process.stdin.isTTY === true,
        },
      );
      result = await executeSync({
        root,
        force: opts.force as boolean,
        dokId: opts.dok as string | undefined,
        ...(proposalNote !== undefined ? { proposalNote } : {}),
        authorizedRun,
        prepared: staged,
        // Live per-Dok progress during regeneration (slow LLM calls). Streams
        // during runSync; the summary below is printed afterwards.
        onProgress: machine
          ? undefined
          : (e) => {
            if (e.stage === 'plan') {
              console.log('\n  ' + chalk.cyan(ctx.t('sync.regenerating', { count: e.total })));
            } else if (e.stage === 'dok-start') {
              console.log(
                `  ${chalk.dim(`[${e.index}/${e.total}]`)} ${chalk.bold(e.dokId)} ${chalk.dim(`— ${e.featureLabel}`)}`,
              );
            } else if (e.stage === 'dok-done') {
              const elapsed = `${(e.elapsedMs / 1000).toFixed(1)}s`;
              if (e.success) {
                console.log(`         ${chalk.green('✓')} ${chalk.dim(elapsed)}`);
              } else {
                console.error(
                  `         ${chalk.red('✗')} ${chalk.dim(elapsed)} ${chalk.red((e.error ?? '').split('\n')[0]?.slice(0, 80) ?? '')}`,
                );
              }
            }
          },
      });
    }

    // Form-only changes are not drift; one line keeps them from passing silently.
    const formatOnlyCount = result.formatOnly?.length ?? 0;
    const printFormatOnly = (): void => {
      if (!machine && formatOnlyCount > 0) {
        console.log('  ' + chalk.dim(ctx.t('sync.format_only', { count: formatOnlyCount })));
      }
    };

    // ── Nothing drifted and nothing undecidable → clean bill of health. ──
    if (result.stale.length === 0 && result.unknown.length === 0) {
      if (!machine) {
        console.log('\n  ' + chalk.green(ctx.t('sync.all_fresh', { count: result.checked })));
      }
      printFormatOnly();
      recordSyncResult(program, result, 'success', check);
      return;
    }

    // ── --check preview: list the stale Doks, note undecidables, signal CI. ──
    if (check) {
      if (!machine && result.stale.length > 0) {
        console.log('\n  ' + chalk.cyan(ctx.t('sync.stale_header', { count: result.stale.length })));
        // Critical Doks are named individually with the axis that earned the
        // tier; everything else collapses to a count. Listing all of them
        // equally is what made drift output unreadable.
        const critical = result.stale.filter((entry) => entry.tier === 'critical');
        for (const entry of critical) {
          console.log('  ' + chalk.red(ctx.t('sync.stale_critical', {
            dokId: entry.dokId,
            reason: result.criticalReasons[entry.dokId] ?? 'critical',
          })));
        }
        const rest = result.stale.length - critical.length;
        if (rest > 0) {
          console.log('  ' + chalk.dim(ctx.t('sync.stale_rest', { count: rest })));
        }
      }
      printFormatOnly();
      if (!machine) {
        // A stale Dok the judge called accurate and nobody has confirmed yet.
        for (const entry of result.judged ?? []) {
          console.log('  ' + chalk.dim(ctx.t('sync.judged_accurate_unconfirmed', {
            dokId: entry.dokId,
            model: entry.model,
            summary: entry.summary ?? '—',
          })));
        }
        for (const dokId of result.planOutdated) {
          console.log('  ' + chalk.yellow('⚠ ' + ctx.t('sync.plan_outdated', { dokId })));
        }
      }
      recordSyncResult(
        program,
        result,
        result.stale.length > 0 ? 'partial' : 'success',
        true,
      );
      return;
    }

    // ── Regeneration summary (progress already streamed above). ──
    if (!machine) {
      console.log('\n  ' + chalk.green(ctx.t('sync.done', { count: result.regenerated.length })));
      printFormatOnly();
      if (result.returnedToDraft.length > 0) {
        console.log('  ' + chalk.yellow('⚠ ' + ctx.t('sync.returned_to_draft', {
          count: result.returnedToDraft.length,
        })));
      }
      if (proposalNote !== undefined && result.regenerated.length === 0) {
        console.log('  ' + chalk.yellow('⚠ --note was not applied (no Dok regenerated)'));
      }
      for (const dokId of result.planOutdated) {
        console.log('  ' + chalk.yellow('⚠ ' + ctx.t('sync.plan_outdated', { dokId })));
      }
    }
    const incomplete =
      result.skippedHumanEdit.length > 0
      || result.notInPlan.length > 0
      || result.failures.length > 0
      // Kept by the judge: still stale until a person confirms it.
      || (result.judged ?? []).some((entry) => entry.verdict === 'accurate');
    recordSyncResult(program, result, result.tokenCapFailure ? 'cancelled' : incomplete ? 'partial' : 'success', false);
  });
}

/** Commander parser for `--judge-max`: a non-negative integer. */
function parseJudgeMax(value: string): number {
  if (!/^[0-9]+$/u.test(value.trim())) {
    throw new InvalidArgumentError('--judge-max must be a non-negative integer');
  }
  const max = Number(value.trim());
  if (!Number.isSafeInteger(max)) throw new InvalidArgumentError('--judge-max must be a non-negative integer');
  return max;
}

/** The judge preview's frozen calls are a hand-off between steps, not part of a reported result. */
function withoutJudgeHandoff(result: RunSyncResult): RunSyncResult {
  if (result.preparedJudge === undefined) return result;
  const { preparedJudge: _handoff, ...rest } = result;
  return rest;
}

const JUDGE_REASON_KEY: Record<NonNullable<SyncJudgedDok['reason']>, string> = {
  call_failed: 'sync.judge_reason_failed',
  unparseable: 'sync.judge_reason_unparseable',
  evidence_outside_sent: 'sync.judge_reason_evidence',
  accurate_with_findings: 'sync.judge_reason_findings',
  accurate_without_evidence: 'sync.judge_reason_no_evidence',
  token_cap: 'sync.judge_reason_token_cap',
};

/** One human line for one verdict (`--judge`). */
export function formatJudgeVerdict(entry: SyncJudgedDok, t: I18nT): string {
  const reason = entry.reason === undefined ? undefined : t(JUDGE_REASON_KEY[entry.reason]);
  const said = entry.summary ?? '—';
  if (entry.verdict === 'accurate') {
    return t(entry.cached ? 'sync.judge_accurate_cached' : 'sync.judge_accurate', {
      dokId: entry.dokId,
      model: entry.model,
      summary: said,
    });
  }
  if (entry.verdict === 'needs_update') {
    return t('sync.judge_needs_update', { dokId: entry.dokId, model: entry.model, summary: reason ?? said });
  }
  return t('sync.judge_uncertain', { dokId: entry.dokId, model: entry.model, reason: reason ?? said });
}

/** The judge's verdict lines, their count, and the Doks it did not read. */
function printJudgeOutcome(
  result: RunSyncResult,
  t: I18nT,
  chalk: typeof import('chalk').default,
): void {
  const judged = result.judged ?? [];
  if (judged.length > 0) console.log();
  for (const entry of judged) {
    const line = '  ' + formatJudgeVerdict(entry, t);
    console.log(entry.verdict === 'accurate'
      ? chalk.green(line)
      : entry.verdict === 'needs_update' ? chalk.yellow(line) : chalk.dim(line));
  }
  if (judged.length > 0) {
    console.log('  ' + t('sync.judge_summary', {
      accurate: judged.filter((entry) => entry.verdict === 'accurate').length,
      needsUpdate: judged.filter((entry) => entry.verdict === 'needs_update').length,
      uncertain: judged.filter((entry) => entry.verdict === 'uncertain').length,
      cached: judged.filter((entry) => entry.cached).length,
    }));
  }
  const skipped = result.judgeSkipped;
  if (skipped === undefined) return;
  if (skipped.noFacts.length > 0) {
    console.log('  ' + chalk.dim(t('sync.judge_no_facts', { count: skipped.noFacts.length })));
  }
  if (skipped.overMax.length > 0) {
    console.log('  ' + chalk.dim(t('sync.judge_over_max', { count: skipped.overMax.length })));
  }
  if (skipped.overBudget.length > 0) {
    console.log('  ' + chalk.dim(t('sync.judge_over_budget', {
      count: skipped.overBudget.length,
      limit: JUDGE_INPUT_BUDGET_CHARS.toLocaleString('en-US'),
    })));
  }
  if (skipped.noDiff.length > 0) {
    console.log('  ' + chalk.dim(t('sync.judge_no_diff', { count: skipped.noDiff.length })));
  }
}

function inferAuthSource(resolved: {
  providerKind: ProviderKind;
  apiKey?: string;
  fetch?: typeof fetch;
}): LlmAuthSource {
  if (resolved.providerKind === 'claude-code') return 'claude-code';
  if (resolved.fetch !== undefined) return 'oauth';
  return resolved.apiKey !== undefined ? 'keychain' : 'environment';
}

function recordSyncResult(
  owner: object,
  result: RunSyncResult,
  status: CommandStatus,
  check: boolean,
): void {
  recordCommandResult(owner, {
    schema_version: 1,
    command: 'sync',
    status,
    data: result,
    diagnostics: buildSyncDiagnostics(result, check),
  });
}

const TIER_SEVERITY: Record<PriorityTier, CommandDiagnostic['severity']> = {
  critical: 'high',
  standard: 'normal',
  peripheral: 'low',
};

export function buildSyncDiagnostics(
  result: RunSyncResult,
  check: boolean,
): CommandDiagnostic[] {
  const diagnostics: CommandDiagnostic[] = [];

  if (result.tokenCapFailure) {
    diagnostics.push({ ...result.tokenCapFailure, preserved: result.regenerated });
  }

  // Verdicts of `accurate` nobody has confirmed: the Dok stays stale until a
  // person confirms it in the web app ("Still accurate") or it is regenerated.
  const judgedAccurate = new Map(
    (result.judged ?? [])
      .filter((entry) => entry.verdict === 'accurate')
      .map((entry) => [entry.dokId, entry]),
  );

  if (check) {
    for (const stale of result.stale) {
      const judged = judgedAccurate.get(stale.dokId);
      diagnostics.push({
        code: 'SYNC_STALE_DOK',
        severity: TIER_SEVERITY[stale.tier],
        message:
          `${stale.dokId} is stale (${stale.reason})`
          + (stale.humanEdited ? ' and contains human edits' : '')
          + (judged === undefined ? '.' : `; judged accurate by ${judged.model}, awaiting a person's confirmation.`),
        ...(stale.humanEdited ? { preserved: [stale.dokId] } : {}),
        nextCommand: judged !== undefined
          ? 'doklo serve'
          : stale.humanEdited
            ? 'doklo sync --force --yes'
            : 'doklo sync --yes',
      });
    }
  } else {
    for (const [dokId, judged] of judgedAccurate) {
      diagnostics.push({
        code: 'SYNC_KEPT_BY_JUDGE',
        message:
          `${dokId} was judged accurate by ${judged.model}${judged.cached ? ' (verdict reused)' : ''} and not regenerated; `
          + 'it stays stale until a person confirms it in the web app.',
        preserved: [dokId],
        nextCommand: 'doklo serve',
      });
    }
    const skipped = result.judgeSkipped;
    const skippedLists: Array<[string[] | undefined, string]> = [
      [skipped?.noFacts, 'no change facts recorded yet'],
      [skipped?.overMax, 'over --judge-max'],
      [skipped?.overBudget, 'the Dok and its changes exceed the judge input budget'],
      [skipped?.noDiff, 'no readable change to show the judge'],
    ];
    for (const [dokIds, why] of skippedLists) {
      if (dokIds === undefined || dokIds.length === 0) continue;
      diagnostics.push({
        code: 'SYNC_JUDGE_SKIPPED',
        severity: 'low',
        message: `Regenerated without the judge (${why}): ${dokIds.join(', ')}`,
      });
    }
    for (const dokId of result.regeneratedUnchanged ?? []) {
      diagnostics.push({
        code: 'SYNC_JUDGE_UNCHANGED_REGENERATION',
        message:
          `${dokId}: the judge said it needs an update, but its regeneration came out unchanged; `
          + 'edit it in the web app.',
        preserved: [dokId],
        nextCommand: 'doklo serve',
      });
    }
  }

  // Reported on every path, --check or not: the warning is about the plan a
  // regeneration *would* use, which is equally true when previewing.
  for (const dokId of result.planOutdated) {
    diagnostics.push({
      code: 'SYNC_PLAN_OUTDATED',
      message:
        `${dokId} changed after the consolidated plan was built `
        + `(${result.planOutdatedAt[dokId] ?? 'unknown'}); regeneration will use `
        + 'the outdated plan and may mistrack new dependencies.',
      preserved: [dokId],
      nextCommand: 'doklo scan && doklo consolidate --yes',
    });
  }

  if (result.unknown.length > 0) {
    diagnostics.push({
      code: 'SYNC_DRIFT_UNKNOWN',
      message:
        `Drift is unknown for ${result.unknown.length} Dok(s) without a logic hash or verified source tracking: `
        + result.unknown.join(', '),
      preserved: result.unknown,
      nextCommand: 'doklo generate --force --yes',
    });
  }

  for (const dokId of result.skippedHumanEdit) {
    diagnostics.push({
      code: 'SYNC_HUMAN_EDIT_PRESERVED',
      message: `${dokId} was not regenerated because it contains human edits.`,
      preserved: [dokId],
      nextCommand: 'doklo sync --force --yes',
    });
  }

  for (const dokId of result.notInPlan) {
    diagnostics.push({
      code: 'SYNC_DOK_NOT_IN_PLAN',
      message: `${dokId} is stale but absent from the current consolidated plan.`,
      preserved: [dokId],
      nextCommand: 'doklo scan && doklo consolidate --yes',
    });
  }

  for (const failure of result.failures) {
    diagnostics.push({
      code: 'SYNC_REGENERATION_FAILED',
      message: `${failure.dokId} regeneration failed: ${failure.reason}`,
      serviceId: failure.serviceId,
      nextCommand: `doklo sync --dok ${failure.dokId} --yes`,
    });
  }

  return diagnostics;
}
