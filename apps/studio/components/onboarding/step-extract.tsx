'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, FileText, Loader2 } from 'lucide-react';
import { createOnboardingStreamTruth, observeOnboardingEvent } from '../../lib/onboarding-stream-truth';
import { readJsonLines } from '../../lib/parse-json-lines';
import {
  acquireGenerationConsent,
  GenerationConsentError,
  startGenerationRequest,
} from '../../lib/generation-consent';
import {
  wizardGetDoks,
  wizardRunScan,
  type WizardScanFailureResult,
} from '../../lib/wizard-actions';
import { WIZARD_COPY } from '../../lib/wizard-copy';
import {
  useOnboarding,
  type DokCard,
  type PipelineRow,
  type PipelineStage,
  type PipelineStatus,
} from './onboarding-store';
import { Reveal, STAGGER } from './reveal';
import { SplitBody } from './wizard-frame';

const PIPELINE_STAGES: PipelineStage[] = [
  'scan', 'consolidate', 'roles', 'lexicon', 'doks', 'ia', 'code-mapping',
];

function stringValue(event: Record<string, unknown>, key: string): string | null {
  const value = event[key];
  return typeof value === 'string' ? value : null;
}

function numberValue(event: Record<string, unknown>, key: string): number | null {
  const value = event[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function terminalDiagnosticMessage(event: Record<string, unknown>, primary: string): string {
  const messages = [primary];
  const diagnostics = event['diagnostics'];
  if (!Array.isArray(diagnostics)) return primary;
  for (const diagnostic of diagnostics) {
    if (diagnostic === null || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) continue;
    const message = (diagnostic as Record<string, unknown>)['message'];
    if (typeof message !== 'string' || message.trim() === '') continue;
    const normalized = message.trim();
    if (messages.some((current) => current === normalized || current.startsWith(normalized))) continue;
    messages.push(normalized);
  }
  return messages.join(' · ');
}

function eventStatus(value: string | null): PipelineStatus {
  if (value === 'error') return 'failed';
  if (value === 'running') return 'running';
  if (value === 'skipped') return 'skipped';
  return 'complete';
}

function pipelineStage(stage: string | null): PipelineStage {
  if (stage === 'scan' || stage === 'consolidate' || stage === 'roles' || stage === 'lexicon' || stage === 'ia' || stage === 'code-mapping') return stage;
  return 'doks';
}

export function StepExtract() {
  const {
    workspace,
    serviceId,
    setServiceId,
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
    setCounters,
    error,
    setError,
    goTo,
    locale,
  } = useOnboarding();
  const c = WIZARD_COPY[locale].extract;
  const controllerRef = useRef<AbortController | null>(null);
  const invocationRef = useRef(false);
  const [showReloadStatus, setShowReloadStatus] = useState(false);
  const [scanFailure, setScanFailure] = useState<WizardScanFailureResult['error'] | null>(null);

  useEffect(() => () => {
    controllerRef.current?.abort();
    invocationRef.current = false;
  }, []);

  const initialRows = useCallback((): PipelineRow[] =>
    PIPELINE_STAGES.map((stage) => ({ stage, status: 'waiting', detail: c.waiting })),
  [c.waiting]);

  const startGeneration = useCallback(async () => {
    if (!serviceId || invocationRef.current) return;

    invocationRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunState('running');
    setError(null);
    setScanFailure(null);
    setShowReloadStatus(false);
    if (runState === 'ready' || runState === 'no-candidates') {
      setCounters(null);
      setGenerateTotal(null);
      setPipelineRows(initialRows());
    }
    updatePipelineRow({ stage: 'scan', status: 'running', detail: c.scanPreparing });

    const truth = createOnboardingStreamTruth();
    truth.activeStage = 'scan';
    truth.runningStage = 'scan';
    let terminalFailure: string | null = null;
    let terminalDiagnostic: string | null = null;
    const dokFailureDetails: string[] = [];
    let generationRequested = false;
    let protocolFailure: string | null = null;
    const persistedDoksAtStart = revealedDoks.length;
    let persistedDokCount = persistedDoksAtStart;
    const failedStages = new Set<PipelineStage>();

    const fail = (
      message: string,
      paintActive = true,
      hasPersistedProgress = persistedDokCount > 0 || truth.successfulDokIds.size > 0,
      activeDetail = message,
    ) => {
      if (terminalFailure) return;
      terminalFailure = message;
      setError(message);
      if (paintActive) {
        const running = truth.runningStage === null ? null : pipelineStage(truth.runningStage);
        if (running && !failedStages.has(running)) updatePipelineRow({ stage: running, status: 'failed', detail: activeDetail });
      }
      setRunState(hasPersistedProgress ? 'partial' : 'failed');
    };

    const reconcileInterruptedGeneration = async (): Promise<boolean> => {
      const hasObservedProgress = truth.successfulDokIds.size > 0;
      try {
        const persisted = await wizardGetDoks();
        persistedDokCount = persisted.length;
        setRevealedDoks(persisted);
        return hasObservedProgress || persisted.length > 0;
      } catch {
        return hasObservedProgress || persistedDokCount > 0;
      }
    };

    try {
      const scan = await wizardRunScan(serviceId);
      if (controller.signal.aborted) return;
      if (!scan.ok) {
        const fileCount = scan.error.failedFiles.length;
        setScanFailure(scan.error);
        fail(
          c.scanFailureSummary(fileCount),
          true,
          false,
          c.scanFailureStatus(fileCount),
        );
        return;
      }
      setScanResult(scan);
      updatePipelineRow({
        stage: 'scan',
        status: 'complete',
        detail: c.scanReady(scan.counts.routes, scan.counts.components),
      });
      truth.runningStage = null;

      const endpoint = `/api/wizard/generate?service=${encodeURIComponent(serviceId)}`;
      let consentToken: string;
      try {
        consentToken = await acquireGenerationConsent(endpoint, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof GenerationConsentError) {
          fail(
            cause.status === 400 || cause.status === 403
              ? c.requestRejected
              : c.requestFailed(cause.status),
            false,
          );
        } else {
          fail(c.requestRejected, false);
        }
        return;
      }
      generationRequested = true;
      const response = await startGenerationRequest(
        endpoint,
        consentToken,
        controller.signal,
      );
      if (!response.ok) {
        if (response.status === 400) fail(c.requestRejected, false);
        else if (response.status === 409) {
          setShowReloadStatus(true);
          fail(c.alreadyRunning, false);
        }
        else fail(c.requestFailed(response.status), false);
        return;
      }
      if (!response.body) {
        fail(c.noStream, false);
        return;
      }

      await readJsonLines(response.body, (event) => {
        if (terminalFailure) return;
        const stage = stringValue(event, 'stage');
        if (!stage) return;
        const truthError = observeOnboardingEvent(truth, event);
        if (truthError) {
          protocolFailure = c.protocolError(truthError);
          controller.abort();
          throw new Error('Generation returned an unreadable progress event.');
        }

        if (stage === 'scan' || stage === 'consolidate') {
          const status = eventStatus(stringValue(event, 'status'));
          const routeCount = numberValue(event, 'routes');
          const componentCount = numberValue(event, 'components');
          const featureGroups = numberValue(event, 'featureGroups');
          const reason = stringValue(event, 'reason') ?? stringValue(event, 'error');
          const detail = reason ?? (
            stage === 'scan'
              ? c.scanReady(routeCount ?? 0, componentCount ?? 0)
              : c.consolidated(featureGroups ?? 0)
          );
          updatePipelineRow({ stage, status, detail });
          if (status === 'failed') failedStages.add(stage);
          return;
        }

        if (stage === 'roles') {
          const status = eventStatus(stringValue(event, 'status'));
          const detail = stringValue(event, 'error') ?? c.roles(
            numberValue(event, 'added') ?? 0,
            numberValue(event, 'kept') ?? 0,
          );
          updatePipelineRow({
            stage: 'roles',
            status,
            detail,
          });
          if (status === 'failed') failedStages.add('roles');
          return;
        }

        if (stage === 'lexicon') {
          updatePipelineRow({
            stage: 'lexicon',
            status: eventStatus(stringValue(event, 'status')),
            detail: c.lexicon(numberValue(event, 'termCount') ?? 0),
          });
          if (eventStatus(stringValue(event, 'status')) === 'failed') failedStages.add('lexicon');
          return;
        }

        if (stage === 'plan') {
          const total = numberValue(event, 'total');
          if (total === null || total < 0 || !Number.isInteger(total)) {
            fail(c.unreadableProgress);
            return;
          }
          setGenerateTotal(persistedDoksAtStart + total);
          updatePipelineRow({
            stage: 'doks',
            status: total === 0 ? 'skipped' : 'running',
            detail: total === 0 ? c.noRemaining : c.doksPlanned(total),
          });
          return;
        }

        if (stage === 'dok-start') {
          const dokId = stringValue(event, 'dokId') ?? c.dok;
          updatePipelineRow({
            stage: 'doks',
            status: truth.failedDokIds.size > 0 ? 'failed' : 'running',
            detail: dokFailureDetails.length > 0
              ? dokFailureDetails.join(' · ')
              : c.dokGenerating(dokId),
          });
          return;
        }

        if (stage === 'dok-done') {
          const success = event.success === true;
          const dok = event.dok as DokCard | undefined;
          if (success && dok && typeof dok.dok_id === 'string' && typeof dok.name === 'string') {
            pushRevealedDok(dok);
          }
          const dokId = stringValue(event, 'dokId') ?? dok?.dok_id ?? c.dok;
          if (!success) {
            const reason = stringValue(event, 'error');
            const detail = reason === null
              ? c.dokFailed(dokId)
              : (reason.includes(dokId) ? reason : `${dokId}: ${reason}`);
            if (!dokFailureDetails.includes(detail)) dokFailureDetails.push(detail);
          }
          const hasKnownFailure = truth.failedDokIds.size > 0;
          updatePipelineRow({
            stage: 'doks',
            status: hasKnownFailure
              ? 'failed'
              : (truth.runningStage === null ? 'complete' : 'running'),
            detail: hasKnownFailure
              ? (dokFailureDetails.join(' · ') || c.dokFailed(dokId))
              : c.dokGenerated(dokId),
          });
          if (!success) failedStages.add('doks');
          return;
        }

        if (stage === 'ia' || stage === 'code-mapping') {
          const count = numberValue(event, 'count') ?? 0;
          updatePipelineRow({
            stage,
            status: eventStatus(stringValue(event, 'status')),
            detail: stringValue(event, 'error') ?? (stage === 'ia' ? c.ia(count) : c.codeMapping(count)),
          });
          if (eventStatus(stringValue(event, 'status')) === 'failed') failedStages.add(stage);
          return;
        }

        if (stage === 'done') {
          if (truth.done) setCounters(truth.done);
          return;
        }

        if (stage === 'clean-close') {
          return;
        }

        if (stage === 'error') {
          const message = stringValue(event, 'message') ?? c.unknownError;
          if (truth.done) {
            terminalDiagnostic = terminalDiagnosticMessage(event, message);
            setError(terminalDiagnostic);
          }
          else fail(message);
        }
      });

      if (controller.signal.aborted) return;
      if (!truth.done && !terminalFailure) {
        fail(c.streamIncomplete);
      }
      if (truth.done && truth.terminal !== 'closed') fail(c.streamIncomplete);
      if (truth.done) {
        const done = truth.done;
        let persisted: DokCard[];
        try {
          persisted = await wizardGetDoks();
        } catch {
          fail(c.emptyHub);
          return;
        }
        if (controller.signal.aborted) return;
        const persistedIds = new Set(persisted.map((dok) => dok.dok_id));
        for (const dokId of truth.successfulDokIds) {
          if (!persistedIds.has(dokId)) {
            fail(c.emptyHub);
            return;
          }
        }
        persistedDokCount = persisted.length;
        setRevealedDoks(persisted);
        setGenerateTotal(Math.max(
          persisted.length,
          persistedDoksAtStart + (truth.planTotal ?? 0),
        ));
        setCounters({
          ...done,
          succeeded: persisted.length,
        });
        if (
          persisted.length === 0
          && truth.planTotal === 0
          && done.failed === 0
          && done.layerFailed === 0
          && terminalFailure === null
          && truth.terminal === 'closed'
        ) {
          setError(null);
          setRunState('no-candidates');
          return;
        }
        if (persisted.length === 0 && truth.successfulDokIds.size > 0) {
          fail(c.emptyHub);
          return;
        }
      }
      if (terminalFailure || !truth.done) return;
      if (truth.done.failed > 0 || truth.done.layerFailed > 0) {
        const detail = terminalDiagnostic
          ?? c.failureSummary(truth.done.failed, truth.done.layerFailed);
        setError(detail);
        if (truth.done.failed > 0) {
          updatePipelineRow({
            stage: 'doks',
            status: 'failed',
            detail: dokFailureDetails.join(' · ') || detail,
          });
        }
        setRunState(persistedDokCount > 0 || truth.successfulDokIds.size > 0 ? 'partial' : 'failed');
        return;
      }
      if (truth.planTotal !== null && truth.planTotal > 0) {
        updatePipelineRow({
          stage: 'doks',
          status: 'complete',
          detail: c.doksGenerated(truth.done.succeeded),
        });
      }
      setRunState('complete');
    } catch (caught) {
      const abortedByNavigation = controller.signal.aborted && protocolFailure === null
        && caught instanceof DOMException && caught.name === 'AbortError';
      if (abortedByNavigation) return;

      const detail = protocolFailure
        ?? (caught instanceof Error && caught.message === 'Generation returned an unreadable progress event.'
          ? c.unreadableProgress
          : caught instanceof Error && caught.message === 'Generation stream ended with a partial event.'
            ? c.partialStream
            : caught instanceof Error
              ? caught.message
              : c.unknownError);
      if (!generationRequested) {
        fail(detail);
        return;
      }

      controller.abort();
      const hasPersistedProgress = await reconcileInterruptedGeneration();
      fail(c.connectionLost(detail), true, hasPersistedProgress);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      invocationRef.current = false;
    }
  }, [
    c, initialRows, pushRevealedDok, revealedDoks.length, runState, serviceId, setCounters,
    setError, setGenerateTotal, setPipelineRows, setRevealedDoks, setRunState, setScanResult,
    updatePipelineRow,
  ]);

  const total = generateTotal ?? revealedDoks.length;
  const completed = revealedDoks.length;
  const canStart = serviceId !== null && runState !== 'running';
  const actionLabel = runState === 'partial' || runState === 'failed' || runState === 'no-candidates'
    ? c.retry
    : c.generate;
  const displayRows = pipelineRows.length > 0 ? pipelineRows : initialRows();

  return (
    <SplitBody
      narrative={
        <>
          <Reveal delay={0}>
            <span className="text-xs font-semibold uppercase tracking-wide text-accent">{c.eyebrow}</span>
          </Reveal>
          <Reveal delay={STAGGER} as="h2" className="text-xl font-bold leading-tight tracking-tight text-ink-strong">
            {runState === 'complete' ? c.headingDone : c.heading}
          </Reveal>
          <Reveal delay={STAGGER * 2} as="p" className="text-base leading-relaxed text-ink-muted">
            {c.lead}
          </Reveal>

          <Reveal delay={STAGGER * 3} className="flex flex-col gap-3">
            <label className="text-sm font-medium text-ink" htmlFor="onboarding-service">
              {c.service}
            </label>
            <select
              id="onboarding-service"
              value={serviceId ?? ''}
              disabled={runState === 'running' || workspace.services.length === 0}
              onChange={(event) => {
                const next = event.currentTarget.value;
                if (!next || next === serviceId) return;
                setServiceId(next);
                setRunState('ready');
                setError(null);
                setScanFailure(null);
                setShowReloadStatus(false);
                setCounters(null);
                setGenerateTotal(null);
                setPipelineRows([]);
                setScanResult(null);
                setRevealedDoks([]);
              }}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            >
              {workspace.services.length === 0 ? <option value="">{c.noService}</option> : null}
              {workspace.services.map((service) => (
                <option key={service.serviceId} value={service.serviceId}>
                  {service.serviceId} · {service.framework}
                </option>
              ))}
            </select>
            {workspace.services.length === 0 ? (
              <p role="alert" className="text-sm leading-relaxed text-warning">{c.noService}</p>
            ) : null}
            <div className="border-l-2 border-accent/50 pl-3 text-sm leading-relaxed text-ink-muted">
              <p>{c.model(workspace.model ?? c.notConfigured)}</p>
              <p>{c.provider(workspace.provider ?? c.notConfigured)}</p>
              <p className="mt-2">{c.disclosure(workspace.provider ?? c.providerFallback)}</p>
            </div>
            <button
              type="button"
              disabled={!canStart}
              onClick={startGeneration}
              className="inline-flex w-fit items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-canvas shadow-md transition-all duration-200 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {runState === 'running' ? <Loader2 className="h-4 w-4 wizard-spin" aria-hidden /> : null}
              {actionLabel}
            </button>
          </Reveal>

          {error ? (
            <div role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm leading-relaxed text-danger">
              <p>{showReloadStatus ? c.alreadyRunning : error}</p>
              {scanFailure ? (
                <details className="mt-2 border-t border-danger/20 pt-2">
                  <summary className="cursor-pointer font-semibold">{c.scanFailureDetails}</summary>
                  <ul className="mt-2 space-y-3">
                    {scanFailure.failedFiles.map((failure) => (
                      <li key={failure.file}>
                        <p className="font-mono text-xs text-ink-strong">{failure.file}</p>
                        <p className="text-ink-secondary">
                          {failure.stages.map(c.scanFailureStage).join(' · ')}
                        </p>
                        <p className="font-mono text-xs">{failure.reason}</p>
                        {failure.diagnosticCount > 1 ? (
                          <p>{c.scanFailureAdditional(failure.diagnosticCount - 1)}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3">{c.scanFailureNext}</p>
                </details>
              ) : null}
            </div>
          ) : null}
          {showReloadStatus ? (
            <a
              href="/onboarding"
              className="inline-flex w-fit items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-ink-secondary no-underline transition-colors hover:bg-surface-2 hover:no-underline"
            >
              {c.reloadStatus}
            </a>
          ) : null}
          {runState === 'up-to-date' ? (
            <div className="mt-4 rounded-md border border-border bg-surface/70 px-3 py-2 text-sm leading-relaxed text-ink-secondary">
              {c.upToDate}
            </div>
          ) : null}
          {runState === 'no-candidates' ? (
            <div className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm leading-relaxed text-warning">
              {c.noCandidates}
            </div>
          ) : null}
          {runState === 'complete' ? (
            <Reveal className="mt-4">
              <button
                type="button"
                onClick={() => goTo('hub')}
                className="group inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-canvas shadow-md transition-all duration-200 hover:bg-accent-hover"
              >
                {c.recommend}
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </button>
            </Reveal>
          ) : null}
        </>
      }
      peek={
        <div className="rounded-lg border border-border bg-surface/60 p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between text-xs">
            <span className="font-semibold text-ink-secondary">{c.receipt}</span>
            <span className="font-mono text-ink-faint">{completed} / {total}</span>
          </div>
          <ul aria-live="polite" className="flex flex-col gap-1.5">
            {displayRows.map((row) => (
              <li key={row.stage} className="flex items-start gap-2 rounded-md bg-surface px-2.5 py-2">
                {row.status === 'complete' || row.status === 'skipped' ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                ) : row.status === 'failed' ? (
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
                ) : row.status === 'running' ? (
                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent wizard-spin" aria-hidden />
                ) : (
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{c.stage[row.stage]}</span>
                  <span className="block text-xs leading-relaxed text-ink-muted">{row.detail}</span>
                  <span className="sr-only">{c.status[row.status]}</span>
                </span>
              </li>
            ))}
          </ul>
          {revealedDoks.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
              {revealedDoks.slice(-3).map((dok) => (
                <li key={dok.dok_id} className="flex items-center gap-2 text-sm text-ink-secondary">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                  <span className="truncate">{dok.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      }
    />
  );
}
