'use client';

// Studio's Live Docs page body — the home of livedoc-engine outputs and,
// in practice, Doklo's most important screen: the place where the Hub
// becomes documents people actually hand over. The layout is therefore
// document-first — a slim template rail on the left, and the rendered
// document filling every remaining pixel.

import { useEffect, useState, type ComponentType } from 'react';
import {
  Ban,
  BookOpen,
  BookText,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Presentation,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  GALLERY_LIVEDOCS,
  type DocLocale,
  type LivedocTemplateMeta,
  type RenderedDoc,
} from '../lib/livedoc-templates';
import { triggerDownload } from '../lib/download';
import { Spinner } from './onboarding/progress';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'saas-prd': FileText,
  'help-page': BookOpen,
  'github-onboarding': Users,
  'why-blocked': Ban,
  'permission-gap': ShieldCheck,
  'rtm-trace': FileSpreadsheet,
  'ops-manual': BookText,
  'korean-public-ppt': Presentation,
};

const LOCALES: DocLocale[] = ['ko', 'en'];

const UI: Record<
  DocLocale,
  {
    title: string;
    lead: string;
    perDokNote: string;
    openFull: string;
    download: string;
    rendering: string;
    error: string;
    binaryNote: string;
  }
> = {
  ko: {
    title: 'Live Docs',
    lead: 'Hub에서 결정적으로 렌더되는 산출물 — Dok이 바뀌면 같은 템플릿으로 다시 만들 수 있어요.',
    perDokNote: '대표 Dok 1개 기준 미리보기',
    openFull: '새 탭에서 열기',
    download: '다운로드',
    rendering: '렌더링 중…',
    error: '렌더에 실패했어요',
    binaryNote: '브라우저 미리보기가 없는 파일 산출물입니다 — 내려받아 Excel·한컴오피스·PowerPoint에서 여세요.',
  },
  en: {
    title: 'Live Docs',
    lead: 'Deliverables rendered deterministically from this Hub — when Doks change, regenerate from the same template.',
    perDokNote: 'Previewing one representative Dok',
    openFull: 'Open in new tab',
    download: 'Download',
    rendering: 'Rendering…',
    error: 'Rendering failed',
    binaryNote: 'A file deliverable with no browser preview — download and open in Excel / Hancom Office / PowerPoint.',
  },
};

/** Dok entry for the per_dok picker — captured Doks lead, newest first. */
export interface GalleryDok {
  id: string;
  label: string;
  captured: boolean;
}

export function LivedocsGallery({
  initialLocale,
  doks,
}: {
  initialLocale: DocLocale;
  doks: GalleryDok[];
}) {
  const [locale, setLocale] = useState<DocLocale>(initialLocale);
  const [selected, setSelected] = useState<LivedocTemplateMeta>(GALLERY_LIVEDOCS[0]!);
  const [dokId, setDokId] = useState<string>(doks[0]?.id ?? '');
  const [cache, setCache] = useState<Record<string, RenderedDoc>>({});
  const [error, setError] = useState<string | null>(null);

  const ui = UI[locale];
  const perDok = selected.scope === 'per_dok';
  const key = `${selected.ref}:${locale}${perDok ? `:${dokId}` : ''}`;
  const doc = cache[key] ?? null;
  const isBinary = (selected.preview ?? 'html') !== 'html';
  const getHref = `/api/wizard/livedoc?ref=${selected.ref}&locale=${locale}${
    perDok && dokId ? `&dok=${encodeURIComponent(dokId)}` : ''
  }`;

  useEffect(() => {
    // Binary deliverables download via the GET route — no preview fetch.
    if (cache[key] || (selected.preview ?? 'html') !== 'html') return;
    let cancelled = false;
    setError(null);
    fetch('/api/wizard/livedoc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: selected.ref,
        locale,
        ...(selected.scope === 'per_dok' && dokId ? { dok: dokId } : {}),
      }),
    })
      .then(async (res) => {
        const data = (await res.json()) as RenderedDoc & { error?: string };
        if (cancelled) return;
        if (!res.ok || data.error) setError(data.error ?? `HTTP ${res.status}`);
        else setCache((prev) => ({ ...prev, [key]: data }));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key, selected.ref, selected.preview, selected.scope, dokId, locale, cache]);

  const BinaryIcon =
    selected.preview === 'xlsx'
      ? FileSpreadsheet
      : selected.preview === 'pptx'
        ? Presentation
        : BookText;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Slim page header */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-5 py-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="shrink-0 text-base font-bold tracking-tight text-ink-strong">
            {ui.title}
          </h1>
          <p className="truncate text-xs text-ink-muted">{ui.lead}</p>
        </div>
        <div className="inline-flex shrink-0 rounded-md border border-border bg-surface p-0.5">
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLocale(l)}
              className={
                locale === l
                  ? 'rounded bg-accent px-2.5 py-0.5 text-xs font-semibold text-canvas'
                  : 'rounded px-2.5 py-0.5 text-xs font-medium text-ink-secondary transition-colors hover:text-ink'
              }
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Template rail */}
        <div className="flex w-60 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border bg-surface p-2.5">
          {GALLERY_LIVEDOCS.map((t) => {
            const Icon = ICONS[t.ref] ?? FileText;
            const active = selected.ref === t.ref;
            return (
              <button
                key={t.ref}
                type="button"
                onClick={() => setSelected(t)}
                className={[
                  'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all duration-150',
                  active
                    ? 'border-accent bg-accent-soft/60'
                    : 'border-transparent hover:border-border hover:bg-surface-2',
                ].join(' ')}
              >
                <div
                  className={[
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                    active ? 'bg-accent text-canvas' : 'bg-accent-soft text-accent',
                  ].join(' ')}
                >
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold leading-tight text-ink-strong">
                    {t.title[locale]}
                  </p>
                  <p className="truncate text-[11px] text-ink-faint">{t.audience[locale]}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Document column — the hero */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Document toolbar */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2">
            <p className="min-w-0 truncate text-sm text-ink-muted" title={selected.desc[locale]}>
              <span className="font-semibold text-ink-strong">{selected.title[locale]}</span>
              <span className="mx-2 text-ink-faint">·</span>
              {selected.desc[locale]}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {perDok && doks.length > 0 && (
                <select
                  value={dokId}
                  onChange={(e) => setDokId(e.target.value)}
                  className="max-w-64 rounded-md border border-border bg-surface px-2 py-1.5 text-xs font-medium text-ink-secondary outline-none transition-colors hover:border-border-strong"
                >
                  {doks.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.captured ? '📷 ' : ''}
                      {d.label} — {d.id}
                    </option>
                  ))}
                </select>
              )}
              {!isBinary && (
                <a
                  href={getHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary no-underline transition-colors hover:bg-surface-2 hover:no-underline"
                >
                  {ui.openFull}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {isBinary ? (
                <a
                  href={getHref}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-canvas no-underline shadow-sm transition-all duration-200 hover:bg-accent-hover hover:no-underline"
                >
                  <Download className="h-3 w-3" />
                  {ui.download}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => doc?.kind === 'html' && triggerDownload(doc)}
                  disabled={doc?.kind !== 'html'}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-canvas shadow-sm transition-all duration-200 hover:bg-accent-hover disabled:opacity-50"
                >
                  <Download className="h-3 w-3" />
                  {ui.download}
                </button>
              )}
            </div>
          </div>

          {/* Document canvas — fills everything that remains */}
          <div className="min-h-0 flex-1 bg-surface-2">
            {isBinary ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                  <BinaryIcon className="h-10 w-10" />
                </div>
                <p className="text-base font-semibold text-ink-strong">
                  {selected.title[locale]} (.{selected.preview})
                </p>
                <p className="max-w-md text-sm leading-relaxed text-ink-muted">{ui.binaryNote}</p>
                <a
                  href={getHref}
                  className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-canvas no-underline shadow-sm transition-all duration-200 hover:bg-accent-hover hover:no-underline"
                >
                  <Download className="h-4 w-4" />
                  {ui.download}
                </a>
              </div>
            ) : doc?.kind === 'html' ? (
              <iframe
                srcDoc={doc.html}
                title={`${selected.title[locale]} — Live Docs`}
                sandbox=""
                className="h-full w-full border-0"
              />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 px-6 text-center text-sm text-ink-muted">
                {error ? (
                  <span className="text-danger">
                    {ui.error} — {error}
                  </span>
                ) : (
                  <>
                    <Spinner className="h-4 w-4 text-accent" />
                    {ui.rendering}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
