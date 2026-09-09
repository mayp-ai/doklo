'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  useStudio,
  type PendingSaveRegistration,
} from '../../components/studio-store';
import type { SaveResult } from '../persistence';

export function usePersistentAction<Request>(input: {
  key: string;
  path: string;
  persist: (request: Request) => Promise<SaveResult>;
  onSuccess?: (request: Request, result: Extract<SaveResult, { ok: true }>) => void;
}): {
  execute: (request: Request) => Promise<boolean>;
} {
  const { key, path, persist, onSuccess } = input;
  const {
    claimPendingSave,
    replacePendingSave,
    setSaveStatus,
    unregisterPendingSave,
  } = useStudio();
  const requestRef = useRef<Request | null>(null);
  const persistRef = useRef(persist);
  const onSuccessRef = useRef(onSuccess);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const registrationRef = useRef<PendingSaveRegistration | null>(null);
  const generationRef = useRef(0);
  const performRef = useRef<() => Promise<boolean>>(async () => true);
  persistRef.current = persist;
  onSuccessRef.current = onSuccess;

  const createRegistration = useCallback((affectedPath: string) => {
    return {
      path: affectedPath,
      flush: () => performRef.current(),
    } satisfies PendingSaveRegistration;
  }, []);

  const replaceRegistrationPath = useCallback((affectedPath: string) => {
    const current = registrationRef.current;
    if (!current || current.path === affectedPath) return;
    const registration: PendingSaveRegistration = {
      path: affectedPath,
      flush: () => performRef.current(),
    };
    if (replacePendingSave(current, registration)) {
      registrationRef.current = registration;
    }
  }, [replacePendingSave]);

  const unregister = useCallback(() => {
    const registration = registrationRef.current;
    if (!registration) return;
    unregisterPendingSave(registration);
    if (registrationRef.current === registration) registrationRef.current = null;
  }, [unregisterPendingSave]);

  const perform = useCallback((): Promise<boolean> => {
    if (inFlightRef.current) return inFlightRef.current;
    const request = requestRef.current;
    if (request === null) return Promise.resolve(true);
    const generation = generationRef.current;
    setSaveStatus({ kind: 'saving', path });

    const operation = (async () => {
      let result: SaveResult;
      try {
        result = await persistRef.current(request);
      } catch (error) {
        if (generationRef.current !== generation) return false;
        const message = error instanceof Error ? error.message : String(error);
        setSaveStatus({
          kind: 'error',
          path,
          message,
          retry: () => performRef.current(),
        });
        return false;
      }

      if (generationRef.current !== generation) return result.ok;
      if (!result.ok) {
        setSaveStatus({
          kind: result.code === 'CONFLICT' ? 'conflict' : 'error',
          path: result.path,
          message: result.error,
          retry: () => performRef.current(),
        });
        replaceRegistrationPath(result.path);
        return false;
      }

      requestRef.current = null;
      setSaveStatus({ kind: 'saved', path: result.path });
      unregister();
      onSuccessRef.current?.(request, result);
      return true;
    })();

    inFlightRef.current = operation;
    void operation.then(
      () => {
        if (inFlightRef.current === operation) inFlightRef.current = null;
      },
      () => {
        if (inFlightRef.current === operation) inFlightRef.current = null;
      },
    );
    return operation;
  }, [path, replaceRegistrationPath, setSaveStatus, unregister]);
  performRef.current = perform;

  const execute = useCallback(async (request: Request) => {
    if (inFlightRef.current || requestRef.current !== null) return Promise.resolve(false);
    requestRef.current = request;
    const generation = generationRef.current;
    const registration = createRegistration(path);
    registrationRef.current = registration;
    const claimed = await claimPendingSave(registration);
    if (!claimed || generationRef.current !== generation) {
      unregisterPendingSave(registration);
      if (registrationRef.current === registration) registrationRef.current = null;
      if (generationRef.current === generation) requestRef.current = null;
      return false;
    }
    return performRef.current();
  }, [claimPendingSave, createRegistration, path, unregisterPendingSave]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    requestRef.current = null;
    inFlightRef.current = null;
    unregister();
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      unregister();
    };
  }, [key, unregister]);

  return { execute };
}
