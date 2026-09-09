import { loadHubModel, resolveContainedPath } from '@doklo-beta/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  inlinePreviewAssets,
  textPreviewDocument,
} from './livedoc-preview-document';
import type { PublicationTemplateReadModel } from './publication-read-model';

const TEXT_PREVIEW_FORMATS = [
  'html',
  'markdown',
  'text',
  'json',
  'yaml',
] as const;

const MAX_TEMPLATE_PREVIEWS = 24;
const completedPreviews = new Map<string, PublicationTemplatePreview>();
const pendingPreviews = new Map<string, Promise<PublicationTemplatePreview>>();

export type PublicationTemplatePreview =
  | {
      kind: 'html';
      fidelity: 'workspace';
      html: string;
      filename: string;
      format: string;
      output_count: number;
    }
  | {
      kind: 'example';
      fidelity: 'example';
      format: string;
      title: string;
      audience: string;
      purpose: string;
      job: string;
      output_shape: string;
    };

export async function getPublicationTemplatePreview(input: {
  root: string;
  template: PublicationTemplateReadModel;
  locale: string;
  signal?: AbortSignal;
}): Promise<PublicationTemplatePreview> {
  const hub = await loadHubModel(input.root);
  const dokIds = previewCandidateDokIds(input.template);
  const doks = dokIds.map((dokId) => {
    const dok = hub.doks.find((candidate) => candidate.dok_id === dokId);
    if (!dok) throw new Error(`Template preview Dok '${dokId}' was not found.`);
    return dok;
  });
  const format = TEXT_PREVIEW_FORMATS.find((candidate) =>
    input.template.output_formats.includes(candidate),
  )
    ?? input.template.default_format;
  if (!format) {
    throw new Error(`Template '${input.template.name}' declares no output format.`);
  }
  if (dokIds.length === 0) {
    return examplePreview(input.template, format, input.locale);
  }
  const variables = Object.fromEntries(
    Object.entries(input.template.variables)
      .filter(([, definition]) => definition.default !== undefined)
      .map(([name, definition]) => [name, definition.default]),
  );
  const engine = await loadEngine();
  const renderInputSha256 = await engine.effectiveRenderInputDigest({
    workspaceRoot: input.root,
    templateRef: input.template.name,
    templateSource: input.template.source,
    locale: input.locale,
    format: format as never,
    variables,
    selectedDokIds: dokIds,
    hub,
  });
  const key = previewCacheKey({
    root: input.root,
    template: input.template,
    locale: input.locale,
    dokIds,
    doks,
    format,
    variables,
    renderInputSha256,
  });
  const completed = completedPreviews.get(key);
  if (completed) {
    completedPreviews.delete(key);
    completedPreviews.set(key, completed);
    return awaitForCaller(Promise.resolve(completed), input.signal);
  }
  let pending = pendingPreviews.get(key);
  if (!pending) {
    pending = renderTemplatePreview({
      root: input.root,
      template: input.template,
      locale: input.locale,
      dokIds,
      format,
      variables,
    });
    pendingPreviews.set(key, pending);
    void pending.then((preview) => {
      completedPreviews.set(key, preview);
      while (completedPreviews.size > MAX_TEMPLATE_PREVIEWS) {
        completedPreviews.delete(completedPreviews.keys().next().value!);
      }
    }).finally(() => {
      if (pendingPreviews.get(key) === pending) pendingPreviews.delete(key);
    }).catch(() => {});
  }
  return awaitForCaller(pending, input.signal);
}

async function renderTemplatePreview(input: {
  root: string;
  template: PublicationTemplateReadModel;
  locale: string;
  dokIds: string[];
  format: string;
  variables: Record<string, string | boolean | number | undefined>;
}): Promise<PublicationTemplatePreview> {
  if (!isTextPreviewFormat(input.format)) {
    return examplePreview(input.template, input.format, input.locale);
  }
  const format = input.format;
  const engine = await loadEngine();
  if (input.template.scope === 'per_dok') {
    let lastStableLintError: Error | undefined;
    for (const dokId of input.dokIds) {
      try {
        return await renderTextTemplatePreview({
          ...input,
          engine,
          dokIds: [dokId],
          format,
        });
      } catch (error) {
        if (!(error instanceof engine.StableLintError)) throw error;
        lastStableLintError = error;
      }
    }
    if (lastStableLintError) throw lastStableLintError;
    throw new Error(
      `Template '${input.template.name}' has no eligible Dok to preview.`,
    );
  }
  return renderTextTemplatePreview({
    ...input,
    engine,
    format,
  });
}

async function renderTextTemplatePreview(input: {
  root: string;
  template: PublicationTemplateReadModel;
  locale: string;
  dokIds: string[];
  format: (typeof TEXT_PREVIEW_FORMATS)[number];
  variables: Record<string, string | boolean | number | undefined>;
  engine: Awaited<ReturnType<typeof loadEngine>>;
}): Promise<PublicationTemplatePreview> {
  const outDir = await mkdtemp(join(tmpdir(), 'doklo-template-preview-'));
  try {
    const result = await input.engine.renderLivedoc({
      workspaceRoot: input.root,
      templateRef: input.template.name,
      source: input.template.source,
      locale: input.locale,
      outDir,
      dokIds: input.dokIds,
      format: input.format as never,
      variables: Object.fromEntries(
        Object.entries(input.variables).map(([name, value]) => [
          name,
          String(value),
        ]),
      ),
    });
    const outputs = result.outputs.filter((output) => output.format === input.format);
    const first = outputs[0];
    if (!first) {
      throw new Error(`Template renderer produced no ${input.format} output.`);
    }
    const canonicalOutDir = await realpath(outDir);
    const path = await resolveContainedPath(
      canonicalOutDir,
      relative(canonicalOutDir, first.path),
      { rejectSymlinkLeaf: true },
    );
    const filename = basename(path);
    const content = await readFile(path, 'utf8');
    return {
      kind: 'html',
      fidelity: 'workspace',
      html: input.format === 'html'
        ? await inlinePreviewAssets(content, canonicalOutDir)
        : textPreviewDocument(content, filename, input.locale),
      filename,
      format: input.format,
      output_count: outputs.length,
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function previewCandidateDokIds(
  template: PublicationTemplateReadModel,
): string[] {
  return [...template.selection.eligible_dok_ids].sort(compareText);
}

function examplePreview(
  template: PublicationTemplateReadModel,
  format: string,
  locale: string,
): PublicationTemplatePreview {
  return {
    kind: 'example',
    fidelity: 'example',
    format,
    title: template.display_name,
    audience: template.audience,
    purpose: template.purpose,
    job: template.job,
    output_shape: localizedOutputShape(template.scope, format, locale),
  };
}

function localizedOutputShape(
  scope: PublicationTemplateReadModel['scope'],
  format: string,
  locale: string,
): string {
  const label = format.toUpperCase();
  if (locale.toLowerCase().startsWith('ko')) {
    return scope === 'per_dok'
      ? `대상 Dok마다 ${label} 문서 1개`
      : scope === 'selected_doks'
        ? `선택한 Dok을 묶은 ${label} 문서 1개`
        : `워크스페이스 전체 ${label} 문서 1개`;
  }
  return scope === 'per_dok'
    ? `One ${label} document per eligible Dok`
    : scope === 'selected_doks'
      ? `One ${label} document for the selected Doks`
      : `One ${label} document for the workspace`;
}

function isTextPreviewFormat(
  format: string,
): format is (typeof TEXT_PREVIEW_FORMATS)[number] {
  return TEXT_PREVIEW_FORMATS.includes(
    format as (typeof TEXT_PREVIEW_FORMATS)[number],
  );
}

function previewCacheKey(input: {
  root: string;
  template: PublicationTemplateReadModel;
  locale: string;
  dokIds: string[];
  doks: unknown[];
  format: string;
  variables: Record<string, unknown>;
  renderInputSha256: string;
}): string {
  return createHash('sha256').update(stableSerialize({
    root: input.root,
    template: {
      source: input.template.source,
      name: input.template.name,
      version: input.template.version,
    },
    locale: input.locale,
    dok_ids: input.dokIds,
    doks: input.doks,
    format: input.format,
    variables: input.variables,
    render_input_sha256: input.renderInputSha256,
  })).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function awaitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new PreviewCancelledError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new PreviewCancelledError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

export class PreviewCancelledError extends Error {
  constructor() {
    super('Template preview was cancelled.');
    this.name = 'PreviewCancelledError';
  }
}

async function loadEngine(): Promise<typeof import('@doklo-beta/livedoc-engine')> {
  return import(
    /* webpackIgnore: true */
    '@doklo-beta/livedoc-engine'
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
