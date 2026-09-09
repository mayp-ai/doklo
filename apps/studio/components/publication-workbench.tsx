'use client';

import {
  AlertTriangle,
  Archive,
  Check,
  ChevronRight,
  CircleDot,
  FileOutput,
  Plus,
  RefreshCw,
  Send,
  Settings2,
} from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  publicationCopy,
  publicationErrorMessage,
} from '../lib/publication-copy';
import type { RenderedPublicationCandidate } from '../lib/publication-preview';
import type {
  PublicationReadModelEntry,
  PublicationWorkspaceModel,
} from '../lib/publication-read-model';
import type { StudioPublicationActionInput } from '../lib/publication-run';
import { PublicationPreview } from './publication-preview';

type DetailTab = 'preview' | 'changes' | 'settings';
type PreviewSlot = {
  key: string;
  value?: RenderedPublicationCandidate;
};
type ModelReadToken = {
  generation: number;
  sequence: number;
};

export function PublicationWorkbench({
  initialModel,
  initialPublicationName,
}: {
  initialModel: PublicationWorkspaceModel;
  initialPublicationName?: string;
}) {
  const [model, setModel] = useState(initialModel);
  const [selectedName, setSelectedName] = useState(() => (
    initialModel.publications.some(
      (entry) => entry.publication.name === initialPublicationName,
    )
      ? initialPublicationName!
      : initialModel.publications[0]?.publication.name ?? null
  ));
  const [candidateSlot, setCandidateSlot] = useState<PreviewSlot>();
  const [officialSlot, setOfficialSlot] = useState<PreviewSlot>();
  const [showCandidate, setShowCandidate] = useState(false);
  const [loadingCandidateKey, setLoadingCandidateKey] = useState<
    string | null
  >(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: 'error' | 'success' | 'warning';
    text: string;
  } | null>(null);
  const [tab, setTab] = useState<DetailTab>('preview');
  const modelReadSequence = useRef(0);
  const mutationGeneration = useRef(0);
  const officialRequestSequence = useRef(0);
  const candidateRequestSequence = useRef(0);
  const copy = publicationCopy(model.locale);
  const selected = useMemo(
    () => model.publications.find(
      (entry) => entry.publication.name === selectedName,
    ) ?? model.publications[0],
    [model.publications, selectedName],
  );
  const officialPreviewVersion = useMemo(
    () => selected?.evidence?.outputs
      .map((output) => `${output.relative_path}:${output.sha256}`)
      .sort()
      .join('\0') ?? '',
    [selected?.evidence],
  );
  const officialKey = selected
    ? `${selected.publication.name}\0${officialPreviewVersion}`
    : null;
  const candidateKey = selected
    && selected.effective_update_mode === 'review'
    && selected.status.render_state === 'update_available'
    ? `${selected.publication.name}\0${selected.status.input_fingerprint}`
    : null;
  const official = officialKey && officialSlot?.key === officialKey
    ? officialSlot.value
    : undefined;
  const candidate = candidateKey && candidateSlot?.key === candidateKey
    ? candidateSlot.value
    : undefined;
  const previewLoading = candidateKey !== null
    && loadingCandidateKey === candidateKey;

  const applyModel = useCallback((fresh: PublicationWorkspaceModel) => {
    setModel(fresh);
    setSelectedName((current) => (
      fresh.publications.some(
        (entry) => entry.publication.name === current,
      )
        ? current
        : fresh.publications[0]?.publication.name ?? null
    ));
  }, []);

  const beginModelRead = useCallback((): ModelReadToken => ({
    generation: mutationGeneration.current,
    sequence: ++modelReadSequence.current,
  }), []);

  const isCurrentModelRead = useCallback((token: ModelReadToken): boolean => (
    token.generation === mutationGeneration.current
    && token.sequence === modelReadSequence.current
  ), []);

  const applyReadModel = useCallback((
    token: ModelReadToken,
    fresh: PublicationWorkspaceModel,
  ): boolean => {
    if (!isCurrentModelRead(token)) return false;
    applyModel(fresh);
    return true;
  }, [applyModel, isCurrentModelRead]);

  const applyMutationModel = useCallback((
    fresh: PublicationWorkspaceModel,
  ) => {
    mutationGeneration.current += 1;
    modelReadSequence.current += 1;
    applyModel(fresh);
  }, [applyModel]);

  const refresh = useCallback(async () => {
    const token = beginModelRead();
    try {
      const response = await fetch('/api/livedocs');
      const fresh = await response.json() as PublicationWorkspaceModel & {
        code?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(publicationErrorMessage(model.locale, fresh.code));
      }
      if (!Array.isArray(fresh.publications)) {
        throw new Error('Invalid Publication catalog response');
      }
      applyReadModel(token, fresh);
    } catch {
      if (!isCurrentModelRead(token)) return;
      setMessage({ tone: 'error', text: copy.errors.generic });
    }
  }, [
    applyReadModel,
    beginModelRead,
    copy.errors.generic,
    isCurrentModelRead,
    model.locale,
  ]);

  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    const requestSequence = ++officialRequestSequence.current;
    if (!selected || !officialKey) {
      setOfficialSlot(undefined);
      return;
    }
    const token = beginModelRead();
    const controller = new AbortController();
    setOfficialSlot({ key: officialKey });
    fetch(
      `/api/livedocs/${encodeURIComponent(selected.publication.name)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json() as {
          model?: PublicationWorkspaceModel;
          official_preview?: RenderedPublicationCandidate;
        };
        if (
          controller.signal.aborted
          || requestSequence !== officialRequestSequence.current
          || !response.ok
        ) {
          return;
        }
        if (body.model) applyReadModel(token, body.model);
        setOfficialSlot({
          key: officialKey,
          value: body.official_preview,
        });
      })
      .catch(() => {});
    return () => {
      controller.abort();
    };
  }, [
    applyReadModel,
    beginModelRead,
    officialKey,
    officialPreviewVersion,
    selected?.publication.name,
  ]);

  useEffect(() => {
    const requestSequence = ++candidateRequestSequence.current;
    if (!selected || !candidateKey) {
      setCandidateSlot(undefined);
      setShowCandidate(false);
      setLoadingCandidateKey(null);
      return;
    }
    const fingerprint = selected.status.input_fingerprint;
    const controller = new AbortController();
    setCandidateSlot({ key: candidateKey });
    setShowCandidate(false);
    setLoadingCandidateKey(candidateKey);
    fetch(
      `/api/livedocs/${encodeURIComponent(selected.publication.name)}/preview`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const body = await response.json() as RenderedPublicationCandidate & {
          code?: string;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(publicationErrorMessage(model.locale, body.code));
        }
        if (body.fingerprint !== fingerprint) {
          throw new Error('Invalid candidate preview fingerprint.');
        }
        if (
          controller.signal.aborted
          || requestSequence !== candidateRequestSequence.current
        ) {
          return;
        }
        setCandidateSlot({ key: candidateKey, value: body });
        setShowCandidate(true);
      })
      .catch((error) => {
        if (
          controller.signal.aborted
          || requestSequence !== candidateRequestSequence.current
        ) {
          return;
        }
        setCandidateSlot({ key: candidateKey });
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (requestSequence === candidateRequestSequence.current) {
          setLoadingCandidateKey(null);
        }
      });
    return () => controller.abort();
  }, [
    candidateKey,
    model.locale,
  ]);

  const runAction = async (
    action: StudioPublicationActionInput['action'],
  ) => {
    if (!selected || actionPending) return;
    setActionPending(action);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/livedocs/${encodeURIComponent(selected.publication.name)}/action`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            fingerprint: selected.status.input_fingerprint,
          } satisfies StudioPublicationActionInput),
        },
      );
      const body = await response.json() as {
        status?: 'success' | 'partial';
        completed?: string[];
        failed?: string;
        model?: PublicationWorkspaceModel;
        error?: string;
        code?: string;
      };
      if (body.model) applyMutationModel(body.model);
      if (response.status === 207 || body.status === 'partial') {
        setMessage({
          tone: 'warning',
          text: partialActionMessage({
            completed: body.completed,
            failed: body.failed,
            code: body.code,
            locale: model.locale,
          }),
        });
      } else if (!response.ok) {
        throw new Error(publicationErrorMessage(model.locale, body.code));
      } else {
        setMessage({ tone: 'success', text: copy.status.current });
        if (action === 'export') {
          downloadPublicationExport(selected.publication.name);
        }
      }
      await refresh();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setActionPending(null);
    }
  };

  if (model.publications.length === 0) {
    return (
      <main className="flex h-full items-center justify-center bg-canvas p-8">
        <div className="max-w-lg text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <FileOutput size={26} aria-hidden />
          </span>
          <h1 className="mt-5 text-xl font-bold text-ink-strong">
            {copy.workbench.emptyTitle}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            {copy.workbench.emptyBody}
          </p>
          <Link
            href="/livedocs/new"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-canvas no-underline shadow-sm hover:bg-accent-hover"
          >
            <Plus size={16} aria-hidden />
            {copy.workbench.newPublication}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="publication-workbench flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-bold text-ink-strong">
            {copy.workbench.title}
          </h1>
          <p className="truncate text-xs text-ink-muted">
            {copy.workbench.lead}
          </p>
        </div>
        <Link
          href="/livedocs/new"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-canvas no-underline shadow-sm hover:bg-accent-hover"
        >
          <Plus size={14} aria-hidden />
          {copy.workbench.newPublication}
        </Link>
      </header>

      <div
        className="publication-workbench-grid grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)_340px]"
        data-active-tab={tab}
      >
        <nav
          aria-label={copy.workbench.publications}
          className="publication-list overflow-y-auto border-r border-border bg-surface p-2.5"
        >
          <p className="px-2 pb-2 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
            {copy.workbench.publications} · {model.publications.length}
          </p>
          <div className="space-y-1">
            {model.publications.map((entry) => (
              <PublicationListItem
                key={entry.publication.name}
                entry={entry}
                selected={
                  entry.publication.name === selected?.publication.name
                }
                locale={model.locale}
                onClick={() => {
                  setSelectedName(entry.publication.name);
                  setTab('preview');
                }}
              />
            ))}
          </div>
        </nav>

        <div
          role="tablist"
          aria-label={copy.workbench.title}
          className="publication-mobile-tabs hidden border-b border-border bg-surface p-1"
        >
          {([
            ['preview', copy.preview.preview],
            ['changes', copy.preview.changes],
            ['settings', copy.preview.settings],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              id={`publication-tab-${value}`}
              role="tab"
              aria-selected={tab === value}
              aria-controls={
                value === 'preview'
                  ? 'publication-panel-preview'
                  : 'publication-panel-detail'
              }
              data-publication-tab={value}
              onClick={() => setTab(value)}
              className={[
                'flex-1 rounded px-2 py-2 text-xs font-semibold',
                tab === value
                  ? 'bg-accent-soft text-accent-ink'
                  : 'text-ink-muted',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        <section
          id="publication-panel-preview"
          role="tabpanel"
          aria-labelledby="publication-tab-preview"
          className="publication-preview-column flex min-h-0 min-w-0 flex-col"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-strong">
                {selected?.publication.display_name}
              </p>
              <p className="truncate font-mono text-[11px] text-ink-faint">
                {selected?.publication.name}
              </p>
            </div>
            {candidate ? (
              <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
                <button
                  type="button"
                  aria-pressed={!showCandidate}
                  onClick={() => setShowCandidate(false)}
                  className={[
                    'rounded px-2.5 py-1 text-xs font-semibold',
                    !showCandidate
                      ? 'bg-surface text-ink shadow-sm'
                      : 'text-ink-muted',
                  ].join(' ')}
                >
                  {copy.preview.official}
                </button>
                <button
                  type="button"
                  aria-pressed={showCandidate}
                  onClick={() => setShowCandidate(true)}
                  className={[
                    'rounded px-2.5 py-1 text-xs font-semibold',
                    showCandidate
                      ? 'bg-accent text-canvas shadow-sm'
                      : 'text-ink-muted',
                  ].join(' ')}
                >
                  {copy.preview.candidate}
                </button>
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 bg-surface-2">
            <PublicationPreview
              locale={model.locale}
              candidate={showCandidate ? candidate : official}
              loading={previewLoading && !official}
              mode={showCandidate && candidate ? 'candidate' : 'official'}
            />
          </div>
        </section>

        <aside
          id="publication-panel-detail"
          role="tabpanel"
          aria-labelledby={`publication-tab-${tab === 'settings' ? 'settings' : 'changes'}`}
          className="publication-detail min-h-0 overflow-y-auto border-l border-border bg-surface"
        >
          {selected ? (
            <PublicationDetail
              entry={selected}
              locale={model.locale}
              pending={actionPending}
              message={message}
              runAction={runAction}
            />
          ) : null}
        </aside>
      </div>
    </main>
  );
}

function downloadPublicationExport(name: string): void {
  const anchor = document.createElement('a');
  anchor.href = `/api/livedocs/${encodeURIComponent(name)}/download`;
  anchor.download = `${name}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function PublicationListItem({
  entry,
  selected,
  locale,
  onClick,
}: {
  entry: PublicationReadModelEntry;
  selected: boolean;
  locale: PublicationWorkspaceModel['locale'];
  onClick: () => void;
}) {
  const copy = publicationCopy(locale);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={[
        'w-full rounded-md border px-3 py-3 text-left transition-colors',
        selected
          ? 'border-accent bg-accent-soft'
          : 'border-transparent hover:border-border hover:bg-surface-2',
      ].join(' ')}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-ink-strong">
            {entry.publication.display_name}
          </span>
          <span className="mt-1 block truncate text-[11px] text-ink-faint">
            {entry.template.display_name}
          </span>
        </span>
        <ChevronRight size={14} className="mt-0.5 shrink-0 text-ink-faint" aria-hidden />
      </span>
      <span className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
        <StatusDot state={entry.status.render_state} />
        {renderStateLabel(entry.status.render_state, copy)}
      </span>
    </button>
  );
}

function PublicationDetail({
  entry,
  locale,
  pending,
  message,
  runAction,
}: {
  entry: PublicationReadModelEntry;
  locale: PublicationWorkspaceModel['locale'];
  pending: string | null;
  message: { tone: 'error' | 'success' | 'warning'; text: string } | null;
  runAction: (action: StudioPublicationActionInput['action']) => Promise<void>;
}) {
  const copy = publicationCopy(locale);
  const review = entry.effective_update_mode === 'review';
  const canApprove = review
    && (
      entry.status.render_state === 'update_available'
      || entry.status.render_state === 'definition_changed'
    );
  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
            {entry.template.display_name}
          </p>
          <h2 className="mt-1 text-lg font-bold text-ink-strong">
            {entry.publication.display_name}
          </h2>
        </div>
        <StatusDot state={entry.status.render_state} large />
      </div>

      <div className="publication-changes-pane">
        <dl className="mt-6 divide-y divide-border border-y border-border text-sm">
          <DetailRow
            label={copy.status.render}
            value={renderStateLabel(entry.status.render_state, copy)}
          />
          <DetailRow
            label={copy.status.publish}
            value={publishStateLabel(entry.status.publish_state, copy)}
          />
          <DetailRow
            label={copy.selection.resolved}
            value={`${entry.status.resolved_dok_ids.length} ${copy.common.doks}`}
          />
          <DetailRow
            label={copy.update.title}
            value={review ? copy.update.review : copy.update.manual}
          />
          <DetailRow
            label={copy.create.format}
            value={`${entry.publication.locale.toUpperCase()} · ${entry.publication.format}`}
          />
        </dl>

        {entry.status.freshness === 'unknown' ? (
          <p className="mt-4 flex items-start gap-2 rounded-md bg-warning-bg p-3 text-xs leading-relaxed text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
            {copy.status.freshnessUnknown}
          </p>
        ) : null}
        {entry.status.template_update_available ? (
          <p className="mt-3 text-xs font-medium text-info">
            {copy.status.templateChanged}
          </p>
        ) : null}
        <ChangeSummary
          summary={entry.change_summary}
          locale={locale}
        />
        {message ? (
          <p
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={[
              'mt-4 rounded-md p-3 text-xs font-medium',
              message.tone === 'error'
                ? 'bg-danger-bg text-danger'
                : message.tone === 'warning'
                  ? 'bg-warning-bg text-warning'
                  : 'bg-success-bg text-success',
            ].join(' ')}
          >
            {message.text}
          </p>
        ) : null}

        <div className="mt-6 space-y-2">
          {canApprove ? (
            <ActionButton
              primary
              pending={pending === 'approve'}
              disabled={pending !== null}
              icon={<Check size={15} aria-hidden />}
              onClick={() => void runAction('approve')}
            >
              {entry.publication.destination
                ? copy.actions.approvePublish
                : copy.actions.approveRender}
            </ActionButton>
          ) : (
            <>
              <ActionButton
                primary={entry.status.render_state !== 'current'}
                pending={pending === 'render'}
                disabled={pending !== null}
                icon={<FileOutput size={15} aria-hidden />}
                onClick={() => void runAction('render')}
              >
                {copy.actions.render}
              </ActionButton>
              {entry.publication.destination ? (
                <ActionButton
                  pending={pending === 'publish'}
                  disabled={pending !== null || !entry.evidence}
                  icon={<Send size={15} aria-hidden />}
                  onClick={() => void runAction('publish')}
                >
                  {copy.actions.publish}
                </ActionButton>
              ) : null}
            </>
          )}
          <ActionButton
            pending={pending === 'export'}
            disabled={pending !== null || !entry.evidence}
            icon={<Archive size={15} aria-hidden />}
            onClick={() => void runAction('export')}
          >
            {copy.actions.export}
          </ActionButton>
        </div>
      </div>

      <div className="publication-settings-pane mt-7 border-t border-border pt-5">
        <p className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
          <Settings2 size={14} aria-hidden />
          {copy.preview.settings}
        </p>
        <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-ink-faint">
          {entry.definition_path}
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          {entry.publication.destination?.path
            ?? copy.workbench.noDestination}
        </p>
      </div>
    </div>
  );
}

function ChangeSummary({
  summary,
  locale,
}: {
  summary: PublicationReadModelEntry['change_summary'] | undefined;
  locale: PublicationWorkspaceModel['locale'];
}) {
  const copy = publicationCopy(locale);
  const groups = summary
    ? [
        [copy.changes.added, summary.added, false],
        [copy.changes.changed, summary.changed, false],
        [copy.changes.removed, summary.removed, false],
        [copy.changes.excluded, summary.excluded, true],
      ] as const
    : [];
  const populated = groups.filter(([, items]) => items.length > 0);
  if (populated.length === 0) {
    return (
      <p className="mt-4 text-xs leading-relaxed text-ink-faint">
        {copy.changes.none}
      </p>
    );
  }
  return (
    <div className="mt-5 space-y-4 border-t border-border pt-4">
      {populated.map(([label, items, showReason]) => (
        <div key={label}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            {label} · {items.length}
          </p>
          <ul className="mt-2 space-y-1.5">
            {items.slice(0, 8).map((item) => (
              <li
                key={item.dok_id}
                className="rounded-md bg-surface-2 px-2.5 py-2 text-xs"
              >
                <span className="block font-medium text-ink">
                  {item.name}
                </span>
                <span className="font-mono text-[10px] text-ink-faint">
                  {item.dok_id}
                  {showReason && 'reason' in item
                    ? ` · ${item.reason === 'unreviewed'
                      ? copy.selection.unreviewed
                      : copy.selection.templateSelector}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          {items.length > 8 ? (
            <p className="mt-1 text-[10px] text-ink-faint">
              +{items.length - 8} {copy.changes.more}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ActionButton({
  children,
  icon,
  primary = false,
  pending,
  disabled,
  onClick,
}: {
  children: ReactNode;
  icon: ReactNode;
  primary?: boolean;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex w-full items-center justify-center gap-2 rounded-md px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-45',
        primary
          ? 'bg-accent text-canvas shadow-sm hover:bg-accent-hover'
          : 'border border-border bg-surface text-ink-secondary hover:bg-surface-2',
      ].join(' ')}
    >
      {pending ? <RefreshCw size={15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 py-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function StatusDot({
  state,
  large = false,
}: {
  state: PublicationReadModelEntry['status']['render_state'];
  large?: boolean;
}) {
  const Icon = state === 'current'
    ? Check
    : state === 'blocked'
      ? AlertTriangle
      : CircleDot;
  return (
    <span className={[
      'inline-flex shrink-0 items-center justify-center rounded-full',
      large ? 'h-8 w-8' : 'h-4 w-4',
      state === 'current'
        ? 'bg-success-bg text-success'
        : state === 'blocked'
          ? 'bg-danger-bg text-danger'
          : 'bg-warning-bg text-warning',
    ].join(' ')}>
      <Icon size={large ? 16 : 10} aria-hidden />
    </span>
  );
}

function renderStateLabel(
  state: PublicationReadModelEntry['status']['render_state'],
  copy: ReturnType<typeof publicationCopy>,
): string {
  return {
    not_rendered: copy.status.notRendered,
    current: copy.status.current,
    update_available: copy.status.updateAvailable,
    definition_changed: copy.status.definitionChanged,
    blocked: copy.status.blocked,
  }[state];
}

function publishStateLabel(
  state: PublicationReadModelEntry['status']['publish_state'],
  copy: ReturnType<typeof publicationCopy>,
): string {
  return {
    no_destination: copy.status.noDestination,
    not_published: copy.status.notPublished,
    published: copy.status.published,
    publish_needed: copy.status.publishNeeded,
    publish_blocked: copy.status.publishBlocked,
  }[state];
}

function partialActionMessage(input: {
  completed: string[] | undefined;
  failed: string | undefined;
  code: string | undefined;
  locale: PublicationWorkspaceModel['locale'];
}): string {
  const copy = publicationCopy(input.locale);
  const completed = new Set(input.completed ?? []);
  if (input.failed === 'render' && completed.has('resnapshot')) {
    return copy.status.selectionUpdatedRenderFailed;
  }
  if (
    (input.failed === 'publish' || input.failed === 'publish-dry-run')
    && completed.has('render')
  ) {
    return copy.status.renderedPublishBlocked;
  }
  if (
    input.failed === 'publish'
    || input.failed === 'publish-dry-run'
  ) {
    return copy.status.publishFailed;
  }
  return publicationErrorMessage(input.locale, input.code);
}
