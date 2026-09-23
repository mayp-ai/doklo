// @doklo-beta/adapter-nextjs
//
// Public API: extractIR(rootDir) → ProjectIR
// Everything else is implementation detail (vendored legacy parsers + mappers)
// re-exported under named groups for testing and advanced use cases.

import type { ProjectIR } from '@doklo-beta/core';
import { scanProject } from './scanner.js';
import { parseProject } from './ast.js';
import { parseNextJsProject } from './routing.js';
import { parseStores } from './state.js';
import {
  buildImportGraph,
  serializeImportGraph,
  type ImportGraphWarning,
} from './import-graph.js';
import { inspectNextJsSupport } from './support.js';
import { buildFileLedger } from './file-ledger.js';
import type { ParserDiagnostic, ParserStage } from './legacy-types.js';
import {
  mapAppRoutes,
  mapApiRoutes,
  dedupeRoutes,
  mapComponents,
  mapFunctions,
  mapClasses,
  mapStores,
  mapContexts,
} from './mappers.js';

export interface ExtractIROptions {
  /** Project root to analyze (absolute or relative). */
  rootDir: string;
  /**
   * Build the import graph (via ts-morph) for every page route discovered.
   * Default: true. Adds ~20-60s on large projects but is required for
   * irToFeatures to attribute non-entry files to features.
   */
  includeImportGraph?: boolean;
  /** Optional shared discovery boundary supplied by the parser registry. */
  allowedSourceFiles?: ReadonlySet<string>;
}

// Run the full Next.js adapter pipeline and emit a ProjectIR.
//
// Pipeline:
//   1. scanner   — discover source files
//   2. ast       — extract functions / components / classes / api routes
//   3. routing   — extract App Router pages/layouts/route handlers + meta
//   4. state     — extract Zustand/Redux/Jotai/Context stores
//   5. mappers   — translate vendor output → IR
//
// The 3 derived parsers (ast / routing / state) run in parallel.
export async function extractIR(options: ExtractIROptions): Promise<ProjectIR> {
  const support = await inspectNextJsSupport(options.rootDir);
  const scan = await scanProject(options.rootDir);
  if (options.allowedSourceFiles) {
    scan.files = scan.files.filter(file => options.allowedSourceFiles!.has(file));
    scan.candidates = scan.candidates.filter(candidate => options.allowedSourceFiles!.has(candidate.file));
  }

  const [ast, next, storeAnalysis] = await Promise.all([
    Promise.resolve(parseProject(scan)),
    parseNextJsProject(scan, options.allowedSourceFiles),
    Promise.resolve(parseStores(scan)),
  ]);

  const routes = dedupeRoutes([
    ...mapAppRoutes(next.appRoutes),
    ...mapApiRoutes(ast.routes),
  ]);

  const components = [
    ...mapComponents(ast.components),
    ...mapFunctions(ast.functions),
    ...mapClasses(ast.classes),
  ];

  const stores = [
    ...mapStores(storeAnalysis.stores),
    ...mapContexts(storeAnalysis.contexts),
  ];

  // Optional: build the import graph from every page entry. The default
  // is on because downstream consolidate / generate use it for feature
  // attribution; opt-out is for callers (tests, fast-paths) that don't
  // need it.
  const includeImportGraph = options.includeImportGraph ?? true;
  let importGraphSerialized: Record<string, string[]> | undefined;
  let importGraphDiagnostics: ParserDiagnostic[] = [];
  let importGraphProcessedFiles: string[] = [];
  let importGraphWarnings: ImportGraphWarning[] = [];
  if (includeImportGraph) {
    const pageEntryFiles = routes
      .filter((r) => r.kind === 'page')
      .map((r) => r.file);
    if (pageEntryFiles.length > 0) {
      const graph = buildImportGraph({
        rootDir: scan.rootDir,
        entryFiles: pageEntryFiles,
        allowedSourceFiles: options.allowedSourceFiles,
      });
      importGraphSerialized = serializeImportGraph(graph);
      importGraphDiagnostics = graph.diagnostics ?? [];
      importGraphProcessedFiles = graph.processedFiles ?? [];
      importGraphWarnings = graph.warnings ?? [];
    }
  }

  const executedStagesByFile = new Map<string, ParserStage[]>(
    scan.candidates.map((candidate) => [candidate.file, ['discovery']]),
  );
  const recordStage = (files: readonly string[], stage: ParserStage): void => {
    for (const file of files) {
      const stages = executedStagesByFile.get(file);
      if (stages && !stages.includes(stage)) stages.push(stage);
    }
  };
  recordStage(scan.files, 'ast');
  recordStage(scan.files, 'routing');
  recordStage(storeAnalysis.processedFiles, 'state');
  recordStage(importGraphProcessedFiles, 'import-graph');

  const fileLedger = buildFileLedger(scan.candidates, [
    ...ast.diagnostics,
    ...next.diagnostics,
    ...storeAnalysis.diagnostics,
    ...importGraphDiagnostics,
  ], executedStagesByFile);

  const ir: ProjectIR = {
    framework: 'nextjs',
    root: scan.rootDir,
    files: scan.files,
    routes,
    components,
    stores,
    role_signals: ast.roleSignals,
    framework_specific: {
      next_config: next.nextConfig,
      middleware: next.middleware,
      package_json: next.packageJson,
      env_keys: next.envKeys,
      ast_errors: ast.errors,
      ...(importGraphSerialized ? { import_graph: importGraphSerialized } : {}),
      ...(importGraphSerialized && importGraphDiagnostics.length === 0
        ? { import_graph_tracking_version: 2 } : {}),
      ...(importGraphDiagnostics.length > 0 ? { import_diagnostics: importGraphDiagnostics } : {}),
      ...(importGraphWarnings.length > 0 ? { import_warnings: importGraphWarnings } : {}),
      file_ledger: fileLedger,
    },
  };

  if (support.nextVersion) ir.framework_version = support.nextVersion;

  return ir;
}

// ───────── Implementation re-exports (advanced use / testing) ─────

export * from './scanner.js';
export * from './ast.js';
export * from './routing.js';
export * from './state.js';
export * from './role-extractor.js';
export * from './role-signal-extractor.js';
export * from './import-graph.js';
export * from './lexicon-extractor.js';
export * from './jsx-lexicon-extractor.js';
export * from './support.js';
export * from './file-ledger.js';
export * as mappers from './mappers.js';
export type * from './legacy-types.js';

// Sentinel for "is this package wired up?" smoke checks.
export const ADAPTER_VERSION = '0.1.0';

export * from './generic.js';
export * from './registry.js';
