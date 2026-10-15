// The sync judge (judge-gated sync design §4.3–§4.8): which stale Doks it
// reads, how each call is made, and what its answer decides.
//
// Calls go through the CLI's own machinery, exactly like generation: the
// route resolved for the `judge` role (Sonnet 5 on the direct Anthropic route,
// or GPT-6 Luna on an OpenAI API key or the exact OpenAI Codex OAuth route),
// `callModel` from the generator (debug records under `.doklo/debug`), and the
// runtime-trust layer —
// every prompt prepared before consent, each call admitted by
// `beginAuthorizedLlmCall` against the approved plan and reconciled into the
// workspace token ledger (`llm-cost-cap.ts`). The benchmark harness's
// transports (benchmarks/judge-sync/src/judge-call.ts, luna-call.ts) used the
// same routes from outside the CLI; here they are the CLI's own.
import {
  callModel,
  type LLMUsage,
  type ProviderKind,
} from '@doklo-beta/generator';
import { readAnchorContentsSync, type Dok, type TranslateContext } from '@doklo-beta/core';
import { CommandContractError } from '../command-result.js';
import {
  beginAuthorizedLlmCall,
  completeAuthorizedLlmCall,
  getAuthorizedJudgeRunModel,
  type AuthorizedLlmRun,
  type LlmCandidateFile,
  type LlmPreparedCall,
  type LlmWorkItem,
} from '../llm-preflight.js';
import {
  judgeCacheMatches,
  readJudgeCache,
  removeJudgeCache,
  writeJudgeCache,
} from './cache.js';
import { parseSyncJudgeResponse, type SyncJudgeVerdict } from './parse.js';
import { applyPostRules, type EffectiveVerdict } from './post-rules.js';
import { SYNC_JUDGE_PROMPT_DIGEST } from './prompt.js';
import {
  buildJudgeRequest,
  gitJudgeSeams,
  hasJudgeFacts,
  type BuiltJudgeRequest,
  type JudgeRequestSeams,
  type JudgeTransmission,
} from './request.js';

/** Output cap per judge call (enforced where the route sends it; the Codex route drops it). */
export const JUDGE_MAX_OUTPUT_TOKENS = 8_192;
export const JUDGE_TIMEOUT_MS = 300_000;

// ───────── one call ──────────────────────────────────────────────────

export interface JudgeDokRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Debug-record label, e.g. `judge-AUTH`. */
  label: string;
}

/** The authorized route for one call, plus its limits and debug directory. */
export interface JudgeDokOptions {
  providerKind: ProviderKind;
  model: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  maxTokens: number;
  timeout: number;
  debugDir: string;
}

export interface JudgeDokResult {
  success: boolean;
  content: string | null;
  usage: LLMUsage | null;
  /** A short failure description; never a credential or provider body. */
  error: string | null;
  finishReason?: string;
}

/** One judge call. Injected in tests the way `GenerateDeps` injects the generator. */
export type JudgeDokFn = (request: JudgeDokRequest, options: JudgeDokOptions) => Promise<JudgeDokResult>;

/** The production judge call: the generator's `callModel` on the authorized route. */
export const judgeDok: JudgeDokFn = async (request, options) => {
  const result = await callModel(
    { systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, label: request.label },
    {
      providerKind: options.providerKind,
      model: options.model,
      maxTokens: options.maxTokens,
      timeout: options.timeout,
      debugDir: options.debugDir,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    },
  );
  return {
    success: result.success,
    content: result.content,
    usage: result.usage,
    error: result.error ? `${result.error.type}: ${result.error.message.slice(0, 300)}` : null,
    ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
  };
};

// ───────── verdicts, as sync reports them ────────────────────────────

/**
 * Why a verdict is not the judge's own word:
 *  - `call_failed`               — the call failed or returned nothing (R0);
 *  - `unparseable`               — the answer was not the contract's shape (R1);
 *  - `evidence_outside_sent`     — it cited a file it was not sent (R2);
 *  - `accurate_with_findings`    — "accurate" with a wrong claim or omission, read as needs_update (R3);
 *  - `accurate_without_evidence` — "accurate" without one evidenced check (R4);
 *  - `token_cap`                 — not asked: a token cap stopped the judge run.
 */
export type SyncJudgeReason =
  | 'call_failed'
  | 'unparseable'
  | 'evidence_outside_sent'
  | 'accurate_with_findings'
  | 'accurate_without_evidence'
  | 'token_cap';

/** One Dok's verdict in a sync result. */
export interface SyncJudgedDok {
  dokId: string;
  /** After the post-rules: only `accurate` keeps the Dok from regeneration. */
  verdict: SyncJudgeVerdict;
  /** True when the verdict was reused from `.doklo/cache/judge/` instead of a call. */
  cached: boolean;
  /** The model that gave the verdict. */
  model: string;
  /** The judge's one sentence, in the Dok's language: what the Dok must now say, or why it holds. */
  summary?: string;
  /** Set when the verdict is not the judge's own answer (see `SyncJudgeReason`). */
  reason?: SyncJudgeReason;
}

/** Stale Doks the judge did not read; each is regenerated as without `--judge`. */
export interface SyncJudgeSkipped {
  /** No `source_commit` or a logic file without its `sha256` (generated before judge-gated sync). */
  noFacts: string[];
  /** Beyond `--judge-max`. */
  overMax: string[];
  /** The Dok and its changes alone exceed the judge's input budget. */
  overBudget: string[];
  /** No change to show: every changed file changed in form only or is withheld, or a file is unreadable. */
  noDiff: string[];
}

export function emptyJudgeSkipped(): SyncJudgeSkipped {
  return { noFacts: [], overMax: [], overBudget: [], noDiff: [] };
}

const RULE_REASON: Record<string, SyncJudgeReason> = {
  R0_FAILURE: 'call_failed',
  R1_SHAPE: 'unparseable',
  R2_EVIDENCE_OUTSIDE_SENT: 'evidence_outside_sent',
  R3_ACCURATE_WITH_FINDINGS: 'accurate_with_findings',
  R4_ACCURATE_WITHOUT_EVIDENCE: 'accurate_without_evidence',
};

export function judgedDokOf(dokId: string, model: string, verdict: EffectiveVerdict): SyncJudgedDok {
  const rule = verdict.rules_applied[0];
  const reason = rule === undefined ? undefined : RULE_REASON[rule];
  const summary = verdict.summary.trim();
  return {
    dokId,
    verdict: verdict.effective_verdict,
    cached: false,
    model,
    ...(summary.length > 0 ? { summary } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * The judge's sentences that become staged proposals (`source: 'model'`,
 * design §4.5): only a `needs_update` the judge itself gave, with a summary.
 * A verdict the post-rules turned into needs_update (R3) carries a sentence
 * about why the Dok *holds*, so it proposes nothing; the deterministic
 * comparison stands in, as it does for every other regeneration.
 */
export function judgeProposalsOf(judged: readonly SyncJudgedDok[]): Record<string, string> {
  const proposals: Record<string, string> = {};
  for (const entry of judged) {
    if (entry.verdict === 'needs_update' && !entry.cached && entry.reason === undefined && entry.summary) {
      proposals[entry.dokId] = entry.summary;
    }
  }
  return proposals;
}

// ───────── preparation (before consent) ──────────────────────────────

/** One judge call, prepared and frozen before consent. */
export interface PreparedJudgeCall {
  readonly dokId: string;
  /** The work item's service (the Dok's anchor service, or `workspace`). */
  readonly serviceId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** `joinPromptParts(...)` — the exact text consent digests. */
  readonly prompt: string;
  readonly requestDigest: string;
  readonly transmissions: readonly JudgeTransmission[];
  /** The evidence whitelist (post-rule R2). */
  readonly sentFiles: readonly string[];
  /** Changed files shown (mechanical scope). */
  readonly changedFiles: readonly string[];
  /** Cache key facts. */
  readonly logicHash: string;
  readonly sourceCommit: string;
  readonly dokSha256: string;
}

export interface PreparedJudgePayload {
  readonly calls: readonly PreparedJudgeCall[];
}

export interface JudgeTarget {
  dok: Dok;
  /** `dokProjectRoot(dok, workspace, root)`. */
  projectRoot: string;
  serviceId: string;
}

export interface SyncJudgePreparation {
  /** Verdicts reused from the cache (always `accurate`, `cached: true`). */
  judged: SyncJudgedDok[];
  judgeSkipped: SyncJudgeSkipped;
  payload: PreparedJudgePayload;
}

export interface PrepareSyncJudgeDeps {
  seamsFor?: (projectRoot: string) => JudgeRequestSeams;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function preparedCallOf(built: BuiltJudgeRequest, target: JudgeTarget): PreparedJudgeCall {
  return {
    dokId: built.dokId,
    serviceId: target.serviceId,
    systemPrompt: built.systemPrompt,
    userPrompt: built.userPrompt,
    prompt: built.prompt,
    requestDigest: built.requestDigest,
    transmissions: built.transmissions,
    sentFiles: built.sentFiles,
    changedFiles: built.changedFiles,
    logicHash: built.logicHash,
    sourceCommit: target.dok._meta.source_commit!,
    dokSha256: built.dokSha256,
  };
}

/**
 * Prepare the judge for these targets, in order, without spending anything:
 * Doks without the change facts are listed (`noFacts`); a Dok whose cached
 * `accurate` verdict still holds for the exact request reuses it; the rest get
 * a request built — or are listed when it cannot be sent (`overBudget`,
 * `noDiff`) — and the first `max` of them become the calls to consent to
 * (`overMax` for the rest). A reused verdict costs nothing and does not count
 * toward `max`.
 */
export async function prepareSyncJudge(
  input: {
    root: string;
    targets: readonly JudgeTarget[];
    translate: TranslateContext;
    locale: string;
    max?: number;
    budgetChars?: number;
  },
  deps: PrepareSyncJudgeDeps = {},
): Promise<SyncJudgePreparation> {
  const seamsFor = deps.seamsFor ?? gitJudgeSeams;
  const judged: SyncJudgedDok[] = [];
  const judgeSkipped = emptyJudgeSkipped();
  const ready: PreparedJudgeCall[] = [];
  for (const target of input.targets) {
    const { dok, projectRoot } = target;
    if (!hasJudgeFacts(dok)) {
      judgeSkipped.noFacts.push(dok.dok_id);
      continue;
    }
    const files = (dok._meta.logic_files ?? []).map((entry) => entry.file);
    const read = readAnchorContentsSync(files, projectRoot);
    const built = await buildJudgeRequest(
      {
        dok,
        read,
        translate: input.translate,
        locale: input.locale,
        ...(input.budgetChars !== undefined ? { budgetChars: input.budgetChars } : {}),
      },
      seamsFor(projectRoot),
    );
    if (built.status === 'skip') {
      if (built.skipReason === 'over_budget') judgeSkipped.overBudget.push(dok.dok_id);
      else if (built.skipReason === 'no_facts') judgeSkipped.noFacts.push(dok.dok_id);
      else judgeSkipped.noDiff.push(dok.dok_id);
      continue;
    }
    const call = preparedCallOf(built, target);
    const record = await readJudgeCache(input.root, dok.dok_id);
    if (
      record !== null
      && record.prompt_digest === SYNC_JUDGE_PROMPT_DIGEST
      && record.request_digest === call.requestDigest
      && judgeCacheMatches(record, {
        dokId: dok.dok_id,
        logicHash: call.logicHash,
        sourceCommit: call.sourceCommit,
        dokSha256: call.dokSha256,
      })
    ) {
      judged.push({
        dokId: dok.dok_id,
        verdict: 'accurate',
        cached: true,
        model: record.model,
        ...(record.summary.trim().length > 0 ? { summary: record.summary.trim() } : {}),
      });
      continue;
    }
    ready.push(call);
  }
  const max = input.max ?? ready.length;
  judgeSkipped.overMax.push(...ready.slice(max).map((call) => call.dokId));
  return {
    judged,
    judgeSkipped,
    payload: deepFreeze({ calls: ready.slice(0, max) }),
  };
}

/** The judge plan's inputs for `buildLlmRunPlan` (phase `judge`, one work item per Dok). */
export function judgePlanInput(payload: PreparedJudgePayload): {
  candidateFiles: LlmCandidateFile[];
  workItems: LlmWorkItem[];
  calls: { consolidate: 0; lexicon: 0; generateMax: 0; judgeMax: number };
  preparedCalls: LlmPreparedCall[];
} {
  const workItem = (call: PreparedJudgeCall): LlmWorkItem => ({ phase: 'judge', serviceId: call.serviceId, id: call.dokId });
  return {
    candidateFiles: payload.calls.flatMap((call) => call.transmissions.map((sent) => ({
      phase: 'judge' as const,
      serviceId: call.serviceId,
      file: sent.file,
      maxChars: sent.chars,
      dokId: call.dokId,
    }))),
    workItems: payload.calls.map(workItem),
    calls: { consolidate: 0, lexicon: 0, generateMax: 0, judgeMax: payload.calls.length },
    preparedCalls: payload.calls.map((call) => ({
      phase: 'judge' as const,
      workItem: workItem(call),
      prompt: call.prompt,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    })),
  };
}

// ───────── the authorized judge run ──────────────────────────────────

export interface JudgeRunResult {
  judged: SyncJudgedDok[];
  tokenCapFailure?: { code: 'LLM_RUN_TOKEN_CAP' | 'LLM_TOTAL_TOKEN_CAP'; message: string };
}

/**
 * Run the approved judge calls in order. Each call is admitted by the
 * authorized run (exact prompt, exact transmissions, its token reservation),
 * sent through `judgeDok`, reconciled into the token ledger, then parsed and
 * put through the post-rules. An `accurate` verdict is cached; any other
 * verdict drops the Dok's stale cache entry. A token cap stops the remaining
 * calls (their Doks are regenerated, reason `token_cap`); the call that
 * reached it keeps its answer. Cache writes are best-effort: a verdict this
 * run already reported is never lost to a cache failure.
 */
export async function runJudgeCalls(
  input: {
    root: string;
    authorizedRun: AuthorizedLlmRun;
    payload: PreparedJudgePayload;
    debugDir: string;
    onVerdict?: (verdict: SyncJudgedDok) => void;
  },
  deps: { judgeDok?: JudgeDokFn } = {},
): Promise<JudgeRunResult> {
  const call = deps.judgeDok ?? judgeDok;
  const model = await getAuthorizedJudgeRunModel(input.authorizedRun, input.root);
  const judged: SyncJudgedDok[] = [];
  let tokenCapFailure: JudgeRunResult['tokenCapFailure'];
  const retainTokenCapFailure = (error: unknown): boolean => {
    if (!(error instanceof CommandContractError)) return false;
    const diagnostic = error.result.diagnostics.find((item) =>
      item.code === 'LLM_RUN_TOKEN_CAP' || item.code === 'LLM_TOTAL_TOKEN_CAP');
    if (!diagnostic) return false;
    tokenCapFailure ??= {
      code: diagnostic.code as 'LLM_RUN_TOKEN_CAP' | 'LLM_TOTAL_TOKEN_CAP',
      message: diagnostic.message,
    };
    return true;
  };
  const record = (entry: SyncJudgedDok): void => {
    judged.push(entry);
    input.onVerdict?.(entry);
  };

  for (const prepared of input.payload.calls) {
    if (tokenCapFailure) {
      record({ dokId: prepared.dokId, verdict: 'uncertain', cached: false, model, reason: 'token_cap' });
      continue;
    }
    let authorized: Awaited<ReturnType<typeof beginAuthorizedLlmCall>>;
    try {
      authorized = await beginAuthorizedLlmCall(input.authorizedRun, input.root, {
        phase: 'judge',
        workItem: { phase: 'judge', serviceId: prepared.serviceId, id: prepared.dokId },
        debugDir: input.debugDir,
        prompt: prepared.prompt,
        transmissions: prepared.transmissions.map((sent) => ({
          phase: 'judge' as const,
          serviceId: prepared.serviceId,
          file: sent.file,
          actualChars: sent.chars,
        })),
      });
    } catch (error) {
      if (!retainTokenCapFailure(error)) throw error;
      record({ dokId: prepared.dokId, verdict: 'uncertain', cached: false, model, reason: 'token_cap' });
      continue;
    }

    let result: JudgeDokResult;
    try {
      result = await call(
        { systemPrompt: prepared.systemPrompt, userPrompt: prepared.userPrompt, label: `judge-${prepared.dokId}` },
        {
          providerKind: authorized.providerKind,
          model: authorized.model,
          ...(authorized.apiKey !== undefined ? { apiKey: authorized.apiKey } : {}),
          ...(authorized.baseURL !== undefined ? { baseURL: authorized.baseURL } : {}),
          ...(authorized.fetch !== undefined ? { fetch: authorized.fetch } : {}),
          maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
          timeout: JUDGE_TIMEOUT_MS,
          debugDir: input.debugDir,
        },
      );
    } catch (error) {
      result = {
        success: false,
        content: null,
        usage: null,
        error: `threw: ${error instanceof Error ? error.name : 'unknown'}`,
      };
    }
    try {
      await completeAuthorizedLlmCall(input.authorizedRun, input.root, authorized, result.usage);
    } catch (error) {
      // Reconciliation records measured usage before reporting a cap breach;
      // this call's answer stands, and the run stops after it.
      if (!retainTokenCapFailure(error)) throw error;
    }

    const verdict = applyPostRules({
      outcome: result.success && result.content !== null ? parseSyncJudgeResponse(result.content) : null,
      failure: result.success ? null : (result.error ?? 'call failed'),
      sentFiles: prepared.sentFiles,
      changedFiles: prepared.changedFiles,
    });
    const entry = judgedDokOf(prepared.dokId, authorized.model, verdict);
    try {
      if (entry.verdict === 'accurate') {
        await writeJudgeCache(input.root, {
          schema_version: 1,
          dok_id: prepared.dokId,
          logic_hash: prepared.logicHash,
          source_commit: prepared.sourceCommit,
          dok_sha256: prepared.dokSha256,
          verdict: 'accurate',
          errors: verdict.errors.map(({ display_severity: _d, mechanical_scope: _m, ...error }) => error),
          omissions: verdict.omissions,
          checked: verdict.checked,
          summary: verdict.summary,
          model: authorized.model,
          prompt_digest: SYNC_JUDGE_PROMPT_DIGEST,
          request_digest: prepared.requestDigest,
        });
      } else {
        await removeJudgeCache(input.root, prepared.dokId);
      }
    } catch {
      // Best-effort: the cache only saves a later run a call.
    }
    record(entry);
  }
  return { judged, ...(tokenCapFailure ? { tokenCapFailure } : {}) };
}
