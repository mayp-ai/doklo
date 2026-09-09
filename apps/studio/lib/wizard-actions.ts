'use server';

// Server actions backing the onboarding wizard. These wrap the CLI's pure
// `run*` runners (imported via the `@doklo-beta/cli/api` subpath, which
// does NOT execute the CLI) and shape their output for the wizard UI.

import {
  ParserLedgerIncompleteError,
  runScan,
  runEvaluate,
} from '@doklo-beta/cli/api';
import { DokIdSchema, ProjectIRSchema, type Framework, type Workspace } from '@doklo-beta/core';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  workspaceRoot,
  loadWorkspaceState,
  loadDoksState,
  loadLexicon,
  summarizeDoks,
  type DokSummary,
} from './data';

export interface WizardWorkspaceState {
  workspaceName: string;
  workspacePath: string;
  services: Array<{
    serviceId: string;
    framework: string;
    scan: WizardCachedScanState;
  }>;
  existingDoks: number;
  doks: DokSummary[];
  generation: WizardGenerationState;
  model: string | null;
  provider: string | null;
}

export interface WizardCachedScanState {
  status: 'ready' | 'missing' | 'invalid' | 'unreadable';
  counts: { routes: number; components: number; stores: number } | null;
}

export interface WizardGenerationSummary {
  sourceFeatures: number;
  success: number;
  skipped: number;
  failed: number;
  /** Unique non-null Dok targets derived from validated ledger entries. */
  dokTargets?: number;
  /** Sorted target IDs used to reconcile service-scoped ledger work with the workspace Hub. */
  dokTargetIds?: string[];
}

export interface WizardGenerationState {
  status: 'none' | 'no-candidates' | 'complete' | 'partial' | 'failed' | 'unavailable';
  summary: WizardGenerationSummary | null;
  completedAt: string | null;
}

interface ConfigModelSummary {
  model: string | null;
  provider: string | null;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_MODEL_REFERENCE_LENGTH = 256;

function configPath(): string {
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  const base = xdgConfigHome !== undefined && xdgConfigHome !== '' && isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : resolve(homedir(), '.config');
  return join(base, 'doklo', 'config.json');
}

function configRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function modelPrimary(models: Record<string, unknown>, role: string): unknown {
  const roleConfig = configRecord(models[role]);
  return roleConfig?.['primary'];
}

function modelSummaryFromReference(reference: unknown): ConfigModelSummary {
  if (
    typeof reference !== 'string'
    || reference.length === 0
    || reference.length > MAX_MODEL_REFERENCE_LENGTH
    || reference !== reference.trim()
    || /[\u0000-\u001F\u007F\s]/u.test(reference)
  ) {
    return { model: null, provider: null };
  }
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1) {
    return { model: null, provider: null };
  }
  const provider = reference.slice(0, separator);
  const model = reference.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider) || model === '') {
    return { model: null, provider: null };
  }
  return { model: reference, provider };
}

function modelSummaryFromConfig(raw: unknown): ConfigModelSummary {
  const config = configRecord(raw);
  if (config === null) {
    return { model: null, provider: null };
  }
  const models = configRecord(config['models']);
  if (models === null) {
    return { model: null, provider: null };
  }
  return modelSummaryFromReference(
    modelPrimary(models, 'generate') ?? modelPrimary(models, 'default'),
  );
}

async function loadConfigModelSummary(): Promise<ConfigModelSummary> {
  try {
    const raw = await readFile(configPath(), 'utf-8');
    if (Buffer.byteLength(raw, 'utf-8') > MAX_CONFIG_BYTES) {
      return { model: null, provider: null };
    }
    return modelSummaryFromConfig(JSON.parse(raw));
  } catch {
    return { model: null, provider: null };
  }
}

async function requireWorkspace() {
  return (await requireWorkspaceContext()).workspace;
}

async function requireWorkspaceContext(): Promise<{ workspace: Workspace; root: string }> {
  const state = await loadWorkspaceState();
  if (state.kind === 'ready' || state.kind === 'empty') {
    return { workspace: state.data, root: dirname(state.path) };
  }
  throw new Error(
    `Doklo workspace is ${state.kind}. Run \`doklo init\` in this project, then reopen Studio.`,
  );
}

async function requireDokCatalog() {
  const state = await loadDoksState();
  if (state.kind === 'ready' || state.kind === 'empty') return state.data.doks;
  if (state.kind === 'missing' && extname(state.path) !== '.json') return [];
  throw new Error(
    `Dok catalog is ${state.kind}. Repair ${state.path}, then reopen Studio.`,
  );
}

export async function wizardGetState(): Promise<WizardWorkspaceState> {
  const { workspace, root } = await requireWorkspaceContext();
  const doks = await requireDokCatalog();
  const [config, lexicon, scans, generation] = await Promise.all([
    loadConfigModelSummary(),
    loadLexicon(),
    Promise.all(workspace.services.map((service) =>
      loadCachedScanState(root, service.service_id, service.framework))),
    loadGenerationState(root, workspace.workspace_id, doks.length),
  ]);
  const summaries = summarizeDoks(doks, {
    lexicon,
    locale: workspace.default_locale ?? 'en',
  });

  return {
    workspaceName: workspace.name,
    workspacePath: root,
    services: workspace.services.map((service, index) => ({
      serviceId: service.service_id,
      framework: service.framework,
      scan: scans[index]!,
    })),
    existingDoks: doks.length,
    doks: summaries,
    generation,
    ...config,
  };
}

function isMissingFile(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ENOENT';
}

async function loadCachedScanState(
  root: string,
  serviceId: string,
  framework: Framework,
): Promise<WizardCachedScanState> {
  let raw: string;
  try {
    raw = await readFile(join(root, '.doklo', 'cache', `${serviceId}.scan.json`), 'utf-8');
  } catch (error) {
    return {
      status: isMissingFile(error) ? 'missing' : 'unreadable',
      counts: null,
    };
  }

  try {
    const parsed = ProjectIRSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.framework !== framework) {
      return { status: 'invalid', counts: null };
    }
    return {
      status: 'ready',
      counts: {
        routes: parsed.data.routes.length,
        components: parsed.data.components.length,
        stores: parsed.data.stores.length,
      },
    };
  } catch {
    return { status: 'invalid', counts: null };
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function generationSummary(value: unknown): WizardGenerationSummary | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  const sourceFeatures = summary['sourceFeatures'];
  const success = summary['success'];
  const skipped = summary['skipped'];
  const failed = summary['failed'];
  if (
    !nonNegativeInteger(sourceFeatures)
    || !nonNegativeInteger(success)
    || !nonNegativeInteger(skipped)
    || !nonNegativeInteger(failed)
    || sourceFeatures !== success + skipped + failed
  ) {
    return null;
  }
  return { sourceFeatures, success, skipped, failed };
}

type GenerationLedgerStatus = 'success' | 'skipped' | 'failed';

const GENERATION_REASON_STATUS = {
  GENERATED: 'success',
  EXISTING_PRESERVED: 'skipped',
  EXCLUDED_BY_CONSOLIDATION: 'skipped',
  NOT_SELECTED: 'skipped',
  INTERRUPTED: 'failed',
  GENERATION_FAILED: 'failed',
} as const satisfies Record<string, GenerationLedgerStatus>;

interface ValidatedGenerationEntries {
  dokTargetIds: string[];
  summary: WizardGenerationSummary;
}

function generationEntries(entries: unknown[]): ValidatedGenerationEntries | null {
  const ids = new Set<string>();
  const sourceFeatureKeys = new Set<string>();
  const summary: WizardGenerationSummary = {
    sourceFeatures: entries.length,
    success: 0,
    skipped: 0,
    failed: 0,
  };
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const sourceFeatureId = record['sourceFeatureId'];
    const serviceId = record['serviceId'];
    const canonicalFeatureId = record['canonicalFeatureId'];
    const status = record['status'];
    const reasonCode = record['reasonCode'];
    const message = record['message'];
    if (
      typeof sourceFeatureId !== 'string'
      || sourceFeatureId.length === 0
      || typeof serviceId !== 'string'
      || serviceId.length === 0
      || (canonicalFeatureId !== null && typeof canonicalFeatureId !== 'string')
      || (status !== 'success' && status !== 'skipped' && status !== 'failed')
      || typeof reasonCode !== 'string'
      || !(reasonCode in GENERATION_REASON_STATUS)
      || GENERATION_REASON_STATUS[reasonCode as keyof typeof GENERATION_REASON_STATUS] !== status
      || typeof message !== 'string'
    ) {
      return null;
    }
    const sourceFeatureKey = `${serviceId}\u0000${sourceFeatureId}`;
    if (sourceFeatureKeys.has(sourceFeatureKey)) return null;
    sourceFeatureKeys.add(sourceFeatureKey);
    summary[status] += 1;

    const dokId = record['dokId'];
    if (dokId === null) continue;
    const parsed = DokIdSchema.safeParse(dokId);
    if (!parsed.success) return null;
    ids.add(parsed.data);
  }
  return { dokTargetIds: [...ids].sort(), summary };
}

function generationSummariesMatch(
  persisted: WizardGenerationSummary,
  derived: WizardGenerationSummary,
): boolean {
  return persisted.sourceFeatures === derived.sourceFeatures
    && persisted.success === derived.success
    && persisted.skipped === derived.skipped
    && persisted.failed === derived.failed;
}

async function loadGenerationState(
  root: string,
  workspaceId: string,
  existingDoks: number,
): Promise<WizardGenerationState> {
  let raw: string;
  try {
    raw = await readFile(join(root, '.doklo', 'cache', 'generation-ledger.json'), 'utf-8');
  } catch (error) {
    return {
      status: isMissingFile(error) ? 'none' : 'unavailable',
      summary: null,
      completedAt: null,
    };
  }

  try {
    const ledger = JSON.parse(raw) as unknown;
    if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
      return { status: 'unavailable', summary: null, completedAt: null };
    }
    const record = ledger as Record<string, unknown>;
    const summary = generationSummary(record['summary']);
    const entries = record['entries'];
    const validatedEntries = Array.isArray(entries) ? generationEntries(entries) : null;
    const completedAt = record['completedAt'];
    if (
      record['schema_version'] !== 1
      || record['workspaceId'] !== workspaceId
      || !Array.isArray(entries)
      || summary === null
      || validatedEntries === null
      || !generationSummariesMatch(summary, validatedEntries.summary)
      || typeof completedAt !== 'string'
      || Number.isNaN(Date.parse(completedAt))
    ) {
      return { status: 'unavailable', summary: null, completedAt: null };
    }
    const { dokTargetIds } = validatedEntries;
    const status: WizardGenerationState['status'] = dokTargetIds.length === 0 && existingDoks === 0
      ? 'no-candidates'
      : summary.failed === 0
        ? 'complete'
        : (summary.success > 0 || existingDoks > 0 ? 'partial' : 'failed');
    return {
      status,
      summary: {
        ...summary,
        dokTargets: dokTargetIds.length,
        dokTargetIds,
      },
      completedAt,
    };
  } catch {
    return { status: 'unavailable', summary: null, completedAt: null };
  }
}

export interface WizardFeatureGroup {
  /** Domain prefix of the dok_id (e.g. AUTH, PROG, IMPACT). */
  domain: string;
  count: number;
  /** Up to three resolved Dok names for the card preview. */
  sampleNames: string[];
}

export interface WizardScanResult {
  ok: true;
  workspaceName: string;
  serviceCount: number;
  counts: { routes: number; components: number; stores: number };
  featureGroups: WizardFeatureGroup[];
  totalDoks: number;
}

export interface WizardParserLedgerFailure {
  file: string;
  stages: string[];
  reason: string;
  diagnosticCount: number;
}

export interface WizardScanFailureResult {
  ok: false;
  error: {
    code: 'PARSER_LEDGER_INCOMPLETE';
    serviceId: string;
    failedFiles: WizardParserLedgerFailure[];
    preserved: string[];
    nextCommand: string;
  };
}

export type WizardScanOutcome = WizardScanResult | WizardScanFailureResult;

/** Domain bucket = the dok_id's first segment (AUTH-SIGNIN → AUTH). */
function dokDomain(dokId: string): string {
  return dokId.split('-')[0] ?? dokId;
}

export async function wizardRunScan(serviceId: string): Promise<WizardScanOutcome> {
  const workspace = await requireWorkspace();
  const service = workspace.services.find((candidate) => candidate.service_id === serviceId);
  if (!service) throw new Error(`Unknown workspace service: ${serviceId}`);
  const doks = await requireDokCatalog();
  const root = workspaceRoot();

  let scan;
  try {
    scan = await runScan({ root, serviceId });
  } catch (error) {
    if (!(error instanceof ParserLedgerIncompleteError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        serviceId: error.details.serviceId,
        failedFiles: error.details.failures.map((failure) => ({
          file: failure.file,
          stages: [...failure.stages],
          reason: failure.reason,
          diagnosticCount: failure.diagnosticCount,
        })),
        preserved: [...error.details.preserved],
        nextCommand: error.details.nextCommand,
      },
    };
  }
  const counts = scan.results.reduce(
    (acc, r) => ({
      routes: acc.routes + r.counts.routes,
      components: acc.components + r.counts.components,
      stores: acc.stores + r.counts.stores,
    }),
    { routes: 0, components: 0, stores: 0 },
  );

  const lexicon = await loadLexicon();
  const locale = workspace.default_locale ?? 'en';
  const summaries = summarizeDoks(doks, { lexicon, locale });

  const map = new Map<string, WizardFeatureGroup>();
  for (const s of summaries) {
    const domain = dokDomain(s.dok_id);
    const group = map.get(domain) ?? { domain, count: 0, sampleNames: [] };
    group.count += 1;
    if (group.sampleNames.length < 3) group.sampleNames.push(s.name);
    map.set(domain, group);
  }
  const featureGroups = Array.from(map.values()).sort((a, b) => b.count - a.count);

  return {
    ok: true,
    workspaceName: workspace.name,
    serviceCount: 1,
    counts,
    featureGroups,
    totalDoks: summaries.length,
  };
}

export interface WizardCategoryScore {
  name: string;
  score: number;
  max: number;
}

export interface WizardScore {
  total: number;
  maxTotal: number;
  totalDoks: number;
  categories: WizardCategoryScore[];
}

export async function wizardRunEvaluate(): Promise<WizardScore> {
  await requireWorkspace();
  await requireDokCatalog();
  const root = workspaceRoot();
  const { report } = await runEvaluate({ root });
  return {
    total: report.total,
    maxTotal: report.maxTotal,
    totalDoks: report.totalDoks,
    categories: Object.entries(report.categories).map(([name, cat]) => ({
      name,
      score: cat.score,
      max: cat.max,
    })),
  };
}

export async function wizardGetDoks(): Promise<DokSummary[]> {
  const workspace = await requireWorkspace();
  const doks = await requireDokCatalog();
  const lexicon = await loadLexicon();
  const locale = workspace.default_locale ?? 'en';
  return summarizeDoks(doks, { lexicon, locale });
}
