'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { WizardScanResult, WizardWorkspaceState } from '../../lib/wizard-actions';
import type { DocLocale } from '../../lib/livedoc-templates';

export type WizardStep = 'welcome' | 'extract' | 'hub' | 'livedocs';
export const STEP_ORDER: WizardStep[] = ['welcome', 'extract', 'hub', 'livedocs'];

export interface DokCard {
  dok_id: string;
  name: string;
  status: string;
  anchorFiles?: string[];
}

export type GenerationRunState = 'ready' | 'running' | 'no-candidates' | 'partial' | 'failed' | 'complete' | 'up-to-date';
export type PipelineStage = 'scan' | 'consolidate' | 'roles' | 'lexicon' | 'doks' | 'ia' | 'code-mapping';
export type PipelineStatus = 'waiting' | 'running' | 'complete' | 'skipped' | 'failed';

export interface PipelineRow {
  stage: PipelineStage;
  status: PipelineStatus;
  detail: string;
}

export interface GenerationCounters {
  succeeded: number;
  failed: number;
  layerFailed: number;
}

interface OnboardingState {
  step: WizardStep;
  goTo: (step: WizardStep) => void;
  locale: DocLocale;
  setLocale: (locale: DocLocale) => void;
  workspace: WizardWorkspaceState;
  serviceId: string | null;
  setServiceId: (serviceId: string) => void;
  scanResult: WizardScanResult | null;
  setScanResult: (result: WizardScanResult | null) => void;
  revealedDoks: DokCard[];
  setRevealedDoks: (doks: DokCard[]) => void;
  pushRevealedDok: (dok: DokCard) => void;
  generateTotal: number | null;
  setGenerateTotal: (total: number | null) => void;
  runState: GenerationRunState;
  setRunState: (state: GenerationRunState) => void;
  pipelineRows: PipelineRow[];
  setPipelineRows: (rows: PipelineRow[]) => void;
  updatePipelineRow: (row: PipelineRow) => void;
  counters: GenerationCounters | null;
  setCounters: (counters: GenerationCounters | null) => void;
  error: string | null;
  setError: (error: string | null) => void;
}

const OnboardingContext = createContext<OnboardingState | null>(null);

export function OnboardingProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState: WizardWorkspaceState;
}) {
  const [step, setStep] = useState<WizardStep>('welcome');
  const [locale, setLocaleState] = useState<DocLocale>('en');
  const [serviceId, setServiceIdState] = useState<string | null>(
    () => initialState.services[0]?.serviceId ?? null,
  );
  const [scanResult, setScanResultState] = useState<WizardScanResult | null>(null);
  const [revealedDoks, setRevealedDoksState] = useState<DokCard[]>(() => initialState.doks);
  const [generateTotal, setGenerateTotalState] = useState<number | null>(() => {
    const generation = initialState.generation;
    if (generation.status === 'none' || generation.status === 'unavailable') return null;
    if (generation.status === 'partial' || generation.status === 'failed') {
      const targetIds = generation.summary?.dokTargetIds;
      if (targetIds) {
        const knownIds = new Set(initialState.doks.map((dok) => dok.dok_id));
        for (const dokId of targetIds) knownIds.add(dokId);
        return Math.max(initialState.existingDoks, knownIds.size);
      }
      return Math.max(initialState.existingDoks, generation.summary?.dokTargets ?? 0);
    }
    return initialState.existingDoks;
  });
  const [runState, setRunStateState] = useState<GenerationRunState>(() => {
    if (initialState.generation.status === 'no-candidates') return 'no-candidates';
    if (initialState.generation.status === 'complete') return 'complete';
    if (initialState.generation.status === 'partial') return 'partial';
    if (initialState.generation.status === 'failed') return 'failed';
    return 'ready';
  });
  const [pipelineRows, setPipelineRowsState] = useState<PipelineRow[]>([]);
  const [counters, setCountersState] = useState<GenerationCounters | null>(null);
  const [error, setErrorState] = useState<string | null>(null);

  const goTo = useCallback((next: WizardStep) => setStep(next), []);
  const setLocale = useCallback((next: DocLocale) => setLocaleState(next), []);
  const setServiceId = useCallback((next: string) => setServiceIdState(next), []);
  const setScanResult = useCallback((result: WizardScanResult | null) => setScanResultState(result), []);
  const setRevealedDoks = useCallback((doks: DokCard[]) => setRevealedDoksState(doks), []);
  const pushRevealedDok = useCallback((dok: DokCard) => {
    setRevealedDoksState((current) =>
      current.some((item) => item.dok_id === dok.dok_id) ? current : [...current, dok],
    );
  }, []);
  const setGenerateTotal = useCallback((total: number | null) => setGenerateTotalState(total), []);
  const setRunState = useCallback((next: GenerationRunState) => setRunStateState(next), []);
  const setPipelineRows = useCallback((rows: PipelineRow[]) => setPipelineRowsState(rows), []);
  const updatePipelineRow = useCallback((row: PipelineRow) => {
    setPipelineRowsState((current) => {
      const index = current.findIndex((item) => item.stage === row.stage);
      if (index === -1) return [...current, row];
      const next = [...current];
      next[index] = row;
      return next;
    });
  }, []);
  const setCounters = useCallback((next: GenerationCounters | null) => setCountersState(next), []);
  const setError = useCallback((next: string | null) => setErrorState(next), []);

  const value = useMemo<OnboardingState>(
    () => ({
      step,
      goTo,
      locale,
      setLocale,
      workspace: initialState,
      serviceId,
      setServiceId,
      scanResult,
      setScanResult,
      revealedDoks,
      setRevealedDoks,
      pushRevealedDok,
      generateTotal,
      setGenerateTotal,
      runState,
      setRunState,
      pipelineRows,
      setPipelineRows,
      updatePipelineRow,
      counters,
      setCounters,
      error,
      setError,
    }),
    [
      step, goTo, locale, setLocale, initialState, serviceId, setServiceId, scanResult,
      setScanResult, revealedDoks, setRevealedDoks, pushRevealedDok, generateTotal,
      setGenerateTotal, runState, setRunState, pipelineRows, setPipelineRows,
      updatePipelineRow, counters, setCounters, error, setError,
    ],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingState {
  const context = useContext(OnboardingContext);
  if (!context) throw new Error('useOnboarding() must be used inside <OnboardingProvider>');
  return context;
}
