import { readLlmTokenBudget } from '../lib/llm-cost-cap.js';
// `doklo consolidate` — LLM grouping pass over scanned features.
//
// Reads each .doklo/cache/<service-id>.scan.json, bridges it to a
// FeatureConfig (irToFeatures), feeds it to the consolidator (LLM call
// to claude-haiku), and writes <service-id>.consolidated.json next to
// the scan cache.

import { assertRecordingSource, assertCacheSource, recordCacheSource } from '../lib/recording-branch.js';
import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { readFile, access, readdir } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join, relative } from 'node:path';
import {
  consolidateFeatures,
  ConsolidationProcessingError,
  buildConsolidationPromptForFeatures,
  buildConsolidationPromptParts,
  joinPromptParts,
  irToFeatures,
  isLLMBackend,
  resolveContainedOutputPath,
  resolveContainedPath,
  ConsolidatedFeatureConfigSchema,
  type ConsolidateOptions,
  type ConsolidateResult,
  type ConsolidatedFeatureConfig,
  type ExistingDokIdentity,
  type FeatureConfig,
  type LLMUsage,
  type LLMBackend,
  type ProviderKind,
} from '@doklo-beta/generator';

/** Commander parser: reject misspelled --llm-backend values up front so a
 * typo fails with a clear message instead of silently falling back to the
 * default backend. */
function parseLlmBackend(value: string): LLMBackend {
  if (isLLMBackend(value)) return value;
  throw new InvalidArgumentError('Expected "claude-code" (local CLI) or "anthropic-api" (direct API). Try: doklo consolidate --llm-backend anthropic-api');
}
import { DokSchema, ProjectIRSchema, type ProjectIR } from '@doklo-beta/core';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import type { WorkspacePaths } from '../lib/paths.js';
import { addLlmOptions, resolveLlmForRole } from '../lib/llm-options.js';
import { scanCachePath, validateProjectIrPaths } from './scan.js';
import type { CliContext } from '../lib/context.js';
import { writeTextFileAtomic } from '../lib/atomic-file.js';
import {
  CommandContractError,
  recordCommandResult,
  requireExplicitApproval,
  type CommandDiagnostic,
} from '../lib/command-result.js';
import {
  authorizeLlmRun,
  beginAuthorizedLlmCall,
  buildLlmRunPlan,
  completeAuthorizedLlmCall,
  emitLlmRunPlan,
  isSensitiveLlmPath,
  requireAuthorizedLlmRun,
  type AuthorizedLlmRun,
  type ConsolidationPreview,
  type LlmAuthSource,
} from '../lib/llm-preflight.js';

export interface ConsolidateCommandDeps {
  runConsolidate: typeof runConsolidate;
  resolveLlmForRole: typeof resolveLlmForRole;
  authorizeLlmRun: typeof authorizeLlmRun;
}

export interface ConsolidateDeps {
  /** Injectable for tests; defaults to the real LLM-backed consolidator. */
  consolidateFeatures: (
    features: FeatureConfig,
    options?: Partial<ConsolidateOptions>,
  ) => Promise<ConsolidateResult>;
}

const DEFAULT_DEPS: ConsolidateDeps = {
  consolidateFeatures,
};

export class ScanCacheMissingError extends Error {
  constructor() {
    super('No service has a scan cache yet. Run `doklo scan` first.');
    this.name = 'ScanCacheMissingError';
  }
}

export class InvalidConsolidationOutputError extends CommandContractError<RunConsolidateResult> {
  readonly serviceId: string;
  readonly cachePath: string;

  constructor(serviceId: string, cachePath: string, cause: unknown, data?: RunConsolidateResult) {
    super({
      schema_version: 1, command: 'consolidate', status: data?.results.length ? 'partial' : 'failed',
      data: data ?? null,
      diagnostics: [{ code: 'CONSOLIDATION_OUTPUT_INVALID', serviceId,
        message: `Consolidation produced an invalid cache for service "${serviceId}": ${cachePath}` }],
    });
    this.cause = cause;
    this.name = 'InvalidConsolidationOutputError';
    this.serviceId = serviceId;
    this.cachePath = cachePath;
  }
}

export interface RunConsolidateOptions {
  root: string;
  /** When true, report source candidates and prompt estimates without an LLM call. */
  dryRun?: boolean;
  /** Limit to one service (matches workspace.services[].service_id). */
  serviceId?: string;
  /** One-shot command-owned capability for paid provider work. */
  authorizedRun?: AuthorizedLlmRun;
  /** Validated IR prepared by a mutation-free scan preview. */
  scanIrs?: Readonly<Record<string, ProjectIR>>;
}

export interface ConsolidateServiceResult {
  serviceId: string;
  featureGroupCount: number;
  /** Null when dry-run; absolute path otherwise. */
  outputPath: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number | null;
  maxOutputTokens?: number;
  usage?: LLMUsage | null;
  preview: ConsolidationPreview;
  sourceClassification?: ConsolidationSourceClassification;
}

export interface ConsolidationSourceClassification extends NonNullable<FeatureConfig['sourceClassification']> {
  /** Enabled inputs to consolidation; these remain candidates, not confirmed product features. */
  includedFeatureIds: string[];
  /** Inputs requiring review, including unconnected source behavior. */
  reviewFeatureIds: string[];
}

export interface ConsolidateSkip {
  serviceId: string;
  reason: string;
}

/**
 * A feature claimed an existing Dok's id that reconciliation could not verify
 * belongs to it — the Dok predates provenance, so there is nothing to match
 * against and nothing to contradict either (see `assertNoUnpinnedIdCapture`).
 * Advisory: the run keeps the id, and the user is told which file will be
 * rewritten by which feature, because only they can confirm it is the same one.
 */
export interface UnverifiedIdReuseNotice {
  serviceId: string;
  dokId: string;
  canonicalId: string;
}

export interface ConsolidationAttempt {
  phase: 'consolidate';
  serviceId: string;
  model: string;
  success: boolean;
  estimated: { inputTokens: number; outputTokens: null; maxOutputTokens: number };
  usage: LLMUsage | null;
  error?: string;
}

export interface RunConsolidateResult {
  /** Attempted calls only, including failed/unknown responses; excludes generation. */
  attempts?: ConsolidationAttempt[];
  results: ConsolidateServiceResult[];
  skipped: ConsolidateSkip[];
  /** Existing Doks a feature took over without verifiable provenance. */
  unverifiedIdReuse: UnverifiedIdReuseNotice[];
}

export async function runConsolidate(
  opts: RunConsolidateOptions,
  deps: Partial<ConsolidateDeps> = {},
): Promise<RunConsolidateResult> {
  const { consolidateFeatures: consolidate } = { ...DEFAULT_DEPS, ...deps };
  const { workspace, paths } = await loadWorkspaceWithPaths(opts.root);
  const recordingSource = await assertRecordingSource(paths.root);

  const services = opts.serviceId
    ? workspace.services.filter((s) => s.service_id === opts.serviceId)
    : workspace.services;

  const results: ConsolidateServiceResult[] = [];
  const attempts: ConsolidationAttempt[] = [];
  const skipped: ConsolidateSkip[] = [];
  const unverifiedIdReuse: UnverifiedIdReuseNotice[] = [];
  const prepared: Array<{
    serviceId: string;
    features: FeatureConfig;
    outputPath: string;
    safeOutputPath: string;
    preview: ConsolidationPreview;
    existingIdentities: ExistingDokIdentity[];
  }> = [];

  // Doks this workspace already published. They are what makes a re-run
  // idempotent: the model is shown their ids and the normalized output is
  // pinned back onto them, so re-consolidating cannot silently rename
  // AUTH-SIGNIN to AUTH-LOGIN and orphan the file. Absent on a first run.
  const existingIdentities = await loadExistingDokIdentities(paths);

  for (const svc of services) {
    const serviceRoot = await resolveContainedPath(paths.root, svc.code_root);
    const cachePath = await resolveContainedPath(
      paths.root,
      relative(paths.root, scanCachePath(paths.cacheDir, svc)),
      { allowMissingLeaf: true, rejectSymlinkLeaf: true },
    );
    await assertCacheSource(paths.root, 'scan', svc.service_id, cachePath, recordingSource);
    const preparedIr = opts.scanIrs?.[svc.service_id];
    if (!(await exists(cachePath)) && preparedIr === undefined) {
      skipped.push({
        serviceId: svc.service_id,
        reason: 'no scan cache (run `doklo scan` first)',
      });
      continue;
    }

    const ir = ProjectIRSchema.parse(
      preparedIr ?? JSON.parse(await readFile(cachePath, 'utf-8')),
    );
    await validateProjectIrPaths(serviceRoot, ir);
    const features = privacyFilterFeatures(
      irToFeatures(ir, { projectName: workspace.workspace_id }),
    );
    const transmittedFiles = await containedTransmissionFiles(serviceRoot, features);
    const serviceIdentities = identitiesForService(existingIdentities, svc.service_id);
    const prompt = buildConsolidationPromptForFeatures(features, serviceIdentities);
    const estimatedInputTokens = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);
    const estimatedOutputTokens = null;
    const maxOutputTokens = 32_768;
    const preview: ConsolidationPreview = {
      serviceId: svc.service_id,
      sourceFeatureCount: features.featureGroups.reduce(
        (sum, group) => sum + group.features.length,
        0,
      ),
      transmittedFiles,
      estimatedInputTokens,
      estimatedOutputTokens,
      maxOutputTokens,
      prompt,
    };
    const outputPath = consolidatedCachePath(paths.cacheDir, svc.service_id);
    const safeOutputPath = await resolveContainedOutputPath(
      paths.root,
      relative(paths.root, outputPath),
    );

    if (opts.dryRun) {
      results.push({
        serviceId: svc.service_id,
        featureGroupCount: features.featureGroups.length,
        outputPath: null,
        estimatedInputTokens,
        estimatedOutputTokens,
        maxOutputTokens,
        usage: null,
        preview,
        sourceClassification: describeConsolidationSources(features),
      });
      continue;
    }

    prepared.push({
      serviceId: svc.service_id,
      features,
      outputPath,
      safeOutputPath,
      preview,
      existingIdentities: serviceIdentities,
    });
  }

  if (results.length === 0 && prepared.length === 0 && skipped.length === 0) {
    throw new ScanCacheMissingError();
  }
  if (results.length === 0 && prepared.length === 0 && skipped.length > 0) {
    throw new ScanCacheMissingError();
  }

  // Every selected cache/root/output is now validated. Only after this global
  // barrier may the first paid consolidation or cache write begin.
  const safeDebugDir = opts.dryRun
    ? paths.debugDir
    : await resolveContainedOutputPath(
        paths.root,
        relative(paths.root, paths.debugDir),
      );
  if (prepared.length > 0) await requireAuthorizedLlmRun(opts.authorizedRun, opts.root);

  // Dok ids are workspace-global (one hub/doks directory), but each service is
  // consolidated by its own LLM call that only sees its own features. This set
  // carries the ids already spoken for across those calls — services this run
  // does not touch keep their cached ids, and each consolidated service adds
  // both its new ids and the existing ones it left unclaimed.
  const usedPrefixes = new Set<string>(
    await foreignConsolidatedPrefixes(
      paths,
      workspace.services.map((service) => service.service_id),
      new Set(prepared.map((item) => item.serviceId)),
    ),
  );

  try {
    for (const item of prepared) {
      const { serviceId, features, outputPath, safeOutputPath, preview } = item;
      // Seed for this call: the accumulated set plus every hub Dok this service
      // may not reuse. Held in a per-service copy — reserving another service's
      // ids permanently would stop that service from keeping its own.
      const reusableIds = new Set(item.existingIdentities.map((identity) => identity.dok_id));
      const seededPrefixes = new Set(usedPrefixes);
      for (const identity of existingIdentities) {
        if (!reusableIds.has(identity.dok_id)) seededPrefixes.add(identity.dok_id);
      }

      // The trust gate digests the canonical joined string; the split parts are
      // what the provider actually receives (system = cacheable static prefix).
      // Existing identities are per-workspace data, so they ride in the user part.
      const promptParts = buildConsolidationPromptParts(features, item.existingIdentities);
      const authorizedCall = await beginAuthorizedLlmCall(opts.authorizedRun, opts.root, {
        phase: 'consolidate',
        workItem: { phase: 'consolidate', serviceId, id: serviceId },
        debugDir: safeDebugDir,
        prompt: joinPromptParts(promptParts),
        transmissions: preview.transmittedFiles.map((file) => ({
          phase: 'consolidate' as const,
          serviceId,
          file,
          actualChars: 0,
        })),
      });
      const consolidateOpts: Partial<ConsolidateOptions> = {
        debugDir: safeDebugDir,
        verbose: false,
        model: authorizedCall.model,
        providerKind: authorizedCall.providerKind,
        apiKey: authorizedCall.apiKey,
        ...(authorizedCall.baseURL === undefined ? {} : { baseURL: authorizedCall.baseURL }),
        ...(authorizedCall.fetch === undefined ? {} : { fetch: authorizedCall.fetch }),
        preparedPrompt: promptParts,
        serviceId,
        existingIdentities: item.existingIdentities,
        usedPrefixes: [...seededPrefixes],
        // Only the advisory matters here: a Dok changing hands is something the
        // user has to see, and nothing else in the run will mention it.
        onProgress: (event) => {
          if (event.stage !== 'unverified-id-reuse') return;
          unverifiedIdReuse.push({
            serviceId,
            dokId: event.dokId,
            canonicalId: event.canonicalId,
          });
        },
      };
      const attempt: ConsolidationAttempt = {
        phase: 'consolidate', serviceId, model: authorizedCall.model, success: false,
        estimated: { inputTokens: preview.estimatedInputTokens, outputTokens: null, maxOutputTokens: 32_768 },
        usage: null,
      };
      attempts.push(attempt);
      const failedRun = (error: unknown): CommandContractError => {
        attempt.error = error instanceof Error ? error.message : String(error);
        const diagnostics = error instanceof CommandContractError
          ? error.result.diagnostics
          : [{ code: 'CONSOLIDATION_FAILED', serviceId, message: attempt.error }];
        return new CommandContractError({
          schema_version: 1, command: 'consolidate', status: results.length > 0 ? 'partial' : 'failed',
          data: { results, skipped, unverifiedIdReuse, attempts }, diagnostics,
        });
      };
      let consolidateResult: ConsolidateResult;
      try {
        consolidateResult = await consolidate(features, consolidateOpts);
      } catch (error) {
        attempt.usage = error instanceof ConsolidationProcessingError ? error.usage : null;
        try {
          await completeAuthorizedLlmCall(opts.authorizedRun, opts.root, authorizedCall, attempt.usage);
        } catch (settlementError) {
          throw failedRun(settlementError);
        }
        throw failedRun(error);
      }
      attempt.usage = consolidateResult.usage ?? null;
      try {
        await completeAuthorizedLlmCall(opts.authorizedRun, opts.root, authorizedCall, attempt.usage);
      } catch (error) {
        throw failedRun(error);
      }
      if (!consolidateResult.success || !consolidateResult.config) {
        throw failedRun(new Error(
          `Consolidation failed for service "${serviceId}": ${consolidateResult.error ?? 'unknown error'}`,
        ));
      }

      const parsedConfig = ConsolidatedFeatureConfigSchema.safeParse(consolidateResult.config);
      if (!parsedConfig.success) {
        attempt.error = `Invalid consolidation cache: ${outputPath}`;
        throw new InvalidConsolidationOutputError(
          serviceId, outputPath, parsedConfig.error, { results, skipped, unverifiedIdReuse, attempts },
        );
      }
      const config = parsedConfig.data;

      try {
        await writeTextFileAtomic(safeOutputPath, JSON.stringify(config, null, 2) + '\n');
        await recordCacheSource(paths.root, 'consolidate', serviceId, outputPath, recordingSource);
      } catch (error) {
        throw failedRun(error);
      }

      // Reserve what this service now owns for the services still to come: the
      // ids it just assigned, plus the ids of its existing Doks that no feature
      // claimed. The latter files stay on disk (generate warns about them), so
      // another service must not mint the same id and overwrite one.
      const assignedPrefixes = collectDokIdPrefixes(config);
      for (const prefix of assignedPrefixes) usedPrefixes.add(prefix);
      for (const identity of item.existingIdentities) {
        if (!assignedPrefixes.has(identity.dok_id)) usedPrefixes.add(identity.dok_id);
      }

      attempt.success = true;
      results.push({
        serviceId,
        featureGroupCount: config.groups.length,
        outputPath,
        estimatedInputTokens: preview.estimatedInputTokens,
        estimatedOutputTokens: null,
        maxOutputTokens: 32_768,
        usage: attempt.usage,
        preview,
        sourceClassification: describeConsolidationSources(features),
      });
    }
  } catch (error) {
    if (attempts.length === 0) throw error;
    if (error instanceof CommandContractError && error.result.command === 'consolidate') throw error;
    throw new CommandContractError({
      schema_version: 1, command: 'consolidate', status: results.length > 0 ? 'partial' : 'failed',
      data: { results, skipped, unverifiedIdReuse, attempts },
      diagnostics: error instanceof CommandContractError ? error.result.diagnostics
        : [{ code: 'CONSOLIDATION_FAILED', message: error instanceof Error ? error.message : String(error) }],
    });
  }
  return { results, skipped, unverifiedIdReuse, attempts };
}

export function formatConsolidationAttempt(attempt: ConsolidationAttempt): string {
  const usage = attempt.usage;
  const input = usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : null;
  return `  consolidate ${attempt.serviceId} (${attempt.model}): ${attempt.success ? 'completed' : 'failed'}; `
    + `attempt input estimate ~${attempt.estimated.inputTokens}, output unknown; `
    + (usage ? `measured input ${input}, output ${usage.output_tokens}, cache read ${usage.cache_read_input_tokens ?? 0}, cache creation ${usage.cache_creation_input_tokens ?? 0}`
      : 'usage unavailable; reservation retained');
}

/**
 * One line per Dok that changed hands without provenance. Shared by the console
 * warning and the machine diagnostic so both say the same thing.
 */
export function formatUnverifiedIdReuse(notice: UnverifiedIdReuseNotice): string {
  return `${notice.dokId} was claimed by feature "${notice.canonicalId}" (${notice.serviceId}) `
    + 'but has no recorded provenance to confirm they are the same feature — '
    + `generate will overwrite .doklo/hub/doks/${notice.dokId}.json with it. `
    + 'Check the Dok before generating.';
}

function privacyFilterFeatures(features: FeatureConfig): FeatureConfig {
  return {
    ...features,
    featureGroups: features.featureGroups.map((group) => ({
      ...group,
      features: group.features.map((feature) => ({
        ...feature,
        files: feature.files.filter((file) => !isSensitiveLlmPath(file.path)),
        ...(feature.logic_files === undefined
          ? {}
          : { logic_files: feature.logic_files.filter((file) => !isSensitiveLlmPath(file)) }),
      })),
    })),
    sharedInfrastructure: {
      sharedComponents: features.sharedInfrastructure.sharedComponents.filter((file) => !isSensitiveLlmPath(file)),
      sharedHooks: features.sharedInfrastructure.sharedHooks.filter((file) => !isSensitiveLlmPath(file)),
      sharedStores: features.sharedInfrastructure.sharedStores.filter((file) => !isSensitiveLlmPath(file)),
      sharedUtils: features.sharedInfrastructure.sharedUtils.filter((file) => !isSensitiveLlmPath(file)),
      sharedTypes: features.sharedInfrastructure.sharedTypes.filter((file) => !isSensitiveLlmPath(file)),
    },
    unmappedFiles: features.unmappedFiles.filter((file) => !isSensitiveLlmPath(file)),
  };
}

function describeConsolidationSources(features: FeatureConfig): ConsolidationSourceClassification {
  const classification = features.sourceClassification;
  const visible = (files: readonly string[]): string[] => [...new Set(files.filter((file) => !isSensitiveLlmPath(file)))];
  return {
    candidateUnits: classification?.candidateUnits ?? 0,
    auxiliaryFiles: visible(classification?.auxiliaryFiles ?? []),
    unconnectedFiles: visible(classification?.unconnectedFiles ?? []),
    excludedUnits: (classification?.excludedUnits ?? []).map((unit) => ({ ...unit, files: visible(unit.files) })),
    includedFeatureIds: features.featureGroups.flatMap((group) => group.features
      .filter((feature) => group.enabled && feature.enabled).map((feature) => feature.id)),
    reviewFeatureIds: features.featureGroups.flatMap((group) => group.features
      .filter((feature) => !group.enabled || !feature.enabled).map((feature) => feature.id)),
  };
}

export function formatConsolidationSourceSummary(result: Pick<ConsolidateServiceResult, 'serviceId' | 'sourceClassification'>): string {
  const summary = result.sourceClassification;
  if (!summary) return '';
  const sample = (items: readonly string[]): string => items.slice(0, 5).join(', ')
    + (items.length > 5 ? ` (+${items.length - 5} more)` : '');
  return [
    `  ${result.serviceId} source plan: ${summary.includedFeatureIds.length} included candidates, ${summary.reviewFeatureIds.length} needing review, ${summary.excludedUnits.length} excluded auxiliary units; ${summary.auxiliaryFiles.length} auxiliary files.`,
    ...(summary.includedFeatureIds.length ? [`    Included: ${sample(summary.includedFeatureIds)}`] : []),
    ...(summary.reviewFeatureIds.length ? [`    Review before documentation: ${sample(summary.reviewFeatureIds)}`] : []),
    ...(summary.excludedUnits.length ? [`    Excluded (auxiliary source only): ${sample(summary.excludedUnits.map((unit) => unit.id))}`] : []),
  ].join('\n');
}

async function containedTransmissionFiles(
  serviceRoot: string,
  features: FeatureConfig,
): Promise<string[]> {
  const files = new Set<string>();
  for (const group of features.featureGroups) {
    for (const feature of group.features) {
      for (const file of feature.files) {
        await resolveContainedPath(serviceRoot, file.path);
        files.add(file.path.replaceAll('\\', '/'));
      }
    }
  }
  return [...files].sort();
}

export function consolidatedCachePath(cacheDir: string, serviceId: string): string {
  return join(cacheDir, `${serviceId}.consolidated.json`);
}

/**
 * Identity of every Dok already in the hub, as the id-reconciliation ladder
 * reads it.
 *
 * A Dok contributes one identity per `_meta.origins` entry, because the same
 * business capability can surface in several services. One generated before
 * origins existed falls back to a single identity scoped by
 * `_meta.anchor_service_id`: nothing can match on it yet, but its id is known,
 * so the first regeneration can still reserve it and seed origins.
 *
 * Files that fail schema validation are skipped rather than thrown on —
 * `generate` preflights the same directory and fails closed there, and a broken
 * hub file must not make consolidation (a read-only planning step) unusable.
 */
async function loadExistingDokIdentities(
  paths: WorkspacePaths,
): Promise<ExistingDokIdentity[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.doksDir);
  } catch {
    return [];
  }

  const identities: ExistingDokIdentity[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const file = await resolveContainedPath(
      paths.root,
      relative(paths.root, join(paths.doksDir, entry)),
      { rejectSymlinkLeaf: true },
    );
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf-8'));
    } catch {
      continue;
    }
    const parsed = DokSchema.safeParse(raw);
    if (!parsed.success) continue;
    const dok = parsed.data;

    const origins = dok._meta.origins ?? [];
    if (origins.length === 0) {
      identities.push({
        dok_id: dok.dok_id,
        ...(dok._meta.anchor_service_id === undefined
          ? {}
          : { service_id: dok._meta.anchor_service_id }),
      });
      continue;
    }
    for (const origin of origins) {
      identities.push({
        dok_id: dok.dok_id,
        service_id: origin.service_id,
        canonical_feature_id: origin.canonical_feature_id,
        ...(origin.primary_route === undefined ? {} : { primary_route: origin.primary_route }),
      });
    }
  }
  return identities;
}

/** Identities a given service may reuse — its own, plus unscoped legacy Doks. */
function identitiesForService(
  identities: readonly ExistingDokIdentity[],
  serviceId: string,
): ExistingDokIdentity[] {
  return identities.filter(
    (identity) => identity.service_id === undefined || identity.service_id === serviceId,
  );
}

/**
 * Dok ids held by services this run does not consolidate. Their caches keep
 * driving `generate`, so their ids stay taken. Best-effort: an unreadable or
 * outdated cache is skipped — the hub identities already cover every id that
 * reached a Dok file.
 */
async function foreignConsolidatedPrefixes(
  paths: WorkspacePaths,
  serviceIds: readonly string[],
  consolidatedNow: ReadonlySet<string>,
): Promise<string[]> {
  const prefixes: string[] = [];
  for (const serviceId of serviceIds) {
    if (consolidatedNow.has(serviceId)) continue;
    const cachePath = await resolveContainedPath(
      paths.root,
      relative(paths.root, consolidatedCachePath(paths.cacheDir, serviceId)),
      { allowMissingLeaf: true, rejectSymlinkLeaf: true },
    );
    if (!(await exists(cachePath))) continue;
    try {
      const parsed = ConsolidatedFeatureConfigSchema.safeParse(
        JSON.parse(await readFile(cachePath, 'utf-8')),
      );
      if (!parsed.success) continue;
      prefixes.push(...collectDokIdPrefixes(parsed.data));
    } catch {
      continue;
    }
  }
  return prefixes;
}

function collectDokIdPrefixes(config: ConsolidatedFeatureConfig): Set<string> {
  const prefixes = new Set<string>();
  for (const group of config.groups) {
    for (const feature of group.features) {
      if (feature.decision !== 'exclude' && feature.dok_id_prefix) {
        prefixes.add(feature.dok_id_prefix);
      }
    }
  }
  return prefixes;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
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

// ───────── commander wiring ─────────────────────────────────────────

export function registerConsolidateCommand(
  program: Command,
  ctx: CliContext,
  deps: Partial<ConsolidateCommandDeps> = {},
): void {
  const executeConsolidate = deps.runConsolidate ?? runConsolidate;
  const resolveConsolidateLlm = deps.resolveLlmForRole ?? resolveLlmForRole;
  const authorizeRun = deps.authorizeLlmRun ?? authorizeLlmRun;
  addLlmOptions(
    program
      .command('consolidate')
      .description(
        'LLM consolidation via runtime-trust (anthropic/claude-sonnet-5 or openai/gpt-5.6-terra)',
      )
      .option('-r, --root <dir>', 'Workspace root', process.cwd())
      .option('--dry-run', 'Preview source candidates and consolidation estimates without an LLM call', false)
      .option('--service <id>', 'Limit to one service')
      .option('-y, --yes', 'Approve the displayed immutable plan', false)
      .option('--json', 'Emit JSONL only', false)
      .option(
        '--llm-backend <backend>',
        'Override the configured runtime-trust route with local Claude Code or direct Anthropic',
        parseLlmBackend,
      ),
  ).action(async (opts) => {
      const { default: chalk } = await import('chalk');
      const dryRun = opts.dryRun as boolean;
      const machine = opts.json === true;

      if (!dryRun) {
        requireExplicitApproval({
          command: 'doklo consolidate',
          yes: opts.yes === true,
          isTTY: !machine && process.stdin.isTTY === true,
        });
      }

      const preview = await executeConsolidate({
        root: opts.root as string,
        dryRun: true,
        serviceId: opts.service as string | undefined,
      });

      for (const service of preview.results) {
        if (!service.sourceClassification) continue;
        if (machine && !dryRun) {
          process.stdout.write(JSON.stringify({ stage: 'source-classification', serviceId: service.serviceId,
            sourceClassification: service.sourceClassification }) + '\n');
        } else if (!machine) {
          console.log(formatConsolidationSourceSummary(service));
        }
      }

      if (!machine) console.log('  Candidate groups are not a Dok count. Narrow the paid call with --service <id>, or stop and adjust source scope before approval. Output size and cache usage remain unknown.');

      // Credential resolution follows the LLM-free contained preview.
      const resolved = dryRun
        ? undefined
        : await resolveConsolidateLlm('consolidate', {
            model: opts.model as string | undefined,
            profile: opts.profile as string | undefined,
            backend: opts.llmBackend as 'claude-code' | 'anthropic-api' | undefined,
          });

      let result = preview;
      if (resolved !== undefined) {
        const { paths } = await loadWorkspaceWithPaths(opts.root as string);
        const consolidationPreviews = preview.results.map((item) => item.preview);
        const plan = buildLlmRunPlan({
          llm: {
            ...resolved,
            authSource: resolved.authSource ?? inferAuthSource(resolved),
          },
          previews: consolidationPreviews,
          candidateFiles: [],
          workItems: consolidationPreviews.map((item) => ({
            phase: 'consolidate' as const,
            serviceId: item.serviceId,
            id: item.serviceId,
          })),
          calls: {
            consolidate: consolidationPreviews.length,
            lexicon: 0,
            generateMax: 0,
            judgeMax: 0,
          },
          debugDir: await resolveContainedOutputPath(
            paths.root,
            relative(paths.root, paths.debugDir),
          ),
        });
        emitLlmRunPlan(plan, { machine, budget: await readLlmTokenBudget(opts.root as string) });
        const authorizedRun = await authorizeRun(
          opts.root as string,
          plan,
          resolved,
          {
            yes: opts.yes === true,
            isTTY: !machine && process.stdin.isTTY === true,
          },
        );
        try {
          result = await executeConsolidate({
            root: opts.root as string,
            serviceId: opts.service as string | undefined,
            authorizedRun,
          });
        } catch (error) {
          if (!machine && error instanceof CommandContractError) {
            for (const attempt of (error.result.data as RunConsolidateResult | null)?.attempts ?? []) {
              console.log(formatConsolidationAttempt(attempt));
            }
          }
          throw error;
        }
      }

      if (!machine) {
        for (const r of result.results) {
          const target = r.outputPath ?? '(dry-run)';
          const tokenInfo = ` · consolidation input ~${r.estimatedInputTokens} tokens (bytes / 4); output unknown, allowance ${r.maxOutputTokens ?? 32_768}`;
          console.log(
            `  ${chalk.cyan('•')} ${r.serviceId}: ${r.featureGroupCount} group(s)${tokenInfo} → ${target}`,
          );
        }
        for (const attempt of result.attempts ?? []) console.log(formatConsolidationAttempt(attempt));
        for (const notice of result.unverifiedIdReuse) {
          console.log(`  ${chalk.yellow('⚠')} ${formatUnverifiedIdReuse(notice)}`);
        }
      }
      const diagnostics: CommandDiagnostic[] = [
        ...result.skipped.map((skip) => ({
          code: 'SERVICE_SKIPPED',
          message: skip.reason,
          serviceId: skip.serviceId,
        })),
        ...result.unverifiedIdReuse.map((notice) => ({
          code: 'UNVERIFIED_ID_REUSE',
          message: formatUnverifiedIdReuse(notice),
          serviceId: notice.serviceId,
        })),
      ];
      recordCommandResult(program, {
        schema_version: 1,
        command: 'consolidate',
        status: result.skipped.length > 0 ? 'partial' : 'success',
        data: result,
        diagnostics,
      });
      // Use ctx for future user-facing strings; reference avoids unused-param lint.
      void ctx;
    });
}
