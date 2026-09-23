// `doklo scan` — extract IR for every service in workspace.json.
//
// Wraps the per-framework adapter and writes one ProjectIR snapshot per
// service to .doklo/cache/<service-id>.scan.json. Downstream commands
// (consolidate, generate) read these snapshots so they don't re-scan.

import { assertRecordingSource, recordCacheSource } from '../lib/recording-branch.js';
import type { Command } from 'commander';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  extractProjectIR,
  type ParserFileLedgerEntry,
} from '@doklo-beta/adapter-nextjs';
import { resolveContainedOutputPath, resolveContainedPath } from '@doklo-beta/generator';
import {
  ProjectIRSchema,
  writeFileAtomicContained,
  type Framework,
  type ProjectIR,
  type Service,
} from '@doklo-beta/core';
import { prepareTrackingRepair, type TrackingRepairPlan } from '../lib/tracking-recovery.js';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import type { CliContext } from '../lib/context.js';
import { writeTextFileAtomic } from '../lib/atomic-file.js';
import {
  assertSupportedRuntimeProject,
} from '../lib/runtime-support.js';
import { recordCommandResult, type CommandDiagnostic } from '../lib/command-result.js';

export interface ScanDeps {
  /**
   * Adapter call to extract IR for one service. Default = Next.js adapter
   * (the only one wired up today). DI hook for tests.
   */
  extractIR: (opts: { rootDir: string }) => Promise<ProjectIR>;
}

const DEFAULT_DEPS: ScanDeps = {
  extractIR: extractProjectIR,
};

export interface RunScanOptions {
  root: string;
  serviceId?: string;
  /** Rebuild cached tracking and mark affected existing Doks for review, without LLM calls. */
  repairTracking?: boolean;
  /** Validate and return IR without creating the cache. */
  previewOnly?: boolean;
  /** Persist a prior preview without rescanning. */
  prepared?: RunScanResult;
}

export class ScanServiceNotFoundError extends Error {
  constructor(serviceId: string) {
    super(`No service with id "${serviceId}" exists in workspace.json.`);
    this.name = 'ScanServiceNotFoundError';
  }
}

export interface ParserLedgerIncompleteDetails {
  readonly serviceId: string;
  readonly failedFiles: readonly string[];
  readonly failures: readonly ParserLedgerFailureDetails[];
  readonly preserved: readonly string[];
  readonly nextCommand: string;
}

export interface ParserLedgerFailureDetails {
  readonly file: string;
  readonly stages: readonly ParserFileLedgerEntry['stages'][number][];
  readonly reason: string;
  readonly diagnosticCount: number;
}

export class ParserLedgerIncompleteError extends Error {
  readonly code = 'PARSER_LEDGER_INCOMPLETE' as const;
  readonly details: Readonly<ParserLedgerIncompleteDetails>;

  constructor(details: ParserLedgerIncompleteDetails) {
    super(`Parser ledger is incomplete for service "${details.serviceId}".`);
    this.name = 'ParserLedgerIncompleteError';
    this.details = Object.freeze({
      ...details,
      failedFiles: Object.freeze([...details.failedFiles]),
      failures: Object.freeze(details.failures.map((failure) => Object.freeze({
        ...failure,
        stages: Object.freeze([...failure.stages]),
      }))),
      preserved: Object.freeze([...details.preserved]),
    });
  }
}

export interface ScanServiceResult {
  serviceId: string;
  framework: Framework;
  outputPath: string;
  counts: { routes: number; components: number; stores: number };
  warnings?: ScanWarning[];
  trackingRepair?: { repairedDokIds: string[]; unmatchedDokIds: string[] };
  /** Non-enumerable for normal output; available to the in-process preview flow. */
  ir?: ProjectIR;
}

export interface ScanWarning {
  code: 'PUBLIC_STATIC_IMPORT';
  file: string;
  importPath: string;
  target: string;
}

export interface ScanSkip {
  serviceId: string;
  framework: Framework;
  reason: string;
}

export interface RunScanResult {
  results: ScanServiceResult[];
  skipped: ScanSkip[];
}

export async function runScan(
  opts: RunScanOptions,
  deps: Partial<ScanDeps> = {},
): Promise<RunScanResult> {
  const { extractIR: extract } = { ...DEFAULT_DEPS, ...deps };
  const { workspace, paths } = await loadWorkspaceWithPaths(opts.root);
  const recordingSource = await assertRecordingSource(paths.root);
  const selectedService = opts.serviceId
    ? workspace.services.find((service) => service.service_id === opts.serviceId)
    : undefined;
  if (opts.serviceId && !selectedService) {
    throw new ScanServiceNotFoundError(opts.serviceId);
  }
  const services = selectedService ? [selectedService] : workspace.services;

  const results: ScanServiceResult[] = [];
  const skipped: ScanSkip[] = [];

  const cacheDir = await resolveContainedOutputPath(
    paths.root,
    relative(paths.root, paths.cacheDir),
  );

  const prepared: Array<{
    service: Service;
    serviceRoot: string;
    requestedOutputPath: string;
    safeOutputPath: string;
  }> = [];

  for (const svc of services) {
    const serviceRoot = await resolveContainedPath(paths.root, svc.code_root);
    await assertSupportedRuntimeProject(serviceRoot);

    const requestedOutputPath = scanCachePath(paths.cacheDir, svc);
    const safeOutputPath = await resolveContainedOutputPath(
      paths.root,
      relative(paths.root, requestedOutputPath),
    );
    prepared.push({ service: svc, serviceRoot, requestedOutputPath, safeOutputPath });
  }

  // Extract and validate every selected service before writing the first
  // cache. A bad second service must not leave a trusted-looking partial scan.
  const extracted: Array<(typeof prepared)[number] & { ir: ProjectIR }> = [];
  for (const item of prepared) {
    const { serviceRoot } = item;
    const prior = opts.prepared?.results.find((result) =>
      result.serviceId === item.service.service_id)?.ir;
    const ir = ProjectIRSchema.parse(prior ?? await extract({ rootDir: serviceRoot }));
    await validateProjectIrPaths(serviceRoot, ir);
    const ledger = readValidatedFileLedger(ir);
    const failedEntries = ledger?.filter((entry) => entry.status === 'failed')
      .sort((a, b) => a.file.localeCompare(b.file)) ?? [];
    const failedFiles = ledger === null
      ? [...ir.files].sort()
      : failedEntries.map((entry) => entry.file);
    if (ledger === null || failedFiles.length > 0) {
      throw new ParserLedgerIncompleteError({
        serviceId: item.service.service_id,
        failedFiles,
        failures: failedEntries.map((entry) => ({
          file: entry.file,
          stages: entry.stages,
          reason: entry.reason,
          diagnosticCount: entry.diagnosticCount ?? 1,
        })),
        preserved: [item.requestedOutputPath],
        nextCommand: `doklo scan --service ${item.service.service_id}`,
      });
    }
    extracted.push({ ...item, ir });
  }

  const repairPlans = new Map<string, TrackingRepairPlan>();
  if (opts.repairTracking) {
    for (const item of extracted) {
      repairPlans.set(item.service.service_id, await prepareTrackingRepair(paths, item.service.service_id, item.ir));
    }
  }

  if (!opts.previewOnly) await mkdir(cacheDir, { recursive: true });
  for (const item of extracted) {
    const { service: svc, ir, requestedOutputPath, safeOutputPath } = item;
    const warnings = readValidatedImportWarnings(ir);
    const repair = repairPlans.get(svc.service_id);
    if (!opts.previewOnly) {
      await mkdir(dirname(safeOutputPath), { recursive: true });
      await writeTextFileAtomic(safeOutputPath, JSON.stringify(ir, null, 2) + '\n');
      for (const write of repair?.writes ?? []) {
        await writeFileAtomicContained(paths.root, relative(paths.root, write.path), write.content);
      }
    }
    const result: ScanServiceResult = {
      serviceId: svc.service_id,
      framework: svc.framework,
      outputPath: requestedOutputPath,
      counts: {
        routes: ir.routes.length,
        components: ir.components.length,
        stores: ir.stores.length,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(repair ? { trackingRepair: { repairedDokIds: repair.repairedDokIds, unmatchedDokIds: repair.unmatchedDokIds } } : {}),
    };
    Object.defineProperty(result, 'ir', { value: ir, enumerable: false });
    results.push(result);
  }

  if (!opts.previewOnly) {
    for (const result of results) {
      await recordCacheSource(paths.root, 'scan', result.serviceId, result.outputPath, recordingSource);
      const repair = repairPlans.get(result.serviceId);
      if (repair) await recordCacheSource(paths.root, 'consolidate', result.serviceId, repair.cachePath, recordingSource);
    }
  }
  return { results, skipped };
}

export function scanCachePath(cacheDir: string, svc: Pick<Service, 'service_id'>): string {
  return join(cacheDir, `${svc.service_id}.scan.json`);
}

const PARSER_STAGES: ReadonlySet<string> = new Set([
  'discovery',
  'ast',
  'routing',
  'state',
  'import-graph',
]);

const PARSER_FILE_STATUSES: ReadonlySet<string> = new Set([
  'processed',
  'excluded',
  'failed',
]);

function readValidatedFileLedger(ir: ProjectIR): ParserFileLedgerEntry[] | null {
  const rawLedger = ir.framework_specific?.['file_ledger'];
  if (!Array.isArray(rawLedger)) return null;

  const ledger: ParserFileLedgerEntry[] = [];
  for (const value of rawLedger) {
    const entry = parseFileLedgerEntry(value);
    if (entry === null) return null;
    ledger.push(entry);
  }

  const ledgerFiles = ledger.map((entry) => entry.file);
  if (new Set(ledgerFiles).size !== ledgerFiles.length) return null;
  if (new Set(ir.files).size !== ir.files.length) return null;

  const includedLedgerFiles = ledger
    .filter((entry) => entry.status !== 'excluded')
    .map((entry) => entry.file);
  if (includedLedgerFiles.length !== ir.files.length) return null;
  const includedFileSet = new Set(includedLedgerFiles);
  if (ir.files.some((file) => !includedFileSet.has(file))) return null;

  return ledger;
}

function parseFileLedgerEntry(value: unknown): ParserFileLedgerEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.file !== 'string' || value.file.length === 0) return null;
  if (!isParserFileStatus(value.status)) return null;
  if (!Array.isArray(value.stages) || value.stages.length === 0) return null;
  if (!value.stages.every(isParserStage)) return null;
  if (new Set(value.stages).size !== value.stages.length) return null;
  if (typeof value.reason !== 'string') return null;
  const diagnosticCount = value.diagnosticCount;
  if (
    diagnosticCount !== undefined
    && (
      typeof diagnosticCount !== 'number'
      || !Number.isInteger(diagnosticCount)
      || diagnosticCount < 1
    )
  ) return null;

  return {
    file: value.file,
    status: value.status,
    stages: [...value.stages],
    reason: value.reason,
    ...(typeof diagnosticCount === 'number'
      ? { diagnosticCount }
      : {}),
  };
}

function readValidatedImportWarnings(ir: ProjectIR): ScanWarning[] {
  const rawWarnings = ir.framework_specific?.['import_warnings'];
  if (!Array.isArray(rawWarnings)) return [];
  const warnings: ScanWarning[] = [];
  for (const value of rawWarnings) {
    if (!isRecord(value)) continue;
    if (value.code !== 'PUBLIC_STATIC_IMPORT') continue;
    if (typeof value.file !== 'string' || value.file.length === 0) continue;
    if (typeof value.importPath !== 'string' || value.importPath.length === 0) continue;
    if (typeof value.target !== 'string' || value.target.length === 0) continue;
    warnings.push({
      code: value.code,
      file: value.file,
      importPath: value.importPath,
      target: value.target,
    });
  }
  return warnings;
}

function isParserStage(value: unknown): value is ParserFileLedgerEntry['stages'][number] {
  return typeof value === 'string' && PARSER_STAGES.has(value);
}

function isParserFileStatus(value: unknown): value is ParserFileLedgerEntry['status'] {
  return typeof value === 'string' && PARSER_FILE_STATUSES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate every IR field that can be consumed later as a source path. */
export async function validateProjectIrPaths(
  serviceRoot: string,
  ir: ProjectIR,
): Promise<void> {
  const candidates = new Set<string>(ir.files);
  const unitIds = new Set<string>();
  for (const unit of ir.analysis_units ?? []) {
    if (unitIds.has(unit.id)) throw new Error('Duplicate analysis unit id.');
    unitIds.add(unit.id);
    for (const file of unit.files) {
      if (!candidates.has(file)) throw new Error('Analysis unit references an undiscovered source file.');
    }
  }
  for (const route of ir.routes) {
    candidates.add(route.file);
    for (const layout of route.layout_chain) candidates.add(layout);
  }
  for (const component of ir.components) candidates.add(component.file);
  for (const store of ir.stores) candidates.add(store.file);
  for (const signal of ir.role_signals ?? []) candidates.add(signal.file);

  const graph = ir.framework_specific?.['import_graph'];
  if (typeof graph === 'object' && graph !== null && !Array.isArray(graph)) {
    for (const [source, targets] of Object.entries(graph)) {
      candidates.add(source);
      if (Array.isArray(targets)) {
        for (const target of targets) {
          if (typeof target === 'string') candidates.add(target);
        }
      }
    }
  }

  for (const warning of readValidatedImportWarnings(ir)) {
    candidates.add(warning.file);
    candidates.add(warning.target);
  }

  for (const candidate of [...candidates].sort()) {
    await resolveContainedPath(serviceRoot, candidate);
  }
}

// ───────── commander wiring ─────────────────────────────────────────

export function registerScanCommand(program: Command, ctx: CliContext): void {
  program
    .command('scan')
    .description('Extract intermediate representation (IR) for every service')
    .option('-r, --root <dir>', 'Workspace root', process.cwd())
    .option('--service <id>', 'Limit to one service')
    .option('--repair-tracking', 'Repair local tracking mappings and mark existing Doks for review', false)
    .option('--json', 'Emit JSONL only', false)
    .action(async (opts) => {
      const { default: chalk } = await import('chalk');
      const root = opts.root as string;
      const machine = opts.json === true;
      const result = await runScan({
        root,
        serviceId: opts.service as string | undefined,
        repairTracking: opts.repairTracking === true,
      });

      if (!machine) {
        for (const r of result.results) {
          const c = r.counts;
          console.log(
            `  ${chalk.cyan('•')} ${r.serviceId} (${r.framework}) — ` +
              `${c.routes} routes, ${c.components} components, ${c.stores} stores ` +
              `→ ${r.outputPath}`,
          );
        }
        if (result.results.length > 0) {
          console.log('\n  ' + chalk.cyan('→ ') + chalk.dim(ctx.t('scan.next_step')) + '\n');
        }
      }

      const diagnostics: CommandDiagnostic[] = result.skipped.map((skip) => ({
        code: 'SERVICE_SKIPPED',
        message: skip.reason,
        serviceId: skip.serviceId,
      }));
      for (const service of result.results) {
        if (service.trackingRepair) {
          diagnostics.push({ code: 'TRACKING_REPAIR_REVIEW_REQUIRED', serviceId: service.serviceId,
            message: `Tracking repaired for ${service.trackingRepair.repairedDokIds.length} Dok(s); review required. ${service.trackingRepair.unmatchedDokIds.length} unmatched Dok(s) preserved.` });
        }
        for (const warning of service.warnings ?? []) {
          diagnostics.push({
            code: warning.code,
            message: `Source file "${warning.file}" imports "${warning.importPath}" from public/.`,
            severity: 'normal',
            serviceId: service.serviceId,
            file: warning.file,
            importPath: warning.importPath,
          });
        }
      }
      if (result.results.length === 0 && result.skipped.length === 0) {
        diagnostics.push({ code: 'NO_SERVICES', message: 'No services in workspace.json.' });
      }
      recordCommandResult(program, {
        schema_version: 1,
        command: 'scan',
        status: result.skipped.length > 0 ? 'partial' : 'success',
        data: result,
        diagnostics,
      });
    });
}
