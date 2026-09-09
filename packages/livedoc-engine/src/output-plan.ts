import { lstat } from 'node:fs/promises';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { resolveContainedPath } from '@doklo-beta/core';

export type PlannedOutput = {
  path: string;
  relative_path: string;
  format: string;
  dok_id?: string;
  exists: boolean;
  action: 'create' | 'overwrite' | 'blocked';
};

export type WritablePlannedOutput = PlannedOutput & {
  action: 'create' | 'overwrite';
};

export function isWritablePlannedOutput(
  output: PlannedOutput,
): output is WritablePlannedOutput {
  return output.action === 'create' || output.action === 'overwrite';
}

export function plannedOutputReplace(output: WritablePlannedOutput): boolean {
  return output.action === 'overwrite';
}

export type RenderPlanInputs = {
  template_ref?: string;
  template_source?: string;
  template_path?: string;
  dok_ids: string[];
  source_paths: string[];
};

export type RenderPlanWarning = {
  code: string;
  message: string;
  dok_id?: string;
  field?: string;
};

export type RenderOutputPlan = {
  output_root: string;
  overwrite: boolean;
  outputs: PlannedOutput[];
  manifest_path: string;
  inputs: RenderPlanInputs;
  warnings: RenderPlanWarning[];
};

export type ReproduciblePlannedOutput = Omit<PlannedOutput, 'exists' | 'action'>;

export type ReproducibleRenderOutputPlan = Omit<RenderOutputPlan, 'overwrite' | 'outputs'> & {
  outputs: ReproduciblePlannedOutput[];
};

export class DuplicateOutputError extends Error {
  readonly code = 'DUPLICATE_OUTPUT';

  constructor(relativePath: string) {
    super(`multiple producers claim output: ${relativePath}`);
    this.name = 'DuplicateOutputError';
  }
}

type OutputTarget = { relativePath: string; format: string; dokId?: string };

export function plannedRelativePath(outputPath: string, format: string): string {
  switch (format) {
    case 'markdown':
      return ensureExtension(outputPath, '.md');
    case 'html':
      return ensureExtension(outputPath, '.html');
    case 'yaml':
      return ensureExtension(outputPath, '.yaml');
    case 'json':
      return ensureExtension(outputPath, '.json');
    case 'hwpx':
      return ensureExtension(outputPath, '.hwpx');
    case 'pptx':
      return ensureExtension(outputPath, '.pptx');
    case 'xlsx':
      return ensureExtension(outputPath, '.xlsx');
    case 'text':
      return outputPath;
    default:
      throw new Error(`unsupported planned output format: ${format}`);
  }
}

export async function resolveOutputDestination(destination: string): Promise<{
  outputRoot: string;
  outputDir: string;
}> {
  const absolute = resolve(destination);
  let probe = absolute;
  for (;;) {
    try {
      const stat = await lstat(probe);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        return {
          outputRoot: probe,
          outputDir: relative(probe, absolute).split(sep).join('/'),
        };
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = dirname(probe);
    if (parent === probe) {
      throw new Error(`no existing output ancestor: ${destination}`);
    }
    probe = parent;
  }
}

export async function planRenderOutputs(input: {
  outputRoot: string;
  outputDir: string;
  overwrite: boolean;
  targets: OutputTarget[];
  screenshots: Array<{ relativePath: string; dokId?: string }>;
  inputs?: Partial<RenderPlanInputs>;
  warnings?: RenderPlanWarning[];
}): Promise<RenderOutputPlan> {
  const outputRoot = await resolveContainedPath(input.outputRoot, '.', {
    rejectSymlinkLeaf: true,
  });
  const outputDir = canonicalRelative(input.outputDir);
  await validateRelative(outputRoot, outputDir || '.');

  const producers: OutputTarget[] = [
    ...input.targets,
    ...input.screenshots.map((screenshot) => ({
      relativePath: screenshot.relativePath,
      format: 'screenshot',
      ...(screenshot.dokId ? { dokId: screenshot.dokId } : {}),
    })),
    { relativePath: 'livedoc-manifest.json', format: 'manifest' },
  ];

  const outputs: PlannedOutput[] = [];
  const claimed = new Set<string>();
  for (const producer of producers) {
    const producerPath = canonicalRelative(producer.relativePath);
    await validateRelative(outputRoot, producerPath);
    const relativePath = outputDir
      ? posix.join(outputDir, producerPath)
      : producerPath;
    const path = await resolveContainedPath(outputRoot, relativePath, {
      allowMissingLeaf: true,
      rejectSymlinkLeaf: true,
    });
    const claimKey = collisionKey(path);
    if (claimed.has(claimKey)) throw new DuplicateOutputError(relativePath);
    claimed.add(claimKey);
    const exists = await pathExists(path);
    outputs.push({
      path,
      relative_path: relativePath,
      format: producer.format,
      ...(producer.dokId ? { dok_id: producer.dokId } : {}),
      exists,
      action: exists ? (input.overwrite ? 'overwrite' : 'blocked') : 'create',
    });
  }

  outputs.sort((a, b) => compareText(a.relative_path, b.relative_path));
  const manifest = outputs.find((output) => output.format === 'manifest');
  if (!manifest) throw new Error('manifest output was not planned');

  return {
    output_root: outputRoot,
    overwrite: input.overwrite,
    outputs,
    manifest_path: manifest.path,
    inputs: canonicalInputs(input.inputs),
    warnings: canonicalWarnings(input.warnings ?? []),
  };
}

export function reproducibleRenderOutputPlan(
  plan: RenderOutputPlan,
): ReproducibleRenderOutputPlan {
  const { overwrite: _overwrite, outputs, ...reproduciblePlan } = plan;
  return {
    ...reproduciblePlan,
    outputs: outputs.map(({ exists: _exists, action: _action, ...output }) => output),
  };
}

function canonicalRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (normalized === '.' || normalized === '') return '';
  return normalized.split('/').filter((segment) => segment !== '.').join('/');
}

function ensureExtension(path: string, extension: string): string {
  if (path.toLowerCase().endsWith(extension)) return path;
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return dot > slash ? `${path.slice(0, dot)}${extension}` : `${path}${extension}`;
}

async function validateRelative(root: string, relativePath: string): Promise<void> {
  await resolveContainedPath(root, relativePath, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function canonicalInputs(input: Partial<RenderPlanInputs> | undefined): RenderPlanInputs {
  return {
    ...(input?.template_ref ? { template_ref: input.template_ref } : {}),
    ...(input?.template_source ? { template_source: input.template_source } : {}),
    ...(input?.template_path ? { template_path: input.template_path } : {}),
    dok_ids: sortedUnique(input?.dok_ids ?? []),
    source_paths: sortedUnique(input?.source_paths ?? []),
  };
}

function canonicalWarnings(warnings: RenderPlanWarning[]): RenderPlanWarning[] {
  return [...warnings].sort((a, b) => compareText(
    `${a.code}\0${a.dok_id ?? ''}\0${a.field ?? ''}\0${a.message}`,
    `${b.code}\0${b.dok_id ?? ''}\0${b.field ?? ''}\0${b.message}`,
  ));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Live Docs plans are portable artifacts. Reject aliases conservatively so a
 * plan that is safe on a case-sensitive volume cannot collapse into one file
 * on the default case-insensitive macOS filesystem. Unicode normalization also
 * covers canonically equivalent names without probing or mutating the output.
 */
function collisionKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  // ENOTDIR proves that an existing ancestor is a file, so it must remain a
  // planning error instead of being reported as a creatable missing path.
  return code === 'ENOENT';
}
