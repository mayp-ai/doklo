import { doneCounters, type DoneCounters } from './generate-progress';

type Terminal = 'open' | 'success-pending-close' | 'failure-pending-error' | 'closed';

export interface OnboardingStreamTruth {
  planTotal: number | null;
  successfulDokIds: Set<string>;
  failedDokIds: Set<string>;
  layerErrorKeys: Set<string>;
  rolesFailed: boolean;
  done: DoneCounters | null;
  cleanClose: boolean;
  activeStage: string | null;
  runningStage: string | null;
  terminal: Terminal;
}

export function createOnboardingStreamTruth(): OnboardingStreamTruth {
  return {
    planTotal: null,
    successfulDokIds: new Set(),
    failedDokIds: new Set(),
    layerErrorKeys: new Set(),
    rolesFailed: false,
    done: null,
    cleanClose: false,
    activeStage: null,
    runningStage: null,
    terminal: 'open',
  };
}

function stringValue(event: Record<string, unknown>, key: string): string | null {
  const value = event[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isPrePlanStage(stage: string): boolean {
  return stage === 'scan' || stage === 'consolidate' || stage === 'roles' || stage === 'lexicon' || stage === 'consent-plan';
}

function isConsentPlan(event: Record<string, unknown>): boolean {
  const phase = event.phase;
  const plan = event.plan;
  return (phase === 'consolidation' || phase === 'generation') && plan !== null && typeof plan === 'object' && !Array.isArray(plan);
}

export function observeOnboardingEvent(
  truth: OnboardingStreamTruth,
  event: Record<string, unknown>,
): string | null {
  const stage = stringValue(event, 'stage');
  if (!stage) return 'Generation returned an unreadable progress event.';
  if (truth.terminal === 'closed') return 'Generation returned an event after its terminal event.';

  if (truth.terminal === 'success-pending-close') {
    if (stage !== 'clean-close') return 'Generation returned an event after successful completion.';
    truth.cleanClose = true;
    truth.terminal = 'closed';
    return null;
  }
  if (truth.terminal === 'failure-pending-error') {
    if (stage !== 'error') return 'Generation returned an event after failed completion.';
    truth.terminal = 'closed';
    return null;
  }

  if (stage === 'clean-close') return 'Generation closed before done.';
  if (stage === 'error') {
    truth.terminal = 'closed';
    return null;
  }
  if (stage === 'done') {
    if (truth.planTotal === null) return 'Generation completed without a plan.';
    if (truth.rolesFailed) return 'Generation completed after roles failed.';
    const counters = doneCounters(event);
    if (!counters) return 'Generation returned an invalid completion summary.';
    const observed = truth.successfulDokIds.size + truth.failedDokIds.size;
    if (observed !== truth.planTotal) return 'Generation completion does not match its plan.';
    if (counters.succeeded !== truth.successfulDokIds.size || counters.failed !== truth.failedDokIds.size) {
      return 'Generation completion counters do not match Dok progress.';
    }
    if (counters.layerFailed !== truth.layerErrorKeys.size) {
      return 'Generation completion counters do not match layer progress.';
    }
    truth.done = counters;
    truth.runningStage = null;
    truth.terminal = counters.failed === 0 && counters.layerFailed === 0
      ? 'success-pending-close'
      : 'failure-pending-error';
    return null;
  }

  if (truth.planTotal === null) {
    if (stage === 'plan') {
      const total = event.total;
      if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
        return 'Generation returned an unreadable progress event.';
      }
      truth.planTotal = total;
      truth.activeStage = stage;
      truth.runningStage = total > 0 ? 'doks' : null;
      return null;
    }
    if (!isPrePlanStage(stage)) return 'Generation returned progress before its plan.';
    if (stage === 'consent-plan' && !isConsentPlan(event)) return 'Generation returned an unreadable consent plan.';
    truth.activeStage = stage;
    if (event.status === 'running') truth.runningStage = stage;
    else if (truth.runningStage === stage) truth.runningStage = null;
    if (stage === 'roles' && event.status === 'error') truth.rolesFailed = true;
    return null;
  }

  if (isPrePlanStage(stage) || stage === 'plan') return 'Generation returned preparation after its plan.';
  truth.activeStage = stage;
  if (stage === 'dok-start') {
    truth.runningStage = 'doks';
    return null;
  }
  if (stage === 'dok-done') {
    const dokId = stringValue(event, 'dokId');
    if (!dokId || typeof event.success !== 'boolean') return 'Generation returned an unreadable progress event.';
    if (truth.successfulDokIds.has(dokId) || truth.failedDokIds.has(dokId)) {
      return `Generation returned duplicate Dok progress for ${dokId}.`;
    }
    if (event.success) truth.successfulDokIds.add(dokId);
    else truth.failedDokIds.add(dokId);
    if (truth.successfulDokIds.size + truth.failedDokIds.size === truth.planTotal) {
      truth.runningStage = null;
    }
    return null;
  }
  if (stage === 'ia' || stage === 'code-mapping') {
    if (event.status === 'running') truth.runningStage = stage;
    else if (truth.runningStage === stage) truth.runningStage = null;
    if (event.status === 'error') {
      const serviceId = stringValue(event, 'serviceId');
      if (!serviceId) return 'Generation returned an unreadable progress event.';
      const key = `${stage}:${serviceId}`;
      if (truth.layerErrorKeys.has(key)) return `Generation returned duplicate layer progress for ${key}.`;
      truth.layerErrorKeys.add(key);
    }
    return null;
  }
  if (stage === 'lexicon') return 'Generation returned preparation after its plan.';
  return 'Generation returned an unreadable progress event.';
}
