import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  IaFileV2Schema,
  ServiceCodeMappingFileSchema,
  type IaFileV2,
  type IaLabel,
  type ProjectIR,
  type ServiceCodeMappingEntry,
  type ServiceCodeMappingFile,
  type ServiceId,
} from '@doklo-beta/core';
import type {
  ConsolidatedFeature,
  ConsolidatedFeatureConfig,
} from './legacy-types.js';
import {
  assertSitemapCoverage,
  buildSitemapNodes,
  routeTreeIds,
  ROUTE_HIERARCHY_PRODUCER,
  type SitemapPresentation,
} from './ia-sitemap.js';
import { resolveContainedPath } from './path-containment.js';

export { mergeDerivedIA } from './ia-merge.js';
// The producer identity travels with `deriveIA`: every caller that derives IA
// also needs to know which producer signed the tree.
export { ROUTE_HIERARCHY_PRODUCER, routeTreeIds } from './ia-sitemap.js';

export interface DeriveServiceMetaContext {
  serviceId: ServiceId;
  serviceRoot: string;
  consolidated: ConsolidatedFeatureConfig;
  ir: ProjectIR;
  availableDokIds: ReadonlySet<string>;
  dokNames?: ReadonlyMap<string, IaLabel>;
}

export interface MergeResult<T> {
  file: T;
  changed: boolean;
}

/** A consolidated group assigned the same dok_id_prefix to two features. */
export class DuplicateDokIdPrefixError extends Error {
  constructor(readonly prefix: string, readonly canonicalIds: [string, string]) {
    super(`Duplicate dok_id_prefix "${prefix}" (features: ${canonicalIds.join(', ')}). ` +
      'Each consolidated feature needs a unique prefix — rename one in Studio\'s consolidation ' +
      'screen, or edit it directly in the consolidated cache ' +
      '(`.doklo/cache/<service>.consolidated.json`), and retry.');
  }
}

/** Assign Dok IDs: the semantic prefix IS the id. Duplicates are a hard error. */
export function assignDokIds(
  consolidated: ConsolidatedFeatureConfig,
): Map<string, string> {
  const assigned = new Map<string, string>();
  const ownerByPrefix = new Map<string, string>();

  for (const group of consolidated.groups) {
    for (const feature of group.features) {
      if (feature.decision === 'exclude' || !feature.dok_id_prefix) continue;

      const prefix = feature.dok_id_prefix;
      const owner = ownerByPrefix.get(prefix);
      if (owner !== undefined) throw new DuplicateDokIdPrefixError(prefix, [owner, feature.canonical_id]);
      ownerByPrefix.set(prefix, feature.canonical_id);
      assigned.set(feature.canonical_id, prefix);
    }
  }

  return assigned;
}

/** Derive the deterministic route hierarchy from the service's page routes. */
export function deriveIA(ctx: DeriveServiceMetaContext): IaFileV2 {
  const assigned = assignDokIds(ctx.consolidated);
  const labelByRoute = new Map<string, string>();
  const dokByRoute = new Map<string, string>();

  for (const group of ctx.consolidated.groups) {
    for (const feature of group.features) {
      if (!labelByRoute.has(feature.primary_route) && feature.label.trim() !== '') {
        labelByRoute.set(feature.primary_route, feature.label);
      }
      const dokId = assigned.get(feature.canonical_id);
      if (
        dokId
        && ctx.availableDokIds.has(dokId)
        && !dokByRoute.has(feature.primary_route)
      ) {
        dokByRoute.set(feature.primary_route, dokId);
      }
    }
  }

  const presentation = new Map<string, SitemapPresentation>();
  for (const route of ctx.ir.routes) {
    const routePath = normalizeRoutePath(route.path);
    if (route.kind !== 'page' || presentation.has(routePath)) continue;
    const dokRef = dokByRoute.get(route.path);
    const dokName = dokRef === undefined ? undefined : ctx.dokNames?.get(dokRef);
    const featureLabel = labelByRoute.get(route.path);
    presentation.set(routePath, {
      ...(featureLabel === undefined ? {} : { featureLabel }),
      ...(dokRef === undefined ? {} : { dokRef }),
      ...(dokName === undefined ? {} : { dokName }),
    });
  }

  const nodes = buildSitemapNodes(ctx.ir.routes, presentation);
  assertSitemapCoverage(ctx.ir.routes, nodes);

  return IaFileV2Schema.parse({
    service_id: ctx.serviceId,
    version: 2,
    trees: [
      {
        tree_id: routeTreeIds(ctx.serviceId).canonical,
        type: 'route_hierarchy',
        source: 'auto',
        producer: ROUTE_HIERARCHY_PRODUCER,
        platform: 'all',
        nodes,
      },
    ],
  });
}

/** Derive deterministic Dok-to-file mappings without introducing timestamps. */
export async function deriveCodeMapping(
  ctx: DeriveServiceMetaContext,
): Promise<ServiceCodeMappingFile> {
  const assigned = assignDokIds(ctx.consolidated);
  const entries: ServiceCodeMappingEntry[] = [];

  for (const group of ctx.consolidated.groups) {
    for (const feature of group.features) {
      const dokId = assigned.get(feature.canonical_id);
      if (!dokId || !ctx.availableDokIds.has(dokId)) continue;

      const paths = collectFeaturePaths(feature, ctx.ir);
      entries.push({
        dok_id: dokId,
        files: paths.map((path) => ({ path, functions: [], components: [] })),
        content_hash: await hashFiles(ctx.serviceRoot, paths),
        sync_status: 'synced',
      });
    }
  }

  entries.sort((left, right) => compareStrings(left.dok_id, right.dok_id));

  return ServiceCodeMappingFileSchema.parse({
    service_id: ctx.serviceId,
    entries,
    version: 1,
  });
}

/** Merge automatic mapping fields while retaining supported manual enrichments. */
export function mergeDerivedCodeMapping(
  existing: ServiceCodeMappingFile | null,
  derived: ServiceCodeMappingFile,
  now: string,
): MergeResult<ServiceCodeMappingFile> {
  const parsedDerived = ServiceCodeMappingFileSchema.parse(derived);
  const parsedExisting = existing === null
    ? null
    : ServiceCodeMappingFileSchema.parse(existing);
  const existingByDokId = new Map(
    (parsedExisting?.entries ?? []).map((entry) => [entry.dok_id, entry]),
  );

  const mergedEntries = parsedDerived.entries.map((entry) => {
    const previous = existingByDokId.get(entry.dok_id);
    return mergeMappingEntry(previous, entry);
  });
  const semanticFile = withoutMappingFileTimestamp({
    ...parsedDerived,
    version: parsedExisting?.version ?? parsedDerived.version,
    entries: mergedEntries,
  });

  if (
    parsedExisting !== null
    && semanticEqual(semanticFile, withoutMappingFileTimestamp(parsedExisting))
  ) {
    return { file: existing!, changed: false };
  }

  const stampedEntries = mergedEntries.map((entry) => {
    const previous = existingByDokId.get(entry.dok_id);
    const entryChanged = previous === undefined || !semanticEqual(
      withoutEntryTimestamp(entry),
      withoutEntryTimestamp(previous),
    );

    if (entryChanged) return { ...entry, last_synced_at: now };
    if (previous.last_synced_at !== undefined) {
      return { ...entry, last_synced_at: previous.last_synced_at };
    }
    return entry;
  });

  return {
    file: ServiceCodeMappingFileSchema.parse({
      ...semanticFile,
      entries: stampedEntries,
      updated_at: now,
    }),
    changed: true,
  };
}

function normalizeRoutePath(value: string): string {
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash === '/' ? '/' : withLeadingSlash.replace(/\/+$/, '');
}

function collectFeaturePaths(feature: ConsolidatedFeature, ir: ProjectIR): string[] {
  const paths = feature.source_files !== undefined
    ? feature.source_files
    : ir.routes
      .filter((route) => route.kind === 'page' && route.path === feature.primary_route)
      .map((route) => route.file);

  return [...new Set(paths)].sort(compareStrings);
}

async function hashFiles(serviceRoot: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return '';

  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    const absolutePath = await resolveContainedPath(serviceRoot, path, {
      allowMissingLeaf: true,
      rejectSymlinkLeaf: true,
    });
    try {
      hash.update(await readFile(absolutePath));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function mergeMappingEntry(
  existing: ServiceCodeMappingEntry | undefined,
  derived: ServiceCodeMappingEntry,
): ServiceCodeMappingEntry {
  const {
    last_synced_at: _lastSyncedAt,
    exposes_apis: _exposesApis,
    consumes_apis: _consumesApis,
    db_tables: _dbTables,
    ...automatic
  } = derived;

  if (!existing) return automatic;

  const existingFiles = new Map(existing.files.map((file) => [file.path, file]));
  const files = derived.files.map((file) => {
    const previous = existingFiles.get(file.path);
    if (!previous) return file;
    return {
      path: file.path,
      functions: previous.functions,
      components: previous.components,
      ...(previous.lines === undefined ? {} : { lines: previous.lines }),
      ...(previous.last_commit === undefined ? {} : { last_commit: previous.last_commit }),
    };
  });

  return {
    ...automatic,
    files,
    ...(existing.exposes_apis === undefined ? {} : { exposes_apis: existing.exposes_apis }),
    ...(existing.consumes_apis === undefined ? {} : { consumes_apis: existing.consumes_apis }),
    ...(existing.db_tables === undefined ? {} : { db_tables: existing.db_tables }),
  };
}

function withoutEntryTimestamp(entry: ServiceCodeMappingEntry): ServiceCodeMappingEntry {
  const { last_synced_at: _lastSyncedAt, ...semantic } = entry;
  return semantic;
}

function withoutMappingFileTimestamp(
  file: ServiceCodeMappingFile,
): ServiceCodeMappingFile {
  const { updated_at: _updatedAt, ...semantic } = file;
  return {
    ...semantic,
    entries: semantic.entries.map(withoutEntryTimestamp),
  };
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
