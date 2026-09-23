import { resolveLlmTokenLimits, readLlmTokenBudget, estimateConservativeLlmCallTokens, LlmTokenCapError } from '../lib/llm-cost-cap.js';
// `doklo generate` — per-feature LLM-driven Dok generation.
//
// Reads each service's consolidated cache, walks every consolidated
// feature, calls the LLM via @doklo-beta/generator.generateDokForFeature,
// and writes one .doklo/hub/doks/<DOK-ID>.json per success. Failures are
// surfaced in result.failures (whole run does not throw).

import { validateCurrentSourceFiles } from '../lib/current-source-policy.js';
import { assertRecordingSource, assertCacheSource } from '../lib/recording-branch.js';
import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { readFile, access, mkdir, readdir } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  assignDokIds,
  buildDokPromptParts,
  DOK_SOURCE_MAX_CHARS,
  capDokRolesForPrompt,
  carryForwardMeta,
  joinPromptParts,
  type PromptParts,
  parseConsolidatedFeatureConfig,
  deriveCodeMapping,
  deriveIA,
  detectPrioritySignals,
  mergePriority,
  generateDokForFeature,
  isLLMBackend,
  upsertOriginsByService,
  resolveContainedOutputPath,
  resolveContainedPath,
  renderDokFeatureBlock,
  type DokGenContext,
  type FeatureForGeneration,
  type GenerateDokResult,
  type GenerateDokOptions,
  type ConsolidatedFeatureConfig,
  type ConsolidatedFeature,
  type LLMBackend,
  type ProviderKind,
  finalizeGenerationLedger,
  reconcileSourceFeatures,
  validateDokForWrite,
  type ConsolidatedFeatureAccounting,
  type FeatureLedgerEntry,
  type GenerationLedger,
  type GenerationLedgerModel,
  type GenerationLedgerMetadata,
} from '@doklo-beta/generator';

/** Commander parser: reject misspelled --llm-backend values up front so a
 * typo fails with a clear message instead of silently routing to the wrong
 * backend (e.g. an unintended anthropic-api call failing on a missing key). */
function parseLlmBackend(value: string): LLMBackend {
  if (isLLMBackend(value)) return value;
  throw new InvalidArgumentError('Expected "claude-code" or "anthropic-api".');
}
import {
  extractRoleCandidates,
  mergeRoleCandidateSets,
  suggestRoleFromRoutePath,
} from '@doklo-beta/adapter-nextjs';
import {
  DokSchema,
  PathIdentityChangedError,
  PathOutsideRootError,
  ProjectIRSchema,
  RolesFileSchema,
  LexiconFileSchema,
  captureContainedPathIdentity,
  computeChangeProposal,
  computeLogicHash,
  lockedPriorityFields,
  readAnchorContents,
  unlinkContained,
  writeFileAtomicContained,
  type Dok,
  type DokHistoryCategory,
  type IaLabel,
  type ProjectIR,
  type RoleId,
  type LexiconTerm,
  type Service,
} from '@doklo-beta/core';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import { addLlmOptions, resolveLlmForRole } from '../lib/llm-options.js';
import {
  consolidatedCachePath,
  formatUnverifiedIdReuse,
  runConsolidate,
  type UnverifiedIdReuseNotice,
} from './consolidate.js';
import { scanCachePath, runScan, validateProjectIrPaths } from './scan.js';
import { hasValidatedTrackingEvidence, refreshTrackingMappings } from '../lib/tracking-recovery.js';
import { runServe } from './serve.js';
import { DEFAULT_STUDIO_PORT, pickStudioPort } from '../lib/studio-port.js';
import { InvalidRolesFileError, runRolesRefresh } from './roles.js';
import type { CliContext } from '../lib/context.js';
import {
  persistCodeMappingFile,
  persistIaFile,
  validateExistingCodeMappingFile,
  validateExistingIaFile,
  type LayerWriteResult,
} from '../lib/service-meta-files.js';
import type { WorkspacePaths } from '../lib/paths.js';
import { preflightExistingHubOutputs } from '../lib/hub-output-preflight.js';
import { createGenerateTokenUsage, recordGenerateUsage, type GenerateTokenUsage } from '../lib/generate-usage.js';
import { selectGenerationBatch } from '../lib/llm-batch.js';
import {
  formatGeneratePlan,
  estimateGenerateTokens,
  formatGateSummary,
  shouldPromptGate,
  runGateInteraction,
} from '../lib/generate-gate.js';
import {
  assertSupportedRuntimeProject,
} from '../lib/runtime-support.js';
import {
  CommandContractError,
  recordCommandResult,
  requireExplicitApproval,
  toCommandContractError,
  type CommandDiagnostic,
} from '../lib/command-result.js';
import {
  authorizeLlmRun,
  beginAuthorizedLlmCall,
  buildLlmRunPlan,
  completeAuthorizedLlmCall,
  emitLlmRunPlan,
  getAuthorizedLlmRunModel,
  getAuthorizedLlmRunPlanDigest,
  isSensitiveLlmPath,
  requireAuthorizedLlmRun,
  type AuthorizedLlmRun,
  type ConsolidationPreview,
  type LlmAuthSource,
  type LlmCandidateFile,
  type LlmPreparedCall,
  type LlmRunPlan,
} from '../lib/llm-preflight.js';

export interface GenerateDeps {
  generateDokForFeature: typeof generateDokForFeature;
  /** @deprecated `generate` never invokes paid lexicon suggestion work. */
  runLexiconSuggest?: unknown;
  runRolesRefresh: typeof runRolesRefresh;
  deriveIA: typeof deriveIA;
  deriveCodeMapping: typeof deriveCodeMapping;
  writeFileAtomicContained: typeof writeFileAtomicContained;
  now: () => string;
}

const DEFAULT_DEPS: GenerateDeps = {
  generateDokForFeature,
  runRolesRefresh,
  deriveIA,
  deriveCodeMapping,
  writeFileAtomicContained,
  now: () => new Date().toISOString(),
};

export interface GenerateCommandDeps {
  /** Dependencies passed to the real runGenerate pipeline. */
  runGenerateDeps: Partial<GenerateDeps>;
  resolveLlmForRole: typeof resolveLlmForRole;
  runConsolidate: typeof runConsolidate;
  authorizeLlmRun: typeof authorizeLlmRun;
}

export class ConsolidatedCacheMissingError extends Error {
  constructor(serviceId?: string) {
    super(serviceId
      ? `Service "${serviceId}" has no consolidated cache. Run \`doklo consolidate --service ${serviceId}\` first.`
      : 'No consolidated cache found. Run `doklo consolidate` first.');
    this.name = 'ConsolidatedCacheMissingError';
  }
}

export class GenerateServiceNotFoundError extends Error {
  constructor(serviceId: string) {
    super(`No service with id "${serviceId}" exists in workspace.json.`);
    this.name = 'GenerateServiceNotFoundError';
  }
}

export class GenerateScanCacheMissingError extends Error {
  constructor(serviceId: string) {
    super(`Service "${serviceId}" has no scan cache. Run \`doklo scan --service ${serviceId}\` first.`);
    this.name = 'GenerateScanCacheMissingError';
  }
}

export class GenerateDokIdCollisionError extends Error {
  constructor(dokId: string, firstServiceId: string, secondServiceId: string) {
    super(
      `Dok ID collision for "${dokId}" between services "${firstServiceId}" and "${secondServiceId}". ` +
        'Dok IDs must be unique across the workspace.',
    );
    this.name = 'GenerateDokIdCollisionError';
  }
}

export class GenerateUnknownDokIdError extends Error {
  constructor(dokIds: readonly string[]) {
    super(`Unknown Dok ID(s) in onlyDokIds: ${dokIds.join(', ')}`);
    this.name = 'GenerateUnknownDokIdError';
  }
}

export class InvalidConsolidatedCacheError extends Error {
  readonly cachePath: string;

  constructor(cachePath: string, cause: unknown) {
    super(`Consolidated cache is invalid: ${cachePath}`, { cause });
    this.name = 'InvalidConsolidatedCacheError';
    this.cachePath = cachePath;
  }
}

export class InvalidExistingDokError extends Error {
  readonly dokFile: string;
  readonly expectedDokId: string;

  constructor(dokFile: string, expectedDokId: string, cause: unknown) {
    const detail = cause instanceof Error ? ` (${cause.message})` : '';
    super(`Existing Dok "${expectedDokId}" is invalid: ${dokFile}${detail}`, { cause });
    this.name = 'InvalidExistingDokError';
    this.dokFile = dokFile;
    this.expectedDokId = expectedDokId;
  }
}

export type GenerateProgressEvent =
  | {
      stage: 'roles';
      status: 'updated' | 'unchanged' | 'skipped' | 'error';
      added: number;
      kept: number;
      error?: string;
    }
  | {
      stage: 'plan';
      /** Number of Doks that will be generated this run. */
      total: number;
      /** dok_ids skipped because their target file already exists (empty when force=true). */
      skippedExisting: string[];
    }
  | { stage: 'dok-start'; index: number; total: number; serviceId: string; dokId: string; featureLabel: string }
  | {
      stage: 'dok-done';
      index: number;
      total: number;
      serviceId: string;
      dokId: string;
      success: boolean;
      elapsedMs: number;
      error?: string;
    }
  | { stage: 'lexicon'; status: 'reused' | 'skipped'; termCount: number }
  | {
      stage: 'ia' | 'code-mapping';
      serviceId: string;
      status: 'written' | 'unchanged' | 'skipped' | 'error';
      count: number;
      error?: string;
    }
  | { stage: 'done'; succeeded: number; failed: number; layerFailed: number };

/**
 * Progress emitted by the Commander pipeline in addition to runGenerate's
 * existing deterministic-layer and Dok lifecycle events.
 */
export type GeneratePipelineProgressEvent =
  | {
      stage: 'scan';
      serviceId: string;
      status: 'running' | 'completed' | 'reused' | 'skipped';
      routes: number;
      components: number;
      reason?: string;
    }
  | {
      stage: 'consolidate';
      serviceId: string;
      status: 'running' | 'completed' | 'reused' | 'skipped';
      featureGroups: number;
      reason?: string;
    }
  | GenerateProgressEvent;

/**
 * A person's annotation for the Doks a run regenerates (`doklo sync --note`).
 * Staged into `_meta.pending_change` (source 'human'); never a history entry —
 * recording happens when a person approves the draft in Studio.
 */
export interface ProposalNote {
  change: string;
  category?: DokHistoryCategory;
}

export interface RunGenerateOptions {
  root: string;
  /** Cancels the current provider call and leaves remaining work retryable. */
  signal?: AbortSignal;
  dryRun?: boolean;
  serviceId?: string;
  /**
   * When false (default), Doks whose target file already exists under
   * .doklo/hub/doks/ are skipped. Lets you safely re-run \`generate\`
   * after a partial failure without paying for the LLM calls again.
   * When true, every Dok is regenerated and existing files are
   * overwritten.
   */
  force?: boolean;
  /**
   * Restrict generation to these dok_ids (as assigned by the deterministic
   * prefix counters). Used by `doklo sync` to regenerate only stale Doks.
   * Valid as long as the consolidated cache is unchanged since the ids were
   * assigned. Applied after the skip-existing pass; combine with force:true
   * to overwrite the existing files.
   */
  onlyDokIds?: string[];
  /**
   * Ignore existing approved Lexicon and suggestion-cache terminology hints.
   * Fresh paid suggestions are only produced by `doklo lexicon-suggest`.
   */
  noLexicon?: boolean;
  /** Skip deterministic role extraction and roles.json refresh. */
  noRoles?: boolean;
  /** Skip deterministic IA derivation and persistence. */
  noIa?: boolean;
  /** Skip deterministic code-mapping derivation and persistence. */
  noCodeMapping?: boolean;
  /** Streaming lifecycle events; lets the CLI render per-Dok progress lines. */
  onProgress?: (event: GenerateProgressEvent) => void;
  authorizedRun?: AuthorizedLlmRun;
  /** Digest of the exact approved LLM run plan bound to this generation. */
  planDigest?: string;
  /**
   * Human proposal to stage on every regenerated Dok. Without it a
   * deterministic structural comparison proposes instead (or nothing when the
   * regenerated content is identical). Never writes history, never reads a
   * clock — see the propose-and-approve model in the history pipeline spec.
   */
  proposalNote?: ProposalNote;
  preparedGeneration?: PreparedGenerationPayload;
}

export interface PreparedGenerationItem {
  readonly serviceId: string;
  readonly dokId: string;
  readonly feature: FeatureForGeneration;
  readonly ctx: DokGenContext;
  /** Canonical single-string prompt (= joinPromptParts(promptParts)) — what the trust gate digests. */
  readonly prompt: string;
  /** Split provider prompt actually sent (system = per-run-stable cacheable prefix). */
  readonly promptParts: PromptParts;
  readonly transmissions: readonly {
    phase: 'generate';
    serviceId: string;
    originServiceId?: string;
    codeRoot?: string;
    file: string;
    actualChars: number;
  }[];
}

export interface PreparedGenerationPayload {
  readonly items: readonly PreparedGenerationItem[];
}

export interface PreflightGenerateHubOptions {
  root: string;
  serviceId?: string;
  noLexicon?: boolean;
  noIa?: boolean;
  noCodeMapping?: boolean;
}

/**
 * Read-only trust-boundary check used before Commander auto-scan or paid
 * consolidation. Present Hub files must be valid and every enabled layer
 * target must resolve to a non-symlink path inside the workspace.
 */
export async function preflightGenerateHub(
  opts: PreflightGenerateHubOptions,
): Promise<void> {
  const { workspace, paths } = await loadWorkspaceWithPaths(opts.root);
  const selectedService = opts.serviceId
    ? workspace.services.find((service) => service.service_id === opts.serviceId)
    : undefined;
  if (opts.serviceId && !selectedService) {
    throw new GenerateServiceNotFoundError(opts.serviceId);
  }
  const services = selectedService ? [selectedService] : workspace.services;
  // Normalize malformed roles into a file-scoped error before the shared Hub
  // validator's raw JSON parser can erase the affected-file identity.
  await loadKnownRoles(
    paths.rolesFile,
    relative(paths.root, paths.rolesFile).replaceAll('\\', '/'),
  );
  // Validate all existing Doks, including files unrelated to the selected
  // service/generation plan, before auto-scan or paid consolidation can write.
  await preflightExistingHubOutputs({ root: opts.root });
  await preflightExistingHubFiles(paths, services, opts);
}

export interface GenerateOneResult {
  serviceId: string;
  dokId: string;
  outputPath: string;
}

export interface GenerateOneFailure {
  serviceId: string;
  dokId: string;
  reason: string;
  code?: string;
  retryable?: boolean;
  file?: string;
  preserved?: string[];
  nextCommand?: string;
}

export interface GeneratePlanItem {
  serviceId: string;
  dokId: string;
  featureLabel: string;
  domain: string;
}

export interface LayerFailure {
  layer: 'ia' | 'code-mapping';
  serviceId: string;
  reason: string;
}

export interface LayerResults {
  roles?: {
    status: 'updated' | 'unchanged' | 'skipped';
    added: number;
    kept: number;
  };
  ia: LayerWriteResult[];
  codeMapping: LayerWriteResult[];
}

export interface RunGenerateResult {
  tokenCapFailure?: { code: 'LLM_RUN_TOKEN_CAP' | 'LLM_TOTAL_TOKEN_CAP'; message: string };
  tokenUsage?: GenerateTokenUsage;
  results: GenerateOneResult[];
  failures: GenerateOneFailure[];
  /** dok_ids that already had a file on disk and were skipped (force=false). */
  skippedExisting: string[];
  /**
   * dok_ids whose deterministic source resolution produced no files, so they
   * were written with `_meta.source_anchors: []`. Surfaces the empty-anchor
   * rate (spec §8) instead of hiding unmapped Doks — high counts usually mean
   * the scan lacked an import graph or a stale consolidated cache was reused.
   */
  emptyAnchorDokIds: string[];
  /**
   * Hub Dok files no consolidated feature produces any more — a renamed,
   * merged, excluded or deleted feature leaves its documentation behind.
   * Reported for review; `generate` never deletes a Dok file. Empty for a
   * dry run or a partial run (single service / `onlyDokIds` / skipped
   * services), where the planned set does not cover the whole hub.
   */
  orphanedDokIds: string[];
  /** Populated when dryRun=true; lists what would be generated. */
  plan: GeneratePlanItem[];
  /** Deterministic layer writes completed by this run. */
  layers: LayerResults;
  /** Per-service post-layer failures; other services continue. */
  layerFailures: LayerFailure[];
  /** Contained, privacy-filtered source excerpts the paid run may transmit. */
  transmissions: LlmCandidateFile[];
  /** Immutable exact prompts/contexts prepared by a read-only dry run. */
  preparedGeneration?: PreparedGenerationPayload;
  generationLedger?: GenerationLedger;
  /** Stable recovery metadata when completed work could not be ledgered. */
  generationLedgerFailure?: GenerationLedgerFailure;
  /** True when generation stopped at a provider boundary after cancellation. */
  interrupted?: boolean;
}

export interface GenerationLedgerFailure {
  code: 'GENERATION_LEDGER_UNAVAILABLE';
  message: string;
  file: string;
  retryable: true;
  preserved: string[];
  nextCommand: 'doklo generate --yes';
}

interface GenerationAccounting {
  sourceFeatures: string[];
  consolidated: ConsolidatedFeatureAccounting[];
}

export async function runGenerate(
  opts: RunGenerateOptions,
  deps: Partial<GenerateDeps> = {},
): Promise<RunGenerateResult> {
  const {
    generateDokForFeature: generate,
    runRolesRefresh: refreshRoles,
    deriveIA: deriveServiceIA,
    deriveCodeMapping: deriveServiceCodeMapping,
    writeFileAtomicContained: writeContained,
    now,
  } = { ...DEFAULT_DEPS, ...deps };
  const startedAt = now();
  const { workspace, paths } = await loadWorkspaceWithPaths(opts.root);
  const recordingSource = await assertRecordingSource(paths.root);

  const selectedService = opts.serviceId
    ? workspace.services.find((service) => service.service_id === opts.serviceId)
    : undefined;
  if (opts.serviceId && !selectedService) {
    throw new GenerateServiceNotFoundError(opts.serviceId);
  }
  const services = selectedService ? [selectedService] : workspace.services;
  const serviceRoots = new Map<Service, string>();
  for (const service of services) {
    const serviceRoot = await resolveContainedPath(paths.root, service.code_root);
    await assertSupportedRuntimeProject(serviceRoot);
    serviceRoots.set(service, serviceRoot);
  }

  const results: GenerateOneResult[] = [];
  const failures: GenerateOneFailure[] = [];
  const emptyAnchorDokIds: string[] = [];
  const plan: GeneratePlanItem[] = [];
  const layers: LayerResults = { ia: [], codeMapping: [] };
  const layerFailures: LayerFailure[] = [];
  const transmissions: LlmCandidateFile[] = [];
  const interruptedDokIds = new Set<string>();
  let interrupted = false;
  let generationModel: GenerationLedgerModel = 'anthropic/claude-sonnet-5';
  const accountingByService = new Map<string, GenerationAccounting>();

  const emit = opts.onProgress ?? (() => {});
  const force = opts.force ?? false;

  // ── Pass 1: build the work list across services so we know N upfront. ──
  interface ServiceGenerationContext {
    serviceId: string;
    serviceRoot: string;
    codeRoot: string;
    consolidated: ConsolidatedFeatureConfig;
    ir: ProjectIR;
    iaPath?: string;
    codeMappingPath?: string;
  }
  interface PlannedItem {
    serviceId: string;
    serviceRoot: string;
    feature: ConsolidatedFeature;
    dokId: string;
    ir: ProjectIR | null;
    domain: string;
    consolidatedFile: string;
  }
  const allPlanned: PlannedItem[] = [];
  const serviceContexts: ServiceGenerationContext[] = [];
  const contextByServiceId = new Map<string, ServiceGenerationContext>();
  const skippedLayerServices = new Map<string, string>();
  const availableDokIds = new Set<string>();
  const availableDokNames = new Map<string, IaLabel>();
  const dokOutputPaths = new Map<string, string>();
  const dokOutputCapabilities = new Map<
    string,
    Awaited<ReturnType<typeof captureContainedPathIdentity>>
  >();
  let hasRoleScanCache = false;

  for (const svc of services) {
    const serviceRoot = serviceRoots.get(svc);
    if (serviceRoot === undefined) {
      throw new Error(`Missing validated service root for "${svc.service_id}".`);
    }
    const requestedCachePath = consolidatedCachePath(
      paths.cacheDir,
      svc.service_id,
    );
    const requestedCacheFile = relative(paths.root, requestedCachePath).replaceAll('\\', '/');
    if (isSensitiveLlmPath(requestedCacheFile)) {
      if (opts.serviceId) throw new ConsolidatedCacheMissingError(svc.service_id);
      skippedLayerServices.set(svc.service_id, 'sensitive consolidated cache excluded from LLM input');
      continue;
    }
    const cachePath = await resolveContainedPath(
      paths.root,
      requestedCacheFile,
      { allowMissingLeaf: true, rejectSymlinkLeaf: true },
    );
    const scanPath = await resolveContainedPath(
      paths.root,
      relative(paths.root, scanCachePath(paths.cacheDir, svc)),
      { allowMissingLeaf: true, rejectSymlinkLeaf: true },
    );
    const hasScan = await exists(scanPath);
    if (hasScan) {
      await assertCacheSource(paths.root, 'scan', svc.service_id, scanPath, recordingSource);
      hasRoleScanCache = true;
    }

    if (!(await exists(cachePath))) {
      if (opts.serviceId) throw new ConsolidatedCacheMissingError(svc.service_id);
      skippedLayerServices.set(
        svc.service_id,
        'no consolidated cache (run `doklo consolidate` first)',
      );
      continue;
    }

    await assertCacheSource(paths.root, 'consolidate', svc.service_id, cachePath, recordingSource);
    let consolidated = await loadConsolidatedCache(cachePath, requestedCachePath);
    await validateConsolidatedPaths(serviceRoot, consolidated);
    let ir: ProjectIR | null = null;
    if (!hasScan) {
      if (opts.serviceId) throw new GenerateScanCacheMissingError(svc.service_id);
      skippedLayerServices.set(
        svc.service_id,
        'no scan cache (run `doklo scan` first)',
      );
    } else {
      ir = ProjectIRSchema.parse(JSON.parse(await readFile(scanPath, 'utf-8')));
      await validateProjectIrPaths(serviceRoot, ir);
      if (hasValidatedTrackingEvidence(ir)) {
        consolidated = refreshTrackingMappings(consolidated, ir);
        await validateConsolidatedPaths(serviceRoot, consolidated);
      }
      const context: ServiceGenerationContext = {
        serviceId: svc.service_id,
        serviceRoot,
        codeRoot: svc.code_root
          .replaceAll('\\', '/')
          .replace(/^\.\//, '')
          .replace(/^\.$/, ''),
        consolidated,
        ir,
      };
      serviceContexts.push(context);
      contextByServiceId.set(context.serviceId, context);
    }

    const { assigned, accounting } = buildGenerationAccounting(consolidated);
    for (const group of consolidated.groups) {
      for (const feature of group.features) {
        const dokId = assigned.get(feature.canonical_id);
        if (!dokId) continue;
        allPlanned.push({
          serviceId: svc.service_id,
          serviceRoot,
          feature,
          dokId,
          ir,
          domain: group.label,
          consolidatedFile: requestedCacheFile,
        });
      }
    }
    accountingByService.set(svc.service_id, accounting);
  }

  // Dok IDs are workspace-global because every service writes into the same
  // hub/doks directory. Reject a collision before roles, LLMs, or filesystem
  // producers can mutate the workspace.
  const ownerByDokId = new Map<string, string>();
  for (const p of allPlanned) {
    const existingOwner = ownerByDokId.get(p.dokId);
    if (existingOwner !== undefined) {
      throw new GenerateDokIdCollisionError(p.dokId, existingOwner, p.serviceId);
    }
    ownerByDokId.set(p.dokId, p.serviceId);
  }
  if (opts.onlyDokIds !== undefined) {
    const knownDokIds = new Set(allPlanned.map((item) => item.dokId));
    const unknownDokIds = opts.onlyDokIds.filter((dokId) => !knownDokIds.has(dokId));
    if (unknownDokIds.length > 0) throw new GenerateUnknownDokIdError(unknownDokIds);
  }

  // ── Skip-existing pass (idempotent re-run). ──
  // When force=false (default), Doks whose target file already exists are
  // dropped from the work list. Lets the user safely re-run after a
  // partial failure without paying for the LLM calls a second time.
  const skippedExisting: string[] = [];
  const planned: PlannedItem[] = [];
  // Kept for the write path: a forced regeneration overwrites the file, so the
  // identity/audit half of its `_meta` has to be carried over from here.
  const existingDokByPlannedId = new Map<string, Dok>();
  for (const p of allPlanned) {
    const relativeDokPath = relative(paths.root, paths.dokFile(p.dokId)).replaceAll('\\', '/');
    const dokFile = await resolveContainedOutputPath(
      paths.root,
      relativeDokPath,
    );
    dokOutputPaths.set(p.dokId, dokFile);
    if (!opts.dryRun) {
      await mkdir(dirname(dokFile), { recursive: true });
      dokOutputCapabilities.set(
        p.dokId,
        await captureContainedPathIdentity(paths.root, relativeDokPath, { allowMissingLeaf: true }),
      );
    }
    if (await exists(dokFile)) {
      const existingDok = await validateExistingDok(dokFile, p.dokId);
      existingDokByPlannedId.set(p.dokId, existingDok);
      availableDokIds.add(p.dokId);
      availableDokNames.set(p.dokId, existingDok.name);
      if (!force) {
        skippedExisting.push(p.dokId);
        continue;
      }
    }
    planned.push(p);
  }

  // Reconcile the shape before any role refresh, LLM call, or Hub write. The
  // final ledger repeats this transition with concrete failure reasons.
  for (const [serviceId, accounting] of accountingByService) {
    reconcileSourceFeatures({
      sourceFeatures: accounting.sourceFeatures,
      consolidated: accounting.consolidated,
      serviceId,
    });
  }

  // ── onlyDokIds filter (drift-driven regeneration). ──
  // `doklo sync` regenerates only the Doks it judged stale. The ids are the
  // semantic ids, stable via reconciliation while the consolidated cache is
  // unchanged. Applied after skip-existing so the two passes compose; sync
  // pairs it with force:true to actually overwrite the stale files. When
  // onlyDokIds is absent this is a no-op (workList === planned).
  const workList = opts.onlyDokIds
    ? planned.filter((p) => opts.onlyDokIds!.includes(p.dokId))
    : planned;
  const prospectiveRolePlan = opts.noRoles
    ? { roles: [], sources: [] }
    : buildProspectiveRolePlan(serviceContexts);

  // Resolve legacy route fallbacks before checking current permission. Batch by
  // service so a many-Dok preview inventories Git once, not once per document.
  const currentFilesByRoot = new Map<string, Set<string>>();
  for (const item of workList) {
    const feature = buildFeatureForGeneration(item.feature, item.ir);
    const files = currentFilesByRoot.get(item.serviceRoot) ?? new Set<string>();
    for (const file of [...feature.files, ...(feature.logic_files ?? [])]) files.add(file);
    currentFilesByRoot.set(item.serviceRoot, files);
  }
  for (const [root, files] of currentFilesByRoot) {
    await validateCurrentSourceFiles(root, files);
  }

  for (const item of workList) {
    transmissions.push({
      phase: 'generate',
      serviceId: item.serviceId,
      file: item.consolidatedFile,
      maxChars: 12_000,
      dokId: item.dokId,
    });
    const forGen = buildFeatureForGeneration(item.feature, item.ir);
    for (const file of forGen.files) {
      await resolveContainedPath(item.serviceRoot, file);
      transmissions.push({
        phase: 'generate',
        serviceId: item.serviceId,
        file: file.replaceAll('\\', '/'),
        maxChars: DOK_SOURCE_MAX_CHARS,
        dokId: item.dokId,
      });
    }
    for (const source of prospectiveRolePlan.sources) {
      await resolveContainedPath(paths.root, source.workspaceRelativeFile);
      transmissions.push({
        phase: 'generate',
        serviceId: item.serviceId,
        originServiceId: source.originServiceId,
        codeRoot: source.codeRoot,
        file: source.workspaceRelativeFile,
        maxChars: 12_000,
        dokId: item.dokId,
      });
    }
  }
  transmissions.sort((a, b) =>
    a.serviceId.localeCompare(b.serviceId) || a.file.localeCompare(b.file));

  // Global read-only barrier: every enabled existing layer must be valid for
  // every selected service before roles, lexicon, LLMs, or any Hub write.
  const hubPreflight = await preflightExistingHubFiles(paths, services, opts);
  const trustPreflight = await preflightExistingHubOutputs({ root: opts.root });
  if (await exists(hubPreflight.rolesPath)) {
    for (const item of workList) {
      transmissions.push({
        phase: 'generate',
        serviceId: item.serviceId,
        file: relative(paths.root, paths.rolesFile).replaceAll('\\', '/'),
        maxChars: 12_000,
        dokId: item.dokId,
      });
    }
  }
  if (!opts.noLexicon) {
    for (const item of workList) {
      if (hubPreflight.lexiconPath !== undefined) {
        transmissions.push({
          phase: 'generate',
          serviceId: item.serviceId,
          file: relative(paths.root, paths.lexiconFile).replaceAll('\\', '/'),
          maxChars: 12_000,
          dokId: item.dokId,
        });
      }
      if (hubPreflight.lexiconSuggestionPath !== undefined) {
        transmissions.push({
          phase: 'generate',
          serviceId: item.serviceId,
          file: relative(paths.root, join(paths.cacheDir, 'lexicon-suggestions.json')).replaceAll('\\', '/'),
          maxChars: 12_000,
          dokId: item.dokId,
        });
      }
    }
  }
  transmissions.sort((a, b) =>
    a.serviceId.localeCompare(b.serviceId)
    || (a.dokId ?? '').localeCompare(b.dokId ?? '')
    || a.file.localeCompare(b.file));
  for (const context of serviceContexts) {
    const layerPaths = hubPreflight.byService.get(context.serviceId);
    context.iaPath = layerPaths?.iaPath;
    context.codeMappingPath = layerPaths?.codeMappingPath;
  }

  const preparedGeneration = opts.dryRun
    ? await prepareGenerationPayload({
        workList,
        transmissions,
        workspaceLocale: workspace.default_locale,
        rolesPath: hubPreflight.rolesPath,
        rolesFile: relative(paths.root, paths.rolesFile).replaceAll('\\', '/'),
        lexiconPath: hubPreflight.lexiconPath ?? paths.lexiconFile,
        suggestionPath: hubPreflight.lexiconSuggestionPath
          ?? join(paths.cacheDir, 'lexicon-suggestions.json'),
        noLexicon: opts.noLexicon === true,
        prospectiveRolePlan,
        existingDoks: existingDokByPlannedId,
      })
    : opts.preparedGeneration;
  const contributingTransmissions = preparedGeneration === undefined
    ? transmissions
    : selectContributingTransmissions(transmissions, preparedGeneration);

  // ── Dry-run short-circuit. ──
  if (opts.dryRun) {
    for (const p of workList) {
      plan.push({ serviceId: p.serviceId, dokId: p.dokId, featureLabel: p.feature.label, domain: p.domain });
    }
    return {
      results,
      failures,
      skippedExisting,
      emptyAnchorDokIds,
      orphanedDokIds: [],
      plan,
      layers,
      layerFailures,
      transmissions: contributingTransmissions,
      preparedGeneration,
      generationLedger: undefined,
    };
  }

  let approvedPlanDigest = opts.planDigest?.trim() || undefined;
  if (workList.length > 0) {
    await requireAuthorizedLlmRun(opts.authorizedRun, opts.root);
    const boundPlanDigest = await getAuthorizedLlmRunPlanDigest(opts.authorizedRun, opts.root);
    generationModel = await getAuthorizedLlmRunModel(opts.authorizedRun, opts.root);
    approvedPlanDigest ??= boundPlanDigest;
    if (opts.planDigest !== undefined && opts.planDigest !== boundPlanDigest) {
      throw new CommandContractError({
        schema_version: 1,
        command: 'llm',
        status: 'cancelled',
        data: null,
        diagnostics: [{
          code: 'LLM_PLAN_DIGEST_MISMATCH',
          message: 'Generation plan digest does not match the authorized run.',
        }],
      }, 2);
    }
    if (!preparedGeneration || preparedGeneration.items.length !== workList.length) {
      throw new CommandContractError({
        schema_version: 1,
        command: 'llm',
        status: 'cancelled',
        data: null,
        diagnostics: [{
          code: 'LLM_PREPARED_PAYLOAD_REQUIRED',
          message: 'Paid generation requires its immutable read-only prepared payload.',
        }],
      }, 2);
    }
  }

  // ── Roles pre-pass: refresh the registry before building any Dok context. ──
  if (opts.noRoles || !hasRoleScanCache) {
    layers.roles = { status: 'skipped', added: 0, kept: 0 };
    emit({ stage: 'roles', status: 'skipped', added: 0, kept: 0 });
  } else {
    try {
      const roleResult = await refreshRoles({
        root: opts.root,
        apply: true,
        ...(opts.serviceId === undefined ? {} : { serviceId: opts.serviceId }),
      });
      const roleStatus = roleResult.written ? 'updated' : 'unchanged';
      layers.roles = {
        status: roleStatus,
        added: roleResult.added.length,
        kept: roleResult.kept.length,
      };
      emit({
        stage: 'roles',
        status: roleStatus,
        added: roleResult.added.length,
        kept: roleResult.kept.length,
      });
    } catch (error) {
      const reason = errorMessage(error);
      emit({ stage: 'roles', status: 'error', added: 0, kept: 0, error: reason });
      throw error;
    }
  }

  // Generation only reuses the exact approved/cache terminology already
  // captured in the immutable prepared prompts. Paid suggestion work is a
  // separate, explicitly approved `doklo lexicon-suggest` command.
  if (opts.noLexicon) {
    emit({ stage: 'lexicon', status: 'skipped', termCount: 0 });
  } else if (workList.length > 0) {
    const termCount = new Set(
      preparedGeneration?.items.flatMap((item) => item.ctx.lexiconTerms ?? []) ?? [],
    ).size;
    emit({ stage: 'lexicon', status: 'reused', termCount });
  }

  const tokenUsage = createGenerateTokenUsage();
  let tokenCapFailure: { code: 'LLM_RUN_TOKEN_CAP' | 'LLM_TOTAL_TOKEN_CAP'; message: string } | undefined;
  const retainTokenCapFailure = (error: unknown): boolean => {
    if (!(error instanceof CommandContractError)) return false;
    const diagnostic = error.result.diagnostics.find((item) =>
      item.code === 'LLM_RUN_TOKEN_CAP' || item.code === 'LLM_TOTAL_TOKEN_CAP');
    if (!diagnostic) return false;
    tokenCapFailure = {
      code: diagnostic.code as 'LLM_RUN_TOKEN_CAP' | 'LLM_TOTAL_TOKEN_CAP',
      message: diagnostic.message,
    };
    return true;
  };
  const settleCall = async (
    call: Awaited<ReturnType<typeof beginAuthorizedLlmCall>>,
    usage: GenerateDokResult['usage'],
  ): Promise<void> => {
    try {
      await completeAuthorizedLlmCall(opts.authorizedRun, opts.root, call, usage);
    } catch (error) {
      // Reconciliation persists measured usage before reporting a cap breach.
      // Preserve this call's outcome and finalize the Hub before cancellation.
      if (!retainTokenCapFailure(error)) throw error;
    }
  };

  // ── Pass 2: actually generate each Dok with progress events. ──
  emit({ stage: 'plan', total: workList.length, skippedExisting });

  for (let i = 0; i < workList.length; i++) {
    if (tokenCapFailure) {
      for (const pending of workList.slice(i)) interruptedDokIds.add(pending.dokId);
      break;
    }
    if (opts.signal?.aborted) {
      interrupted = true;
      for (const pending of workList.slice(i)) interruptedDokIds.add(pending.dokId);
      break;
    }
    const p = workList[i]!;
    const preparedItem = preparedGeneration!.items[i]!;
    if (preparedItem.serviceId !== p.serviceId || preparedItem.dokId !== p.dokId) {
      throw new CommandContractError({
        schema_version: 1,
        command: 'llm',
        status: 'cancelled',
        data: null,
        diagnostics: [{
          code: 'LLM_PREPARED_PAYLOAD_CHANGED',
          message: 'Prepared generation work list changed after approval.',
        }],
      }, 2);
    }
    const total = workList.length;
    const index = i + 1;
    const projectRoot = p.serviceRoot;

    const forGen = preparedItem.feature;
    const ctx = preparedItem.ctx;

    // Approval preserves the prepared payload, but source access may have
    // changed since preview. Check the exact payload before authorizing a call.
    await validateCurrentSourceFiles(projectRoot, new Set([
      ...forGen.files,
      ...(forGen.logic_files ?? []),
      ...Object.keys(ctx.fileContext),
    ]));

    emit({
      stage: 'dok-start',
      index,
      total,
      serviceId: p.serviceId,
      dokId: p.dokId,
      featureLabel: p.feature.label,
    });

    let authorizedCall: Awaited<ReturnType<typeof beginAuthorizedLlmCall>>;
    try {
      authorizedCall = await beginAuthorizedLlmCall(opts.authorizedRun, opts.root, {
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: p.serviceId, id: p.dokId },
        debugDir: hubPreflight.debugDir,
        transmissions: preparedItem.transmissions,
        prompt: preparedItem.prompt,
      });
    } catch (error) {
      if (!retainTokenCapFailure(error)) throw error;
      for (const pending of workList.slice(i)) interruptedDokIds.add(pending.dokId);
      break;
    }
    const generateOpts: GenerateDokOptions = {
      debugDir: hubPreflight.debugDir,
      model: authorizedCall.model,
      providerKind: authorizedCall.providerKind,
      apiKey: authorizedCall.apiKey,
      ...(authorizedCall.baseURL === undefined ? {} : { baseURL: authorizedCall.baseURL }),
      ...(authorizedCall.fetch === undefined ? {} : { fetch: authorizedCall.fetch }),
      // beginAuthorizedLlmCall verified that preparedItem.prompt — which is
      // joinPromptParts(preparedItem.promptParts) by construction — matches
      // the approved plan digest byte-for-byte, so sending the split parts
      // sends exactly the authorized prompt.
      preparedPrompt: preparedItem.promptParts,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    };
    const t0 = Date.now();
    let llmResult: GenerateDokResult;
    try {
      llmResult = await generate(forGen, ctx, generateOpts);
    } catch (error) {
      await settleCall(authorizedCall, null);
      if (opts.signal?.aborted) {
        interrupted = true;
        for (const pending of workList.slice(i)) interruptedDokIds.add(pending.dokId);
        break;
      }
      throw error;
    }
    recordGenerateUsage(tokenUsage, preparedItem.prompt, llmResult.usage);
    const elapsedMs = Date.now() - t0;

    if (opts.signal?.aborted || llmResult.interrupted) {
      await settleCall(authorizedCall, llmResult.usage);
      interrupted = true;
      for (const pending of workList.slice(i)) interruptedDokIds.add(pending.dokId);
      break;
    }

    if (!llmResult.success || !llmResult.dok) {
      await settleCall(authorizedCall, llmResult.usage);
      if (opts.signal?.aborted) {
        interrupted = true;
        for (const pending of workList.slice(i)) interruptedDokIds.add(pending.dokId);
        break;
      }
      const reason = llmResult.error ?? 'unknown LLM failure';
      const retryableFailure = llmResult.failureKind === 'rate_limit'
        ? retryableGenerationFailure(
            'PROVIDER_RATE_LIMITED',
            paths.root,
            paths.dokFile(p.dokId),
            results,
            skippedExisting,
          )
        : llmResult.failureKind === 'truncated_response'
          ? retryableGenerationFailure(
              'PROVIDER_RESPONSE_TRUNCATED',
              paths.root,
              paths.dokFile(p.dokId),
              results,
              skippedExisting,
            )
          : {};
      failures.push({
        serviceId: p.serviceId,
        dokId: p.dokId,
        reason,
        ...retryableFailure,
      });
      emit({
        stage: 'dok-done',
        index,
        total,
        serviceId: p.serviceId,
        dokId: p.dokId,
        success: false,
        elapsedMs,
        error: reason,
      });
      continue;
    }
    await settleCall(authorizedCall, llmResult.usage);
    if (opts.signal?.aborted) {
      interrupted = true;
      for (const pending of workList.slice(i)) interruptedDokIds.add(pending.dokId);
      break;
    }

    // Deterministic provenance injection — stamp the feature's source files
    // onto the Dok as `_meta.source_anchors`. These are facts carried from the
    // project IR (entry page + reachable code), never an LLM guess, so they
    // can't hallucinate a source. This is the trust layer's floor and the
    // input drift detection (logic_hash) hashes.
    //
    // Also stamp `anchor_service_id`: the service these anchors were resolved
    // against (its `code_root` is the base the paths are relative to). We know
    // it deterministically here (p.serviceId), so drift can resolve paths off it
    // instead of the LLM-authored `surfaces` — see dokProjectRoot.
    const dok = llmResult.dok;
    // Human review state is not model-authoritative. Keep this boundary even
    // when a custom generator dependency bypasses the standard response parser.
    dok.status = 'draft';
    const anchors = forGen.files.map((file) => ({ file }));
    dok._meta = { ...dok._meta, source_anchors: anchors, anchor_service_id: p.serviceId };

    // Drift input: hash the drift file set's current content into _meta.logic_hash
    // so a later `doklo status` can detect when the code drifted from this Dok.
    // The drift set is `logic_files` when present — the full reachable closure
    // incl. shared infra, a superset of the display `source_anchors` — so a change
    // to a shared dependency this feature reaches is still caught (B1). Legacy
    // caches without logic_files fall back to the display files (drift set ==
    // display set → hash unchanged). Read the full set (not the 4-file LLM context
    // slice) so the hash covers all provenance; omitted when there is nothing to
    // hash. Record the exact set hashed as _meta.logic_files so verify re-hashes
    // the identical set (compute ≡ verify).
    //
    // The read itself comes from core — the same function drift verification
    // calls — so compute and verify cannot disagree about which anchors are
    // readable. A local copy of that loop is what let containment land on the
    // generate side only, structurally false-staling every Dok with an anchor
    // path that escapes the project root.
    const driftFiles = forGen.logic_files ?? forGen.files;
    const anchorRead = await readAnchorContents(driftFiles, projectRoot);
    const anchorContents = anchorRead.contents;
    const logicHash = computeLogicHash(anchorContents);
    if (logicHash) {
      dok._meta.logic_hash = logicHash;
      dok._meta.logic_files = driftFiles.map((file) => ({ file }));
    }

    // Priority evidence — deterministic, over the exact contents the drift
    // hash just read, so it costs no extra I/O. Signals justify an axis; they
    // never set one. The merge then puts back any axis a person pinned, and
    // drops the previous run's signals so a moved file leaves no dead anchor.
    dok.priority = mergePriority(
      dok.priority === undefined
        ? undefined
        : {
            ...dok.priority,
            signals: detectPrioritySignals({
              files: driftFiles,
              contents: new Map(anchorContents.map((read) => [read.file, read.content])),
            }),
          },
      existingDokByPlannedId.get(p.dokId)?.priority,
    );

    // Identity carry-forward — the fresh Dok above describes today's code, but
    // the file it replaces owns its own history. Version, audit trail, external
    // ids, creation time and the previous ids/origins that keep links resolving
    // after a rename all survive the regeneration (see carryForwardMeta), and
    // this run's provenance replaces this service's origin entry so the next
    // consolidation recognizes the feature as it is now — not as it was named
    // some earlier run (see upsertOriginsByService). Other services' entries stay.
    dok._meta = carryForwardMeta(existingDokByPlannedId.get(p.dokId)?._meta, dok._meta);
    // Resolver evidence is deterministic, never model-authored. Legacy scans
    // and partial reads cannot establish a new trusted baseline.
    delete dok._meta.tracking_version;
    delete dok._meta.tracking_review_required;
    if (p.ir && hasValidatedTrackingEvidence(p.ir) && driftFiles.length > 0 && anchorRead.missing.length === 0 && logicHash) {
      dok._meta.tracking_version = 2;
    } else if (existingDokByPlannedId.get(p.dokId)?._meta.tracking_review_required) {
      dok._meta.tracking_review_required = true;
    }

    // Propose-and-approve (§0b): a regeneration of an existing Dok stages a
    // change proposal for the person who will approve the draft. A human note
    // (sync --note) wins; otherwise a deterministic structural comparison
    // proposes — or stays silent when the regenerated content is identical.
    // Never an entry and never a clock: recording happens at approval.
    const existingForProposal = existingDokByPlannedId.get(p.dokId);
    delete dok._meta.pending_change;
    if (existingForProposal !== undefined) {
      const note = opts.proposalNote;
      const proposed = note !== undefined
        ? { summary: note.change, source: 'human' as const, ...(note.category !== undefined ? { category: note.category } : {}) }
        : (() => {
            const diff = computeChangeProposal(existingForProposal, dok);
            return diff === null ? undefined : { summary: diff.summary, source: 'diff' as const };
          })();
      if (proposed !== undefined) {
        dok._meta.pending_change = {
          ...proposed,
          base_version: existingForProposal._meta.version,
          previous_status: existingForProposal.status,
        };
      }
    }

    dok._meta.origins = upsertOriginsByService(dok._meta.origins, [{
      service_id: p.serviceId,
      canonical_feature_id: p.feature.canonical_id,
      ...(p.feature.primary_route ? { primary_route: p.feature.primary_route } : {}),
    }]);

    let canonicalDok: Awaited<ReturnType<typeof validateDokForWrite>>;
    try {
      const knownRoleIds = new Set(await loadKnownRoles(hubPreflight.rolesPath));
      canonicalDok = await validateDokForWrite(dok, {
        expectedDokId: p.dokId,
        expectedStatus: 'draft',
        serviceRoots: trustPreflight.serviceRoots,
        knownRoleIds,
      });
    } catch (error) {
      const reason = `Generated Dok "${p.dokId}" is invalid: ${errorMessage(error)}`;
      failures.push({ serviceId: p.serviceId, dokId: p.dokId, reason });
      emit({
        stage: 'dok-done',
        index,
        total,
        serviceId: p.serviceId,
        dokId: p.dokId,
        success: false,
        elapsedMs,
        error: reason,
      });
      continue;
    }

    const outputPath = dokOutputPaths.get(p.dokId);
    const outputCapability = dokOutputCapabilities.get(p.dokId);
    if (!outputPath || !outputCapability) {
      throw new Error(`Missing preflight output path for Dok "${p.dokId}".`);
    }
    // Ensure the hub doks dir exists — a workspace may be missing it (legacy
    // layout, deleted .doklo/hub, or scan/consolidate run without a fresh init).
    try {
      await mkdir(dirname(outputPath), { recursive: true });
      const relativeDokPath = relative(paths.root, paths.dokFile(p.dokId)).replaceAll('\\', '/');
      await writeCapturedFileAtomicContained(
        writeContained,
        paths.root,
        relativeDokPath,
        JSON.stringify(canonicalDok, null, 2) + '\n',
        outputCapability,
      );
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      const reason = 'The Dok could not be written because its destination is not writable.';
      failures.push({
        serviceId: p.serviceId,
        dokId: p.dokId,
        reason,
        ...retryableGenerationFailure(
          'PERMISSION_DENIED',
          paths.root,
          paths.dokFile(p.dokId),
          results,
          skippedExisting,
        ),
      });
      emit({
        stage: 'dok-done',
        index,
        total,
        serviceId: p.serviceId,
        dokId: p.dokId,
        success: false,
        elapsedMs,
        error: reason,
      });
      continue;
    }
    if (anchors.length === 0) emptyAnchorDokIds.push(p.dokId);
    availableDokIds.add(p.dokId);
    availableDokNames.set(p.dokId, canonicalDok.name);
    results.push({
      serviceId: p.serviceId,
      dokId: p.dokId,
      outputPath: paths.dokFile(p.dokId),
    });
    emit({
      stage: 'dok-done',
      index,
      total,
      serviceId: p.serviceId,
      dokId: p.dokId,
      success: true,
      elapsedMs,
    });
  }

  // Only Doks validated during preflight or after generation may be referenced
  // by the deterministic service layers.

  // ── IA post-pass. Errors are isolated per service. ──
  for (const svc of services) {
    const context = contextByServiceId.get(svc.service_id);
    const skippedReason = skippedLayerServices.get(svc.service_id);
    if (opts.noIa || !context) {
      emit({
        stage: 'ia',
        serviceId: svc.service_id,
        status: 'skipped',
        count: 0,
        ...(skippedReason === undefined ? {} : { error: skippedReason }),
      });
      continue;
    }

    try {
      const derived = deriveServiceIA({
        ...context,
        availableDokIds,
        dokNames: availableDokNames,
      });
      const persisted = await persistIaFile(
        paths.root,
        context.iaPath ?? paths.serviceIa(context.serviceId),
        derived,
        now(),
        // Migrating a legacy file must not resurrect a binding to a Dok that no
        // longer exists, so the writer sees the same catalog the producer saw.
        { availableDokIds },
      );
      layers.ia.push(persisted);
      emit({
        stage: 'ia',
        serviceId: context.serviceId,
        status: persisted.status,
        count: persisted.count,
      });
    } catch (error) {
      const reason = errorMessage(error);
      layerFailures.push({ layer: 'ia', serviceId: context.serviceId, reason });
      emit({
        stage: 'ia',
        serviceId: context.serviceId,
        status: 'error',
        count: 0,
        error: reason,
      });
    }
  }

  // ── Code-mapping post-pass. It runs even when another service/layer failed. ──
  for (const svc of services) {
    const context = contextByServiceId.get(svc.service_id);
    const skippedReason = skippedLayerServices.get(svc.service_id);
    if (opts.noCodeMapping || !context) {
      emit({
        stage: 'code-mapping',
        serviceId: svc.service_id,
        status: 'skipped',
        count: 0,
        ...(skippedReason === undefined ? {} : { error: skippedReason }),
      });
      continue;
    }

    try {
      const derived = await deriveServiceCodeMapping({ ...context, availableDokIds });
      const persisted = await persistCodeMappingFile(
        paths.root,
        context.codeMappingPath ?? paths.serviceCodeMapping(context.serviceId),
        derived,
        now(),
      );
      layers.codeMapping.push(persisted);
      emit({
        stage: 'code-mapping',
        serviceId: context.serviceId,
        status: persisted.status,
        count: persisted.count,
      });
    } catch (error) {
      const reason = errorMessage(error);
      layerFailures.push({ layer: 'code-mapping', serviceId: context.serviceId, reason });
      emit({
        stage: 'code-mapping',
        serviceId: context.serviceId,
        status: 'error',
        count: 0,
        error: reason,
      });
    }
  }

  // ── Orphan detection. ──
  // Dok files no consolidated feature produces any more: a feature the model
  // now merges or excludes, a deleted route, or a pre-reconciliation rename.
  // Reported, never deleted — the file may carry reviewed prose or external
  // links, so removal is the user's call. Only computed for a run that planned
  // the whole workspace; a partial run has no way to tell a stale file from one
  // owned by a service it never looked at.
  const orphanedDokIds =
    opts.serviceId === undefined
    && opts.onlyDokIds === undefined
    && skippedLayerServices.size === 0
      ? await findOrphanedDokIds(paths, new Set(allPlanned.map((item) => item.dokId)))
      : [];

  // Persist the complete source-feature accounting only after all Hub layer
  // writes have finished. The atomic ledger remains available on partial runs.
  const generationLedgerEntries: FeatureLedgerEntry[] = [];
  const generatedDokIds = new Set(results.map((result) => result.dokId));
  const selectedDokIds = new Set(workList.map((item) => item.dokId));
  for (const [serviceId, accounting] of accountingByService) {
    const failedByDok = new Map(
      failures
        .filter((failure) => failure.serviceId === serviceId)
        .map((failure) => [failure.dokId, failure.reason]),
    );
    const consolidated = accounting.consolidated.map((entry) => ({
      ...entry,
      // `onlyDokIds` intentionally leaves the other source features outside
      // this run. They are settled as preserved/skipped (and never falsely
      // reported as generated); an existing file is additionally represented
      // in `availableDokIds` when the normal skip-existing pass saw it.
      existing: entry.dokId !== undefined
        && !generatedDokIds.has(entry.dokId)
        && availableDokIds.has(entry.dokId),
      notSelected: entry.dokId !== undefined
        && !generatedDokIds.has(entry.dokId)
        && !selectedDokIds.has(entry.dokId)
        && !availableDokIds.has(entry.dokId),
      interrupted: entry.dokId !== undefined
        && !generatedDokIds.has(entry.dokId)
        && interruptedDokIds.has(entry.dokId),
      ...(entry.dokId !== undefined && failedByDok.has(entry.dokId)
        ? { failed: failedByDok.get(entry.dokId) }
        : {}),
    }));
    generationLedgerEntries.push(...reconcileSourceFeatures({
      sourceFeatures: accounting.sourceFeatures,
      consolidated,
      serviceId,
    }));
  }
  let generationLedger: GenerationLedger | undefined;
  let generationLedgerFailure: GenerationLedgerFailure | undefined;
  try {
    generationLedger = await persistGenerationLedger(paths, generationLedgerEntries, {
      workspaceId: workspace.workspace_id,
      model: generationModel,
      // An all-existing run has no paid LLM plan; keep the ledger identity
      // explicit rather than deriving a digest from its entries.
      planDigest: approvedPlanDigest ?? 'none',
      startedAt,
      completedAt: now(),
    }, writeContained);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    generationLedgerFailure = {
      code: 'GENERATION_LEDGER_UNAVAILABLE',
      message: 'Generation completed, but its recovery ledger could not be written.',
      file: relative(paths.root, paths.generationLedgerFile).replaceAll('\\', '/'),
      retryable: true,
      preserved: preservedGenerationFiles(paths.root, results, skippedExisting),
      nextCommand: 'doklo generate --yes',
    };
  }

  emit({
    stage: 'done',
    succeeded: results.length,
    failed: failures.length,
    layerFailed: layerFailures.length,
  });

  return {
    results,
    failures,
    skippedExisting,
    emptyAnchorDokIds,
    orphanedDokIds,
    plan,
    layers,
    layerFailures,
    transmissions: contributingTransmissions,
    generationLedger,
    tokenUsage,
    ...(tokenCapFailure === undefined ? {} : { tokenCapFailure }),
    ...(generationLedgerFailure === undefined ? {} : { generationLedgerFailure }),
    ...(interrupted ? { interrupted: true } : {}),
  };
}

/**
 * Hub Dok files whose id no planned feature produces. Sorted, ids only.
 *
 * Advisory: this runs after the Doks are already written but before the
 * recovery ledger, so an unreadable directory must cost the user a warning, not
 * the run. Any read failure degrades to "no orphans reported".
 */
async function findOrphanedDokIds(
  paths: WorkspacePaths,
  plannedDokIds: ReadonlySet<string>,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.doksDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .filter((dokId) => dokId.length > 0 && !plannedDokIds.has(dokId))
    .sort();
}

function buildGenerationAccounting(consolidated: ConsolidatedFeatureConfig): {
  assigned: Map<string, string>;
  accounting: GenerationAccounting;
} {
  const assigned = assignDokIds(consolidated);
  const accounting: GenerationAccounting = {
    sourceFeatures: [],
    consolidated: [],
  };
  const hasIndependentInventory = consolidated.originalFeatureIds !== undefined;
  if (hasIndependentInventory) {
    accounting.sourceFeatures.push(...consolidated.originalFeatureIds!);
  }
  for (const group of consolidated.groups) {
    for (const feature of group.features) {
      const dokId = assigned.get(feature.canonical_id);
      if (!hasIndependentInventory) accounting.sourceFeatures.push(...feature.members);
      accounting.consolidated.push({
        canonicalFeatureId: feature.canonical_id,
        sourceFeatureIds: feature.members,
        excluded: feature.decision === 'exclude',
        ...(dokId === undefined ? {} : { dokId }),
      });
    }
    for (const excluded of group.excluded) {
      if (!hasIndependentInventory) accounting.sourceFeatures.push(excluded.id);
      accounting.consolidated.push({
        canonicalFeatureId: excluded.id,
        sourceFeatureIds: [excluded.id],
        excluded: true,
      });
    }
  }
  return { assigned, accounting };
}

async function persistGenerationLedger(
  paths: WorkspacePaths,
  entries: readonly FeatureLedgerEntry[],
  metadata: GenerationLedgerMetadata,
  writeContained: typeof writeFileAtomicContained,
): Promise<GenerationLedger> {
  const ledger = finalizeGenerationLedger(entries, metadata);
  await mkdir(paths.cacheDir, { recursive: true });
  const relativeLedgerPath = relative(
    paths.root,
    paths.generationLedgerFile,
  ).replaceAll('\\', '/');
  const outputCapability = await captureContainedPathIdentity(
    paths.root,
    relativeLedgerPath,
    { allowMissingLeaf: true },
  );
  await writeCapturedFileAtomicContained(
    writeContained,
    paths.root,
    relativeLedgerPath,
    JSON.stringify(ledger, null, 2) + '\n',
    outputCapability,
  );
  return ledger;
}

async function writeCapturedFileAtomicContained(
  writeContained: typeof writeFileAtomicContained,
  root: string,
  relativePath: string,
  bytes: string | Uint8Array,
  expectedIdentity: Awaited<ReturnType<typeof captureContainedPathIdentity>>,
): Promise<void> {
  try {
    await writeContained(root, relativePath, bytes, { expectedIdentity });
  } catch (error) {
    if (error instanceof PathOutsideRootError) {
      throw new PathIdentityChangedError(relativePath, 'write');
    }
    throw error;
  }
}

async function persistFailedGenerationLedger(
  paths: WorkspacePaths,
  workspaceId: string,
  accountingByService: ReadonlyMap<string, GenerationAccounting>,
  failure: string,
  now: () => string,
  planDigest: string,
  writeContained: typeof writeFileAtomicContained,
): Promise<GenerationLedger> {
  const entries: FeatureLedgerEntry[] = [];
  for (const [serviceId, accounting] of accountingByService) {
    entries.push(...reconcileSourceFeatures({
      sourceFeatures: accounting.sourceFeatures,
      consolidated: accounting.consolidated.map((entry) =>
        entry.excluded ? entry : { ...entry, failed: failure }),
      serviceId,
    }));
  }
  const startedAt = now();
  return persistGenerationLedger(paths, entries, {
    workspaceId,
    model: 'anthropic/claude-sonnet-5',
    planDigest,
    startedAt,
    completedAt: now(),
  }, writeContained);
}

async function persistPreflightFailureLedger(
  opts: Pick<RunGenerateOptions, 'root' | 'serviceId'>,
  error: unknown,
  now: () => string,
  writeContained: typeof writeFileAtomicContained,
): Promise<void> {
  const { workspace, paths } = await loadWorkspaceWithPaths(opts.root);
  const services = opts.serviceId === undefined
    ? workspace.services
    : workspace.services.filter((service) => service.service_id === opts.serviceId);
  const accountingByService = new Map<string, GenerationAccounting>();
  for (const service of services) {
    const cachePath = consolidatedCachePath(paths.cacheDir, service.service_id);
    if (!(await exists(cachePath))) continue;
    const consolidated = await loadConsolidatedCache(cachePath);
    accountingByService.set(
      service.service_id,
      buildGenerationAccounting(consolidated).accounting,
    );
  }
  if (accountingByService.size === 0) return;
  await persistFailedGenerationLedger(
    paths,
    workspace.workspace_id,
    accountingByService,
    `Preflight failed: ${errorMessage(error)}`,
    now,
    'preflight-failed',
    writeContained,
  );
}

function buildFeatureForGeneration(
  feature: ConsolidatedFeature,
  ir: ProjectIR | null,
): FeatureForGeneration {
  // Look up each member's primary file via the IR (if we have one).
  const members = feature.members.map((memberId) => ({
    id: memberId,
    label: memberId,
    route: feature.primary_route,
  }));

  // Files: prefer the deterministic source provenance carried over by the
  // consolidator (entry page + reachable components/hooks/stores, shared infra
  // excluded — the union across all merged members). Fall back to IR
  // primary-route resolution only for legacy caches written before the
  // consolidator attached `source_files`.
  const files: string[] = [];
  const seen = new Set<string>();
  const push = (f: string) => {
    if (!seen.has(f)) {
      seen.add(f);
      files.push(f);
    }
  };

  if (feature.source_files !== undefined) {
    for (const f of feature.source_files) {
      if (!isSensitiveLlmPath(f)) push(f);
    }
  } else if (ir) {
    for (const route of ir.routes) {
      if (route.kind !== 'page') continue;
      if (route.path === feature.primary_route && !isSensitiveLlmPath(route.file)) push(route.file);
    }
  }

  // Drift closure: the full reachable set incl. shared infra (deduped), carried
  // separately from `files` (the display set, shared excluded) so drift can hash
  // the superset. Omitted for legacy caches without logic_files, where the CLI
  // falls back to hashing `files`.
  let logicFiles: string[] | undefined;
  if (feature.logic_files !== undefined) {
    const logicSeen = new Set<string>();
    const deduped: string[] = [];
    for (const f of feature.logic_files) {
      if (!isSensitiveLlmPath(f) && !logicSeen.has(f)) {
        logicSeen.add(f);
        deduped.push(f);
      }
    }
    logicFiles = deduped;
  }

  return {
    canonical_id: feature.canonical_id,
    label: feature.label,
    dok_id_prefix: feature.dok_id_prefix ?? '',
    primary_route: feature.primary_route,
    members,
    files,
    ...(logicFiles === undefined ? {} : { logic_files: logicFiles }),
  };
}

interface ProspectiveRolePlan {
  roles: RoleId[];
  sources: Array<{
    roleId: RoleId;
    originServiceId: string;
    codeRoot: string;
    workspaceRelativeFile: string;
  }>;
}

function buildProspectiveRolePlan(
  contexts: readonly { serviceId: string; codeRoot: string; ir: ProjectIR }[],
): ProspectiveRolePlan {
  const safeContexts = contexts.map(({ serviceId, codeRoot, ir }) => {
    const workspaceRelativeFile = (file: string) =>
      join(codeRoot, file).replaceAll('\\', '/').replace(/^\.\//, '');
    return {
      serviceId,
      codeRoot,
      workspaceRelativeFile,
      ir: {
        ...ir,
        routes: ir.routes.filter((route) =>
          !isSensitiveLlmPath(workspaceRelativeFile(route.file))),
        role_signals: ir.role_signals.filter((signal) =>
          !isSensitiveLlmPath(workspaceRelativeFile(signal.file))),
      },
    };
  });
  const roles = mergeRoleCandidateSets(
    safeContexts.map(({ ir }) => extractRoleCandidates(ir)),
  )
    .map((candidate) => candidate.role_id);
  const sourceKeys = new Set<string>();
  const sources: ProspectiveRolePlan['sources'] = [];
  const addCandidates = (input: {
    ir: ProjectIR;
    originServiceId: string;
    codeRoot: string;
    workspaceRelativeFile: string;
  }) => {
    for (const candidate of extractRoleCandidates(input.ir)) {
      if (candidate.role_id === 'ROLE-USER') continue;
      const key = `${candidate.role_id}\0${input.originServiceId}\0${
        input.codeRoot
      }\0${input.workspaceRelativeFile}`;
      if (sourceKeys.has(key)) continue;
      sourceKeys.add(key);
      sources.push({
        roleId: candidate.role_id,
        originServiceId: input.originServiceId,
        codeRoot: input.codeRoot,
        workspaceRelativeFile: input.workspaceRelativeFile,
      });
    }
  };
  for (const context of safeContexts) {
    const { ir } = context;
    for (const signal of ir.role_signals) {
      addCandidates({
        ir: { ...ir, routes: [], role_signals: [signal] },
        originServiceId: context.serviceId,
        codeRoot: context.codeRoot,
        workspaceRelativeFile: context.workspaceRelativeFile(signal.file),
      });
    }
    for (const route of ir.routes) {
      addCandidates({
        ir: { ...ir, routes: [route], role_signals: [] },
        originServiceId: context.serviceId,
        codeRoot: context.codeRoot,
        workspaceRelativeFile: context.workspaceRelativeFile(route.file),
      });
    }
  }
  sources.sort((left, right) =>
    left.roleId.localeCompare(right.roleId)
      || left.originServiceId.localeCompare(right.originServiceId)
      || left.workspaceRelativeFile.localeCompare(right.workspaceRelativeFile));
  return { roles, sources };
}

interface HubLayerPreflightResult {
  rolesPath: string;
  lexiconPath?: string;
  lexiconSuggestionPath?: string;
  debugDir: string;
  byService: Map<string, { iaPath?: string; codeMappingPath?: string }>;
}

async function preflightExistingHubFiles(
  paths: WorkspacePaths,
  services: readonly Service[],
  opts: Pick<
    PreflightGenerateHubOptions,
    'noLexicon' | 'noIa' | 'noCodeMapping'
  >,
): Promise<HubLayerPreflightResult> {
  const rolesPath = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.rolesFile),
  );
  // Missing roles.json means an empty registry. Any present-but-invalid file
  // is a trust-layer integrity error, including --no-roles runs.
  await loadKnownRoles(rolesPath);

  const doksDir = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.doksDir),
  );
  await validateExistingDokOutputEntries(paths, doksDir);
  const debugDir = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.debugDir),
  );
  let lexiconPath: string | undefined;
  let lexiconSuggestionPath: string | undefined;
  if (!opts.noLexicon) {
    const safeLexiconPath = await resolveContainedOutputPath(
      paths.root,
      relative(paths.root, paths.lexiconFile),
    );
    const safeSuggestionPath = await resolveContainedOutputPath(
      paths.root,
      relative(paths.root, join(paths.cacheDir, 'lexicon-suggestions.json')),
    );
    if (await exists(safeLexiconPath)) lexiconPath = safeLexiconPath;
    if (await exists(safeSuggestionPath)) lexiconSuggestionPath = safeSuggestionPath;
  }

  const byService = new Map<
    string,
    { iaPath?: string; codeMappingPath?: string }
  >();
  for (const service of services) {
    const layerPaths: { iaPath?: string; codeMappingPath?: string } = {};
    if (!opts.noIa) {
      layerPaths.iaPath = await validateExistingIaFile(
        paths.root,
        paths.serviceIa(service.service_id),
        service.service_id,
      );
    }
    if (!opts.noCodeMapping) {
      layerPaths.codeMappingPath = await validateExistingCodeMappingFile(
        paths.root,
        paths.serviceCodeMapping(service.service_id),
        service.service_id,
      );
    }
    byService.set(service.service_id, layerPaths);
  }

  return {
    rolesPath,
    ...(lexiconPath === undefined ? {} : { lexiconPath }),
    ...(lexiconSuggestionPath === undefined ? {} : { lexiconSuggestionPath }),
    debugDir,
    byService,
  };
}

async function validateExistingDokOutputEntries(
  paths: WorkspacePaths,
  safeDoksDir: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(safeDoksDir);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    await resolveContainedOutputPath(
      paths.root,
      relative(paths.root, join(paths.doksDir, entry)),
    );
  }
}

async function loadKnownRoles(
  rolesFile: string,
  errorPath = rolesFile,
): Promise<RoleId[]> {
  try {
    const raw = JSON.parse(await readFile(rolesFile, 'utf-8'));
    const parsed = RolesFileSchema.parse(raw);
    return parsed.roles.map((r) => r.role_id);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw new InvalidRolesFileError(errorPath, error);
  }
}

async function validateExistingDok(
  dokFile: string,
  expectedDokId: string,
): Promise<Dok> {
  try {
    const parsed = DokSchema.parse(JSON.parse(await readFile(dokFile, 'utf-8')));
    if (parsed.dok_id !== expectedDokId) {
      throw new Error(
        `Dok file has dok_id "${parsed.dok_id}"; expected "${expectedDokId}".`,
      );
    }
    return parsed;
  } catch (error) {
    throw new InvalidExistingDokError(dokFile, expectedDokId, error);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** Display text of an approved Lexicon term in the given locale (any
 *  locale as fallback). i18n-bound terms have no hub-side text → null. */
function termDisplayText(t: LexiconTerm, locale: string): string | null {
  const map =
    t.binding.type === 'owned' ? (t.locales ?? {})
    : t.binding.type === 'constant' ? (t.snapshot ?? {})
    : {};
  return map[locale] ?? Object.values(map)[0] ?? null;
}

async function loadApprovedTermTexts(lexiconFile: string, locale: string): Promise<string[]> {
  if (!(await exists(lexiconFile))) return [];
  try {
    const parsed = LexiconFileSchema.parse(JSON.parse(await readFile(lexiconFile, 'utf-8')));
    return capTerminologyTexts(parsed.terms
      .map((t) => termDisplayText(t, locale))
      .filter((v): v is string => v !== null && v.length > 0));
  } catch {
    return [];
  }
}

async function loadSuggestionTexts(
  cachePath: string,
  excludedTexts: readonly string[] = [],
): Promise<string[]> {
  if (!(await exists(cachePath))) return [];
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf-8')) as { suggestions?: { text?: unknown }[] };
    const excluded = new Set(excludedTexts);
    return capTerminologyTexts((raw.suggestions ?? [])
      .map((s) => (typeof s.text === 'string' ? s.text : ''))
      .filter((t) => t.length > 0 && !excluded.has(t)), excluded.size > 0);
  } catch {
    return [];
  }
}

function capTerminologyTexts(
  values: readonly string[],
  leadingSeparator = false,
): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const value of values) {
    const renderedChars = `  - ${value}`.length
      + (kept.length > 0 || leadingSeparator ? 1 : 0);
    if (chars + renderedChars > 12_000) break;
    kept.push(value);
    chars += renderedChars;
  }
  return kept;
}

function manifestSourceKey(source: {
  file: string;
  originServiceId?: string;
  codeRoot?: string;
}): string {
  return `${source.originServiceId ?? ''}\0${source.codeRoot ?? ''}\0${source.file}`;
}

function selectContributingTransmissions(
  candidates: readonly LlmCandidateFile[],
  prepared: PreparedGenerationPayload,
): LlmCandidateFile[] {
  const contributing = new Set<string>();
  for (const item of prepared.items) {
    for (const source of item.transmissions) {
      if (source.actualChars <= 0) continue;
      contributing.add(
        `${item.serviceId}\0${item.dokId}\0${manifestSourceKey(source)}`,
      );
    }
  }
  const selected = new Map<string, LlmCandidateFile>();
  for (const candidate of candidates) {
    const key = `${candidate.serviceId}\0${candidate.dokId ?? ''}\0${
      manifestSourceKey(candidate)
    }`;
    if (!contributing.has(key)) continue;
    const existing = selected.get(key);
    if (!existing || candidate.maxChars > existing.maxChars) selected.set(key, candidate);
  }
  return [...selected.values()].sort((left, right) =>
    left.serviceId.localeCompare(right.serviceId)
      || (left.dokId ?? '').localeCompare(right.dokId ?? '')
      || manifestSourceKey(left).localeCompare(manifestSourceKey(right)));
}

async function prepareGenerationPayload(input: {
  workList: readonly {
    serviceId: string;
    serviceRoot: string;
    feature: ConsolidatedFeature;
    dokId: string;
    ir: ProjectIR | null;
    consolidatedFile: string;
  }[];
  transmissions: readonly LlmCandidateFile[];
  workspaceLocale: string;
  rolesPath: string;
  rolesFile: string;
  lexiconPath: string;
  suggestionPath: string;
  noLexicon: boolean;
  prospectiveRolePlan: ProspectiveRolePlan;
  /**
   * Doks already on disk, by planned dok_id. Read here only for the priority
   * axes a person pinned: those are stated as settled in the prompt and left
   * out of the answer, so the model never gets a chance to overwrite them.
   */
  existingDoks: ReadonlyMap<string, Dok>;
}): Promise<PreparedGenerationPayload> {
  const existingRoles = await loadKnownRoles(input.rolesPath);
  const knownRoles = capDokRolesForPrompt([
    ...existingRoles,
    ...input.prospectiveRolePlan.roles.filter((role) => !existingRoles.includes(role)),
  ], 9_500) as RoleId[];
  const existingRoleSet = new Set(existingRoles);
  const sourceByProspectiveRole = new Map<
    RoleId,
    ProspectiveRolePlan['sources'][number]
  >();
  for (const source of input.prospectiveRolePlan.sources) {
    if (!sourceByProspectiveRole.has(source.roleId)) {
      sourceByProspectiveRole.set(source.roleId, source);
    }
  }
  const roleCharsBySource = new Map<string, number>();
  for (const [index, role] of knownRoles.entries()) {
    const source = existingRoleSet.has(role)
      ? { file: input.rolesFile }
      : sourceByProspectiveRole.get(role);
    if (!source) continue;
    const sourceIdentity = 'workspaceRelativeFile' in source
      ? {
          file: source.workspaceRelativeFile,
          originServiceId: source.originServiceId,
          codeRoot: source.codeRoot,
        }
      : source;
    const sourceKey = manifestSourceKey(sourceIdentity);
    const fragmentChars = `  - ${role}`.length + (index > 0 ? 1 : 0);
    roleCharsBySource.set(
      sourceKey,
      (roleCharsBySource.get(sourceKey) ?? 0) + fragmentChars,
    );
  }
  const approved = input.noLexicon
    ? []
    : await loadApprovedTermTexts(input.lexiconPath, input.workspaceLocale);
  const cached = input.noLexicon ? [] : await loadSuggestionTexts(input.suggestionPath, approved);
  const merged = [...approved, ...cached.filter((term) => !approved.includes(term))];
  const lexiconTerms = merged.length > 0 ? merged : undefined;
  const approvedChars = renderedTerminologyChars(approved);
  const cachedChars = renderedTerminologyChars(cached, approved.length > 0);
  const items: PreparedGenerationItem[] = [];
  for (const item of input.workList) {
    const feature = buildFeatureForGeneration(item.feature, item.ir);
    const featureChars = renderDokFeatureBlock(feature).length;
    const fileContext = await loadFileContext(item.serviceRoot, feature.files);
    const suggestedActorRole = suggestRoleFromRoutePath(
      feature.primary_route,
      knownRoles,
    ) ?? undefined;
    // Axes a person pinned on the version already on disk. Passing them as
    // locks means the prompt never asks about them at all — filtering the
    // answer afterwards would still let the model spend tokens arguing.
    const existingPriority = input.existingDoks.get(item.dokId)?.priority;
    const lockedPriority = lockedPriorityFields(existingPriority).map((field) => ({
      field,
      value: field === 'impact'
        ? existingPriority!.impact
        : existingPriority!.blast_radius,
      reason: existingPriority!.curated[field]!.reason,
    }));
    const ctx: DokGenContext = {
      defaultLocale: input.workspaceLocale,
      knownRoles,
      fileContext,
      dokId: item.dokId,
      ...(suggestedActorRole ? { suggestedActorRole } : {}),
      ...(lexiconTerms ? { lexiconTerms } : {}),
      ...(lockedPriority.length > 0 ? { lockedPriority } : {}),
    };
    const allowedBySource = new Map<string, LlmCandidateFile>();
    for (const source of input.transmissions.filter((candidate) => candidate.dokId === item.dokId)) {
      const sourceKey = manifestSourceKey(source);
      const existing = allowedBySource.get(sourceKey);
      if (!existing || source.maxChars > existing.maxChars) {
        allowedBySource.set(sourceKey, source);
      }
    }
    const transmissions = [...allowedBySource.values()]
      .sort((left, right) => manifestSourceKey(left).localeCompare(manifestSourceKey(right)))
      .map((source) => {
        const { file, maxChars } = source;
        let actualChars = maxChars === 0 ? 0 : (fileContext[file]?.length ?? 0);
        if (file === item.consolidatedFile) actualChars += featureChars;
        actualChars += roleCharsBySource.get(manifestSourceKey(source)) ?? 0;
        if (file === '.doklo/hub/lexicon.json') actualChars += approvedChars;
        if (file === '.doklo/cache/lexicon-suggestions.json') actualChars += cachedChars;
        if (actualChars > maxChars) {
          throw new Error(`Rendered LLM source contribution exceeds its cap: ${file}`);
        }
        return {
          phase: 'generate' as const,
          serviceId: item.serviceId,
          ...(source.originServiceId === undefined
            ? {}
            : { originServiceId: source.originServiceId }),
          ...(source.codeRoot === undefined ? {} : { codeRoot: source.codeRoot }),
          file,
          actualChars,
        };
      })
      .filter((source) => source.actualChars > 0);
    const promptParts = buildDokPromptParts(feature, ctx);
    items.push({
      serviceId: item.serviceId,
      dokId: item.dokId,
      feature,
      ctx,
      prompt: joinPromptParts(promptParts),
      promptParts,
      transmissions,
    });
  }
  return deepFreeze({ items });
}

function renderedTerminologyChars(
  values: readonly string[],
  leadingSeparator = false,
): number {
  if (values.length === 0) return 0;
  return values.map((value) => `  - ${value}`).join('\n').length
    + (leadingSeparator ? 1 : 0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

async function loadFileContext(
  projectRoot: string,
  files: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let totalChars = 0;
  for (const f of files) {
    const absolute = await resolveContainedPath(projectRoot, f);
    // Do not stamp an unread or truncated file as evidence. Fail before the
    // approved provider call so the user can rescan or split the feature.
    const content = await readFile(absolute, 'utf-8');
    totalChars += content.length;
    if (totalChars > DOK_SOURCE_MAX_CHARS) {
      throw new Error(`Source context exceeds ${DOK_SOURCE_MAX_CHARS} characters at ${f}; split the service or feature before generation. No source was silently omitted.`);
    }
    out[f] = content;
  }
  return out;
}

async function loadConsolidatedCache(
  cachePath: string,
  errorPath = cachePath,
): Promise<ConsolidatedFeatureConfig> {
  try {
    return parseConsolidatedFeatureConfig(JSON.parse(await readFile(cachePath, 'utf-8')));
  } catch (cause) {
    throw new InvalidConsolidatedCacheError(errorPath, cause);
  }
}

async function validateConsolidatedPaths(
  serviceRoot: string,
  consolidated: ConsolidatedFeatureConfig,
): Promise<void> {
  const paths = new Set<string>();
  for (const group of consolidated.groups) {
    for (const feature of group.features) {
      for (const path of feature.source_files ?? []) paths.add(path);
      for (const path of feature.logic_files ?? []) paths.add(path);
    }
  }
  await validateServicePaths(serviceRoot, paths);
  await validateCurrentSourceFiles(serviceRoot, [...paths].filter(path => !isSensitiveLlmPath(path)));
}

async function validateServicePaths(
  serviceRoot: string,
  paths: ReadonlySet<string>,
): Promise<void> {
  for (const path of [...paths].sort()) {
    await resolveContainedPath(serviceRoot, path);
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

interface GeneratePreparationCacheState {
  service: Service;
  scan?: { routes: number; components: number; ir: ProjectIR };
  consolidated?: { featureGroups: number };
  needsScan: boolean;
  needsConsolidation: boolean;
  consolidationSkipReason?: string;
}

/**
 * Inspect preparation caches through the same trust boundary as runGenerate.
 * A cache is reusable only when its path is contained/non-symlinked, its
 * schema parses, and every source path it exposes has been validated.
 */
async function loadGeneratePreparationCacheState(
  paths: WorkspacePaths,
  service: Service,
  serviceRoot: string,
): Promise<GeneratePreparationCacheState> {
  const requestedScanPath = scanCachePath(paths.cacheDir, service);
  const scanPath = await resolveContainedPath(
    paths.root,
    relative(paths.root, requestedScanPath),
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  let scan: GeneratePreparationCacheState['scan'];
  if (await exists(scanPath)) {
    const ir = ProjectIRSchema.parse(JSON.parse(await readFile(scanPath, 'utf-8')));
    await validateProjectIrPaths(serviceRoot, ir);
    scan = { routes: ir.routes.length, components: ir.components.length, ir };
  }

  const requestedConsolidatedPath = consolidatedCachePath(paths.cacheDir, service.service_id);
  const requestedConsolidatedFile = relative(paths.root, requestedConsolidatedPath)
    .replaceAll('\\', '/');
  if (isSensitiveLlmPath(requestedConsolidatedFile)) {
    return {
      service,
      ...(scan === undefined ? {} : { scan }),
      needsScan: false,
      needsConsolidation: false,
      consolidationSkipReason: 'sensitive consolidated cache excluded from LLM input',
    };
  }

  const consolidatedPath = await resolveContainedPath(
    paths.root,
    requestedConsolidatedFile,
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  if (!(await exists(consolidatedPath))) {
    return {
      service,
      ...(scan === undefined ? {} : { scan }),
      needsScan: scan === undefined,
      needsConsolidation: true,
    };
  }

  const consolidated = await loadConsolidatedCache(consolidatedPath, requestedConsolidatedPath);
  await validateConsolidatedPaths(serviceRoot, consolidated);
  return {
    service,
    ...(scan === undefined ? {} : { scan }),
    consolidated: { featureGroups: consolidated.groups.length },
    needsScan: scan === undefined,
    needsConsolidation: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableGenerationFailure(
  code: 'PROVIDER_RATE_LIMITED' | 'PROVIDER_RESPONSE_TRUNCATED' | 'PERMISSION_DENIED',
  root: string,
  outputPath: string,
  completed: readonly GenerateOneResult[],
  skippedExisting: readonly string[],
): Pick<GenerateOneFailure, 'code' | 'retryable' | 'file' | 'preserved' | 'nextCommand'> {
  return {
    code,
    retryable: true,
    file: relative(root, outputPath).replaceAll('\\', '/'),
    preserved: preservedGenerationFiles(root, completed, skippedExisting),
    nextCommand: 'doklo generate --yes',
  };
}

function preservedGenerationFiles(
  root: string,
  completed: readonly GenerateOneResult[],
  skippedExisting: readonly string[],
): string[] {
  const files = new Set(completed.map((entry) =>
    relative(root, entry.outputPath).replaceAll('\\', '/')));
  for (const dokId of skippedExisting) {
    files.add(`.doklo/hub/doks/${dokId}.json`);
  }
  return [...files].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
    && (error.code === 'EACCES' || error.code === 'EPERM');
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

export function registerGenerateCommand(
  program: Command,
  ctx: CliContext,
  deps: Partial<GenerateCommandDeps> = {},
): void {
  const runGenerateDeps = deps.runGenerateDeps ?? {};
  const resolveGenerateLlm = deps.resolveLlmForRole ?? resolveLlmForRole;
  const executeConsolidate = deps.runConsolidate ?? runConsolidate;
  const authorizeRun = deps.authorizeLlmRun ?? authorizeLlmRun;
  const preflightRoles = runGenerateDeps.runRolesRefresh ?? runRolesRefresh;
  const executeGenerate = (options: RunGenerateOptions): Promise<RunGenerateResult> =>
    runGenerate(options, runGenerateDeps);
  addLlmOptions(
    program
      .command('generate')
      .alias('gen')
      .description(
        'Generate Doks via runtime-trust (anthropic/claude-sonnet-5 or openai/gpt-5.6-terra)',
      )
      .option('-r, --root <dir>', 'Workspace root', process.cwd())
      .option('--dry-run', 'List would-be Doks without calling the LLM', false)
      .option('--service <id>', 'Limit to one service')
      .option('--force', 'Regenerate even Doks that already exist on disk', false)
      .option('--no-roles', 'Skip deterministic roles.json refresh')
      .option('--no-lexicon', 'Ignore approved/cached terminology hints (run lexicon-suggest separately)')
      .option('--no-ia', 'Skip deterministic service IA refresh')
      .option('--no-code-mapping', 'Skip deterministic service code-mapping refresh')
      .option(
        '--llm-backend <backend>',
        'Override the configured runtime-trust route with local Claude Code or direct Anthropic',
        parseLlmBackend,
      )
      .option('-y, --yes', 'Approve the displayed immutable plan', false)
      .option('--plan-details', 'Show every Dok ID and feature in the generation preview', false)
      .option('--json', 'Emit JSONL only', false)
      .option(
        '--progress-json',
        'Emit machine-readable JSONL progress events to stdout',
        false,
      ),
  ).action(async (opts) => {
      const { default: chalk } = await import('chalk');
      const root = opts.root as string;
      const dryRun = opts.dryRun as boolean;
      const progressJson = opts.progressJson as boolean;
      const machine = opts.json === true || progressJson;
      type ConsentPlanProgressEvent = {
        stage: 'consent-plan';
        phase: 'consolidation' | 'generation';
        plan: LlmRunPlan;
      };
      type JsonProgressEvent = GeneratePipelineProgressEvent | ConsentPlanProgressEvent;
      const emitProgress = (event: JsonProgressEvent): void => {
        if (progressJson) process.stdout.write(JSON.stringify(event) + '\n');
      };
      const progressStdout: Pick<NodeJS.WriteStream, 'write'> = {
        write(chunk: string | Uint8Array): boolean {
          const event = JSON.parse(String(chunk).trim()) as Omit<ConsentPlanProgressEvent, 'phase'>;
          emitProgress({
            ...event,
            phase: event.plan.calls.consolidate > 0 ? 'consolidation' : 'generation',
          });
          return true;
        },
      };
      const logHuman = (...args: unknown[]): void => {
        if (!machine) console.log(...args);
      };

      if (!dryRun) {
        requireExplicitApproval({
          command: 'doklo generate',
          yes: opts.yes === true,
          isTTY: !machine && process.stdin.isTTY === true,
        });
      }

      // This barrier intentionally precedes auto-scan: invalid committed Hub
      // state may write only the atomic failure ledger; it must not mutate scan
      // caches, Hub outputs, or invoke paid consolidation/generation.
      try {
        await preflightGenerateHub({
          root,
          ...(opts.service === undefined ? {} : { serviceId: opts.service as string }),
          noLexicon: opts.lexicon === false,
          noIa: opts.ia === false,
          noCodeMapping: opts.codeMapping === false,
        });
      } catch (error) {
        if (!dryRun) {
          try {
            await persistPreflightFailureLedger({
              root,
              ...(opts.service === undefined ? {} : { serviceId: opts.service as string }),
            }, error, runGenerateDeps.now ?? DEFAULT_DEPS.now,
            runGenerateDeps.writeFileAtomicContained ?? DEFAULT_DEPS.writeFileAtomicContained);
          } catch {
            const staleDisposition = await discardStaleGenerationLedger(root);
            const primary = toCommandContractError(error, 'generate');
            throw new CommandContractError({
              ...primary.result,
              diagnostics: [
                ...primary.result.diagnostics,
                generationLedgerUnavailableDiagnostic(staleDisposition),
              ],
            }, primary.exitCode);
          }
        }
        throw error;
      }

      let resolved: Awaited<ReturnType<typeof resolveLlmForRole>> | undefined;
      let llmPlan: LlmRunPlan | undefined;
      let authorizedRun: AuthorizedLlmRun | undefined;
      let preparedGeneration: PreparedGenerationPayload | undefined;
      // Set only when the run cap forced a partial batch; narrows the paid run.
      let batchDokIds: string[] | undefined;
      const resolveCredentials = async (): Promise<Awaited<ReturnType<typeof resolveLlmForRole>>> => {
        resolved ??= await resolveGenerateLlm('generate', {
            model: opts.model as string | undefined,
            profile: opts.profile as string | undefined,
            backend: opts.llmBackend as 'claude-code' | 'anthropic-api' | undefined,
          });
        return resolved;
      };
      const approveExecutionPlan = async (input: {
        consolidationPreviews?: ConsolidationPreview[];
        generation?: RunGenerateResult;
      }): Promise<void> => {
        const llm = await resolveCredentials();
        const { paths } = await loadWorkspaceWithPaths(root);
        const consolidationPreviews = input.consolidationPreviews ?? [];
        const generationTransmissions = input.generation?.transmissions ?? [];
        const generateMax = input.generation?.plan.length ?? 0;
        const candidateFiles: LlmCandidateFile[] = [...generationTransmissions];
        const workItems = [
          ...consolidationPreviews.map((preview) => ({
            phase: 'consolidate' as const,
            serviceId: preview.serviceId,
            id: preview.serviceId,
          })),
          ...(input.generation?.plan ?? []).map((item) => ({
            phase: 'generate' as const,
            serviceId: item.serviceId,
            id: item.dokId,
          })),
        ];
        const safeDebugDir = await resolveContainedOutputPath(
          paths.root,
          relative(paths.root, paths.debugDir),
        );
        const preparedCalls: LlmPreparedCall[] = [
          ...consolidationPreviews.map((preview) => ({
            phase: 'consolidate' as const,
            workItem: {
              phase: 'consolidate' as const,
              serviceId: preview.serviceId,
              id: preview.serviceId,
            },
            prompt: preview.prompt ?? '',
            maxOutputTokens: preview.estimatedOutputTokens,
          })),
          ...(input.generation?.preparedGeneration?.items ?? []).map((item) => ({
            phase: 'generate' as const,
            workItem: {
              phase: 'generate' as const,
              serviceId: item.serviceId,
              id: item.dokId,
            },
            prompt: item.prompt,
            maxOutputTokens: 8_192,
          })),
        ];
        llmPlan = buildLlmRunPlan({
          llm: { ...llm, authSource: llm.authSource ?? inferAuthSource(llm) },
          previews: consolidationPreviews,
          candidateFiles,
          workItems,
          calls: {
            consolidate: consolidationPreviews.length,
            lexicon: 0,
            generateMax,
            judgeMax: 0,
          },
          preparedCalls,
          debugDir: safeDebugDir,
        });
        emitLlmRunPlan(llmPlan, {
          machine,
          budget: await readLlmTokenBudget(root),
          ...(progressJson ? { stdout: progressStdout } : {}),
        });
        authorizedRun = await authorizeRun(
          root,
          llmPlan,
          llm,
          {
            yes: opts.yes === true,
            isTTY: !machine && process.stdin.isTTY === true,
          },
        );
      };

      // Doks that changed hands during auto-consolidation without provenance to
      // confirm it. Printed as they happen for humans, and carried to the end so
      // machine consumers get them in the result envelope — same dual surface as
      // orphaned dok files. Stays empty on dry-run, which never consolidates.
      const unverifiedIdReuse: UnverifiedIdReuseNotice[] = [];

      // Happy-path chain: on a fresh workspace `generate` runs scan and
      // consolidate itself when their caches are missing, so the CLI-only
      // route is a single command after `init`. Dry-run keeps the explicit
      // step-by-step contract (no hidden LLM calls).
      if (!dryRun) {
        const { workspace, paths } = await loadWorkspaceWithPaths(root);
        const services = opts.service
          ? workspace.services.filter((s) => s.service_id === opts.service)
          : workspace.services;
        if (opts.service && services.length === 0) {
          throw new GenerateServiceNotFoundError(opts.service as string);
        }
        for (const service of services) {
          const serviceRoot = await resolveContainedPath(paths.root, service.code_root);
          await assertSupportedRuntimeProject(serviceRoot);
        }
        // Build every selected service's state behind the same containment and
        // schema/path trust boundary as runGenerate before emitting or writing
        // anything. This is the global validation barrier for preparation.
        const cacheStates: GeneratePreparationCacheState[] = [];
        for (const service of services) {
          const serviceRoot = await resolveContainedPath(paths.root, service.code_root);
          cacheStates.push(await loadGeneratePreparationCacheState(paths, service, serviceRoot));
        }
        for (const state of cacheStates) {
          if (state.scan !== undefined) {
            emitProgress({
              stage: 'scan',
              serviceId: state.service.service_id,
              status: 'reused',
              routes: state.scan.routes,
              components: state.scan.components,
            });
          }
          if (state.consolidated !== undefined) {
            emitProgress({
              stage: 'consolidate',
              serviceId: state.service.service_id,
              status: 'reused',
              featureGroups: state.consolidated.featureGroups,
            });
          }
          if (state.consolidationSkipReason !== undefined) {
            emitProgress({
              stage: 'consolidate',
              serviceId: state.service.service_id,
              status: 'skipped',
              featureGroups: 0,
              reason: state.consolidationSkipReason,
            });
          }
        }

        type ScanPreview = Awaited<ReturnType<typeof runScan>>['results'][number];
        type ConsolidationPreviewResult = Awaited<ReturnType<typeof executeConsolidate>>['results'][number];
        const scanPreviews = new Map<string, ScanPreview>();
        const consolidationPreviews = new Map<string, ConsolidationPreviewResult>();
        const statesNeedingScan = cacheStates.filter((state) => state.needsScan);
        if (statesNeedingScan.length > 0) {
          logHuman('\n  ' + chalk.cyan('→ ') + chalk.dim(ctx.t('generate.auto_scan')));
          for (const state of statesNeedingScan) {
            const preview = await runScan({
              root,
              serviceId: state.service.service_id,
              previewOnly: true,
            });
            const result = preview.results[0];
            if (result === undefined) throw new Error(`Scan preview produced no result for "${state.service.service_id}".`);
            scanPreviews.set(state.service.service_id, result);
          }
        }

        // Preserve the existing role validation barrier before resolving
        // credentials or allowing a paid consolidation call.
        if (cacheStates.some((state) => state.needsConsolidation)) {
          await loadKnownRoles(paths.rolesFile);
          if (opts.roles !== false && cacheStates.some((state) => state.scan !== undefined)) {
            await preflightRoles({
              root,
              apply: false,
              ...(opts.service === undefined ? {} : { serviceId: opts.service as string }),
            });
          }
        }

        // Preview every required consolidation before the single global paid
        // authorization. Individual real calls below make lifecycle events
        // truthful when an earlier service fails.
        for (const state of cacheStates.filter((item) => item.needsConsolidation)) {
          const scanPreview = scanPreviews.get(state.service.service_id);
          const preview = await executeConsolidate({
            root,
            serviceId: state.service.service_id,
            dryRun: true,
            ...(scanPreview === undefined ? {} : {
              scanIrs: { [state.service.service_id]: scanPreview.ir! },
            }),
          });
          const result = preview.results[0];
          if (result === undefined) throw new Error(`Consolidation preview produced no result for "${state.service.service_id}".`);
          consolidationPreviews.set(state.service.service_id, result);
        }
        if (consolidationPreviews.size > 0) {
          await approveExecutionPlan({
            consolidationPreviews: [...consolidationPreviews.values()].map((item) => item.preview),
          });
        }

        for (const state of statesNeedingScan) {
          const preview = scanPreviews.get(state.service.service_id)!;
          emitProgress({
            stage: 'scan',
            serviceId: state.service.service_id,
            status: 'running',
            routes: preview.counts.routes,
            components: preview.counts.components,
          });
          await runScan({
            root,
            serviceId: state.service.service_id,
            prepared: { results: [preview], skipped: [] },
          });
          emitProgress({
            stage: 'scan',
            serviceId: state.service.service_id,
            status: 'completed',
            routes: preview.counts.routes,
            components: preview.counts.components,
          });
        }

        if (consolidationPreviews.size > 0) {
          logHuman('  ' + chalk.cyan('→ ') + chalk.dim(ctx.t('generate.auto_consolidate')));
        }
        for (const state of cacheStates.filter((item) => item.needsConsolidation)) {
          const preview = consolidationPreviews.get(state.service.service_id)!;
          emitProgress({
            stage: 'consolidate',
            serviceId: state.service.service_id,
            status: 'running',
            featureGroups: preview.featureGroupCount,
          });
          const consolidated = await executeConsolidate({
            root,
            serviceId: state.service.service_id,
            authorizedRun,
            ...(scanPreviews.has(state.service.service_id) ? {
              scanIrs: { [state.service.service_id]: scanPreviews.get(state.service.service_id)!.ir! },
            } : {}),
          });
          const result = consolidated.results[0];
          if (result === undefined) throw new Error(`Consolidation produced no result for "${state.service.service_id}".`);
          emitProgress({
            stage: 'consolidate',
            serviceId: result.serviceId,
            status: 'completed',
            featureGroups: result.featureGroupCount,
          });
          logHuman(
            `  ${chalk.green('✓')} ${result.serviceId}: ${result.featureGroupCount} feature group(s)`,
          );
          // Auto-consolidation is still consolidation: a Dok changing hands
          // without provenance has to be as visible here as in `doklo
          // consolidate`, since this run is about to rewrite that file.
          for (const notice of consolidated.unverifiedIdReuse) {
            unverifiedIdReuse.push(notice);
            logHuman(`  ${chalk.yellow('⚠')} ${formatUnverifiedIdReuse(notice)}`);
          }
        }
      }

      // Preview/confirm gate: before the paid per-Dok generation, show what
      // will be produced (domain-grouped) + a token/time estimates, and
      // confirm. Dry-run skips the gate; non-TTY and machine invocations were
      // already required to pass -y/--yes before reaching this point.
      if (!dryRun) {
        const preview = await executeGenerate({
          root,
          dryRun: true,
          serviceId: opts.service as string | undefined,
          force: opts.force as boolean,
          noRoles: opts.roles === false,
          noLexicon: opts.lexicon === false,
          noIa: opts.ia === false,
          noCodeMapping: opts.codeMapping === false,
        });
        if (preview.plan.length === 0) {
          logHuman('\n  ' + chalk.yellow(ctx.t('generate.gate_none')));
        } else {
          // A large repo can plan more generation than the configured token cap
          // allows (cal.com's apps/web planned 76 Doks). The cap stays; the
          // batch shrinks. Deferred Doks are produced by running the command
          // again — existing files are skipped without --force.
          const limits = resolveLlmTokenLimits();
          const budget = await readLlmTokenBudget(root);
          const remainingTokens = Math.max(0, limits.maxTokensTotal - budget.chargedTokens);
          const batchCap = Math.min(limits.maxTokensPerRun, remainingTokens);
          const items = preview.preparedGeneration?.items ?? [];
          const batch = selectGenerationBatch(items, batchCap);
          if (items.length > 0 && batch.keptDokIds.length === 0) {
            const required = Math.min(...items.map(item => estimateConservativeLlmCallTokens(item.prompt, 8192)));
            const totalLimited = remainingTokens < limits.maxTokensPerRun;
            throw new LlmTokenCapError(totalLimited ? 'LLM_TOTAL_TOKEN_CAP' : 'LLM_RUN_TOKEN_CAP',
              `No Dok fits: smallest reservation ${required} tokens; run limit ${limits.maxTokensPerRun}, workspace remaining ${remainingTokens}. Adjust ${totalLimited ? 'DOKLO_MAX_TOKENS_TOTAL' : 'DOKLO_MAX_TOKENS_PER_RUN'}; rerunning with the same limits will not help.`);
          }
          const batched = batch.capped
            ? {
                ...preview,
                plan: preview.plan.filter((item) => batch.keptDokIds.includes(item.dokId)),
                preparedGeneration: {
                  items: (preview.preparedGeneration?.items ?? []).filter((item) =>
                    batch.keptDokIds.includes(item.dokId)),
                },
              }
            : preview;
          if (batch.capped) {
            batchDokIds = batch.keptDokIds;
            logHuman('\n  ' + chalk.yellow(ctx.t('generate.batch_capped', {
              kept: batch.keptDokIds.length,
              total: batch.keptDokIds.length + batch.deferredDokIds.length,
              deferred: batch.deferredDokIds.length,
            })));
          }
          await approveExecutionPlan({ generation: batched });
          preparedGeneration = batched.preparedGeneration;
          if (!progressJson) {
            const domains = new Set(batched.plan.map((p) => p.domain)).size;
            const tokens = estimateGenerateTokens(batched.preparedGeneration?.items ?? []);
            logHuman(
              '\n  ' +
                chalk.cyan(ctx.t('generate.gate_header', { count: batched.plan.length, domains })) +
                '\n' +
                formatGeneratePlan(batched.plan, opts.planDetails === true),
            );
            logHuman('  ' + ctx.t('generate.token_estimate_note', {
              max: tokens.maxOutputTokens.toLocaleString('en-US'),
            }));
            logHuman('  ' + formatGateSummary(batched.plan.length, tokens, ctx.locale));
            if (!opts.planDetails) logHuman('  ' + ctx.t('generate.plan_details_hint'));
            if (shouldPromptGate({ yes: opts.yes as boolean, isTTY: Boolean(process.stdin.isTTY) })) {
              const { select, isCancel } = await import('@clack/prompts');
              const summary = formatGateSummary(batched.plan.length, tokens, ctx.locale);
              const choice = await runGateInteraction(
                ctx.t('generate.gate_choose', { summary }),
                {
                  generate: ctx.t('generate.gate_opt_generate'),
                  studio: ctx.t('generate.gate_opt_studio'),
                  cancel: ctx.t('generate.gate_opt_cancel'),
                },
                {
                  select,
                  isCancel,
                  launchStudio: async () => {
                    // Non-strict: a busy 4321 falls back to a neighbor
                    // instead of crashing the spawned Studio child.
                    const { port } = await pickStudioPort(DEFAULT_STUDIO_PORT);
                    await runServe({ root, port, open: true, openPath: '/consolidation' });
                  },
                },
              );
              if (choice === 'studio') {
                logHuman('  ' + chalk.dim(ctx.t('generate.gate_studio_return')));
                throw generateCancelled(
                  'STUDIO_HANDOFF',
                  'Generation was cancelled after handing review to the web app.',
                );
              }
              if (choice === 'cancel') {
                logHuman('  ' + chalk.dim(ctx.t('generate.gate_cancelled')));
                throw generateCancelled('COMMAND_CANCELLED', 'Generation was cancelled.');
              }
            }
          }
        }
      }

      let totalForFormatting = 0;
      const widthOf = (n: number) => String(n).length;
      const startTime = Date.now();

      const runOptions: RunGenerateOptions = {
        root,
        dryRun,
        serviceId: opts.service as string | undefined,
        ...(!dryRun && llmPlan !== undefined && authorizedRun !== undefined
          ? {
              authorizedRun,
              planDigest: llmPlan.digest,
              preparedGeneration,
              ...(batchDokIds ? { onlyDokIds: batchDokIds } : {}),
            }
          : {}),
        force: opts.force as boolean,
        // Commander negated options default true and become false when passed.
        noRoles: opts.roles === false,
        // commander maps `--no-lexicon` to opts.lexicon === false (default true).
        noLexicon: opts.lexicon === false,
        noIa: opts.ia === false,
        noCodeMapping: opts.codeMapping === false,
        onProgress: dryRun
          ? undefined
          : progressJson
          ? emitProgress
          : machine
          ? undefined
          : (e) => {
              if (e.stage === 'roles') {
                if (e.status === 'updated') {
                  console.log(`  ${chalk.green('✓')} roles: ${e.added} added, ${e.kept} kept`);
                } else if (e.status === 'unchanged') {
                  console.log(`  ${chalk.dim(`roles: unchanged (${e.kept} kept)`)}`);
                } else if (e.status === 'skipped') {
                  console.log(`  ${chalk.dim('roles: skipped')}`);
                } else {
                  console.error(`  ${chalk.red('✗')} roles: ${chalk.red(e.error ?? 'refresh failed')}`);
                }
              } else if (e.stage === 'plan') {
                totalForFormatting = e.total;
                const skippedNote =
                  e.skippedExisting.length > 0
                    ? chalk.dim(
                        ` (${e.skippedExisting.length} already exist — re-run with --force to regenerate)`,
                      )
                    : '';
                console.log(
                  `\n  ${chalk.cyan(`Generating ${e.total} Dok(s)`)}${skippedNote}\n  ` +
                    chalk.dim(
                      `per-Dok progress below — ${resolved?.model ?? 'the model'} may take 30s–2min per call`,
                    ),
                );
                console.log();
              } else if (e.stage === 'dok-start') {
                const w = widthOf(totalForFormatting);
                const idx = `[${String(e.index).padStart(w)}/${e.total}]`;
                console.log(
                  `  ${chalk.dim(idx)} ${chalk.bold(e.dokId)} ${chalk.dim(`— ${e.featureLabel}`)}`,
                );
              } else if (e.stage === 'dok-done') {
                const elapsed = `${(e.elapsedMs / 1000).toFixed(1)}s`;
                if (e.success) {
                  console.log(
                    `         ${chalk.green('✓')} ${chalk.dim(elapsed)}`,
                  );
                } else {
                  console.error(
                    `         ${chalk.red('✗')} ${chalk.dim(elapsed)} ${chalk.red((e.error ?? '').split('\n')[0]?.slice(0, 80) ?? '')}`,
                  );
                }
              } else if (e.stage === 'done') {
                const total = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(
                  `\n  ${e.succeeded} succeeded, ${e.failed} Dok failed, ${e.layerFailed} layer failed ${chalk.dim(`(total ${total}s)`)}\n`,
                );
              } else if (e.stage === 'lexicon') {
                if (e.status === 'reused') {
                  console.log(`  ${chalk.dim(`lexicon: reusing ${e.termCount} known term(s)`)}`);
                } else {
                  console.log(`  ${chalk.dim('lexicon: hints disabled')}`);
                }
              } else if (e.stage === 'ia' || e.stage === 'code-mapping') {
                const label = `${e.serviceId} ${e.stage}`;
                if (e.status === 'written') {
                  console.log(`  ${chalk.green('✓')} ${label}: ${e.count} item(s) written`);
                } else if (e.status === 'unchanged') {
                  console.log(`  ${chalk.dim(`${label}: unchanged (${e.count} item(s))`)}`);
                } else if (e.status === 'skipped') {
                  const message = `  ${chalk.dim(`${label}: skipped${e.error ? ` (${e.error})` : ''}`)}`;
                  if (e.error) console.error(message);
                  else console.log(message);
                } else {
                  console.error(`  ${chalk.red('✗')} ${label}: ${chalk.red(e.error ?? 'refresh failed')}`);
                }
              }
            },
      };
      let result: RunGenerateResult;
      if (dryRun) {
        result = await executeGenerate(runOptions);
      } else {
        const controller = new AbortController();
        const interrupt = (): void => controller.abort(new Error('SIGINT'));
        process.once('SIGINT', interrupt);
        try {
          result = await executeGenerate({ ...runOptions, signal: controller.signal });
          if (controller.signal.aborted && !result.interrupted) {
            result = { ...result, interrupted: true };
          }
        } finally {
          process.removeListener('SIGINT', interrupt);
        }
      }

      if (opts.dryRun) {
        logHuman(`\n  ${chalk.cyan(`Would generate ${result.plan.length} Dok(s):`)}`);
        for (const p of result.plan) {
          logHuman(`    - ${p.dokId} (${p.serviceId}) — ${p.featureLabel}`);
        }
        recordGenerateResult(program, result, unverifiedIdReuse);
        return;
      }

      if (result.tokenUsage && result.tokenUsage.attemptedCalls > 0) {
        const usage = result.tokenUsage;
        const input = usage.actual.inputTokens + usage.actual.cacheReadTokens + usage.actual.cacheCreationTokens;
        logHuman('\n  ' + ctx.t('generate.usage_summary', {
          attempted: usage.attemptedCalls, measured: usage.measuredCalls, missing: usage.missingCalls,
          input: input.toLocaleString('en-US'), output: usage.actual.outputTokens.toLocaleString('en-US'),
          read: usage.actual.cacheReadTokens.toLocaleString('en-US'),
          write: usage.actual.cacheCreationTokens.toLocaleString('en-US'),
        }));
        if (usage.missingCalls === 0) {
          logHuman('  ' + ctx.t('generate.usage_comparison', {
            input: usage.estimated.inputTokens.toLocaleString('en-US'),
            output: usage.estimated.outputTokens.toLocaleString('en-US'),
            inputDelta: (input - usage.estimated.inputTokens).toLocaleString('en-US', { signDisplay: 'always' }),
            outputDelta: (usage.actual.outputTokens - usage.estimated.outputTokens).toLocaleString('en-US', { signDisplay: 'always' }),
          }));
        } else logHuman('  ' + ctx.t('generate.usage_incomplete'));
      }
      if (batchDokIds) logHuman('  ' + ctx.t('generate.deferred_end'));
      if (result.tokenCapFailure) {
        throw new CommandContractError({
          schema_version: 1, command: 'generate', status: result.results.length > 0 ? 'partial' : 'cancelled',
          data: result, diagnostics: [{ ...result.tokenCapFailure,
            preserved: preservedGenerationFiles(root, result.results, result.skippedExisting),
          }],
        }, 2);
      }
      if (result.interrupted) throw generationInterrupted(root, result);
      if (result.orphanedDokIds.length > 0) {
        logHuman(
          `\n  ${chalk.yellow('⚠')} orphaned dok files (no longer produced by consolidation): `
            + `${formatOrphanedDokFiles(result.orphanedDokIds)} — review & delete manually`,
        );
      }
      recordGenerateResult(program, result, unverifiedIdReuse);
    });
}

function recordGenerateResult(
  program: Command,
  result: RunGenerateResult,
  /** Advisories from auto-consolidation — required so a new call site cannot drop them. */
  unverifiedIdReuse: readonly UnverifiedIdReuseNotice[],
): void {
  const diagnostics: CommandDiagnostic[] = [
    ...result.failures.map((failure) => ({
      code: failure.code ?? 'DOK_GENERATION_FAILED',
      message: `${failure.dokId}: ${failure.reason}`,
      serviceId: failure.serviceId,
      ...(failure.retryable === true ? { retryable: true } : {}),
      ...(failure.file === undefined ? {} : { file: failure.file }),
      ...(failure.preserved === undefined ? {} : { preserved: failure.preserved }),
      ...(failure.nextCommand === undefined ? {} : { nextCommand: failure.nextCommand }),
    })),
    ...result.layerFailures.map((failure) => ({
      code: 'LAYER_GENERATION_FAILED',
      message: `${failure.layer}: ${failure.reason}`,
      serviceId: failure.serviceId,
    })),
    ...(result.generationLedgerFailure === undefined
      ? []
      : [result.generationLedgerFailure]),
    ...(result.emptyAnchorDokIds.length > 0
      ? [{
          code: 'EMPTY_SOURCE_ANCHORS',
          message: `${result.emptyAnchorDokIds.length} Dok(s) resolved to no source files.`,
        }]
      : []),
    ...(result.orphanedDokIds.length > 0
      ? [{
          code: 'ORPHANED_DOK_FILES',
          message: 'orphaned dok files (no longer produced by consolidation): '
            + `${formatOrphanedDokFiles(result.orphanedDokIds)} — review & delete manually`,
        }]
      : []),
    ...unverifiedIdReuse.map((notice) => ({
      code: 'UNVERIFIED_ID_REUSE',
      message: formatUnverifiedIdReuse(notice),
      serviceId: notice.serviceId,
    })),
  ];
  recordCommandResult(program, {
    schema_version: 1,
    command: 'generate',
    status:
      result.failures.length > 0 || result.layerFailures.length > 0
        || (result.generationLedger?.summary.failed ?? 0) > 0
        || result.generationLedgerFailure !== undefined
        ? 'partial'
        : 'success',
    data: result,
    diagnostics,
  });
}

function formatOrphanedDokFiles(dokIds: readonly string[]): string {
  return dokIds.map((dokId) => `${dokId}.json`).join(', ');
}

function generateCancelled(code: string, message: string): CommandContractError {
  return new CommandContractError({
    schema_version: 1,
    command: 'generate',
    status: 'cancelled',
    data: null,
    diagnostics: [{ code, message }],
  });
}

function generationInterrupted(
  root: string,
  result: RunGenerateResult,
): CommandContractError<RunGenerateResult> {
  const preserved = preservedGenerationFiles(root, result.results, result.skippedExisting);
  return new CommandContractError({
    schema_version: 1,
    command: 'generate',
    status: 'cancelled',
    data: result,
    diagnostics: [{
      code: 'GENERATION_INTERRUPTED',
      message: 'Generation was interrupted. Completed Doks were preserved.',
      retryable: true,
      preserved,
      nextCommand: 'doklo generate --yes',
    }],
  }, 130);
}

type StaleLedgerDisposition = 'removed' | 'absent' | 'retained';

async function discardStaleGenerationLedger(root: string): Promise<StaleLedgerDisposition> {
  try {
    await unlinkContained(root, '.doklo/cache/generation-ledger.json');
    return 'removed';
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'absent'
      : 'retained';
  }
}

function generationLedgerUnavailableDiagnostic(
  staleDisposition: StaleLedgerDisposition,
): CommandDiagnostic {
  const message = staleDisposition === 'removed'
    ? 'The generation ledger could not be updated; stale evidence was removed.'
    : staleDisposition === 'retained'
      ? 'The generation ledger could not be updated; an existing ledger may be stale.'
      : 'The generation ledger could not be updated.';
  return {
    code: 'GENERATION_LEDGER_UNAVAILABLE',
    message,
    file: '.doklo/cache/generation-ledger.json',
    retryable: true,
    nextCommand: 'doklo generate --yes',
  };
}
