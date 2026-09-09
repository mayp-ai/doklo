import { describe, expect, it } from 'vitest';
import { DokPrioritySchema, type DokPriority } from '@doklo-beta/core';
import { mergePriority } from '../src/priority-merge.js';

function p(over: Partial<DokPriority>): DokPriority {
  return DokPrioritySchema.parse({
    impact: 'enabling',
    blast_radius: 'degrading',
    ...over,
  });
}

describe('mergePriority', () => {
  it('takes the derived judgment when nothing was pinned', () => {
    const merged = mergePriority(
      p({ impact: 'core_value' }),
      p({ impact: 'supporting' }),
    );
    expect(merged?.impact).toBe('core_value');
  });

  it('keeps a pinned axis and ignores the derived value', () => {
    const merged = mergePriority(
      p({ impact: 'supporting' }),
      p({ impact: 'revenue', curated: { impact: { reason: 'settlement API is called here' } } }),
    );
    expect(merged?.impact).toBe('revenue');
    expect(merged?.curated.impact?.reason).toBe('settlement API is called here');
  });

  it('keeps a pinned blast radius', () => {
    const merged = mergePriority(
      p({ blast_radius: 'cosmetic' }),
      p({ blast_radius: 'blocking', curated: { blast_radius: { reason: 'sole entry path' } } }),
    );
    expect(merged?.blast_radius).toBe('blocking');
  });

  it('leaves an unpinned axis free while the other is pinned', () => {
    const merged = mergePriority(
      p({ impact: 'supporting', blast_radius: 'blocking' }),
      p({ impact: 'revenue', blast_radius: 'cosmetic', curated: { impact: { reason: 'r' } } }),
    );
    expect(merged?.impact).toBe('revenue');
    expect(merged?.blast_radius).toBe('blocking');
  });

  // The producer must not be able to unpin what a person pinned.
  it('takes curated from previous even when derived carries its own', () => {
    const merged = mergePriority(
      p({ curated: { impact: { reason: 'machine wrote this' } } }),
      p({ impact: 'revenue', curated: { blast_radius: { reason: 'human wrote this' } } }),
    );
    expect(merged?.curated.impact).toBeUndefined();
    expect(merged?.curated.blast_radius?.reason).toBe('human wrote this');
  });

  // Evidence is re-derived every run — a moved file must not leave a dead anchor.
  it('never carries signals forward', () => {
    const merged = mergePriority(
      p({ signals: [{ file: 'new.ts', detector: 'money-model' }] }),
      p({
        impact: 'revenue',
        curated: { impact: { reason: 'r' } },
        signals: [{ file: 'old.ts', detector: 'money-model' }],
      }),
    );
    expect(merged?.signals).toEqual([{ file: 'new.ts', detector: 'money-model' }]);
  });

  it('drops stale signals to empty when the new run found none', () => {
    const merged = mergePriority(
      p({ signals: [] }),
      p({
        impact: 'revenue',
        curated: { impact: { reason: 'r' } },
        signals: [{ file: 'old.ts', detector: 'money-model' }],
      }),
    );
    expect(merged?.signals).toEqual([]);
  });

  it('keeps the previous judgment whole when this run produced none', () => {
    const previous = p({ impact: 'revenue', curated: { impact: { reason: 'r' } } });
    expect(mergePriority(undefined, previous)).toEqual(previous);
  });

  it('returns the derived judgment when there is no previous', () => {
    const derived = p({ impact: 'core_value' });
    expect(mergePriority(derived, undefined)).toEqual(derived);
  });

  it('returns undefined when neither side judged', () => {
    expect(mergePriority(undefined, undefined)).toBeUndefined();
  });

  it('does not mutate either input', () => {
    const derived = p({ impact: 'supporting' });
    const previous = p({ impact: 'revenue', curated: { impact: { reason: 'r' } } });
    mergePriority(derived, previous);
    expect(derived.impact).toBe('supporting');
    expect(previous.impact).toBe('revenue');
  });
});
