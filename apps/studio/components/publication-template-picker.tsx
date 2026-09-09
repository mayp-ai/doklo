'use client';

import {
  useEffect,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  publicationCopy,
  type PublicationUiLocale,
} from '../lib/publication-copy';
import type {
  PublicationTemplatePreview,
} from '../lib/publication-template-preview';
import type {
  PublicationTemplateReadModel,
} from '../lib/publication-read-model';

type StabilityFilter = 'all' | 'stable' | 'experimental';
type PreviewState = 'idle' | 'loading' | 'ready' | 'error';

export type PublicationTemplatePickerProps = {
  templates: PublicationTemplateReadModel[];
  locale: PublicationUiLocale;
  selectedName: string;
  onSelect(template: PublicationTemplateReadModel): void;
  onConfirm(template: PublicationTemplateReadModel): void;
};

const FILTER_LABELS: Record<StabilityFilter, string> = {
  all: 'All',
  stable: 'Stable',
  experimental: 'Experimental',
};

export function PublicationTemplatePicker({
  templates,
  locale,
  selectedName,
  onSelect,
  onConfirm,
}: PublicationTemplatePickerProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StabilityFilter>('all');
  const [preview, setPreview] = useState<PublicationTemplatePreview>();
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const [retryNonce, setRetryNonce] = useState(0);
  const copy = publicationCopy(locale);
  const ui = pickerUi(locale);
  const selected = templates.find((template) => template.name === selectedName)
    ?? templates[0];
  const selectedTemplateName = selected?.name;
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const visibleTemplates = templates.filter((template) => {
    if (filter !== 'all' && template.stability !== filter) return false;
    if (!normalizedQuery) return true;
    return [
      template.display_name,
      template.description,
      template.audience,
      template.purpose,
      template.job,
    ].some((value) =>
      value.toLocaleLowerCase(locale).includes(normalizedQuery),
    );
  });
  const selectedIsVisible = visibleTemplates.some(
    (template) => template.name === selectedTemplateName,
  );

  useEffect(() => {
    if (!selectedTemplateName) {
      setPreview(undefined);
      setPreviewState('idle');
      return;
    }
    const controller = new AbortController();
    let acceptsResult = true;
    setPreview(undefined);
    setPreviewState('loading');

    void fetch(
      `/api/livedocs/templates/${encodeURIComponent(selectedTemplateName)}/preview`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale }),
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Template preview failed with ${response.status}.`);
        }
        return response.json() as Promise<PublicationTemplatePreview>;
      })
      .then((nextPreview) => {
        if (!acceptsResult || controller.signal.aborted) return;
        setPreview(nextPreview);
        setPreviewState('ready');
      })
      .catch(() => {
        if (!acceptsResult || controller.signal.aborted) return;
        setPreview(undefined);
        setPreviewState('error');
      });

    return () => {
      acceptsResult = false;
      controller.abort();
    };
  }, [locale, retryNonce, selectedTemplateName]);

  if (!selected) return null;

  const liveStatus = previewState === 'loading'
    ? copy.preview.preparing
    : previewState === 'ready'
      ? ui.previewReady
      : previewState === 'error'
        ? copy.template.previewUnavailable
        : '';

  return (
    <div className="publication-template-picker">
      <section
        className="publication-template-catalog"
        aria-label={ui.catalogLabel}
      >
        <label
          className="publication-template-search"
          htmlFor="publication-template-search"
        >
          <span className="sr-only">{ui.searchLabel}</span>
          <span aria-hidden className="publication-template-search-mark">⌕</span>
          <input
            id="publication-template-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.template.searchPlaceholder}
            autoComplete="off"
          />
        </label>

        <div
          className="publication-template-filters"
          aria-label={ui.filterLabel}
        >
          {(Object.keys(FILTER_LABELS) as StabilityFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              data-template-filter={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {FILTER_LABELS[value]}
            </button>
          ))}
        </div>

        {/* TODO(publication-template-recommendation):
            Re-enable only after an objective recommendation contract is approved. */}
        <div className="publication-template-stability-help">
          <p>
            <StabilityBadge stability="stable" />
            <span>{copy.template.stableHelp}</span>
          </p>
          <p>
            <StabilityBadge stability="experimental" />
            <span>{copy.template.experimentalHelp}</span>
          </p>
        </div>

        <div
          className="publication-template-options"
          role="listbox"
          aria-label={ui.listLabel}
        >
          {visibleTemplates.length > 0 ? visibleTemplates.map((template, index) => {
            const isSelected = template.name === selected.name;
            return (
              <button
                key={template.name}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={isSelected || (!selectedIsVisible && index === 0)
                  ? 0
                  : -1}
                onClick={() => onSelect(template)}
                onKeyDown={(event) => selectWithKeyboard({
                  event,
                  index,
                  templates: visibleTemplates,
                  onSelect,
                })}
                className="publication-template-option"
              >
                <DocumentThumbnail
                  scope={template.scope}
                  stability={template.stability}
                />
                <span className="publication-template-option-copy">
                  <span className="publication-template-option-heading">
                    <span
                      className="publication-template-option-name"
                      data-template-name
                    >
                      {template.display_name}
                    </span>
                    <StabilityBadge
                      stability={template.stability}
                      tracked
                    />
                  </span>
                  <span className="publication-template-option-description">
                    {template.description}
                  </span>
                  <span className="publication-template-option-audience">
                    {copy.template.audience}: {template.audience}
                  </span>
                  <span className="publication-template-option-output">
                    {outputSentence(template.scope, locale)}
                  </span>
                </span>
              </button>
            );
          }) : (
            <p className="publication-template-empty">{ui.noMatches}</p>
          )}
        </div>
      </section>

      <section
        className="publication-template-preview"
        aria-labelledby="publication-template-preview-title"
        aria-busy={previewState === 'loading'}
      >
        <div className="publication-template-preview-header">
          <div>
            <p className="publication-template-preview-eyebrow">
              {copy.preview.preview}
            </p>
            <h3 id="publication-template-preview-title">
              {selected.display_name}
            </h3>
          </div>
          <StabilityBadge stability={selected.stability} />
        </div>

        <dl className="publication-template-preview-facts">
          <div>
            <dt>{copy.template.audience}</dt>
            <dd>{selected.audience}</dd>
          </div>
          <div>
            <dt>{ui.supportedFormatsLabel}</dt>
            <dd>
              {selected.output_formats.map(displayFormat).join(' · ')}
            </dd>
          </div>
          <div>
            <dt>{ui.defaultFormatLabel}</dt>
            <dd>{displayFormat(selected.default_format)}</dd>
          </div>
          <div>
            <dt>{copy.template.scope}</dt>
            <dd>{outputSentence(selected.scope, locale)}</dd>
          </div>
          {preview ? (
            <div>
              <dt>{ui.fidelityLabel}</dt>
              <dd>
                {preview.fidelity === 'workspace'
                  ? copy.template.workspacePreview
                  : copy.template.examplePreview}
              </dd>
            </div>
          ) : null}
        </dl>

        <div
          className="publication-template-live sr-only"
          aria-live="polite"
          aria-atomic="true"
        >
          {liveStatus}
        </div>

        <div className="publication-template-preview-canvas">
          {previewState === 'loading' ? (
            <div className="publication-template-preview-loading" role="status">
              <span aria-hidden className="publication-template-loading-page" />
              <p>{copy.preview.preparing}</p>
            </div>
          ) : previewState === 'error' ? (
            <div className="publication-template-preview-error">
              <p>{copy.template.previewUnavailable}</p>
              <button
                type="button"
                onClick={() => setRetryNonce((value) => value + 1)}
              >
                {copy.common.retry}
              </button>
            </div>
          ) : preview?.kind === 'html' ? (
            <iframe
              title={ui.iframeTitle(selected.display_name)}
              srcDoc={preview.html}
              sandbox=""
              referrerPolicy="no-referrer"
            />
          ) : preview?.kind === 'example' ? (
            <article className="publication-template-example">
              <p className="publication-template-example-format">
                {copy.template.examplePreview} · {preview.format.toUpperCase()}
              </p>
              <h4>{preview.title}</h4>
              <dl>
                <div>
                  <dt>{copy.template.audience}</dt>
                  <dd>{preview.audience}</dd>
                </div>
                <div>
                  <dt>{copy.template.purpose}</dt>
                  <dd>{preview.purpose}</dd>
                </div>
                <div>
                  <dt>{copy.template.job}</dt>
                  <dd>{preview.job}</dd>
                </div>
                <div>
                  <dt>{copy.template.scope}</dt>
                  <dd>{preview.output_shape}</dd>
                </div>
              </dl>
            </article>
          ) : null}
        </div>

        <button
          type="button"
          className="publication-template-use"
          onClick={() => onConfirm(selected)}
        >
          {ui.useDocument}
        </button>
      </section>
    </div>
  );
}

function selectWithKeyboard({
  event,
  index,
  templates,
  onSelect,
}: {
  event: KeyboardEvent<HTMLButtonElement>;
  index: number;
  templates: PublicationTemplateReadModel[];
  onSelect(template: PublicationTemplateReadModel): void;
}) {
  let nextIndex: number;
  switch (event.key) {
    case 'ArrowDown':
      nextIndex = Math.min(index + 1, templates.length - 1);
      break;
    case 'ArrowUp':
      nextIndex = Math.max(index - 1, 0);
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = templates.length - 1;
      break;
    default:
      return;
  }
  const template = templates[nextIndex];
  if (!template) return;
  event.preventDefault();
  const listbox = event.currentTarget.closest('[role="listbox"]');
  const option = listbox?.querySelectorAll<HTMLButtonElement>(
    '[role="option"]',
  )[nextIndex];
  option?.focus();
  onSelect(template);
}

function StabilityBadge({
  stability,
  tracked = false,
}: {
  stability: PublicationTemplateReadModel['stability'];
  tracked?: boolean;
}) {
  return (
    <span
      className="publication-template-badge"
      data-stability={stability}
      {...(tracked ? { 'data-template-stability': stability } : {})}
    >
      {stability === 'stable' ? 'Stable' : 'Experimental'}
    </span>
  );
}

function DocumentThumbnail({
  scope,
  stability,
}: {
  scope: PublicationTemplateReadModel['scope'];
  stability: PublicationTemplateReadModel['stability'];
}) {
  return (
    <span
      className="publication-template-thumbnail"
      data-stability={stability}
      aria-hidden
    >
      <span className="publication-template-thumbnail-kicker">
        {scope === 'workspace' ? '01' : '••'}
      </span>
      <span />
      <span />
      <span />
    </span>
  );
}

function outputSentence(
  scope: PublicationTemplateReadModel['scope'],
  locale: PublicationUiLocale,
): string {
  if (locale === 'ko') {
    return scope === 'per_dok'
      ? '선택한 Dok마다 문서 하나'
      : scope === 'workspace'
        ? '선택한 Dok을 합친 문서 하나'
        : '조건에 맞는 Dok마다 문서 하나';
  }
  return scope === 'per_dok'
    ? 'One document for each selected Dok'
    : scope === 'workspace'
      ? 'One document combining the selected Doks'
      : 'One document for each eligible Dok';
}

function displayFormat(format: string): string {
  return format === 'markdown'
    ? 'Markdown'
    : format === 'text'
      ? 'Text'
      : format.toUpperCase();
}

function pickerUi(locale: PublicationUiLocale) {
  return locale === 'ko'
    ? {
        catalogLabel: 'Template 탐색',
        searchLabel: 'Template 검색',
        filterLabel: 'Template 안정성',
        listLabel: '문서 Template',
        noMatches: '검색 조건에 맞는 Template이 없습니다.',
        previewReady: '문서 미리보기가 준비되었습니다.',
        supportedFormatsLabel: '지원 형식',
        defaultFormatLabel: '기본값',
        fidelityLabel: '미리보기 기준',
        useDocument: '이 문서 선택',
        iframeTitle: (name: string) => `${name} 문서 미리보기`,
      }
    : {
        catalogLabel: 'Template catalog',
        searchLabel: 'Search templates',
        filterLabel: 'Template stability',
        listLabel: 'Document Templates',
        noMatches: 'No Templates match this search.',
        previewReady: 'Document preview ready.',
        supportedFormatsLabel: 'Supported formats',
        defaultFormatLabel: 'Default',
        fidelityLabel: 'Preview fidelity',
        useDocument: 'Use this document',
        iframeTitle: (name: string) => `${name} document preview`,
      };
}
