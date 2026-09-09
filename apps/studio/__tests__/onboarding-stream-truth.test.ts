import { describe, expect, it } from 'vitest';
import { createOnboardingStreamTruth, observeOnboardingEvent } from '../lib/onboarding-stream-truth';

describe('onboarding stream truth', () => {
  it('accepts the bridge order through successful done and exactly one clean-close', () => {
    const truth = createOnboardingStreamTruth();
    const events = [
      { stage: 'scan', status: 'reused' },
      { stage: 'consent-plan', phase: 'consolidation', plan: { calls: { consolidate: 1 } } },
      { stage: 'consolidate', status: 'running' },
      { stage: 'consolidate', status: 'completed' },
      { stage: 'consent-plan', phase: 'generation', plan: { calls: { generate: 1 } } },
      { stage: 'roles', status: 'updated' },
      { stage: 'lexicon', status: 'reused' },
      { stage: 'plan', total: 1 },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true },
      { stage: 'ia', serviceId: 'web', status: 'written', count: 2 },
      { stage: 'code-mapping', serviceId: 'web', status: 'written', count: 2 },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ];
    for (const event of events) expect(observeOnboardingEvent(truth, event)).toBeNull();
    expect(truth.terminal).toBe('closed');
    expect(observeOnboardingEvent(truth, { stage: 'clean-close' })).toContain('terminal');
  });

  it('requires the bridge error after a failed done and reconciles unique layer errors', () => {
    const truth = createOnboardingStreamTruth();
    const events = [
      { stage: 'plan', total: 1 },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: false },
      { stage: 'ia', serviceId: 'web', status: 'error', count: 0, error: 'ia failed' },
      { stage: 'code-mapping', serviceId: 'api', status: 'error', count: 0, error: 'map failed' },
      { stage: 'done', succeeded: 0, failed: 1, layerFailed: 2 },
      { stage: 'error', message: 'Generate completed with 1 Dok failed and 2 layers failed.' },
    ];
    for (const event of events) expect(observeOnboardingEvent(truth, event)).toBeNull();
    expect(truth.terminal).toBe('closed');
    expect(observeOnboardingEvent(truth, { stage: 'clean-close' })).toContain('terminal');
  });

  it('rejects roles errors followed by done and invalid ordering', () => {
    const roles = createOnboardingStreamTruth();
    expect(observeOnboardingEvent(roles, { stage: 'roles', status: 'error', error: 'invalid roles' })).toBeNull();
    expect(observeOnboardingEvent(roles, { stage: 'plan', total: 0 })).toBeNull();
    expect(observeOnboardingEvent(roles, { stage: 'done', succeeded: 0, failed: 0, layerFailed: 0 })).toContain('roles');

    const earlyClose = createOnboardingStreamTruth();
    expect(observeOnboardingEvent(earlyClose, { stage: 'clean-close' })).toContain('before done');
    const duplicateLayer = createOnboardingStreamTruth();
    observeOnboardingEvent(duplicateLayer, { stage: 'plan', total: 0 });
    observeOnboardingEvent(duplicateLayer, { stage: 'ia', serviceId: 'web', status: 'error', count: 0 });
    expect(observeOnboardingEvent(duplicateLayer, { stage: 'ia', serviceId: 'web', status: 'error', count: 0 })).toContain('duplicate');
  });

  it('tracks Doks as running only until the planned outcomes reconcile', () => {
    const truth = createOnboardingStreamTruth();
    observeOnboardingEvent(truth, { stage: 'plan', total: 2 });
    observeOnboardingEvent(truth, { stage: 'dok-start', dokId: 'AUTH-SIGNIN' });
    observeOnboardingEvent(truth, { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true });
    expect(truth.runningStage).toBe('doks');

    observeOnboardingEvent(truth, { stage: 'dok-start', dokId: 'AUTH-SIGNUP' });
    observeOnboardingEvent(truth, { stage: 'dok-done', dokId: 'AUTH-SIGNUP', success: true });
    expect(truth.runningStage).toBeNull();

    observeOnboardingEvent(truth, { stage: 'done', succeeded: 2, failed: 0, layerFailed: 0 });
    expect(truth.runningStage).toBeNull();
    expect(truth.terminal).toBe('success-pending-close');
  });

  it('retains mixed Dok outcomes when failure is followed by success', () => {
    const truth = createOnboardingStreamTruth();
    observeOnboardingEvent(truth, { stage: 'plan', total: 2 });
    observeOnboardingEvent(truth, { stage: 'dok-done', dokId: 'AUTH-SIGNUP', success: false });
    observeOnboardingEvent(truth, { stage: 'dok-start', dokId: 'AUTH-SIGNIN' });
    observeOnboardingEvent(truth, { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true });
    observeOnboardingEvent(truth, { stage: 'error', message: 'bridge failed before done' });

    expect(truth.failedDokIds).toEqual(new Set(['AUTH-SIGNUP']));
    expect(truth.successfulDokIds).toEqual(new Set(['AUTH-SIGNIN']));
    expect(truth.runningStage).toBeNull();
  });
});
