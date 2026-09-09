import { readLlmTokenBudget } from '../lib/llm-cost-cap.js';
// `doklo lexicon-suggest` — LLM-driven Lexicon term suggestion.
//
// Asks the configured runtime-trust model to nominate up to 30
// **domain-relevant** terms with
// category + reason from the project's product corpus. The corpus is
// auto-selected: once Doks exist it mines their bodies (description /
// step intent / outcome / rule + criterion text); before any Dok exists
// it falls back to the consolidated feature cache + i18n display values,
// so the command is useful immediately after `doklo scan && consolidate`.
// `--corpus doks|code` forces a source. The result is written to
// .doklo/cache/lexicon-suggestions.json — *not* to lexicon.json. Studio
// surfaces the candidates with accept / reject buttons; only accepted
// ones become real Lexicon entries.

import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { mkdir, readdir, readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join, relative } from 'node:path';
import {
  suggestLexiconTerms,
  buildSuggestPrompt,
  type SuggestedTerm,
  type ProviderKind,
  type SuggestCorpus,
  type SuggestLexiconContext,
  type CodeCorpusGroup,
  type ConsolidatedFeatureConfig,
  LEXICON_CODE_GROUP_MAX_CHARS,
  LEXICON_DOK_SNIPPET_MAX_CHARS,
  renderLexiconCodeGroup,
  renderLexiconDokSnippet,
  renderLexiconExistingLine,
  renderLexiconI18nLine,
  resolveContainedPath,
  resolveContainedOutputPath,
} from '@doklo-beta/generator';
import { discoverI18nFiles, collectI18nSampleValues } from '@doklo-beta/adapter-nextjs';
import {
  DokSchema,
  LexiconFileSchema,
  type Dok,
  type LexiconTerm,
} from '@doklo-beta/core';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import { addLlmOptions, resolveLlmForRole } from '../lib/llm-options.js';
import {
  CommandContractError,
  recordCommandResult,
  requireExplicitApproval,
} from '../lib/command-result.js';
import { consolidatedCachePath } from './consolidate.js';
import type { CliContext } from '../lib/context.js';
import {
  authorizeLlmRun,
  beginAuthorizedLlmCall,
  buildLlmRunPlan,
  completeAuthorizedLlmCall,
  emitLlmRunPlan,
  isSensitiveLlmPath,
  requireAuthorizedLlmRun,
  type AuthorizedLlmRun,
  type LlmAuthSource,
} from '../lib/llm-preflight.js';
import { writeTextFileAtomic } from '../lib/atomic-file.js';

export interface LexiconSuggestCommandDeps {
  runLexiconSuggest: typeof runLexiconSuggest;
  resolveLlmForRole: typeof resolveLlmForRole;
  authorizeLlmRun: typeof authorizeLlmRun;
}

/** Which product corpus the suggester mines terms from. */
export type CorpusKind = 'doks' | 'code';

export interface LexiconSuggestionsFile {
  generated_at: string;
  /** Corpus items fed to the model (Dok count, or consolidated feature count). */
  corpus_size: number;
  /** Which corpus produced these suggestions. Additive — older files omit it. */
  corpus?: CorpusKind;
  suggestions: SuggestedTerm[];
}

export interface RunLexiconSuggestOptions {
  root: string;
  /** Force a corpus. When omitted: 'doks' if Doks exist, else 'code'. */
  corpus?: CorpusKind;
  /** Build the prompt only — no LLM call, no cache write. */
  dryRun?: boolean;
  maxSuggestions?: number;
  authorizedRun?: AuthorizedLlmRun;
  prepared?: PreparedLexiconPayload;
}

export interface RunLexiconSuggestResult {
  written: boolean;
  cacheFile: string;
  suggestions: SuggestedTerm[];
  /** The corpus actually mined (present on success and dry-run). */
  corpus?: CorpusKind;
  /** The built prompt — populated on dry-run. */
  prompt?: string;
  transmittedFiles?: string[];
  transmissions?: PreparedLexiconSource[];
  error?: string;
  /** Opaque in-process payload reused after consent; deliberately non-enumerable. */
  prepared?: PreparedLexiconPayload;
}

export interface PreparedLexiconPayload {
  readonly corpus: CorpusKind;
  readonly corpusSize: number;
  readonly ctx: SuggestLexiconContext;
  readonly prompt: string;
  readonly transmittedFiles: readonly string[];
  readonly transmissions: readonly PreparedLexiconSource[];
}

export interface PreparedLexiconSource {
  readonly file: string;
  readonly maxChars: 12_000;
  readonly actualChars: number;
}

/** Injectable seam — tests swap the LLM call; production uses the real one. */
export interface RunLexiconSuggestDeps {
  suggest: typeof suggestLexiconTerms;
}
const DEFAULT_DEPS: RunLexiconSuggestDeps = { suggest: suggestLexiconTerms };

export async function runLexiconSuggest(
  opts: RunLexiconSuggestOptions,
  deps: Partial<RunLexiconSuggestDeps> = {},
): Promise<RunLexiconSuggestResult> {
  const { suggest } = { ...DEFAULT_DEPS, ...deps };
  const { workspace, paths } = await loadWorkspaceWithPaths(opts.root);
  const prepared = opts.prepared ?? await prepareLexiconPayload(
    opts.root,
    workspace,
    paths,
    opts.corpus,
    opts.maxSuggestions,
  );
  if ('error' in prepared) return prepared.error;

  const { corpus: kind, corpusSize, ctx, prompt } = prepared;
  const transmittedFiles = [...prepared.transmittedFiles];
  const transmissions = [...prepared.transmissions];

  if (opts.dryRun) {
    return attachPrepared({
      written: false,
      cacheFile: '',
      suggestions: [],
      corpus: kind,
      prompt,
      transmittedFiles,
      transmissions,
    }, prepared);
  }

  await requireAuthorizedLlmRun(opts.authorizedRun, opts.root);
  const safeDebugDir = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.debugDir),
  );
  const authorizedCall = await beginAuthorizedLlmCall(opts.authorizedRun, opts.root, {
    phase: 'lexicon',
    workItem: { phase: 'lexicon', serviceId: 'workspace', id: kind },
    debugDir: safeDebugDir,
    prompt,
    transmissions: transmissions.map((source) => ({
      phase: 'lexicon' as const,
      serviceId: 'workspace',
      file: source.file,
      actualChars: source.actualChars,
    })),
  });
  let result: Awaited<ReturnType<typeof suggest>>;
  try {
    result = await suggest(ctx, {
      apiKey: authorizedCall.apiKey,
      model: authorizedCall.model,
      providerKind: authorizedCall.providerKind,
      ...(authorizedCall.baseURL === undefined ? {} : { baseURL: authorizedCall.baseURL }),
      ...(authorizedCall.fetch === undefined ? {} : { fetch: authorizedCall.fetch }),
      debugDir: safeDebugDir,
      preparedPrompt: authorizedCall.prompt,
    });
  } catch (error) {
    await completeAuthorizedLlmCall(opts.authorizedRun, opts.root, authorizedCall, null);
    throw error;
  }

  if (!result.success) {
    await completeAuthorizedLlmCall(opts.authorizedRun, opts.root, authorizedCall, null);
    return {
      written: false,
      cacheFile: '',
      suggestions: [],
      error: result.error ?? 'LLM call failed',
    };
  }
  await completeAuthorizedLlmCall(opts.authorizedRun, opts.root, authorizedCall, result.usage);

  await mkdir(paths.cacheDir, { recursive: true });
  const cacheFile = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, join(paths.cacheDir, 'lexicon-suggestions.json')),
  );
  const payload: LexiconSuggestionsFile = {
    generated_at: new Date().toISOString(),
    corpus_size: corpusSize,
    corpus: kind,
    suggestions: result.suggestions,
  };
  await writeTextFileAtomic(cacheFile, JSON.stringify(payload, null, 2) + '\n');

  return {
    written: true,
    cacheFile,
    suggestions: result.suggestions,
    corpus: kind,
  };
}

async function prepareLexiconPayload(
  root: string,
  workspace: {
    default_locale: string;
    services: Array<{ service_id: string; code_root: string }>;
  },
  paths: { root: string; doksDir: string; cacheDir: string; lexiconFile: string },
  requestedCorpus: CorpusKind | undefined,
  maxSuggestions: number | undefined,
): Promise<PreparedLexiconPayload | { error: RunLexiconSuggestResult }> {
  const loadedDoks = await loadAllDoks(root, paths.doksDir);
  const doks = loadedDoks.map((item) => item.dok);
  const kind: CorpusKind = requestedCorpus ?? (doks.length > 0 ? 'doks' : 'code');
  let corpus: SuggestCorpus;
  let corpusSize: number;
  let transmissions: PreparedLexiconSource[];
  if (kind === 'doks') {
    if (doks.length === 0) {
      return { error: {
        written: false, cacheFile: '', suggestions: [],
        error: 'No Doks found. Run `doklo generate` first, or use `--corpus code`.',
      } };
    }
    corpus = { kind: 'doks', doks };
    corpusSize = doks.length;
    transmissions = loadedDoks.map(({ file, dok }, index) => ({
      file,
      maxChars: 12_000,
      actualChars: renderLexiconDokSnippet(
        dok,
        LEXICON_DOK_SNIPPET_MAX_CHARS - (index > 0 ? 2 : 0),
      ).length + (index > 0 ? 2 : 0),
    }));
  } else {
    const code = await loadCodeCorpus(root, workspace, paths.cacheDir);
    if (!code) {
      return { error: {
        written: false, cacheFile: '', suggestions: [],
        error: 'No consolidated cache found. Run `doklo scan && doklo consolidate` first (or `doklo generate`, which chains them).',
      } };
    }
    corpus = code.corpus;
    corpusSize = code.featureCount;
    transmissions = code.transmissions;
  }
  const lexiconPath = await resolveContainedPath(
    root,
    relative(root, paths.lexiconFile),
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const existing = await loadExistingLexicon(lexiconPath);
  const cappedExisting = capRenderedStrings(
    existing.terms.flatMap((t) => extractLocaleSamples(t)),
    12_000,
    renderLexiconExistingLine,
    200,
  );
  if (await exists(lexiconPath)) {
    transmissions.push({
      file: relative(root, paths.lexiconFile).replaceAll('\\', '/'),
      maxChars: 12_000,
      actualChars: cappedExisting.actualChars,
    });
  }
  const ctx: SuggestLexiconContext = {
    defaultLocale: workspace.default_locale,
    corpus,
    existingTexts: cappedExisting.values,
    maxSuggestions: maxSuggestions ?? 30,
  };
  return deepFreeze({
    corpus: kind,
    corpusSize,
    ctx,
    prompt: buildSuggestPrompt(ctx),
    transmissions: dedupePreparedSources(transmissions),
    transmittedFiles: [...new Set(transmissions.map((source) => source.file))].sort(),
  });
}

function attachPrepared<T extends RunLexiconSuggestResult>(
  result: T,
  prepared: PreparedLexiconPayload,
): T {
  Object.defineProperty(result, 'prepared', { value: prepared, enumerable: false });
  return result;
}

/** Build the 'code' corpus from each service's consolidated feature cache
 *  (kept, non-excluded features) plus a deduped, capped sample of i18n
 *  display values. Returns null when no consolidated cache exists yet. */
async function loadCodeCorpus(
  root: string,
  // Structural type — avoids importing the workspace type; only these two
  // fields are read.
  workspace: { services: Array<{ service_id: string; code_root: string }> },
  cacheDir: string,
): Promise<{
  corpus: SuggestCorpus;
  featureCount: number;
  transmissions: PreparedLexiconSource[];
} | null> {
  const groups: CodeCorpusGroup[] = [];
  const i18nValues: string[] = [];
  const seenValues = new Set<string>();
  let featureCount = 0;
  const transmissions: PreparedLexiconSource[] = [];
  let remainingGroupChars = LEXICON_CODE_GROUP_MAX_CHARS;

  for (const svc of workspace.services) {
    const requestedCachePath = consolidatedCachePath(cacheDir, svc.service_id);
    const consolidatedFile = relative(root, requestedCachePath).replaceAll('\\', '/');
    if (isSensitiveLlmPath(consolidatedFile)) continue;
    if (!(await exists(requestedCachePath))) continue;
    const cachePath = await resolveContainedPath(
      root,
      consolidatedFile,
    );
    const consolidated = JSON.parse(await readFile(cachePath, 'utf-8')) as ConsolidatedFeatureConfig;
    let consolidatedChars = 0;
    for (const g of consolidated.groups) {
      const features = g.features
        .filter((f) => f.decision !== 'exclude')
        .map((f) => ({ canonical_id: f.canonical_id, label: f.label, primary_route: f.primary_route }));
      if (features.length === 0) continue;
      const group = { label: g.label, features };
      const rendered = `${groups.length > 0 ? '\n\n' : ''}${renderLexiconCodeGroup(group)}`;
      const contribution = Math.min(rendered.length, remainingGroupChars);
      consolidatedChars += contribution;
      remainingGroupChars -= contribution;
      groups.push(group);
      featureCount += features.length;
    }
    transmissions.push({
      file: consolidatedFile,
      maxChars: 12_000,
      actualChars: consolidatedChars,
    });
    const svcRoot = await resolveContainedPath(root, svc.code_root);
    const files = discoverI18nFiles(svcRoot)
      .sort((left, right) => left.file.localeCompare(right.file));
    for (const file of files) {
      const rel = join(svc.code_root, file.file).replaceAll('\\', '/').replace(/^\.\//, '');
      if (isSensitiveLlmPath(rel)) continue;
      await resolveContainedPath(svcRoot, file.file);
      let sourceChars = 0;
      for (const v of collectI18nSampleValues({ rootDir: svcRoot, files: [file], cap: 200 })) {
        if (seenValues.has(v) || i18nValues.length >= 200) continue;
        const fragmentChars = renderLexiconI18nLine(v).length
          + (i18nValues.length > 0 ? 1 : 0);
        if (sourceChars + fragmentChars > 12_000) break;
        seenValues.add(v);
        i18nValues.push(v);
        sourceChars += fragmentChars;
      }
      if (sourceChars > 0) {
        transmissions.push({ file: rel, maxChars: 12_000, actualChars: sourceChars });
      }
    }
  }

  if (groups.length === 0) return null;
  return {
    corpus: { kind: 'code', groups, i18nValues },
    featureCount,
    transmissions: dedupePreparedSources(
      transmissions.filter((source) => !isSensitiveLlmPath(source.file)),
    ),
  };
}

interface LoadedDok {
  dok: Dok;
  file: string;
}

async function loadAllDoks(root: string, doksDir: string): Promise<LoadedDok[]> {
  if (!(await exists(doksDir))) return [];
  const entries = await readdir(doksDir);
  const out: LoadedDok[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const requested = join(doksDir, entry);
    const rel = relative(root, requested).replaceAll('\\', '/');
    if (isSensitiveLlmPath(rel)) continue;
    try {
      const dokPath = await resolveContainedPath(root, rel);
      const raw = JSON.parse(await readFile(dokPath, 'utf-8'));
      const parsed = DokSchema.safeParse(raw);
      if (parsed.success) out.push({ dok: parsed.data, file: rel });
    } catch {
      // skip unreadable / invalid
    }
  }
  out.sort((a, b) => a.dok.dok_id.localeCompare(b.dok.dok_id));
  return out;
}

function capRenderedStrings(
  values: readonly string[],
  maxChars: 12_000,
  render: (value: string) => string,
  maxValues: number,
): {
  values: string[];
  actualChars: number;
} {
  const kept: string[] = [];
  let actualChars = 0;
  for (const value of values) {
    if (kept.length >= maxValues) break;
    const renderedChars = render(value).length + (kept.length === 0 ? 0 : 1);
    if (actualChars + renderedChars > maxChars) break;
    kept.push(value);
    actualChars += renderedChars;
  }
  return { values: kept, actualChars };
}

function dedupePreparedSources(
  sources: readonly PreparedLexiconSource[],
): PreparedLexiconSource[] {
  const byFile = new Map<string, PreparedLexiconSource>();
  for (const source of sources) {
    const existing = byFile.get(source.file);
    if (!existing || source.actualChars > existing.actualChars) byFile.set(source.file, source);
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

async function loadExistingLexicon(
  lexiconFile: string,
): Promise<{ terms: LexiconTerm[]; version: number }> {
  if (!(await exists(lexiconFile))) return { terms: [], version: 1 };
  try {
    const raw = JSON.parse(await readFile(lexiconFile, 'utf-8'));
    const parsed = LexiconFileSchema.parse(raw);
    return { terms: parsed.terms, version: parsed.version };
  } catch {
    return { terms: [], version: 1 };
  }
}

function extractLocaleSamples(t: LexiconTerm): string[] {
  const map =
    t.binding.type === 'constant'
      ? (t.snapshot ?? {})
      : t.binding.type === 'owned'
        ? (t.locales ?? {})
        : {};
  return Object.values(map).filter((v): v is string => typeof v === 'string');
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

function parseCorpusKind(value: string): CorpusKind {
  if (value === 'doks' || value === 'code') return value;
  throw new InvalidArgumentError('Expected "doks" or "code".');
}

export function registerLexiconSuggestCommand(
  program: Command,
  ctx: CliContext,
  deps: Partial<LexiconSuggestCommandDeps> = {},
): void {
  const executeSuggest = deps.runLexiconSuggest ?? runLexiconSuggest;
  const resolveLexiconLlm = deps.resolveLlmForRole ?? resolveLlmForRole;
  const authorizeRun = deps.authorizeLlmRun ?? authorizeLlmRun;
  addLlmOptions(
    program
      .command('lexicon-suggest')
      .description(
        'Ask the configured runtime-trust model to nominate ≤30 domain-relevant Lexicon terms from your product corpus (Doks, or consolidated features before any Dok exists); writes .doklo/cache/lexicon-suggestions.json for web review',
      )
      .option('-r, --root <dir>', 'Workspace root', process.cwd())
      .option(
        '--corpus <kind>',
        'Corpus to mine: "doks" (Dok bodies) or "code" (consolidated features + i18n values). Default: auto',
        parseCorpusKind,
      )
      .option('--dry-run', 'Print the prompt without calling the LLM', false)
      .option('--max <n>', 'Maximum suggestions to request', (v) => parseInt(v, 10), 30)
      .option('-y, --yes', 'Approve the displayed immutable plan', false)
      .option('--json', 'Emit JSONL only', false),
  ).action(async (opts) => {
    const { default: chalk } = await import('chalk');
    const dryRun = opts.dryRun as boolean;
    const machine = opts.json === true;
    if (!dryRun) {
      requireExplicitApproval({
        command: 'doklo lexicon-suggest',
        yes: opts.yes === true,
        isTTY: !machine && process.stdin.isTTY === true,
      });
    }
    const preview = await executeSuggest({
      root: opts.root as string,
      ...(opts.corpus !== undefined ? { corpus: opts.corpus as CorpusKind } : {}),
      dryRun: true,
      maxSuggestions: opts.max as number,
    });
    const r = dryRun || preview.error
      ? undefined
      : await resolveLexiconLlm('lexicon', {
          model: opts.model as string | undefined,
          profile: opts.profile as string | undefined,
        });
    let result = preview;
    if (r !== undefined) {
      const { paths } = await loadWorkspaceWithPaths(opts.root as string);
      const plan = buildLlmRunPlan({
        llm: { ...r, authSource: r.authSource ?? inferAuthSource(r) },
        candidateFiles: (preview.transmissions ?? []).map((source) => ({
          phase: 'lexicon' as const,
          serviceId: 'workspace',
          file: source.file,
          maxChars: source.maxChars,
        })),
        workItems: [{
          phase: 'lexicon',
          serviceId: 'workspace',
          id: preview.corpus ?? 'code',
        }],
        calls: { consolidate: 0, lexicon: 1, generateMax: 0, judgeMax: 0 },
        preparedCalls: [{
          phase: 'lexicon',
          workItem: {
            phase: 'lexicon',
            serviceId: 'workspace',
            id: preview.corpus ?? 'code',
          },
          prompt: preview.prompt ?? '',
          maxOutputTokens: 4_096,
        }],
        debugDir: await resolveContainedOutputPath(
          paths.root,
          relative(paths.root, paths.debugDir),
        ),
      });
      emitLlmRunPlan(plan, { machine, budget: await readLlmTokenBudget(opts.root as string) });
      const authorizedRun = await authorizeRun(
        opts.root as string,
        plan,
        r,
        {
          yes: opts.yes === true,
          isTTY: !machine && process.stdin.isTTY === true,
        },
      );
      result = await executeSuggest({
        root: opts.root as string,
        ...(opts.corpus !== undefined ? { corpus: opts.corpus as CorpusKind } : {}),
        maxSuggestions: opts.max as number,
        authorizedRun,
        prepared: preview.prepared,
      });
    }

    if (result.error) {
      recordCommandResult(program, {
        schema_version: 1,
        command: 'lexicon-suggest',
        status: 'failed',
        data: result,
        diagnostics: [{ code: 'LEXICON_SUGGEST_FAILED', message: result.error }],
      });
      return;
    }

    if (dryRun) {
      if (!machine) {
        console.log(
          `\n  ${chalk.dim(`corpus: ${result.corpus}`)}\n\n${result.prompt ?? ''}\n`,
        );
      }
      recordCommandResult(program, {
        schema_version: 1,
        command: 'lexicon-suggest',
        status: 'success',
        data: result,
        diagnostics: [],
      });
      return;
    }

    if (!machine) {
      console.log(
        `\n  ${chalk.cyan(`${result.suggestions.length} suggestion(s)`)} ${chalk.dim(
          `→ ${result.cacheFile.replace(opts.root as string, '.')}`,
        )}\n`,
      );
      for (const s of result.suggestions) {
        console.log(
          `    ${chalk.bold(s.text.padEnd(20))}  ${chalk.dim(`(${s.category})`)}  ${chalk.dim(s.reason)}`,
        );
      }
      console.log(
        `\n  ${chalk.dim('Review in web: /lexicon → Suggestions section')}\n`,
      );
    }
    recordCommandResult(program, {
      schema_version: 1,
      command: 'lexicon-suggest',
      status: 'success',
      data: result,
      diagnostics: [],
    });
    void ctx;
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
