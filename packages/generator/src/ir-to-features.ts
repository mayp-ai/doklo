// IR → FeatureConfig bridge.
//
// The legacy v4 consolidator works on FeatureConfig (route-grouped feature
// list with file/role/depth metadata). v5 adapters emit ProjectIR. This
// module is the bridge.
//
// Two modes:
//   1. Without an import graph (fallback): each Feature carries only its
//      page entry; non-page files all flow into sharedInfrastructure.
//   2. With an import graph (when ir.framework_specific.import_graph is
//      present): each page's BFS-reachable file set becomes the feature's
//      files; files reachable from ≥SHARED_THRESHOLD features get hoisted
//      to sharedInfrastructure (per-bucket by inferred role).
//   3. With import_context, prompt evidence uses per-entry symbol slices,
//      including used shared behavior; the full file graph still tracks drift.
//
// The import graph itself is built upstream by the adapter (e.g.,
// adapter-nextjs/src/import-graph.ts) and serialized into IR; this module
// just consumes it. Keeping the consumer here means generator stays
// framework-agnostic — it never imports ts-morph.

import type { ProjectIR, RouteIR } from '@doklo-beta/core';
import type {
  Feature,
  FeatureConfig,
  FeatureFile,
  FeatureFileRole,
  FeatureGroup,
  SharedInfrastructure,
  SourceContext,
} from './legacy-types.js';
import { uniqueFeatureIdsForRoutes } from './feature-id.js';

export interface IrToFeaturesOptions {
  projectName: string;
  /** When set, used as the FeatureConfig.terminology dict. */
  terminology?: Record<string, string>;
  /**
   * A file reachable from at least this many feature entries is treated
   * as shared infrastructure rather than belonging to any one feature.
   * Default: 3.
   */
  sharedThreshold?: number;
  /** BFS depth for reachable-files attribution. Default: 4. */
  reachableMaxDepth?: number;
}

const ROOT_GROUP = '_root';
const DEFAULT_SHARED_THRESHOLD = 3;
const DEFAULT_REACHABLE_MAX_DEPTH = 4;

export function irToFeatures(ir: ProjectIR, opts: IrToFeaturesOptions): FeatureConfig {
  const sharedThreshold = opts.sharedThreshold ?? DEFAULT_SHARED_THRESHOLD;
  const maxDepth = opts.reachableMaxDepth ?? DEFAULT_REACHABLE_MAX_DEPTH;

  const pages = ir.routes.filter((r) => r.kind === 'page');
  const apis = ir.routes.filter((r) => r.kind === 'api');
  const pageFeatureIds = uniqueFeatureIdsForRoutes(pages.map((page) => page.path));
  const featureIdByPage = new Map(
    pages.map((page, index) => [page, pageFeatureIds[index]!] as const),
  );

  // Group pages by first path segment.
  const grouped = new Map<string, RouteIR[]>();
  for (const p of pages) {
    const seg = firstSegment(p.path);
    const list = grouped.get(seg) ?? [];
    list.push(p);
    grouped.set(seg, list);
  }

  // Optional: load + use the import graph if the IR carries one.
  const graphData =
    (ir.framework_specific?.['import_graph'] as Record<string, string[]> | undefined) ?? null;
  const edges = graphData ? deserializeEdges(graphData) : null;
  const contexts = ir.framework_specific?.['import_context'] as Record<string, SourceContext[]> | undefined;

  // Build per-page reachable sets + global reference counts (only when graph
  // available). Without a graph, both are empty and we fall back to entry-only
  // attribution.
  const reachableByPage = new Map<RouteIR, Set<string>>();
  const fileRefCount = new Map<string, number>();
  if (edges) {
    for (const page of pages) {
      const reach = bfsReachable(edges, page.file, maxDepth);
      reachableByPage.set(page, reach);
      for (const f of reach) {
        fileRefCount.set(f, (fileRefCount.get(f) ?? 0) + 1);
      }
    }
  }
  const sharedFiles = new Set<string>();
  for (const [f, count] of fileRefCount) {
    if (count >= sharedThreshold) sharedFiles.add(f);
  }

  // Build features per group.
  const featureGroups: FeatureGroup[] = [];
  for (const [groupId, groupPages] of grouped) {
    const features: Feature[] = groupPages.map((page) =>
      buildFeature(page, featureIdByPage.get(page)!, apis, reachableByPage.get(page), sharedFiles, contexts?.[page.file]),
    );
    featureGroups.push({
      id: groupId,
      label: groupId === ROOT_GROUP ? 'Root' : groupId,
      routePrefix: groupId === ROOT_GROUP ? '/' : `/${groupId}`,
      description: '',
      features,
      totalFileCount: features.reduce((acc, f) => acc + f.files.length, 0),
      enabled: true,
    });
  }

  const unitFiles = new Set<string>();
  const connectedSourceFiles = new Set([...pages.map(page => page.file), ...[...reachableByPage.values()].flatMap(files => [...files])]);
  const sourceClassification: NonNullable<FeatureConfig['sourceClassification']> = {
    auxiliaryFiles: ir.files.filter(isAuxiliarySource),
    unconnectedFiles: pages.length ? ir.files.filter(file => !isAuxiliarySource(file) && !connectedSourceFiles.has(file)) : [],
    excludedUnits: [], candidateUnits: 0,
  };
  if (ir.analysis_units?.length) {
    const candidates: Feature[] = [];
    const reachableFiles = new Set([...reachableByPage.values()].flatMap(files => [...files]));
    for (const unit of ir.analysis_units) {
      for (const file of unit.files) unitFiles.add(file);
      const behavior = unit.files.filter(file => !isAuxiliarySource(file));
      if (behavior.length === 0) {
        sourceClassification.excludedUnits.push({ id: unit.id, files: unit.files, reason: 'AUXILIARY_SOURCE_ONLY' });
        continue;
      }
      const unconnected = pages.length > 0 && !behavior.some(file => reachableFiles.has(file));
      candidates.push({
        id: unit.id, label: unit.label, routePath: '', entryPoint: behavior[0]!,
        files: unit.files.map((path) => ({ path, role: path === behavior[0] ? 'entry' as const : 'util' as const, depth: 0, isShared: false })),
        logic_files: [...ir.files], apiRoutes: [], components: [], stores: [], enabled: !unconnected,
        candidate_kind: unconnected ? 'unconnected-source' : 'source-behavior',
      });
    }
    sourceClassification.candidateUnits = candidates.length;
    if (candidates.length) featureGroups.push({ id: '_source', label: 'Source analysis', routePrefix: '',
      description: 'File-based candidates; unconnected source needs review before customer documentation.', features: candidates,
      totalFileCount: new Set(candidates.flatMap(candidate => candidate.files.map(file => file.path))).size, enabled: true });
  }

  // Shared infrastructure: bucket the shared-file set by role. Without a
  // graph, fall back to the prior heuristic (every component / hook / store
  // declared in the IR is "shared").
  const sharedInfrastructure: SharedInfrastructure = edges
    ? bucketByRole([...sharedFiles])
    : {
        sharedComponents: ir.components
          .filter((c) => c.kind === 'component')
          .map((c) => c.file),
        sharedHooks: ir.components
          .filter((c) => c.kind === 'hook')
          .map((c) => c.file),
        sharedStores: ir.stores.map((s) => s.file),
        sharedUtils: [],
        sharedTypes: [],
      };

  // Files outside any feature's reachable set (or, without a graph, every
  // non-page file) are reported as unmapped — useful telemetry, not a
  // correctness concern.
  let unmappedFiles: string[];
  if (edges) {
    const claimed = new Set<string>(sharedFiles);
    for (const reach of reachableByPage.values()) {
      for (const f of reach) claimed.add(f);
    }
    unmappedFiles = ir.files.filter((f) => !claimed.has(f));
  } else {
    const pageFiles = new Set(pages.map((p) => p.file));
    unmappedFiles = ir.files.filter((f) => !pageFiles.has(f));
  }

  return {
    projectName: opts.projectName,
    projectRoot: ir.root,
    featureGroups,
    sharedInfrastructure,
    terminology: opts.terminology ?? {},
    generatedAt: new Date().toISOString(),
    totalFiles: ir.files.length,
    sourceClassification,
    unmappedFiles: unmappedFiles.filter(file => !unitFiles.has(file)),
  };
}

function firstSegment(path: string): string {
  const trimmed = path.replace(/^\/+/, '').split('/')[0] ?? '';
  if (trimmed === '' || trimmed.startsWith('[') || trimmed.startsWith('(')) {
    return ROOT_GROUP;
  }
  return trimmed;
}

function buildFeature(
  page: RouteIR,
  id: string,
  apis: RouteIR[],
  reachable: Set<string> | undefined,
  sharedFiles: Set<string>,
  sourceContext?: SourceContext[],
): Feature {
  const apiRoutes = apis
    .filter((a) => firstSegmentOfApi(a.path) === firstSegment(page.path))
    .map((a) => a.path);

  let files: FeatureFile[];
  let logicFiles: string[];
  let components: string[] = [];
  let stores: string[] = [];

  if (reachable) {
    // Symbol-aware context retains actually used shared behavior. Older scans
    // retain the legacy whole-file attribution and shared-infrastructure split.
    files = [...reachable]
      .filter((f) => sourceContext ? sourceContext.some(context => context.file === f) : f === page.file || !sharedFiles.has(f))
      .map((f) => ({
        path: f,
        role: roleForFile(f, f === page.file),
        depth: f === page.file ? 0 : 1,
        isShared: sharedFiles.has(f),
      }));
    // Drift keeps the conservative whole-file graph, independently of symbol
    // evidence or shared-infrastructure display filtering.
    logicFiles = [...reachable];
    components = files.filter((f) => f.role === 'component').map((f) => f.path);
    stores = files.filter((f) => f.role === 'store').map((f) => f.path);
  } else {
    // Fallback: entry only. Without a graph there is no reachable closure to
    // widen to, so the drift set equals the display set (regression-safe).
    files = [{ path: page.file, role: 'entry', depth: 0, isShared: false }];
    logicFiles = files.map((f) => f.path);
  }

  return {
    id,
    label: id,
    routePath: page.path,
    entryPoint: page.file,
    files,
    logic_files: logicFiles,
    ...(sourceContext ? { source_context: sourceContext } : {}),
    apiRoutes,
    components,
    stores,
    enabled: true,
  };
}

function firstSegmentOfApi(path: string): string {
  const parts = path.replace(/^\/+/, '').split('/');
  if (parts[0] === 'api' && parts[1]) return parts[1];
  return parts[0] ?? '';
}

// ───────── role inference + shared bucketing ───────────────────────

function roleForFile(file: string, isEntry: boolean): FeatureFileRole {
  if (isEntry) return 'entry';
  if (/(^|\/)route\.(ts|js)$/.test(file)) return 'api';
  if (/\/api\//.test(file)) return 'api';
  if (/\/hooks?\//.test(file) || /\/use[A-Z]/.test(file)) return 'hook';
  if (/\.store\.(ts|js)$/.test(file) || /\/stores?\//.test(file)) return 'store';
  if (/\.action\.(ts|js)$/.test(file) || /\/actions?\//.test(file)) return 'action';
  if (/\.types?\.(ts|tsx)$/.test(file) || /\/types?\//.test(file) || /\.d\.ts$/.test(file)) {
    return 'type';
  }
  if (/\.(tsx|jsx)$/.test(file)) return 'component';
  if (/\/(utils?|lib)\//.test(file)) return 'util';
  return 'util';
}

function bucketByRole(files: string[]): SharedInfrastructure {
  const out: SharedInfrastructure = {
    sharedComponents: [],
    sharedHooks: [],
    sharedStores: [],
    sharedUtils: [],
    sharedTypes: [],
  };
  for (const f of files) {
    const role = roleForFile(f, false);
    switch (role) {
      case 'component':
      case 'entry':
        out.sharedComponents.push(f);
        break;
      case 'hook':
        out.sharedHooks.push(f);
        break;
      case 'store':
        out.sharedStores.push(f);
        break;
      case 'type':
        out.sharedTypes.push(f);
        break;
      case 'util':
      case 'action':
      case 'api':
        out.sharedUtils.push(f);
        break;
    }
  }
  return out;
}

// ───────── tiny inline graph helpers ──────────────────────────────

// Inlined here so generator stays free of an adapter-nextjs dep. The
// canonical builder + serializer live in @doklo-beta/adapter-nextjs;
// these mirror just the JSON shape we need to consume.

function deserializeEdges(data: Record<string, string[]>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(data)) m.set(k, new Set(v));
  return m;
}

function bfsReachable(
  edges: Map<string, Set<string>>,
  entry: string,
  maxDepth: number,
): Set<string> {
  const seen = new Set<string>([entry]);
  const queue: { f: string; d: number }[] = [{ f: entry, d: 0 }];
  while (queue.length > 0) {
    const { f, d } = queue.shift()!;
    if (d >= maxDepth) continue;
    const next = edges.get(f);
    if (!next) continue;
    for (const n of next) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push({ f: n, d: d + 1 });
    }
  }
  return seen;
}

/** Technical evidence stays inventoried, but cannot establish a user capability alone. */
function isAuxiliarySource(file: string): boolean {
  return /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|webmanifest|md|mdx|txt|json|jsonc|ya?ml|toml|lock)$/i.test(file) ||
    /(?:^|\/)(?:[^/]+\.config\.[cm]?[jt]s|[jt]sconfig[^/]*|\.dockerignore|Dockerfile|Makefile|Gemfile|go\.(?:mod|sum)|pom\.xml)$/i.test(file) ||
    /(?:^|\/)(?:__tests__|tests?|__mocks__|fixtures)(?:\/|$)/.test(file) || /\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(file);
}
