'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  CircleMinus,
  Clock3,
  Loader2,
  XCircle,
} from 'lucide-react';
import { doneCounters } from '../../lib/generate-progress';
import {
  acquireGenerationConsent,
  startGenerationRequest,
} from '../../lib/generation-consent';
import { readJsonLines } from '../../lib/parse-json-lines';

type RowLayer = 'roles' | 'dok' | 'ia' | 'code-mapping';
type RowState = 'pending' | 'running' | 'success' | 'skipped' | 'error';

interface Row {
  key: string;
  layer: RowLayer;
  title: string;
  detail: string;
  state: RowState;
  statusLabel: string;
  message?: string;
}

const LAYER_ORDER: Record<RowLayer, number> = {
  roles: 0,
  dok: 1,
  ia: 2,
  'code-mapping': 3,
};

export const GENERATE_PANEL_DIALOG_ID = 'generate-panel-dialog';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

interface InertLease {
  count: number;
  originalAttribute: string | null;
}

const inertLeases = new Map<HTMLElement, InertLease>();
const modalStack: symbol[] = [];

function acquireInert(element: HTMLElement): () => void {
  const current = inertLeases.get(element);
  if (current) {
    current.count += 1;
  } else {
    inertLeases.set(element, {
      count: 1,
      originalAttribute: element.getAttribute('inert'),
    });
    element.setAttribute('inert', '');
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const lease = inertLeases.get(element);
    if (!lease) return;
    lease.count -= 1;
    if (lease.count > 0) return;
    inertLeases.delete(element);
    if (lease.originalAttribute === null) element.removeAttribute('inert');
    else element.setAttribute('inert', lease.originalAttribute);
  };
}

function inertBackground(modalRoot: HTMLElement): () => void {
  const parent = modalRoot.parentElement;
  if (!parent) return () => {};
  const releases = Array.from(parent.children)
    .filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child !== modalRoot,
    )
    .map(acquireInert);
  return () => {
    for (const release of releases.reverse()) release();
  };
}

function isHidden(element: HTMLElement): boolean {
  if (
    element.closest(
      '[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]',
    )
  ) {
    return true;
  }
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    const style = getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden'
    ) {
      return true;
    }
  }
  return element.getClientRects().length === 0;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 && !element.matches(':disabled') && !isHidden(element),
  );
}

function focusWithoutScroll(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

function canRestoreFocus(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.matches(':disabled') &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]')
  );
}

function initialRows(service: string): Row[] {
  return [
    {
      key: 'roles',
      layer: 'roles',
      title: 'Roles',
      detail: 'Workspace registry',
      state: 'pending',
      statusLabel: 'Pending',
    },
    {
      key: `ia:${service}`,
      layer: 'ia',
      title: 'IA',
      detail: service,
      state: 'pending',
      statusLabel: 'Pending',
    },
    {
      key: `code-mapping:${service}`,
      layer: 'code-mapping',
      title: 'Code mapping',
      detail: service,
      state: 'pending',
      statusLabel: 'Pending',
    },
  ];
}

function upsertRow(rows: Row[], next: Row): Row[] {
  const index = rows.findIndex((row) => row.key === next.key);
  if (index === -1) return [...rows, next];
  return rows.map((row, rowIndex) => (rowIndex === index ? next : row));
}

function stringValue(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(event: Record<string, unknown>, key: string): number {
  const value = event[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function layerResult(status: string | undefined): Pick<Row, 'state' | 'statusLabel'> {
  if (status === 'updated') return { state: 'success', statusLabel: 'Updated' };
  if (status === 'written') return { state: 'success', statusLabel: 'Written' };
  if (status === 'unchanged') return { state: 'success', statusLabel: 'Unchanged' };
  if (status === 'skipped') return { state: 'skipped', statusLabel: 'Skipped' };
  if (status === 'error') return { state: 'error', statusLabel: 'Failed' };
  return { state: 'pending', statusLabel: 'Pending' };
}

function doneFailureMessage(failed: number, layerFailed: number): string {
  const failures: string[] = [];
  if (failed > 0) failures.push(`${failed} Dok${failed === 1 ? '' : 's'} failed`);
  if (layerFailed > 0) {
    failures.push(`${layerFailed} deterministic layer${layerFailed === 1 ? '' : 's'} failed`);
  }
  return `Generation completed with ${failures.join(' and ')}.`;
}

export function GeneratePanel({ service, onClose }: { service: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => initialRows(service));
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const modalRootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const modalRoot = modalRootRef.current;
    const dialog = dialogRef.current;
    const initialFocus = initialFocusRef.current;
    if (!modalRoot || !dialog || !initialFocus) return;

    const ownerDocument = modalRoot.ownerDocument;
    const activeElement = ownerDocument.activeElement;
    const previousFocus =
      activeElement instanceof HTMLElement &&
      activeElement !== ownerDocument.body &&
      activeElement !== ownerDocument.documentElement &&
      !modalRoot.contains(activeElement)
        ? activeElement
        : null;
    const linkedTrigger = ownerDocument.querySelector<HTMLElement>(
      `[aria-controls="${GENERATE_PANEL_DIALOG_ID}"][aria-haspopup="dialog"]`,
    );
    const token = Symbol('generate-panel');
    modalStack.push(token);
    const releaseInert = inertBackground(modalRoot);
    const isTopModal = () => modalStack.at(-1) === token;

    const containFocus = (shiftKey = false) => {
      const focusables = focusableElements(dialog);
      const target = shiftKey ? focusables.at(-1) : focusables[0];
      focusWithoutScroll(target ?? initialFocus);
    };

    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!isTopModal()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = focusableElements(dialog);
      const active = ownerDocument.activeElement;
      if (focusables.length <= 1) {
        event.preventDefault();
        focusWithoutScroll(focusables[0] ?? initialFocus);
        return;
      }

      const activeIndex =
        active instanceof HTMLElement ? focusables.indexOf(active) : -1;
      const wrapsBackward = event.shiftKey && activeIndex <= 0;
      const wrapsForward = !event.shiftKey && activeIndex === focusables.length - 1;
      const escaped = activeIndex === -1;
      if (!wrapsBackward && !wrapsForward && !escaped) return;

      event.preventDefault();
      const target = event.shiftKey ? focusables.at(-1) : focusables[0];
      if (target) focusWithoutScroll(target);
    };

    const onKeyDownBubble = (event: KeyboardEvent) => {
      if (isTopModal()) event.stopPropagation();
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopModal()) return;
      const target = event.target;
      if (target instanceof Node && dialog.contains(target)) return;
      containFocus();
    };

    ownerDocument.addEventListener('keydown', onKeyDownCapture, true);
    ownerDocument.addEventListener('keydown', onKeyDownBubble);
    ownerDocument.addEventListener('focusin', onFocusIn, true);
    focusWithoutScroll(initialFocus);

    return () => {
      ownerDocument.removeEventListener('keydown', onKeyDownCapture, true);
      ownerDocument.removeEventListener('keydown', onKeyDownBubble);
      ownerDocument.removeEventListener('focusin', onFocusIn, true);
      const wasTopModal = isTopModal();
      const stackIndex = modalStack.lastIndexOf(token);
      if (stackIndex !== -1) modalStack.splice(stackIndex, 1);
      releaseInert();
      if (wasTopModal) {
        const restoreTarget = [previousFocus, linkedTrigger].find(
          (target): target is HTMLElement =>
            target !== null && canRestoreFocus(target),
        );
        if (restoreTarget) focusWithoutScroll(restoreTarget);
      }
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setRows(initialRows(service));
    setDone(false);
    setError('');
    setRunning(false);
  }, [service]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const startGeneration = useCallback(async () => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRows(initialRows(service));
    setDone(false);
    setError('');
    setRunning(true);

    const endpoint = `/api/consolidation/generate?service=${encodeURIComponent(service)}`;
    let terminal = false;
    let completion: 'none' | 'success' | 'failure' = 'none';
    let completionError = '';

    const onEvent = (event: Record<string, unknown>) => {
      if (terminal) return;
      const stage = stringValue(event, 'stage');
      if (stage === 'roles') {
        const added = numberValue(event, 'added');
        const kept = numberValue(event, 'kept');
        setRows((current) =>
          upsertRow(current, {
            key: 'roles',
            layer: 'roles',
            title: 'Roles',
            detail: `${added} added · ${kept} kept`,
            ...layerResult(stringValue(event, 'status')),
            ...(stringValue(event, 'error') ? { message: stringValue(event, 'error') } : {}),
          }),
        );
        return;
      }

      if (stage === 'dok-start') {
        const serviceId = stringValue(event, 'serviceId') ?? service;
        const dokId = stringValue(event, 'dokId') ?? 'Dok';
        const featureLabel = stringValue(event, 'featureLabel');
        setRows((current) =>
          upsertRow(current, {
            key: `dok:${serviceId}:${dokId}`,
            layer: 'dok',
            title: dokId,
            detail: featureLabel ? `${serviceId} · ${featureLabel}` : serviceId,
            state: 'running',
            statusLabel: 'Generating',
          }),
        );
        return;
      }

      if (stage === 'dok-done') {
        const serviceId = stringValue(event, 'serviceId') ?? service;
        const dokId = stringValue(event, 'dokId') ?? 'Dok';
        const key = `dok:${serviceId}:${dokId}`;
        const succeeded = event.success === true;
        setRows((current) => {
          const existing = current.find((row) => row.key === key);
          return upsertRow(current, {
            key,
            layer: 'dok',
            title: existing?.title ?? dokId,
            detail: existing?.detail ?? serviceId,
            state: succeeded ? 'success' : 'error',
            statusLabel: succeeded ? 'Complete' : 'Failed',
            ...(stringValue(event, 'error') ? { message: stringValue(event, 'error') } : {}),
          });
        });
        return;
      }

      if (stage === 'ia' || stage === 'code-mapping') {
        const serviceId = stringValue(event, 'serviceId') ?? service;
        const count = numberValue(event, 'count');
        setRows((current) =>
          upsertRow(current, {
            key: `${stage}:${serviceId}`,
            layer: stage,
            title: stage === 'ia' ? 'IA' : 'Code mapping',
            detail: `${serviceId} · ${count} ${stage === 'ia' ? 'routes' : 'entries'}`,
            ...layerResult(stringValue(event, 'status')),
            ...(stringValue(event, 'error') ? { message: stringValue(event, 'error') } : {}),
          }),
        );
        return;
      }

      if (stage === 'done') {
        const counters = doneCounters(event);
        if (!counters) {
          completion = 'failure';
          completionError = 'Generation returned an invalid completion summary.';
          setDone(false);
          setError(completionError);
        } else if (counters.failed === 0 && counters.layerFailed === 0) {
          // Keep the stream open until the child actually closes. A later
          // non-zero close is forwarded as `stage:error` and must supersede
          // this candidate done payload.
          if (completion !== 'failure') completion = 'success';
        } else {
          completion = 'failure';
          completionError = doneFailureMessage(
            counters.failed,
            counters.layerFailed,
          );
          setDone(false);
          setError(completionError);
        }
        return;
      }

      if (stage === 'clean-close') {
        terminal = true;
        if (completion === 'success') {
          setDone(true);
        } else {
          setDone(false);
          setError(
            completionError ||
              'Generation stream closed before reporting completion.',
          );
        }
        return;
      }

      if (stage === 'error') {
        terminal = true;
        setDone(false);
        setError(stringValue(event, 'message') ?? 'Unknown generation error');
      }
    };

    try {
      const consentToken = await acquireGenerationConsent(endpoint, controller.signal);
      if (controller.signal.aborted) return;
      const response = await startGenerationRequest(
        endpoint,
        consentToken,
        controller.signal,
      );
      if (!response.ok) {
        setError(`Generation request failed with status ${response.status}.`);
        return;
      }
      if (!response.body) {
        setError('Generation returned no progress stream.');
        return;
      }

      await readJsonLines(response.body, onEvent);
      if (!terminal && !controller.signal.aborted) {
        setDone(false);
        setError(
          completionError ||
            'Generation stream closed before reporting clean completion. The generator may still be active; check the Hub before retrying.',
        );
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setDone(false);
      const detail = cause instanceof Error ? cause.message : 'Unknown generation error';
      setError(
        `${detail} The generator may still be active after a connection loss; check the Hub before retrying.`,
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRunning(false);
      }
    }
  }, [service]);

  const orderedRows = [...rows].sort(
    (left, right) => LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer],
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={modalRootRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-strong/30 p-4 sm:p-6"
    >
      <section
        ref={dialogRef}
        id={GENERATE_PANEL_DIALOG_ID}
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-panel-title"
        className="flex max-h-[min(70vh,720px)] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-border bg-canvas shadow-xl"
      >
        <header className="px-5 pb-4 pt-5">
          <h2
            ref={initialFocusRef}
            id="generate-panel-title"
            tabIndex={-1}
            className="mb-1 text-sm font-semibold text-ink-strong"
          >
            Generate Hub layers
          </h2>
          <p className="max-w-[65ch] text-[12px] leading-relaxed text-ink-muted">
            Refreshes Roles, generates Doks, then writes deterministic IA and
            code-mapping layers. This sends selected source excerpts to your
            configured AI provider. Each Dok can take 30s–2min depending on the model.
          </p>
          {error && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-md border border-danger bg-danger-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-danger"
            >
              <XCircle size={14} aria-hidden className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                <strong className="font-semibold">Generation needs attention.</strong>{' '}
                {error}
              </span>
            </div>
          )}
        </header>

        <ul
          aria-live="polite"
          className="m-0 min-h-0 list-none overflow-y-auto overscroll-contain border-y border-border p-0"
        >
          {orderedRows.map((row) => (
            <li
              key={row.key}
              className="flex min-w-0 items-start gap-3 px-5 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="break-words text-[13px] font-medium text-ink [overflow-wrap:anywhere]">
                    {row.title}
                  </span>
                  <span className="break-words font-mono text-[10.5px] text-ink-faint [overflow-wrap:anywhere]">
                    {row.detail}
                  </span>
                </div>
                {row.message && (
                  <p
                    className={[
                      'mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed [overflow-wrap:anywhere]',
                      row.state === 'error' ? 'text-danger' : 'text-ink-muted',
                    ].join(' ')}
                  >
                    {row.message}
                  </p>
                )}
              </div>
              <ProgressStatus state={row.state} label={row.statusLabel} />
            </li>
          ))}
        </ul>

        <footer className="flex flex-wrap justify-end gap-2 px-5 py-4">
          {!done && !running && (
            <button
              type="button"
              onClick={() => void startGeneration()}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              {error ? 'Retry generation' : 'Start generation'}
            </button>
          )}
          {running && (
            <span role="status" className="self-center text-[12px] text-ink-muted">
              Generation running…
            </span>
          )}
          {done && (
            <a
              href="/doks"
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Open Hub
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            Close
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function ProgressStatus({ state, label }: { state: RowState; label: string }) {
  const icon =
    state === 'running' ? (
      <Loader2 size={13} aria-hidden className="motion-safe:animate-spin" />
    ) : state === 'success' ? (
      <CheckCircle2 size={13} aria-hidden />
    ) : state === 'skipped' ? (
      <CircleMinus size={13} aria-hidden />
    ) : state === 'error' ? (
      <XCircle size={13} aria-hidden />
    ) : (
      <Clock3 size={13} aria-hidden />
    );
  const tone =
    state === 'success'
      ? 'text-status-active-fg'
      : state === 'error'
        ? 'text-danger'
        : 'text-ink-muted';

  return (
    <span
      aria-label={`Status: ${label}`}
      className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${tone}`}
    >
      {icon}
      <span>{label}</span>
    </span>
  );
}
