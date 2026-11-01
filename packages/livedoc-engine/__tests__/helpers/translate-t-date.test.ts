import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
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

  it('prints the same calendar day in every timezone (a history day is a label, not an instant)', () => {
    // A Dok history entry's day becomes `YYYY-MM-DDT00:00:00.000Z`; a renderer in a
    // UTC-negative zone must not print the day before.
    const script = `
      import Handlebars from 'handlebars';
      import { registerFormatDate } from ${JSON.stringify(new URL('../../dist/helpers/format-date.js', import.meta.url).href)};
      const hb = Handlebars.create(); registerFormatDate(hb);
      const out = hb.compile('{{format_date d}}')({ d: '2026-05-20T00:00:00.000Z' }, { data: { root: { __locale: 'en', d: '2026-05-20T00:00:00.000Z' } } });
      process.stdout.write(out);
    `;
    const days = ['America/Los_Angeles', 'UTC', 'Asia/Seoul'].map((tz) =>
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
    expect(days.every((day) => day === days[0]), days.join(' | ')).toBe(true);
    expect(days[0]).toMatch(/20/);
  });

  it('prints an instant in the root timezone', () => {
    const root = makeRoot({ __locale: 'en', __timezone: 'Asia/Seoul' });
    expect(render('{{format_date d}}', root, { d: '2026-10-18T22:30:00.000Z' })).toBe('October 19, 2026');
    expect(render('{{format_date d}}', makeRoot({ __locale: 'en' }), { d: '2026-10-18T22:30:00.000Z' })).toBe('October 18, 2026');
  });

  it('prints a date-only label as that day in every root timezone', () => {
    for (const tz of ['America/Los_Angeles', 'UTC', 'Asia/Seoul']) {
      expect(render('{{format_date d}}', makeRoot({ __locale: 'en', __timezone: tz }), { d: '2026-05-20' }), tz).toBe('May 20, 2026');
    }
  });

  it('falls back to UTC when the root timezone is not one Intl knows', () => {
    expect(render('{{format_date d}}', makeRoot({ __locale: 'en', __timezone: 'Mars/Olympus' }), { d: '2026-10-18T22:30:00.000Z' })).toBe('October 18, 2026');
  });

  it('render_date follows the root timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T22:30:00.000Z'));
    try {
      expect(render('{{render_date}}', makeRoot({ __locale: 'en', __timezone: 'Asia/Seoul' }))).toBe('October 19, 2026');
      expect(render('{{render_date}}', makeRoot({ __locale: 'en' }))).toBe('October 18, 2026');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns raw input when unparseable', () => {
    expect(render('{{format_date d}}', makeRoot(), { d: 'not-a-date' })).toBe('not-a-date');
  });

  it('returns empty for empty input', () => {
    expect(render('{{format_date d}}', makeRoot(), { d: '' })).toBe('');
  });
});
