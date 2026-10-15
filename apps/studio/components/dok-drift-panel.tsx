'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import {
  confirmDokStillAccurateAction,
  readDokDriftAction,
  type ConfirmDokStillAccurateResult,
} from '../lib/actions';
import type { DokDriftView, DokJudgeVerdict } from '../lib/dok-drift';
import { dokDriftCopy, type DokDriftCopy } from '../lib/dok-drift-copy';

type DriftNotice = {
  dokId: string;
  tone: 'success' | 'error';
  message: string;
  reload: boolean;
};

/**
 * The editor's source-drift panel (judge-gated sync design §4.6, §4.7). Shown
 * only while the Dok is stale: why, the sync judge's unconfirmed verdict and
 * its evidence when one still holds, and the one "Still accurate" button that
 * re-stamps the drift baseline. Regeneration stays `doklo sync`. A fresh Dok —
 * or a drift read that fails — renders nothing: the panel only ever adds
 * information to the editor.
 */
export function DokDriftPanel({
  dokId,
  revision,
  locale,
  editsPending,
}: {
  dokId: string;
  /** The loaded revision the editor holds — the confirmation's exact-revision check. */
  revision: string;
  locale: string;
  /** Unsaved or in-flight edits: confirming would reload the Dok under them. */
  editsPending: boolean;
}) {
  const router = useRouter();
  const copy = dokDriftCopy(locale);
  const hintId = useId();
  const readKey = `${dokId}\0${revision}`;
  const [view, setView] = useState<{ key: string; value: DokDriftView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DriftNotice | null>(null);

  useEffect(() => {
    if (!dokId) return;
    let live = true;
    void (async () => {
      let result: Awaited<ReturnType<typeof readDokDriftAction>>;
      try {
        result = await readDokDriftAction({ dokId });
      } catch {
        return;
      }
      if (live && result.ok) setView({ key: readKey, value: result });
    })();
    return () => {
      live = false;
    };
  }, [dokId, readKey]);

  const current = view?.key === readKey ? view.value : null;
  const ownNotice = notice?.dokId === dokId ? notice : null;

  const confirm = useCallback(async () => {
    if (busy || current === null || current.blocked !== null || editsPending || !revision) return;
    setBusy(true);
    setNotice(null);
    let result: ConfirmDokStillAccurateResult;
    try {
      result = await confirmDokStillAccurateAction({ dokId, expectedRevision: revision });
    } catch (error) {
      setNotice({
        dokId,
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
        reload: true,
      });
      setBusy(false);
      return;
    }
    if (result.ok) {
      setView({
        key: readKey,
        value: { ...current, drift: result.drift, verdict: null, blocked: null },
      });
      setNotice({ dokId, tone: 'success', message: copy.confirmed, reload: false });
      // The Dok file has a new revision: reload the catalog so the next save
      // checks against it. The confirm is disabled while edits are pending,
      // so nothing unsaved rides on this reload.
      router.refresh();
    } else {
      if (result.drift !== undefined && !result.drift.stale) {
        setView({
          key: readKey,
          value: { ...current, drift: result.drift, verdict: null, blocked: null },
        });
      }
      setNotice({
        dokId,
        tone: 'error',
        message: copy.failure(result.code, result.error),
        reload: result.code === 'CONFLICT',
      });
    }
    setBusy(false);
  }, [busy, copy, current, dokId, editsPending, readKey, revision, router]);

  if (current === null || !current.drift.stale) {
    return ownNotice ? (
      <DriftNoticeLine
        notice={ownNotice}
        copy={copy}
        standalone
        onReload={() => router.refresh()}
      />
    ) : null;
  }

  const blocked = current.blocked;
  const disabled = busy || blocked !== null || editsPending || !revision;
  return (
    <section
      aria-label={copy.panelLabel}
      data-testid="dok-drift-panel"
      className="mb-5 rounded-md border border-border bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-ink"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={16}
          aria-hidden
          className="mt-0.5 shrink-0 text-status-draft-fg"
        />
        <p className="min-w-0 flex-1">
          <strong className="font-semibold text-status-draft-fg">{copy.staleLabel}</strong>
          {' — '}
          {copy.title}
        </p>
        <button
          type="button"
          disabled={disabled}
          aria-describedby={hintId}
          onClick={() => void confirm()}
          className={[
            'inline-flex min-w-[7.5rem] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
            disabled
              ? 'cursor-not-allowed border border-border bg-surface-2 text-ink-faint'
              : 'bg-ink-strong text-canvas hover:bg-ink',
          ].join(' ')}
        >
          {busy ? (
            <>
              <Loader2 size={13} aria-hidden className="motion-safe:animate-spin" />
              {copy.confirming}
            </>
          ) : (
            copy.confirm
          )}
        </button>
      </div>
      {/* Details take the panel's full width, under the title (icon 16px + gap 12px). */}
      <div className="mt-1 sm:pl-7">
        <p className="text-[12.5px] text-ink-secondary">
          {copy.reason(current.drift.reason)} {copy.syncHint}
        </p>
        {current.verdict ? <JudgeVerdict verdict={current.verdict} copy={copy} /> : null}
        <p id={hintId} className="mt-2 text-[12px] text-ink-muted">
          {blocked !== null
            ? copy.blocked(blocked)
            : editsPending
              ? copy.pendingEdits
              : copy.confirmHint}
        </p>
      </div>
      {ownNotice ? (
        <DriftNoticeLine
          notice={ownNotice}
          copy={copy}
          standalone={false}
          onReload={() => router.refresh()}
        />
      ) : null}
    </section>
  );
}

function JudgeVerdict({ verdict, copy }: { verdict: DokJudgeVerdict; copy: DokDriftCopy }) {
  const summary = verdict.summary.trim();
  return (
    <div
      data-testid="dok-drift-verdict"
      className="mt-2.5 rounded border border-border bg-surface-2 px-3 py-2"
    >
      <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
        <span className="font-semibold text-ink">{copy.verdictTitle}</span>
        <span className="font-mono text-[11px] text-ink-muted">{copy.verdictModel(verdict.model)}</span>
      </p>
      {summary ? <p className="mt-1 text-[12.5px] text-ink">{summary}</p> : null}
      <p className="mt-1 text-[11.5px] text-ink-muted">{copy.verdictUnconfirmed}</p>
      {verdict.checked.length > 0 ? (
        <div className="mt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            {copy.evidenceTitle}
          </p>
          <ul className="mt-1 space-y-1">
            {verdict.checked.map((item, index) => (
              <li
                key={`${item.claimPath}-${index}`}
                className="text-[12px] leading-relaxed text-ink-secondary [overflow-wrap:anywhere]"
              >
                <code className="font-mono text-[11px] text-ink">{item.claimPath}</code>
                {item.files.length > 0 ? (
                  <>
                    {' — '}
                    {item.files.map((file, fileIndex) => (
                      <span key={`${file}-${fileIndex}`}>
                        {fileIndex > 0 ? ', ' : null}
                        <code className="font-mono text-[11px]">{file}</code>
                      </span>
                    ))}
                  </>
                ) : null}
                {item.reason ? (
                  <span className="block text-[11.5px] text-ink-muted">{item.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DriftNoticeLine({
  notice,
  copy,
  standalone,
  onReload,
}: {
  notice: DriftNotice;
  copy: DokDriftCopy;
  /** Shown in place of the panel (after a confirmation) rather than inside it. */
  standalone: boolean;
  onReload: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        standalone ? 'mb-5' : 'mt-2.5',
        'flex items-center gap-2 rounded-md px-3 py-2 text-[12.5px]',
        notice.tone === 'success'
          ? 'bg-status-active-bg text-status-active-fg'
          : 'bg-status-deprecated-bg text-status-deprecated-fg',
      ].join(' ')}
    >
      {notice.tone === 'success' ? (
        <CheckCircle2 size={15} aria-hidden className="shrink-0" />
      ) : (
        <AlertTriangle size={15} aria-hidden className="shrink-0" />
      )}
      <span>{notice.message}</span>
      {notice.reload ? (
        <button
          type="button"
          onClick={onReload}
          className="ml-auto rounded-md border border-current/30 px-2.5 py-1 font-semibold hover:bg-canvas/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {copy.reload}
        </button>
      ) : null}
    </div>
  );
}
