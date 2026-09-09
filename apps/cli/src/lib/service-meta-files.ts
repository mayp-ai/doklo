import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import {
  IaFileV2Schema,
  parseIaFileAnyVersion,
  ServiceCodeMappingFileSchema,
  type IaFileV2,
  type IaNodeV2,
  type ServiceCodeMappingFile,
} from '@doklo-beta/core';
import {
  mergeDerivedCodeMapping,
  mergeDerivedIA,
  migrateIaV1ToV2,
  resolveContainedOutputPath,
  type IaMigrationFailure,
} from '@doklo-beta/generator';

export type LayerWriteStatus = 'written' | 'unchanged';

export interface LayerWriteResult {
  serviceId: string;
  status: LayerWriteStatus;
  count: number;
  outputPath: string;
}

export class InvalidLayerFileError extends Error {
  readonly outputPath: string;

  constructor(outputPath: string, cause: unknown) {
    const detail = cause instanceof Error ? ` (${cause.message})` : '';
    super(`Existing service layer file is invalid: ${outputPath}${detail}`, { cause });
    this.name = 'InvalidLayerFileError';
    this.outputPath = outputPath;
  }
}

/**
 * A legacy IA file this run refuses to convert. The file is left untouched and
 * every blocking node is reported at once, so one pass tells the user
 * everything they have to fix.
 */
export class IaMigrationBlockedError extends Error {
  readonly outputPath: string;
  readonly failures: readonly IaMigrationFailure[];

  constructor(outputPath: string, failures: readonly IaMigrationFailure[]) {
    super([
      `Existing IA file cannot be migrated to v2: ${outputPath}`,
      ...failures.map(formatIaMigrationFailure),
    ].join('\n'));
    this.name = 'IaMigrationBlockedError';
    this.outputPath = outputPath;
    this.failures = failures;
  }
}

function formatIaMigrationFailure(failure: IaMigrationFailure): string {
  const node = failure.node_path ?? failure.node_label;
  const location = node === undefined
    ? failure.tree_id
    : `${failure.tree_id}/${node}`;
  return `${location}: ${failure.guidance}`;
}

export async function persistIaFile(
  workspaceRoot: string,
  path: string,
  derived: IaFileV2,
  now: string,
  opts: { availableDokIds: ReadonlySet<string> },
): Promise<LayerWriteResult> {
  const safePath = await resolveSafeLayerTarget(workspaceRoot, path);
  const parsedDerived = IaFileV2Schema.parse(derived);
  const existing = await readExisting(safePath, parseIaFileAnyVersion, path);
  assertSameService(path, existing?.file ?? null, parsedDerived.service_id);
  const count = parsedDerived.trees.reduce(
    (total, tree) => total + countIaDestinations(tree.nodes),
    0,
  );

  // A v1 file is converted, not merged: the migration already folds the derived
  // hierarchy in, and it either produces the whole v2 file or nothing at all.
  if (existing?.version === 1) {
    const migrated = migrateIaV1ToV2({
      v1: existing.file,
      derived: parsedDerived,
      availableDokIds: opts.availableDokIds,
    });
    if (!migrated.ok) throw new IaMigrationBlockedError(path, migrated.failures);

    const canonical = IaFileV2Schema.parse({ ...migrated.file, updated_at: now });
    await writeCanonicalJson(workspaceRoot, path, canonical);
    return {
      serviceId: canonical.service_id,
      status: 'written',
      count,
      outputPath: path,
    };
  }

  const merged = mergeDerivedIA(existing?.file ?? null, parsedDerived, now);

  if (!merged.changed) {
    return {
      serviceId: parsedDerived.service_id,
      status: 'unchanged',
      count,
      outputPath: path,
    };
  }

  const canonical = IaFileV2Schema.parse(merged.file);
  await writeCanonicalJson(workspaceRoot, path, canonical);
  return {
    serviceId: canonical.service_id,
    status: 'written',
    count,
    outputPath: path,
  };
}

export async function persistCodeMappingFile(
  workspaceRoot: string,
  path: string,
  derived: ServiceCodeMappingFile,
  now: string,
): Promise<LayerWriteResult> {
  const safePath = await resolveSafeLayerTarget(workspaceRoot, path);
  const parsedDerived = ServiceCodeMappingFileSchema.parse(derived);
  const existing = await readExisting(
    safePath,
    ServiceCodeMappingFileSchema.parse,
    path,
  );
  assertSameService(path, existing, parsedDerived.service_id);
  const merged = mergeDerivedCodeMapping(existing, parsedDerived, now);
  const count = parsedDerived.entries.length;

  if (!merged.changed) {
    return {
      serviceId: parsedDerived.service_id,
      status: 'unchanged',
      count,
      outputPath: path,
    };
  }

  const canonical = ServiceCodeMappingFileSchema.parse(merged.file);
  await writeCanonicalJson(workspaceRoot, path, canonical);
  return {
    serviceId: canonical.service_id,
    status: 'written',
    count,
    outputPath: path,
  };
}

export async function validateExistingIaFile(
  workspaceRoot: string,
  path: string,
  expectedServiceId: string,
): Promise<string> {
  const safePath = await resolveSafeLayerTarget(workspaceRoot, path);
  // Both contracts are readable here: preflight only proves the file parses and
  // belongs to this service. Converting a v1 file is the producer's job.
  const existing = await readExisting(safePath, parseIaFileAnyVersion, path);
  assertSameService(path, existing?.file ?? null, expectedServiceId);
  return path;
}

export async function validateExistingCodeMappingFile(
  workspaceRoot: string,
  path: string,
  expectedServiceId: string,
): Promise<string> {
  const safePath = await resolveSafeLayerTarget(workspaceRoot, path);
  const existing = await readExisting(
    safePath,
    ServiceCodeMappingFileSchema.parse,
    path,
  );
  assertSameService(path, existing, expectedServiceId);
  return path;
}

async function readExisting<T>(
  path: string,
  parse: (value: unknown) => T,
  errorPath = path,
): Promise<T | null> {
  try {
    return parse(JSON.parse(await readFile(path, 'utf-8')) as unknown);
  } catch (cause) {
    if (isFileNotFoundError(cause)) return null;
    throw new InvalidLayerFileError(errorPath, cause);
  }
}

async function writeCanonicalJson(
  workspaceRoot: string,
  requestedPath: string,
  value: unknown,
): Promise<void> {
  let safePath = await resolveSafeLayerTarget(workspaceRoot, requestedPath);
  await mkdir(dirname(safePath), { recursive: true });
  // Re-resolve after mkdir so a static/dangling parent link cannot become a
  // write primitive between the preflight read and persistence.
  safePath = await resolveSafeLayerTarget(workspaceRoot, requestedPath);

  const tempPath = join(
    dirname(safePath),
    `.${basename(safePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o666);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, safePath);
  } finally {
    await handle?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function resolveSafeLayerTarget(
  workspaceRoot: string,
  path: string,
): Promise<string> {
  return resolveContainedOutputPath(
    workspaceRoot,
    relative(workspaceRoot, path),
  );
}

/** Reported count = reachable surfaces. Groups are containers, not surfaces. */
function countIaDestinations(nodes: readonly IaNodeV2[]): number {
  return nodes.reduce(
    (total, node) =>
      total
      + (node.kind === 'destination' ? 1 : 0)
      + countIaDestinations(node.children),
    0,
  );
}

function assertSameService(
  path: string,
  existing: { service_id: string } | null,
  expectedServiceId: string,
): void {
  if (existing === null || existing.service_id === expectedServiceId) return;
  throw new InvalidLayerFileError(
    path,
    new Error(
      `expected service_id "${expectedServiceId}", found "${existing.service_id}"`,
    ),
  );
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
