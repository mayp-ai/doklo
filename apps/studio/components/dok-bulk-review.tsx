'use client';

import {
  useCallback,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { Dok } from '@doklo-beta/core';
import {
  bulkActivateDoksAction,
  type BulkActivateDoksInput,
  type BulkActivateDoksResult,
} from '../lib/actions';
import {
  dokBulkReviewCopy,
  type DokBulkReviewCopy,
} from '../lib/dok-bulk-review-copy';
import { ConfirmationDialog } from './confirmation-dialog';

const MAX_BULK_REVIEW_TARGETS = 500;

type BulkReviewNotice = {
  tone: 'success' | 'error';
  message: string;
  reload: boolean;
};

type ReviewTarget = BulkActivateDoksInput['targets'][number];

type AllDraftDialogState = {
  opener: HTMLElement;
  targets: ReviewTarget[];
  acknowledged: boolean;
};

export type DokBulkReviewController = {
  reviewMode: boolean;
  selectedIds: ReadonlySet<string>;
  busy: boolean;
  notice: BulkReviewNotice | null;
  copy: DokBulkReviewCopy;
  warningId: string;
  draftCount: number;
  allDraftsLimited: boolean;
  allDraftDialog: AllDraftDialogState | null;
  enterReviewMode: () => void;
  cancelReviewMode: () => void;
  clearForFilterChange: () => void;
  toggleDok: (dokId: string) => void;
  allSelected: boolean;
  someSelected: boolean;
  toggleSelectAll: () => void;
  activateSelected: (opener?: HTMLElement) => Promise<void>;
  openActivateAll: (opener: HTMLElement) => void;
  closeActivateAll: () => void;
  setAllDraftAcknowledged: (acknowledged: boolean) => void;
  activateAll: () => Promise<void>;
  reload: () => void;
};

export function useDokBulkReviewController(input: {
  doks: Dok[];
  revisions: Record<string, string>;
  locale: string;
  onReviewModeChange?: (reviewMode: boolean) => void;
}): DokBulkReviewController {
  const router = useRouter();
  const warningId = useId();
  const copy = dokBulkReviewCopy(input.locale);
  const [reviewMode, setReviewMode] = useState(false);
  const [selectedState, setSelectedState] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<BulkReviewNotice | null>(null);
  const [allDraftDialog, setAllDraftDialog] =
    useState<AllDraftDialogState | null>(null);

  const draftTargets = useMemo(
    () => input.doks.flatMap((dok): ReviewTarget[] => {
      const revision = input.revisions[dok.dok_id];
      return dok.status === 'draft' && revision !== undefined
        ? [{ dokId: dok.dok_id, expectedRevision: revision }]
        : [];
    }),
    [input.doks, input.revisions],
  );
  const draftIds = useMemo(
    () => new Set(draftTargets.map((target) => target.dokId)),
    [draftTargets],
  );
  const selectedIds = useMemo(
    () => new Set([...selectedState].filter((dokId) => draftIds.has(dokId))),
    [draftIds, selectedState],
  );

  const enterReviewMode = useCallback(() => {
    setNotice(null);
    setReviewMode(true);
    input.onReviewModeChange?.(true);
  }, [input.onReviewModeChange]);

  const cancelReviewMode = useCallback(() => {
    setReviewMode(false);
    setSelectedState(new Set());
    setAllDraftDialog(null);
    input.onReviewModeChange?.(false);
  }, [input.onReviewModeChange]);

  const clearForFilterChange = useCallback(() => {
    setSelectedState(new Set());
    setAllDraftDialog(null);
  }, []);

  const toggleDok = useCallback((dokId: string) => {
    if (!draftIds.has(dokId) || busy) return;
    setSelectedState((current) => {
      const next = new Set(current);
      if (next.has(dokId)) next.delete(dokId);
      else next.add(dokId);
      return next;
    });
  }, [busy, draftIds]);

  const runActivation = useCallback(async (
    mode: BulkActivateDoksInput['mode'],
    targets: ReviewTarget[],
  ) => {
    if (busy || targets.length === 0) return;
    setBusy(true);
    setNotice(null);
    let result: BulkActivateDoksResult;
    try {
      result = await bulkActivateDoksAction({ mode, targets });
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
      setSelectedState(new Set());
      setReviewMode(false);
      setAllDraftDialog(null);
      input.onReviewModeChange?.(false);
      setNotice({
        tone: 'success',
        message: copy.success(result.activated.length),
        reload: false,
      });
      router.refresh();
      setBusy(false);
      return;
    }

    if (result.code === 'PARTIAL_FAILURE') {
      setSelectedState(new Set(result.failures.map((failure) => failure.dokId)));
      setAllDraftDialog(null);
      setNotice({
        tone: 'error',
        message: copy.partialFailure(result.activated.length, result.failures.length),
        reload: false,
      });
      router.refresh();
      setBusy(false);
      return;
    }

    setNotice({
      tone: 'error',
      message: copy.preflightFailure,
      reload: true,
    });
    setAllDraftDialog(null);
    setBusy(false);
  }, [busy, copy, input.onReviewModeChange, router]);

  const allSelected =
    draftTargets.length > 0 && selectedIds.size === draftTargets.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleSelectAll = useCallback(() => {
    setSelectedState((current) =>
      draftTargets.length > 0 && current.size >= draftTargets.length
        ? new Set()
        : new Set(draftTargets.map((target) => target.dokId)),
    );
  }, [draftTargets]);


  const openActivateAll = useCallback((opener: HTMLElement) => {
    if (
      busy ||
      draftTargets.length === 0 ||
      draftTargets.length > MAX_BULK_REVIEW_TARGETS
    ) return;
    setAllDraftDialog({
      opener,
      targets: draftTargets.map((target) => ({ ...target })),
      acknowledged: false,
    });
  }, [busy, draftTargets]);

  // Activating every draft weighs the same whether the user got there via
  // "activate all" or by selecting all of them, so both paths go through one
  // acknowledgement rather than a second dialog with different wording.
  const activateSelected = useCallback(async (opener?: HTMLElement) => {
    const targets = draftTargets.filter((target) => selectedIds.has(target.dokId));
    if (targets.length > 0 && targets.length === draftTargets.length && opener) {
      openActivateAll(opener);
      return;
    }
    await runActivation('selected', targets);
  }, [draftTargets, openActivateAll, runActivation, selectedIds]);

  const closeActivateAll = useCallback(() => {
    setAllDraftDialog(null);
  }, []);

  const setAllDraftAcknowledged = useCallback((acknowledged: boolean) => {
    setAllDraftDialog((current) => current
      ? { ...current, acknowledged }
      : null);
  }, []);

  const activateAll = useCallback(async () => {
    const dialog = allDraftDialog;
    if (!dialog?.acknowledged) return;
    await runActivation('all_drafts', dialog.targets);
  }, [allDraftDialog, runActivation]);

  return {
    reviewMode,
    selectedIds,
    busy,
    notice,
    copy,
    warningId,
    draftCount: draftTargets.length,
    allDraftsLimited: draftTargets.length > MAX_BULK_REVIEW_TARGETS,
    allDraftDialog,
    enterReviewMode,
    cancelReviewMode,
    clearForFilterChange,
    toggleDok,
    allSelected,
    someSelected,
    toggleSelectAll,
    activateSelected,
    openActivateAll,
    closeActivateAll,
    setAllDraftAcknowledged,
    activateAll,
    reload: router.refresh,
  };
}

export function DokBulkReviewBar({
  controller,
  draftCount,
}: {
  controller: DokBulkReviewController;
  draftCount: number;
}): ReactNode {
  const selectedCount = controller.selectedIds.size;
  const dialog = controller.allDraftDialog;

  return (
    <>
      {controller.reviewMode ? (
        <section
          aria-labelledby={controller.warningId}
          className="border-b border-status-draft-fg/35 bg-status-draft-bg px-4 py-3.5 sm:px-8"
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
                {controller.copy.warning}
              </p>
            </div>
            <button
              type="button"
              disabled={controller.busy}
              onClick={controller.cancelReviewMode}
              className="inline-flex shrink-0 self-start whitespace-nowrap rounded-md border border-border bg-canvas px-3 py-1.5 text-[12px] font-medium text-ink-secondary hover:bg-surface disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {controller.copy.cancelReview}
            </button>
          </header>
          <div className="mt-3 flex flex-col gap-3 border-t border-status-draft-fg/20 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              role="group"
              aria-label={controller.copy.selectedActions}
              className="flex flex-wrap items-center gap-2.5"
            >
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-ink-secondary">
                <input
                  type="checkbox"
                  aria-label="Select all drafts"
                  checked={controller.allSelected}
                  ref={(node) => {
                    if (node) node.indeterminate = controller.someSelected;
                  }}
                  disabled={controller.busy || draftCount === 0}
                  onChange={controller.toggleSelectAll}
                  className="h-3.5 w-3.5 rounded border-border text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                <span>Select all</span>
              </label>
              <span className="shrink-0 rounded-full border border-status-draft-fg/25 bg-canvas/70 px-2.5 py-1 font-mono text-[11.5px] text-ink-secondary">
                {controller.copy.selected(selectedCount)}
              </span>
              <button
                type="button"
                disabled={selectedCount === 0 || controller.busy}
                onClick={(event) => void controller.activateSelected(event.currentTarget)}
                className="inline-flex min-w-[132px] shrink-0 items-center justify-center whitespace-nowrap rounded-md bg-ink-strong px-3 py-1.5 text-[12.5px] font-semibold text-canvas hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {controller.busy ? (
                  <Loader2 size={14} aria-label="Saving" className="motion-safe:animate-spin" />
                ) : (
                  controller.copy.activateSelected(selectedCount)
                )}
              </button>
            </div>
            <div
              role="group"
              aria-label={controller.copy.allDraftActions}
              className="flex sm:justify-end"
            >
              <button
                type="button"
                disabled={controller.busy || controller.allDraftsLimited}
                onClick={(event) => controller.openActivateAll(event.currentTarget)}
                className="inline-flex w-full shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-status-deprecated-fg/35 bg-canvas px-3 py-1.5 text-[12px] font-semibold text-status-deprecated-fg hover:bg-status-deprecated-bg disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-auto"
              >
                {controller.copy.activateAll(draftCount)}
              </button>
            </div>
          </div>
          {controller.allDraftsLimited ? (
            <p className="mt-2 text-[12px] text-status-deprecated-fg">
              {controller.copy.allLimit(draftCount)}
            </p>
          ) : null}
        </section>
      ) : draftCount > 0 ? (
        <div className="border-b border-border bg-canvas px-8 py-2.5">
          <button
            type="button"
            onClick={controller.enterReviewMode}
            className="inline-flex items-center rounded-full border border-status-draft-fg/35 bg-status-draft-bg px-3 py-1 text-[12.5px] font-medium text-status-draft-fg hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {controller.copy.entry}
          </button>
        </div>
      ) : null}

      {controller.notice ? (
        <div
          role="status"
          aria-live="polite"
          className={[
            'flex items-center gap-2 px-8 py-2.5 text-[12.5px]',
            controller.notice.tone === 'success'
              ? 'bg-status-active-bg text-status-active-fg'
              : 'bg-status-deprecated-bg text-status-deprecated-fg',
          ].join(' ')}
        >
          {controller.notice.tone === 'success' ? (
            <CheckCircle2 size={15} aria-hidden />
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
              {controller.copy.reload}
            </button>
          ) : null}
        </div>
      ) : null}

      {dialog ? (
        <ConfirmationDialog
          title={controller.copy.modalTitle(dialog.targets.length)}
          description={controller.copy.modalDescription(dialog.targets.length)}
          confirmLabel={controller.copy.confirmAll(dialog.targets.length)}
          cancelLabel={controller.copy.cancel}
          confirmDisabled={!dialog.acknowledged || controller.busy}
          returnFocus={dialog.opener}
          onCancel={controller.closeActivateAll}
          onConfirm={() => void controller.activateAll()}
        >
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-md border border-status-deprecated-fg/35 bg-status-deprecated-bg p-3 text-status-deprecated-fg"
          >
            <AlertTriangle size={18} aria-hidden className="mt-0.5 shrink-0" />
            <p className="text-[12.5px] leading-relaxed">
              {controller.copy.modalWarning}
            </p>
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px] font-medium text-ink-secondary">
            <input
              type="checkbox"
              aria-label={controller.copy.acknowledgment}
              checked={dialog.acknowledged}
              onChange={(event) => controller.setAllDraftAcknowledged(
                event.target.checked,
              )}
              className="mt-0.5 h-4 w-4 rounded border-border text-status-deprecated-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-deprecated-fg focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            />
            <span>{controller.copy.acknowledgment}</span>
          </label>
        </ConfirmationDialog>
      ) : null}
    </>
  );
}
