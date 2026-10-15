'use client';

import {
  useCallback,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import type { Dok } from '@doklo-beta/core';
import {
  bulkConfirmDoksStillAccurateAction,
  readDoksDriftAction,
  type BulkConfirmDoksInput,
  type BulkConfirmDoksResult,
} from '../lib/actions';
import type { DokDriftView } from '../lib/dok-drift';
import { dokDriftCopy, type DokDriftCopy } from '../lib/dok-drift-copy';

const MAX_BULK_CONFIRM_TARGETS = 500;

type DriftConfirmNotice = {
  tone: 'success' | 'error' | 'info';
  message: string;
  reload: boolean;
};

type ConfirmTarget = BulkConfirmDoksInput['targets'][number];

const NO_ENTRIES: ReadonlyMap<string, DokDriftView> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();

export type DokDriftConfirmController = {
  /** The list is in confirm mode: stale Doks are marked and selectable. */
  active: boolean;
  /** Reading every Dok's sources before the mode opens. */
  checking: boolean;
  busy: boolean;
  notice: DriftConfirmNotice | null;
  copy: DokDriftCopy;
  warningId: string;
  /** Stale Doks, by id, as the last read found them. */
  entries: ReadonlyMap<string, DokDriftView>;
  /** Stale Doks a confirmation can apply to (not blocked, revision known). */
  confirmableIds: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  allSelected: boolean;
  someSelected: boolean;
  overLimit: boolean;
  enter: () => Promise<void>;
  cancel: () => void;
  clearSelection: () => void;
  toggleDok: (dokId: string) => void;
  toggleSelectAll: () => void;
  confirmSelected: () => Promise<void>;
  reload: () => void;
};

/**
 * Bulk "Still accurate" on the Doks list. The same selection contract as the
 * bulk review (`useDokBulkReviewController`) — a selection set, select-all,
 * exact revisions from the loaded catalog, partial failures left selected,
 * reload guidance after a refused preflight — over a different set of rows:
 * the Doks whose tracked sources changed, whatever their status. Which Doks
 * those are takes a source read per Dok, so it is computed when a person opens
 * the mode, not on every page load.
 */
export function useDokDriftConfirmController(input: {
  doks: Dok[];
  revisions: Record<string, string>;
  locale: string;
  onModeChange?: (active: boolean) => void;
}): DokDriftConfirmController {
  const router = useRouter();
  const warningId = useId();
  const copy = dokDriftCopy(input.locale);
  const [active, setActive] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DriftConfirmNotice | null>(null);
  const [entries, setEntries] = useState<ReadonlyMap<string, DokDriftView>>(NO_ENTRIES);
  const [selectedState, setSelectedState] = useState<Set<string>>(() => new Set());

  // Catalog order, so the request (and any partial report) reads like the list.
  const confirmableTargets = useMemo(
    () => input.doks.flatMap((dok): ConfirmTarget[] => {
      const entry = entries.get(dok.dok_id);
      const revision = input.revisions[dok.dok_id];
      return entry !== undefined && entry.drift.stale && entry.blocked === null && revision !== undefined
        ? [{ dokId: dok.dok_id, expectedRevision: revision }]
        : [];
    }),
    [entries, input.doks, input.revisions],
  );
  const confirmableIds = useMemo(
    () => new Set(confirmableTargets.map((target) => target.dokId)),
    [confirmableTargets],
  );
  const selectedIds = useMemo(
    () => new Set([...selectedState].filter((dokId) => confirmableIds.has(dokId))),
    [confirmableIds, selectedState],
  );

  const leave = useCallback(() => {
    setActive(false);
    setSelectedState(new Set());
    input.onModeChange?.(false);
  }, [input.onModeChange]);

  const enter = useCallback(async () => {
    if (active || checking || busy) return;
    setNotice(null);
    setChecking(true);
    let result: Awaited<ReturnType<typeof readDoksDriftAction>>;
    try {
      result = await readDoksDriftAction();
    } catch {
      setNotice({ tone: 'error', message: copy.bulkReadFailure, reload: true });
      setChecking(false);
      return;
    }
    setChecking(false);
    if (!result.ok) {
      setNotice({ tone: 'error', message: copy.bulkReadFailure, reload: true });
      return;
    }
    if (result.stale.length === 0) {
      setEntries(NO_ENTRIES);
      setNotice({ tone: 'info', message: copy.bulkNone, reload: false });
      return;
    }
    setEntries(new Map(result.stale.map((entry) => [entry.dokId, entry])));
    setSelectedState(new Set());
    setActive(true);
    input.onModeChange?.(true);
  }, [active, busy, checking, copy, input.onModeChange]);

  const cancel = useCallback(() => {
    if (!active) return;
    leave();
  }, [active, leave]);

  const clearSelection = useCallback(() => {
    setSelectedState(new Set());
  }, []);

  const toggleDok = useCallback((dokId: string) => {
    if (!confirmableIds.has(dokId) || busy) return;
    setSelectedState((current) => {
      const next = new Set(current);
      if (next.has(dokId)) next.delete(dokId);
      else next.add(dokId);
      return next;
    });
  }, [busy, confirmableIds]);

  const allSelected =
    confirmableTargets.length > 0 && selectedIds.size === confirmableTargets.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const overLimit = selectedIds.size > MAX_BULK_CONFIRM_TARGETS;

  const toggleSelectAll = useCallback(() => {
    if (busy) return;
    setSelectedState((current) =>
      confirmableTargets.length > 0 && current.size >= confirmableTargets.length
        ? new Set()
        : new Set(confirmableTargets.map((target) => target.dokId)),
    );
  }, [busy, confirmableTargets]);

  const confirmSelected = useCallback(async () => {
    const targets = confirmableTargets.filter((target) => selectedIds.has(target.dokId));
    if (busy || targets.length === 0 || targets.length > MAX_BULK_CONFIRM_TARGETS) return;
    setBusy(true);
    setNotice(null);
    let result: BulkConfirmDoksResult;
    try {
      result = await bulkConfirmDoksStillAccurateAction({ targets });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
        reload: true,
      });
      setBusy(false);
      return;
    }

    if (result.ok) {
      leave();
      setEntries(NO_ENTRIES);
      setNotice({
        tone: 'success',
        message: copy.bulkSuccess(result.confirmed.length),
        reload: false,
      });
      router.refresh();
      setBusy(false);
      return;
    }

    if (result.code === 'PARTIAL_FAILURE') {
      // The confirmed Doks are fresh now: drop them so they cannot be picked
      // again against a revision that no longer exists.
      const confirmed = new Set(result.confirmed.map((item) => item.dokId));
      setEntries((current) => new Map(
        [...current].filter(([dokId]) => !confirmed.has(dokId)),
      ));
      setSelectedState(new Set(result.failures.map((failure) => failure.dokId)));
      setNotice({
        tone: 'error',
        message: copy.bulkPartialFailure(result.confirmed.length, result.failures.length),
        reload: false,
      });
      router.refresh();
      setBusy(false);
      return;
    }

    setNotice({ tone: 'error', message: copy.bulkPreflightFailure, reload: true });
    setBusy(false);
  }, [busy, confirmableTargets, copy, leave, router, selectedIds]);

  return {
    active,
    checking,
    busy,
    notice,
    copy,
    warningId,
    entries: active ? entries : NO_ENTRIES,
    confirmableIds: active ? confirmableIds : NO_IDS,
    selectedIds,
    allSelected,
    someSelected,
    overLimit,
    enter,
    cancel,
    clearSelection,
    toggleDok,
    toggleSelectAll,
    confirmSelected,
    reload: router.refresh,
  };
}

/** The button that opens confirm mode; it sits beside "Review Doks". */
export function DokDriftConfirmEntry({
  controller,
}: {
  controller: DokDriftConfirmController;
}): ReactNode {
  return (
    <button
      type="button"
      disabled={controller.checking || controller.busy}
      onClick={() => void controller.enter()}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas px-3 py-1 text-[12.5px] font-medium text-ink-secondary hover:bg-surface hover:text-ink disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {controller.checking ? (
        <>
          <Loader2 size={13} aria-hidden className="motion-safe:animate-spin" />
          {controller.copy.bulkChecking}
        </>
      ) : (
        controller.copy.bulkEntry
      )}
    </button>
  );
}

/** Confirm mode's bar — the warning line, selection and the confirm action — plus its notices. */
export function DokDriftConfirmBar({
  controller,
}: {
  controller: DokDriftConfirmController;
}): ReactNode {
  const selectedCount = controller.selectedIds.size;
  const copy = controller.copy;
  return (
    <>
      {controller.active ? (
        <section
          aria-labelledby={controller.warningId}
          data-testid="dok-drift-confirm-bar"
          className="border-b border-border bg-surface px-4 py-3.5 sm:px-8"
        >
          <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle
                size={16}
                aria-hidden
                className="mt-0.5 shrink-0 text-status-draft-fg"
              />
              <p
                id={controller.warningId}
                className="max-w-[840px] text-[12.5px] leading-relaxed text-ink-secondary"
              >
                {copy.bulkWarning}
              </p>
            </div>
            <button
              type="button"
              disabled={controller.busy}
              onClick={controller.cancel}
              className="inline-flex shrink-0 self-start whitespace-nowrap rounded-md border border-border bg-canvas px-3 py-1.5 text-[12px] font-medium text-ink-secondary hover:bg-surface-2 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {copy.bulkCancel}
            </button>
          </header>
          <div
            role="group"
            aria-label={copy.bulkSelectedActions}
            className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-border pt-3"
          >
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-ink-secondary">
              <input
                type="checkbox"
                aria-label={copy.bulkSelectAll}
                checked={controller.allSelected}
                ref={(node) => {
                  if (node) node.indeterminate = controller.someSelected;
                }}
                disabled={controller.busy || controller.confirmableIds.size === 0}
                onChange={controller.toggleSelectAll}
                className="h-3.5 w-3.5 rounded border-border text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              <span>{copy.bulkSelectAllLabel}</span>
            </label>
            <span className="shrink-0 rounded-full border border-border bg-canvas px-2.5 py-1 font-mono text-[11.5px] text-ink-secondary">
              {copy.bulkSelected(selectedCount)}
            </span>
            <button
              type="button"
              disabled={selectedCount === 0 || controller.busy || controller.overLimit}
              onClick={() => void controller.confirmSelected()}
              className="inline-flex min-w-[132px] shrink-0 items-center justify-center whitespace-nowrap rounded-md bg-ink-strong px-3 py-1.5 text-[12.5px] font-semibold text-canvas hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {controller.busy ? (
                <Loader2 size={14} aria-label="Saving" className="motion-safe:animate-spin" />
              ) : (
                copy.bulkConfirm(selectedCount)
              )}
            </button>
          </div>
          {controller.overLimit ? (
            <p className="mt-2 text-[12px] text-status-deprecated-fg">
              {copy.bulkLimit(selectedCount)}
            </p>
          ) : null}
        </section>
      ) : null}

      {controller.notice ? (
        <div
          role="status"
          aria-live="polite"
          className={[
            'flex items-center gap-2 px-8 py-2.5 text-[12.5px]',
            controller.notice.tone === 'success'
              ? 'bg-status-active-bg text-status-active-fg'
              : controller.notice.tone === 'info'
                ? 'bg-surface text-ink-secondary'
                : 'bg-status-deprecated-bg text-status-deprecated-fg',
          ].join(' ')}
        >
          {controller.notice.tone === 'success' ? (
            <CheckCircle2 size={15} aria-hidden />
          ) : controller.notice.tone === 'info' ? (
            <Info size={15} aria-hidden />
          ) : (
            <AlertTriangle size={15} aria-hidden />
          )}
          <span>{controller.notice.message}</span>
          {controller.notice.reload ? (
            <button
              type="button"
              onClick={controller.reload}
              className="ml-auto rounded-md border border-current/30 px-2.5 py-1 font-semibold hover:bg-canvas/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {copy.reload}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
