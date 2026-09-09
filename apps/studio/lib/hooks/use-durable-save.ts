'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  useStudio,
  type PendingSaveRegistration,
} from '../../components/studio-store';
import type { SaveResult } from '../persistence';

export function useDurableSave<P>(input: {
  key: string;
  path: string;
  initialRevision: string;
  delayMs?: number;
  mode?: 'auto' | 'manual';
  confirmDiscard?: (path: string) => boolean;
  merge: (current: P | null, next: P) => P;
  persist: (patch: P, expectedRevision: string) => Promise<SaveResult>;
}): {
  queue: (patch: P) => void;
  flush: () => Promise<boolean>;
  retry: () => Promise<boolean>;
} {
  const {
    key,
    path,
    initialRevision,
    delayMs = 800,
    mode = 'auto',
    confirmDiscard = (affectedPath) =>
      window.confirm(`Discard unsaved changes to ${affectedPath}?`),
    merge,
    persist,
  } = input;
  const {
    registerPendingSave,
    setSaveStatus,
    unregisterPendingSave,
  } = useStudio();
  const revisionRef = useRef(initialRevision);
  const patchRef = useRef<P | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const generationRef = useRef(0);
  const registrationRef = useRef<PendingSaveRegistration | null>(null);
  const mergeRef = useRef(merge);
  const persistRef = useRef(persist);
  const modeRef = useRef(mode);
  const confirmDiscardRef = useRef(confirmDiscard);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const discardRef = useRef<() => Promise<boolean>>(async () => false);
  mergeRef.current = merge;
  persistRef.current = persist;
  modeRef.current = mode;
  confirmDiscardRef.current = confirmDiscard;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const registerOwnedSave = useCallback((affectedPath: string) => {
    const registration: PendingSaveRegistration = {
      path: affectedPath,
      flush: () => modeRef.current === 'manual'
        ? discardRef.current()
        : flushRef.current(),
    };
    registrationRef.current = registration;
    registerPendingSave(registration);
  }, [registerPendingSave]);

  const unregisterOwnedSave = useCallback(() => {
    const registration = registrationRef.current;
    if (!registration) return;
    unregisterPendingSave(registration);
    if (registrationRef.current === registration) {
      registrationRef.current = null;
    }
  }, [unregisterPendingSave]);

  const flush = useCallback((): Promise<boolean> => {
    if (inFlightRef.current) return inFlightRef.current;
    const operationGeneration = generationRef.current;

    const pending = (async () => {
      clearTimer();
      while (patchRef.current !== null) {
        if (generationRef.current !== operationGeneration) return false;
        const patch = patchRef.current;
        patchRef.current = null;
        setSaveStatus({ kind: 'saving', path });

        let result: SaveResult;
        try {
          result = await persistRef.current(patch, revisionRef.current);
        } catch (error) {
          if (generationRef.current !== operationGeneration) return false;
          patchRef.current = patchRef.current === null
            ? patch
            : mergeRef.current(patch, patchRef.current);
          setSaveStatus({
            kind: 'error',
            path,
            message: error instanceof Error ? error.message : String(error),
            retry: () => flushRef.current(),
          });
          registerOwnedSave(path);
          return false;
        }

        if (generationRef.current !== operationGeneration) return result.ok;

        if (!result.ok) {
          patchRef.current = patchRef.current === null
            ? patch
            : mergeRef.current(patch, patchRef.current);
          setSaveStatus({
            kind: result.code === 'CONFLICT' ? 'conflict' : 'error',
            path: result.path,
            message: result.error,
            retry: () => flushRef.current(),
          });
          registerOwnedSave(result.path);
          return false;
        }

        revisionRef.current = result.revision;
        clearTimer();
        if (patchRef.current === null) {
          setSaveStatus({ kind: 'saved', path: result.path });
          unregisterOwnedSave();
          return true;
        }
      }

      if (generationRef.current !== operationGeneration) return false;
      unregisterOwnedSave();
      return true;
    })();

    inFlightRef.current = pending;
    void pending.then(
      () => {
        if (inFlightRef.current === pending) inFlightRef.current = null;
      },
      () => {
        if (inFlightRef.current === pending) inFlightRef.current = null;
      },
    );
    return pending;
  }, [
    clearTimer,
    path,
    registerOwnedSave,
    setSaveStatus,
    unregisterOwnedSave,
  ]);
  flushRef.current = flush;

  const discard = useCallback(async (): Promise<boolean> => {
    if (!confirmDiscardRef.current(path)) return false;
    clearTimer();
    patchRef.current = null;
    setSaveStatus({ kind: 'idle' });
    unregisterOwnedSave();
    return true;
  }, [clearTimer, path, setSaveStatus, unregisterOwnedSave]);
  discardRef.current = discard;

  const queue = useCallback((patch: P) => {
    patchRef.current = mergeRef.current(patchRef.current, patch);
    setSaveStatus({ kind: 'dirty', path });
    registerOwnedSave(path);
    clearTimer();
    if (modeRef.current === 'auto') {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flushRef.current();
      }, delayMs);
    }
  }, [clearTimer, delayMs, path, registerOwnedSave, setSaveStatus]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    revisionRef.current = initialRevision;
    patchRef.current = null;
    inFlightRef.current = null;
    clearTimer();
    unregisterOwnedSave();
    setSaveStatus({ kind: 'idle' });
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      clearTimer();
      unregisterOwnedSave();
    };
  }, [
    clearTimer,
    initialRevision,
    key,
    mode,
    setSaveStatus,
    unregisterOwnedSave,
  ]);

  return { queue, flush, retry: flush };
}
