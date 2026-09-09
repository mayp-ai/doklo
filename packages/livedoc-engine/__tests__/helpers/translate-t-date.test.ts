import { describe, expect, it } from 'vitest';
import { makeCollector, type LexiconFile, type RolesFile } from '@doklo-beta/core';
import { createEngine } from '../../src/handlebars-setup.js';
import type { HelperRoot } from '../../src/helpers/index.js';

const lexicon: LexiconFile = {
  version: 1,
  terms: [
    {
      term_id: 'TERM-USER',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { en: 'User', ko: '사용자' },
      related_doks: [],
    },
  ],
};
const roles: RolesFile = { version: 1, roles: [] };

function makeRoot(overrides: Partial<HelperRoot> = {}): HelperRoot {
  return {
    __locale: 'ko',
    __primaryLocale: 'en',
    __lexicon: lexicon,
    __roles: roles,
    __strings: {
      en: { greeting: 'Hello' },
      ko: { greeting: '안녕하세요' },
    },
    __defaultLocale: 'en',
    __stringsMissing: new Set<string>(),
    __collector: makeCollector(),
    ...overrides,
  };
}

function render(tpl: string, root: HelperRoot, ctx: unknown = {}): string {
  const hb = createEngine();
  return hb.compile(tpl)(ctx, { data: { root } });
}

describe('translate helper', () => {
  it('resolves TermRef in active locale', () => {
    expect(render('{{translate term}}', makeRoot(), { term: { term_ref: 'TERM-USER' } })).toBe(
      '사용자',
    );
  });

  it('passes inline string through', () => {
    expect(render('{{translate s}}', makeRoot(), { s: 'plain' })).toBe('plain');
  });

  it('renders [TERM:???] placeholder for missing term', () => {
    expect(
      render('{{translate term}}', makeRoot(), { term: { term_ref: 'TERM-MISSING' } }),
    ).toBe('[TERM:TERM-MISSING]');
  });

  it('returns empty string for null/undefined', () => {
    expect(render('{{translate term}}', makeRoot(), {})).toBe('');
  });
});

describe('t helper', () => {
  it('looks up strings map for active locale', () => {
    expect(render('{{t "greeting"}}', makeRoot())).toBe('안녕하세요');
  });

  it('falls back to default_locale when active missing', () => {
    expect(render('{{t "greeting"}}', makeRoot({ __locale: 'ja' }))).toBe('Hello');
  });

  it('falls back to raw key when both missing + records miss', () => {
    const root = makeRoot();
    expect(render('{{t "absent"}}', root)).toBe('absent');
    expect(root.__stringsMissing?.has('absent')).toBe(true);
  });
});

describe('format_date helper', () => {
  it('formats long-form Korean date', () => {
    const out = render('{{format_date d}}', makeRoot(), { d: '2026-05-29' });
    expect(out).toMatch(/2026/); // exact ICU output varies by node version; verify locale-correctness loosely
    expect(out).toMatch(/년|월|일/);
  });

  it('formats English date', () => {
    const out = render('{{format_date d}}', makeRoot({ __locale: 'en' }), { d: '2026-05-29' });
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/May/);
  });

  it('returns raw input when unparseable', () => {
    expect(render('{{format_date d}}', makeRoot(), { d: 'not-a-date' })).toBe('not-a-date');
  });

  it('returns empty for empty input', () => {
    expect(render('{{format_date d}}', makeRoot(), { d: '' })).toBe('');
  });
});
