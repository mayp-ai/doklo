'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Terminal, Sparkles } from 'lucide-react';
import type { ConsolidatedFeatureConfig } from '../../lib/consolidation';
import { countDoks } from '../../lib/consolidation-edit';
import { saveConsolidatedAction } from '../../lib/actions';
import { GENERATE_PANEL_DIALOG_ID, GeneratePanel } from './generate-panel';
import { ConfirmationDialog } from '../confirmation-dialog';
import {
  useStudio,
  type PendingSaveRegistration,
} from '../studio-store';

const SAVE_GENERATE_CONFIRMATION_ID = 'save-generate-confirmation-dialog';

export function SaveBar({
  service, config, dirty, editVersion, initialRevision, path, onSaved,
}: {
  service: string;
  config: ConsolidatedFeatureConfig;
  dirty: boolean;
  editVersion: number;
  initialRevision: string;
  path: string;
  onSaved: (savedVersion: number) => boolean;
}) {
  const { registerPendingSave, unregisterPendingSave } = useStudio();
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'newer' | 'error'>('idle');
  const [error, setError] = useState('');
  const [affectedPath, setAffectedPath] = useState(path);
  const revisionRef = useRef(initialRevision);
  const [generating, setGenerating] = useState(false);
  const [generateTrigger, setGenerateTrigger] = useState<HTMLButtonElement | null>(null);
  const saveRegionRef = useRef<HTMLElement>(null);
  const configRef = useRef(config);
  const editVersionRef = useRef(editVersion);
  const onSavedRef = useRef(onSaved);
  const inFlightRef = useRef<Promise<'current' | 'stale' | 'failed'> | null>(null);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const registrationRef = useRef<PendingSaveRegistration | null>(null);
  configRef.current = config;
  editVersionRef.current = editVersion;
  onSavedRef.current = onSaved;
  const dokCount = countDoks(config);

  const persist = useCallback((): Promise<'current' | 'stale' | 'failed'> => {
    if (inFlightRef.current) return inFlightRef.current;
    const savedConfig = configRef.current;
    const savedVersion = editVersionRef.current;
    const expectedRevision = revisionRef.current;
    const pending = (async () => {
      setState('saving');
      let res: Awaited<ReturnType<typeof saveConsolidatedAction>>;
      try {
        res = await saveConsolidatedAction({
          serviceId: service,
          config: savedConfig,
          expectedRevision,
        });
      } catch (cause) {
        setAffectedPath(path);
        setState('error');
        setError(cause instanceof Error ? cause.message : String(cause));
        return 'failed' as const;
      }
      setAffectedPath(res.path);
      if (res.ok) {
        revisionRef.current = res.revision;
        setError('');
        const ownsCurrentEdits = onSavedRef.current(savedVersion);
        setState(ownsCurrentEdits ? 'saved' : 'newer');
        return ownsCurrentEdits ? 'current' as const : 'stale' as const;
      }
      setState('error');
      setError(res.error);
      return 'failed' as const;
    })();
    inFlightRef.current = pending;
    void pending.finally(() => {
      if (inFlightRef.current === pending) inFlightRef.current = null;
    });
    return pending;
  }, [path, service]);

  const flushCurrent = useCallback(async (): Promise<boolean> => {
    while (true) {
      const result = await persist();
      if (result === 'failed') return false;
      if (result === 'current') return true;
    }
  }, [persist]);
  flushRef.current = flushCurrent;

  if (!registrationRef.current) {
    registrationRef.current = {
      path: affectedPath,
      flush: () => flushRef.current(),
    };
  }
  registrationRef.current.path = affectedPath;
  const needsSaveGuard = dirty || state === 'saving' || state === 'newer' || state === 'error';

  useEffect(() => {
    const registration = registrationRef.current;
    if (!needsSaveGuard || !registration) return;
    registerPendingSave(registration);
    return () => unregisterPendingSave(registration);
  }, [needsSaveGuard, registerPendingSave, unregisterPendingSave]);

  async function saveThenGenerate() {
    if (await persist() === 'current') setGenerating(true);
  }

  // Show the "saved" confirmation only while the on-disk cache still matches
  // the board (i.e. not dirty) — editing after a save flips dirty and the
  // confirmation must yield to the "unsaved changes" notice.
  const showSaved = state === 'saved' && !dirty;

  return (
    <section
      ref={saveRegionRef}
      tabIndex={-1}
      aria-label="Consolidation save actions"
      className="border-t border-border bg-canvas px-8 py-3"
    >
      <div className="flex items-center gap-3">
        <button type="button" onClick={persist} disabled={state === 'saving'}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">
          <Save size={14} aria-hidden /> {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={(event) => setGenerateTrigger(event.currentTarget)} disabled={state === 'saving' || dokCount === 0}
          aria-controls={generateTrigger ? SAVE_GENERATE_CONFIRMATION_ID : GENERATE_PANEL_DIALOG_ID}
          aria-haspopup="dialog" aria-expanded={generateTrigger !== null || generating}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent px-3 py-1.5 text-[13px] text-accent-ink disabled:opacity-50">
          <Sparkles size={14} aria-hidden /> Save &amp; generate → ({dokCount})
        </button>
        {state === 'error' && (
          <span role="alert" className="inline-flex items-center gap-2 text-[12.5px] text-status-draft-fg">
            <span className="break-all">Save failed · {affectedPath}: {error}</span>
            <button
              type="button"
              onClick={() => void persist()}
              className="rounded border border-current px-2 py-0.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Retry
            </button>
          </span>
        )}
        {dirty && state !== 'saving' && <span className="text-[12.5px] text-ink-faint">Unsaved changes</span>}
      </div>
      {state === 'newer' && (
        <p role="status" className="mt-2 text-[12.5px] text-status-draft-fg">
          Saved snapshot · <code className="break-all">{affectedPath}</code> · newer edits remain unsaved. Save again before generation.
        </p>
      )}
      {showSaved && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-ink-muted">
          <Terminal size={13} aria-hidden /> Saved · <code className="break-all">{affectedPath}</code> · click <b className="mx-1">Save &amp; generate</b> in the browser, or run <code className="mx-1">doklo generate</code> in the terminal.
        </p>
      )}
      {generateTrigger && (
        <ConfirmationDialog
          id={SAVE_GENERATE_CONFIRMATION_ID}
          title="Save this plan and generate Hub layers?"
          description="This saves the reviewed consolidation plan, then starts generation for the selected service. Generation changes persisted Hub files."
          confirmLabel="Save & generate"
          returnFocus={generateTrigger}
          fallbackFocus={saveRegionRef.current}
          onCancel={() => setGenerateTrigger(null)}
          onConfirm={() => {
            setGenerateTrigger(null);
            void saveThenGenerate();
          }}
        />
      )}
      {generating && <GeneratePanel service={service} onClose={() => setGenerating(false)} />}
    </section>
  );
}
