import {
  createHash,
} from 'node:crypto';
import type {
  RenderLivedocResult,
} from '@doklo-beta/livedoc-engine';
import { loadHubModel } from '@doklo-beta/core';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  inlinePreviewAssets,
  textPreviewDocument,
} from './livedoc-preview-document';
import type {
  PublicationReadModelEntry,
  PublicationWorkspaceModel,
} from './publication-read-model';

const BINARY_MIME: Record<string, string> = {
  hwpx: 'application/hwp+zip',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const TEXT_MIME: Record<string, string> = {
  markdown: 'text/markdown; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
};

export type RenderedPublicationDocument =
  | {
      kind: 'html';
      html: string;
      filename: string;
      mime: 'text/html; charset=utf-8';
      dok_id?: string;
    }
  | {
      kind: 'binary';
      data_base64: string;
      filename: string;
      mime: string;
      bytes: number;
      dok_id?: string;
    };

export type RenderedPublicationCandidate = RenderedPublicationDocument & {
  fingerprint: string;
  output_count: number;
  documents: RenderedPublicationDocument[];
};

const candidateRuns = new Map<
  string,
  Promise<RenderedPublicationCandidate>
>();

export function renderPublicationCandidateSingleFlight(input: {
  root: string;
  entry: PublicationReadModelEntry;
  model: PublicationWorkspaceModel;
  signal?: AbortSignal;
}): Promise<RenderedPublicationCandidate> {
  const fingerprint = input.entry.status.input_fingerprint;
  const key = `${input.root}\0${input.entry.publication.name}\0${fingerprint}`;
  const active = candidateRuns.get(key);
  if (active) return awaitCandidateForCaller(active, input.signal);
  const pending = renderPublicationCandidate({
    ...input,
    signal: undefined,
  });
  candidateRuns.set(key, pending);
  void pending.finally(() => {
    if (candidateRuns.get(key) === pending) candidateRuns.delete(key);
  }).catch(() => {});
  return awaitCandidateForCaller(pending, input.signal);
}

export async function renderPublicationCandidate(input: {
  root: string;
  entry: PublicationReadModelEntry;
  model: PublicationWorkspaceModel;
  signal?: AbortSignal;
}): Promise<RenderedPublicationCandidate> {
  if (input.entry.status.render_state === 'blocked') {
    throw new Error('Blocked Publications cannot render a candidate.');
  }
  const temp = await mkdtemp(
    join(tmpdir(), 'doklo-publication-preview-'),
  );
  try {
    const engine = await loadEngine();
    const hub = await loadHubModel(input.root);
    const selectedIds = input.entry.status.resolved_dok_ids;
    const selected = selectedIds
      .map((dokId) => hub.doks.find((dok) => dok.dok_id === dokId))
      .filter((dok): dok is (typeof hub.doks)[number] => dok !== undefined);
    const changes = engine.classifyDokChanges(
      selected,
      input.entry.evidence?.dok_snapshots,
    );
    const audience = await engine.loadWorkspaceAudienceDictionary(
      input.root,
      input.entry.publication.locale,
      input.model.workspace_default_locale,
    );
    const result = await engine.renderLivedoc({
      workspaceRoot: input.root,
      templateRef: input.entry.publication.template,
      locale: input.entry.publication.locale,
      primaryLocale: input.model.workspace_default_locale,
      outDir: temp,
      dokIds: selectedIds,
      variables: input.entry.publication.vars,
      extraContext: { changes },
      format: input.entry.publication.format,
      signal: input.signal,
      ...(audience.dictionary
        ? { audienceDictionary: audience.dictionary }
        : {}),
    });
    return candidateFromResult({
      result,
      format: input.entry.publication.format,
      outDir: temp,
      fingerprint: input.entry.status.input_fingerprint,
      locale: input.entry.publication.locale,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function readOfficialPublicationPreview(input: {
  root: string;
  entry: PublicationReadModelEntry;
}): Promise<RenderedPublicationCandidate | undefined> {
  const evidence = input.entry.evidence;
  if (!evidence) return undefined;
  const outputs = evidence.outputs.filter(
    (output) => output.format === input.entry.publication.format,
  );
  if (outputs.length === 0) return undefined;
  const outputRootRelative = [
    '.doklo',
    'output',
    input.entry.publication.output_dir,
  ].join('/');
  const outputPrefix = `${outputRootRelative}/`;
  for (const output of outputs) {
    if (!output.relative_path.startsWith(outputPrefix)) {
      throw new Error(
        `Official output '${output.relative_path}' is outside the Publication output directory.`,
      );
    }
  }
  const outputRoot = await resolveContainedOutput(
    input.root,
    outputRootRelative,
  );
  const documents = await Promise.all(outputs.map(async (output) => {
    const path = await resolveContainedOutput(
      outputRoot,
      output.relative_path.slice(outputPrefix.length),
    );
    const bytes = await readFile(path);
    if (
      bytes.byteLength !== output.bytes
      || createHash('sha256').update(bytes).digest('hex') !== output.sha256
    ) {
      throw new Error('Official output no longer matches its render evidence.');
    }
    const filename = basename(path);
    const dokIdentity = output.dok_id
      ? { dok_id: output.dok_id }
      : {};
    if (input.entry.publication.format === 'html') {
      return {
        kind: 'html',
        html: await inlinePreviewAssets(
          bytes.toString('utf8'),
          outputRoot,
        ),
        filename,
        mime: 'text/html; charset=utf-8',
        ...dokIdentity,
      } satisfies RenderedPublicationDocument;
    }
    if (TEXT_MIME[input.entry.publication.format]) {
      return {
        kind: 'html',
        html: textPreviewDocument(
          bytes.toString('utf8'),
          filename,
          input.entry.publication.locale,
        ),
        filename,
        mime: 'text/html; charset=utf-8',
        ...dokIdentity,
      } satisfies RenderedPublicationDocument;
    }
    return {
      kind: 'binary',
      data_base64: bytes.toString('base64'),
      filename,
      mime: BINARY_MIME[input.entry.publication.format]
        ?? 'application/octet-stream',
      bytes: bytes.byteLength,
      ...dokIdentity,
    } satisfies RenderedPublicationDocument;
  }));
  const first = documents[0]!;
  const fingerprint = input.entry.status.input_fingerprint;
  return {
    ...first,
    fingerprint,
    output_count: documents.length,
    documents,
  };
}

async function loadEngine(): Promise<
  typeof import('@doklo-beta/livedoc-engine')
> {
  return import(
    /* webpackIgnore: true */
    '@doklo-beta/livedoc-engine'
  );
}

async function candidateFromResult(input: {
  result: RenderLivedocResult;
  format: string;
  outDir: string;
  fingerprint: string;
  locale: string;
}): Promise<RenderedPublicationCandidate> {
  const outputs = input.result.outputs.filter(
    (output) => output.format === input.format,
  );
  if (outputs.length === 0) {
    throw new Error(
      `Candidate renderer produced no ${input.format} output.`,
    );
  }
  const canonicalOutDir = await realpath(input.outDir);
  const documents = await Promise.all(outputs.map(async (output) => {
    const path = await resolveContainedOutput(
      canonicalOutDir,
      relative(canonicalOutDir, output.path),
    );
    const filename = basename(path);
    const dokIdentity = output.dokId ? { dok_id: output.dokId } : {};
    if (input.format === 'html') {
      const html = await readFile(path, 'utf8');
      return {
        kind: 'html',
        html: await inlinePreviewAssets(html, input.outDir),
        filename,
        mime: 'text/html; charset=utf-8',
        ...dokIdentity,
      } satisfies RenderedPublicationDocument;
    }
    if (TEXT_MIME[input.format]) {
      const text = await readFile(path, 'utf8');
      return {
        kind: 'html',
        html: textPreviewDocument(text, filename, input.locale),
        filename,
        mime: 'text/html; charset=utf-8',
        ...dokIdentity,
      } satisfies RenderedPublicationDocument;
    }
    const bytes = await readFile(path);
    return {
      kind: 'binary',
      data_base64: bytes.toString('base64'),
      filename,
      mime: BINARY_MIME[input.format] ?? 'application/octet-stream',
      bytes: bytes.byteLength,
      ...dokIdentity,
    } satisfies RenderedPublicationDocument;
  }));
  const first = documents[0]!;
  return {
    ...first,
    fingerprint: input.fingerprint,
    output_count: documents.length,
    documents,
  };
}

async function resolveContainedOutput(
  root: string,
  relativePath: string,
): Promise<string> {
  const { resolveContainedPath } = await import('@doklo-beta/core');
  return resolveContainedPath(root, relativePath, {
    rejectSymlinkLeaf: true,
  });
}

function awaitCandidateForCaller<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    return Promise.reject(candidateAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(candidateAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function candidateAbortError(): DOMException {
  return new DOMException('Candidate preview was cancelled.', 'AbortError');
}
