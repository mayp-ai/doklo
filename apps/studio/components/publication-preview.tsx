'use client';

import { Download, FileOutput } from 'lucide-react';
import { useState } from 'react';
import type {
  RenderedPublicationCandidate,
  RenderedPublicationDocument,
} from '../lib/publication-preview';
import {
  publicationCopy,
  type PublicationUiLocale,
} from '../lib/publication-copy';

export function PublicationPreview({
  candidate,
  locale,
  loading = false,
  mode = 'candidate',
}: {
  candidate?: RenderedPublicationCandidate;
  locale: PublicationUiLocale;
  loading?: boolean;
  mode?: 'official' | 'candidate';
}) {
  const copy = publicationCopy(locale);
  const [selectedOutputKey, setSelectedOutputKey] = useState<string>();
  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-full items-center justify-center p-8 text-sm text-ink-muted"
      >
        <span className="mr-2 h-2 w-2 animate-pulse rounded-full bg-accent" />
        {copy.preview.preparing}
      </div>
    );
  }
  if (!candidate) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FileOutput size={34} className="text-ink-faint" aria-hidden />
        <p className="max-w-sm text-sm text-ink-muted">
          {copy.preview.unavailable}
        </p>
      </div>
    );
  }
  const documents: RenderedPublicationDocument[] =
    Array.isArray(candidate.documents) && candidate.documents.length > 0
      ? candidate.documents
      : [candidate];
  const activeDocument = documents.find(
    (document) => outputKey(document) === selectedOutputKey,
  ) ?? documents[0]!;
  const activeOutputKey = outputKey(activeDocument);
  const preview = activeDocument.kind === 'html'
    ? (
      <iframe
        title={mode === 'candidate'
          ? copy.workbench.candidatePreview
          : copy.workbench.officialPreview}
        srcDoc={activeDocument.html}
        sandbox=""
        className="h-full w-full border-0 bg-surface"
      />
    )
    : (
      <BinaryPreview
        document={activeDocument}
        downloadLabel={copy.actions.download}
        title={copy.preview.binaryTitle}
        body={copy.preview.binaryBody}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {documents.length > 1 ? (
        <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-surface px-3 py-2">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {copy.preview.documents} · {documents.length}
          </span>
          <div
            role="group"
            aria-label={copy.preview.documents}
            className="flex items-center gap-1.5"
          >
            {documents.map((document) => {
              const key = outputKey(document);
              const active = key === activeOutputKey;
              return (
                <button
                  key={key}
                  type="button"
                  data-publication-output={
                    document.dok_id ?? document.filename
                  }
                  aria-pressed={active}
                  onClick={() => setSelectedOutputKey(key)}
                  className={[
                    'shrink-0 rounded-pill border px-3 py-1.5 font-mono text-[11px] font-semibold transition-colors',
                    active
                      ? 'border-accent bg-accent-soft text-accent-ink'
                      : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
                  ].join(' ')}
                >
                  {document.dok_id ?? document.filename}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {preview}
      </div>
    </div>
  );
}

function BinaryPreview({
  document,
  downloadLabel,
  title,
  body,
}: {
  document: Extract<RenderedPublicationDocument, { kind: 'binary' }>;
  downloadLabel: string;
  title: string;
  body: string;
}) {
  const href = `data:${document.mime};base64,${document.data_base64}`;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <FileOutput size={30} aria-hidden />
      </span>
      <div>
        <h3 className="font-semibold text-ink-strong">{title}</h3>
        <p className="mt-1 max-w-md text-sm leading-relaxed text-ink-muted">
          {body}
        </p>
        <p className="mt-2 font-mono text-xs text-ink-faint">
          {document.filename} · {formatBytes(document.bytes)}
        </p>
      </div>
      <a
        href={href}
        download={document.filename}
        className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas no-underline hover:bg-accent-hover"
      >
        <Download size={15} aria-hidden />
        {downloadLabel}
      </a>
    </div>
  );
}

function outputKey(document: RenderedPublicationDocument): string {
  return `${document.dok_id ?? ''}\0${document.filename}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
