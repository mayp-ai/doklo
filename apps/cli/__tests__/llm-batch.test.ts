import { describe, expect, it } from 'vitest';
import { fitCallsToRunCap, selectGenerationBatch } from '../src/lib/llm-batch.js';
import type { LlmPreparedCall } from '../src/lib/llm-preflight.js';

const call = (
  phase: 'consolidate' | 'generate',
  id: string,
  promptChars = 1_000,
): LlmPreparedCall => ({
  phase,
  workItem: { phase, serviceId: 'web', id },
  prompt: 'x'.repeat(promptChars),
  maxOutputTokens: 8_192,
});

const ids = (calls: readonly LlmPreparedCall[]) => calls.map((c) => c.workItem.id);

describe('fitCallsToRunCap', () => {
  it('keeps everything when the plan already fits', () => {
    const calls = [call('consolidate', 'web'), call('generate', 'A'), call('generate', 'B')];

    const fitted = fitCallsToRunCap(calls, 1_000_000);

    expect(ids(fitted.kept)).toEqual(['web', 'A', 'B']);
    expect(fitted.deferred).toEqual([]);
    expect(fitted.capped).toBe(false);
  });

  it('defers generate calls that do not fit, keeping the rest', () => {
    const many = Array.from({ length: 40 }, (_, i) => call('generate', `D${i}`, 200_000));

    const fitted = fitCallsToRunCap(many, 1_000_000);

    expect(fitted.capped).toBe(true);
    expect(fitted.kept.length).toBeGreaterThan(0);
    expect(fitted.kept.length + fitted.deferred.length).toBe(40);
  });

  it('never defers consolidate work — generation depends on it', () => {
    const calls = [
      call('consolidate', 'web', 400_000),
      ...Array.from({ length: 30 }, (_, i) => call('generate', `D${i}`, 300_000)),
    ];

    const fitted = fitCallsToRunCap(calls, 1_000_000);

    expect(ids(fitted.kept)).toContain('web');
    expect(fitted.deferred.every((c) => c.phase === 'generate')).toBe(true);
  });

  it('leaves an over-cap plan untouched when even the required work exceeds the cap', () => {
    // Nothing can be dropped to make this fit, so the caller must still hit the
    // cap error rather than silently running a plan that cannot complete.
    const calls = [call('consolidate', 'web', 10_000_000)];

    const fitted = fitCallsToRunCap(calls, 1_000_000);

    expect(fitted.kept).toEqual(calls);
    expect(fitted.deferred).toEqual([]);
    expect(fitted.capped).toBe(false);
  });

  it('is deterministic — same input, same split', () => {
    const calls = Array.from({ length: 30 }, (_, i) => call('generate', `D${i}`, 250_000));

    expect(ids(fitCallsToRunCap(calls, 1_000_000).kept)).toEqual(ids(fitCallsToRunCap(calls, 1_000_000).kept));
  });

  it('preserves the caller-supplied order within the kept batch', () => {
    // Stable order means the next run picks up where this one left off.
    const calls = ['C', 'A', 'B'].map((id) => call('generate', id, 200_000));

    const kept = ids(fitCallsToRunCap(calls, 1_000_000).kept);

    expect(kept).toEqual(['C', 'A', 'B'].slice(0, kept.length));
  });

  it('reports the reserved tokens of the batch it kept', () => {
    const calls = [call('generate', 'A'), call('generate', 'B')];

    const fitted = fitCallsToRunCap(calls, 1_000_000);

    expect(fitted.reservedTokens).toBeGreaterThan(0);
    expect(fitted.reservedTokens).toBeLessThanOrEqual(1_000_000);
  });

  it('handles an empty plan', () => {
    expect(fitCallsToRunCap([], 1_000_000)).toMatchObject({ kept: [], deferred: [], capped: false });
  });
});

describe('selectGenerationBatch', () => {
  const item = (dokId: string, promptChars = 1_000) => ({
    serviceId: 'web',
    dokId,
    prompt: 'x'.repeat(promptChars),
  });

  it('keeps every Dok when the plan fits', () => {
    const batch = selectGenerationBatch([item('A'), item('B')], 1_000_000);

    expect(batch.keptDokIds).toEqual(['A', 'B']);
    expect(batch.deferredDokIds).toEqual([]);
    expect(batch.capped).toBe(false);
  });

  it('splits a plan that exceeds the cap, losing nothing', () => {
    // cal.com's shape: 76 Doks planned, cap hit before any file is written.
    const items = Array.from({ length: 76 }, (_, i) => item(`DOK-${i}`, 200_000));

    const batch = selectGenerationBatch(items, 1_000_000);

    expect(batch.capped).toBe(true);
    expect(batch.keptDokIds.length).toBeGreaterThan(0);
    expect(batch.keptDokIds.length + batch.deferredDokIds.length).toBe(76);
    expect(new Set(batch.keptDokIds)).not.toContain(batch.deferredDokIds[0]);
  });

  it('keeps the batch under the cap', () => {
    const items = Array.from({ length: 76 }, (_, i) => item(`DOK-${i}`, 200_000));

    expect(selectGenerationBatch(items, 1_000_000).reservedTokens).toBeLessThanOrEqual(1_000_000);
  });

  it('resumes deterministically — the next run starts where this one stopped', () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`DOK-${i}`, 250_000));

    const first = selectGenerationBatch(items, 1_000_000);
    // Second run sees only what is left (existing Doks are skipped on disk).
    const remaining = items.filter((i) => first.deferredDokIds.includes(i.dokId));
    const second = selectGenerationBatch(remaining, 1_000_000);

    expect(second.keptDokIds[0]).toBe(first.deferredDokIds[0]);
    expect(first.keptDokIds).not.toContain(second.keptDokIds[0]);
  });
});
