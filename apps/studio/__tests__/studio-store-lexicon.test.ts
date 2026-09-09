import { describe, it, expect } from 'vitest';
import type { LexiconTerm } from '@doklo-beta/core';
import { lexiconStatsOf, resolveLexicon } from '../components/studio-store';

// resolveLexicon is the exact seam StudioProvider uses to compute
// useStudio().lexicon. The Studio test env is node-only (no DOM), so we
// assert the fallback rule on the resolver directly rather than rendering
// the provider. Rule: real workspace terms win when present; with no terms
// the catalog is empty (the screen renders its empty state).

const realTerms = [
  { term_id: 'TERM-CONCEPT-001' },
] as unknown as LexiconTerm[];

describe('resolveLexicon (StudioProvider lexicon source)', () => {
  it('returns the provided workspace terms when non-empty', () => {
    // Reference identity (toBe) is deliberate — passthrough must return the
    // very array RootLayout handed in.
    expect(resolveLexicon(realTerms)).toBe(realTerms);
  });

  it('returns an empty catalog when initialLexicon is undefined', () => {
    expect(resolveLexicon(undefined)).toEqual([]);
  });

  it('returns an empty catalog when initialLexicon is an empty array', () => {
    expect(resolveLexicon([])).toEqual([]);
  });
});

// lexiconStatsOf is the pure aggregation behind useLexiconStats. The key
// rule: i18n-bound terms have no Studio-resolvable display text (their text
// lives in workspace i18n files with no reader yet), so they must never be
// counted as "missing" — only owned/constant terms with an empty locale do.
const ownedTerm = (
  term_id: string,
  locales: Record<string, string>,
): LexiconTerm =>
  ({
    term_id,
    category: 'concept',
    binding: { type: 'owned' },
    locales,
    related_doks: [],
  }) as unknown as LexiconTerm;

const i18nTerm = (term_id: string): LexiconTerm =>
  ({
    term_id,
    category: 'concept',
    binding: { type: 'i18n', key: 'nav.x', files: [], supported_locales: [] },
    related_doks: [],
  }) as unknown as LexiconTerm;

describe('lexiconStatsOf (missing-locale aggregation)', () => {
  it('counts an owned term’s empty project locale as missing', () => {
    const stats = lexiconStatsOf([ownedTerm('TERM-A', { en: 'A' })], ['en', 'ko']);
    expect(stats.owned).toBe(1);
    expect(stats.missing).toBe(1); // ko is absent
  });

  it('never counts an i18n-bound term as missing', () => {
    const stats = lexiconStatsOf([i18nTerm('TERM-B')], ['en', 'ko']);
    expect(stats.i18n).toBe(1);
    expect(stats.missing).toBe(0);
  });

  it('mixes both: only the owned gap contributes', () => {
    const stats = lexiconStatsOf(
      [ownedTerm('TERM-A', { en: 'A', ko: '가' }), i18nTerm('TERM-B')],
      ['en', 'ko'],
    );
    expect(stats.total).toBe(2);
    expect(stats.missing).toBe(0); // owned fully covered, i18n skipped
  });
});
