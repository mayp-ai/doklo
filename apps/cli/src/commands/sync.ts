import { readLlmTokenBudget } from '../lib/llm-cost-cap.js';
// `doklo sync` — drift-driven Dok regeneration.
//
// Loads the Hub, judges every Dok (or one, via --dok) against the current
// source with @doklo-beta/core.isDokStale, and regenerates the drifted ones
// through runGenerate (force + onlyDokIds). Human-edited Doks are protected
// unless --force; --check previews without regenerating (and exits 1 when any
// Dok is stale, for CI). runGenerate re-stamps _meta.logic_hash on each
// regenerated Dok, so a synced Dok returns to fresh on the next judgment.
//
// Regeneration reuses the consolidated plan already on disk (consolidate is
// paid + consent-gated, so sync never chains it). When that plan predates the
// edit that made a Dok stale, sync says so — see detectPlanOutdated — without
// blocking the regeneration.

import { assertRecordingSource } from '../lib/recording-branch.js';
import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import {
  derivePriorityTier,
  isDokStale,
  dokProjectRoot,
  loadHubModel,
  type Dok,
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
}

export type RunSyncDeps = Partial<GenerateDeps> & {
  /** Injection seam for asserting preview/actual regeneration options. */
  runGenerate?: typeof runGenerate;
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
  /** Doks actually regenerated (always empty in --check mode). */
  regenerated: string[];
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
  transmissions: LlmCandidateFile[];
  preparedGeneration?: PreparedGenerationPayload;
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
  const { runGenerate: generateRunner = runGenerate, ...generateDeps } = deps;
  if (opts.check === true && opts.proposalNote !== undefined) {
    throw new SyncNoteRequiresRegenerationError();
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
      stale.push({
        dokId: dok.dok_id,
        reason,
        humanEdited: dok._meta?.edited_by_human === true,
        tier: derivePriorityTier(dok.priority),
      });
      const reasonWord = criticalDriftReason(dok);
      if (reasonWord !== null) criticalReasons[dok.dok_id] = reasonWord;
      staleDoks.push(dok);
    } else if (result.reason === 'no-hash' || result.reason === 'unverified-tracking') {
      unknown.push(dok.dok_id);
    }
    // else: fresh — nothing to do.
  }
  const checked = targets.length;

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
    regenerated: [],
    skippedHumanEdit: [],
    notInPlan: [],
    planOutdated: outdatedPlan.dokIds,
    planOutdatedAt: outdatedPlan.generatedAt,
    criticalReasons,
    failures: [],
    plannedRegeneration: [],
    transmissions: [],
  });

  // ── --check: report only, no regeneration, no LLM. ──
  if (opts.check) return empty();

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

  const transmissions = (generationPreview?.transmissions ?? opts.prepared?.transmissions ?? []).filter((item) =>
    item.dokId !== undefined && regenTargets.includes(item.dokId));
  const sourcePrepared = generationPreview?.preparedGeneration ?? opts.prepared?.preparedGeneration;
  const preparedGeneration = sourcePrepared === undefined
    ? undefined
    : Object.freeze({
        items: Object.freeze(
          sourcePrepared.items.filter((item) => regenTargets.includes(item.dokId)),
        ),
      });
  if (opts.previewOnly) {
    return {
      ...empty(),
      skippedHumanEdit,
      notInPlan,
      plannedRegeneration: regenTargets,
      transmissions,
      preparedGeneration,
    };
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
  const result = await generateRunner(
    {
      root: paths.root,
      force: true,
      onlyDokIds: regenTargets,
      noRoles: true,
      noLexicon: true,
      noIa: true,
      noCodeMapping: true,
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.proposalNote !== undefined ? { proposalNote: opts.proposalNote } : {}),
      authorizedRun: opts.authorizedRun,
      preparedGeneration,
    },
    generateDeps,
  );

  return {
    ...(recordingSource ? { recordingSource: { branch: recordingSource.branch, commit: recordingSource.commit } } : {}),
    checked,
    stale,
    unknown,
    criticalReasons,
    regenerated: result.results.map((r) => r.dokId),
    skippedHumanEdit,
    notInPlan,
    planOutdated: outdatedPlan.dokIds,
    planOutdatedAt: outdatedPlan.generatedAt,
    failures: result.failures,
    ...(result.tokenCapFailure === undefined ? {} : { tokenCapFailure: result.tokenCapFailure }),
    ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
    plannedRegeneration: regenTargets,
    transmissions,
    preparedGeneration,
  };
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
    });

    const resolved = check || preview.plannedRegeneration.length === 0
      ? undefined
      : await resolveSyncLlm('generate', {
          model: opts.model as string | undefined,
          profile: opts.profile as string | undefined,
        });
    let result = preview;
    if (resolved !== undefined) {
      const { paths } = await loadWorkspaceWithPaths(root);
      const generateMax = preview.plannedRegeneration.length;
      const plan = buildLlmRunPlan({
        llm: {
          ...resolved,
          authSource: resolved.authSource ?? inferAuthSource(resolved),
        },
        candidateFiles: preview.transmissions,
        workItems: preview.plannedRegeneration.map((dokId) => {
          const serviceId = preview.transmissions.find((item) => item.dokId === dokId)?.serviceId
            ?? 'workspace';
          return { phase: 'generate' as const, serviceId, id: dokId };
        }),
        calls: { consolidate: 0, lexicon: 0, generateMax, judgeMax: 0 },
        preparedCalls: (preview.preparedGeneration?.items ?? []).map((item) => ({
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
        prepared: preview,
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

    // ── Nothing drifted and nothing undecidable → clean bill of health. ──
    if (result.stale.length === 0 && result.unknown.length === 0) {
      if (!machine) {
        console.log('\n  ' + chalk.green(ctx.t('sync.all_fresh', { count: result.checked })));
      }
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
      if (!machine) {
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
      || result.failures.length > 0;
    recordSyncResult(program, result, result.tokenCapFailure ? 'cancelled' : incomplete ? 'partial' : 'success', false);
  });
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

  if (check) {
    for (const stale of result.stale) {
      diagnostics.push({
        code: 'SYNC_STALE_DOK',
        severity: TIER_SEVERITY[stale.tier],
        message:
          `${stale.dokId} is stale (${stale.reason})`
          + (stale.humanEdited ? ' and contains human edits.' : '.'),
        ...(stale.humanEdited ? { preserved: [stale.dokId] } : {}),
        nextCommand: stale.humanEdited
          ? 'doklo sync --force --yes'
          : 'doklo sync --yes',
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
