import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  loadHubModel,
  resolveContainedPath,
  type HubModel,
} from '@doklo-beta/core';
import {
  resolveTemplate,
  type ResolvedTemplate,
  type TemplateSource,
} from './template-loader.js';
import type { PublicationFormat } from './publication.js';
import { ENGINE_VERSION } from './version.js';

type ContentFile = {
  path: string;
  sha256: string;
};

export async function effectiveRenderInputDigest(input: {
  workspaceRoot: string;
  templateRef: string;
  templateSource?: TemplateSource;
  locale: string;
  primaryLocale?: string;
  format: PublicationFormat;
  variables: Record<string, string | boolean | number | undefined>;
  selectedDokIds: string[];
  hub?: HubModel;
  resolvedTemplate?: ResolvedTemplate;
  userHome?: string;
  builtinRoot?: string;
}): Promise<string> {
  const hub = input.hub ?? await loadHubModel(input.workspaceRoot);
  const template = input.resolvedTemplate ?? await resolveTemplate(
    input.templateRef,
    {
      workspaceRoot: input.workspaceRoot,
      ...(input.templateSource
        ? { preferredSource: input.templateSource }
        : {}),
      ...(input.userHome ? { userHome: input.userHome } : {}),
      ...(input.builtinRoot ? { builtinRoot: input.builtinRoot } : {}),
    },
  );
  const selectedDokIds = [...input.selectedDokIds].sort(compareText);
  const runtimeFiles = [
    ...await containedTree(
      input.workspaceRoot,
      '.doklo/branding',
      'branding',
    ),
    ...await containedTree(
      input.workspaceRoot,
      '.doklo/audience-text.json',
      'audience-text.json',
    ),
  ];
  for (const dokId of selectedDokIds) {
    runtimeFiles.push(...await containedTree(
      input.workspaceRoot,
      `.doklo/screenshots/${dokId}`,
      `screenshots/${dokId}`,
    ));
  }

  return digest({
    schema_version: 1,
    engine_version: ENGINE_VERSION,
    template: {
      source: template.source,
      files: await resolvedTree(template.path),
    },
    locale: input.locale,
    primary_locale:
      input.primaryLocale
      ?? hub.workspace.default_locale
      ?? hub.workspace.supported_locales[0]
      ?? 'en',
    format: input.format,
    variables: input.variables,
    selected_dok_ids: selectedDokIds,
    hub,
    runtime_files: runtimeFiles.sort(byPath),
  });
}

async function containedTree(
  root: string,
  relativePath: string,
  evidencePath: string,
): Promise<ContentFile[]> {
  let path: string;
  try {
    path = await resolveContainedPath(root, relativePath, {
      allowMissingLeaf: true,
      rejectSymlinkLeaf: true,
    });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  return resolvedTree(path, evidencePath);
}

async function resolvedTree(
  path: string,
  evidenceRoot = '',
): Promise<ContentFile[]> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Render input cannot be a symbolic link: ${path}`);
  }
  if (stats.isFile()) {
    const bytes = await readFile(path);
    return [{
      path: evidenceRoot || basename(path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }];
  }
  if (!stats.isDirectory()) {
    throw new Error(`Render input must be a regular file or directory: ${path}`);
  }

  const files: ContentFile[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const childEvidencePath = evidenceRoot
      ? `${evidenceRoot}/${entry.name}`
      : entry.name;
    files.push(...await resolvedTree(
      join(path, entry.name),
      childEvidencePath,
    ));
  }
  return files;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value), 'utf8')
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Render input contains a non-JSON value');
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (
      item === undefined ? 'null' : stableStringify(item)
    )).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function isMissingPathError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (
      (error as { code?: unknown }).code === 'ENOENT'
      || (error as { code?: unknown }).code === 'ENOTDIR'
    );
}

function byPath(left: ContentFile, right: ContentFile): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
