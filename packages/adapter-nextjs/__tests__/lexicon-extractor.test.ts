import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  discoverI18nFiles,
  extractLexiconCandidates,
  collectI18nSampleValues,
  type DiscoveredI18nFile,
} from '../src/lexicon-extractor.js';

async function tmpProject(files: Record<string, string | object>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-lex-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(abs, text, 'utf-8');
  }
  return root;
}

describe('discoverI18nFiles', () => {
  it('returns an empty list when no recognized i18n directory exists', async () => {
    const root = await tmpProject({ 'package.json': '{}' });
    expect(discoverI18nFiles(root)).toEqual([]);
  });

  it('discovers next-intl pattern: messages/<locale>.json', async () => {
    const root = await tmpProject({
      'messages/en.json': { hello: 'Hello' },
      'messages/ko.json': { hello: '안녕' },
    });
    const out = discoverI18nFiles(root);
    expect(out.map((f) => `${f.locale}:${f.file}`).sort()).toEqual([
      'en:messages/en.json',
      'ko:messages/ko.json',
    ]);
  });

  it('discovers next-i18next pattern: public/locales/<locale>/<ns>.json', async () => {
    const root = await tmpProject({
      'public/locales/en/common.json': { btn: { save: 'Save' } },
      'public/locales/ko/common.json': { btn: { save: '저장' } },
      'public/locales/en/auth.json': { signin: 'Sign in' },
    });
    const out = discoverI18nFiles(root);
    const keyed = out
      .map((f) => `${f.locale}:${f.namespace ?? '_'}:${f.file}`)
      .sort();
    expect(keyed).toEqual([
      'en:auth:public/locales/en/auth.json',
      'en:common:public/locales/en/common.json',
      'ko:common:public/locales/ko/common.json',
    ]);
  });

  it('discovers custom locales/<locale>.json pattern', async () => {
    const root = await tmpProject({
      'locales/en.json': { x: 'X' },
      'locales/ko.json': { x: 'X' },
    });
    expect(discoverI18nFiles(root).map((f) => f.locale).sort()).toEqual(['en', 'ko']);
  });

  it('discovers src/locales/<locale>.json pattern', async () => {
    const root = await tmpProject({
      'src/locales/en.json': { x: 'X' },
    });
    expect(discoverI18nFiles(root).map((f) => f.locale)).toEqual(['en']);
  });

  it('ignores non-locale-shaped filenames in known dirs', async () => {
    const root = await tmpProject({
      'messages/README.md': '# notes',
      'messages/en.json': { x: 'X' },
    });
    expect(discoverI18nFiles(root).map((f) => f.locale)).toEqual(['en']);
  });
});

describe('extractLexiconCandidates', () => {
  it('returns empty when no i18n files were discovered', () => {
    expect(extractLexiconCandidates({ rootDir: '/x', files: [] })).toEqual([]);
  });

  it('flattens nested keys to dot notation, term_id is uppercased', async () => {
    const root = await tmpProject({
      'messages/en.json': {
        nav: { mypage: 'My Page', settings: 'Settings' },
        btn: { save: 'Save' },
      },
    });
    const files: DiscoveredI18nFile[] = [
      { locale: 'en', file: 'messages/en.json' },
    ];
    const out = extractLexiconCandidates({ rootDir: root, files });
    const keys = out.map((c) => c.key).sort();
    expect(keys).toEqual(['btn.save', 'nav.mypage', 'nav.settings']);
    const ids = out.map((c) => c.term_id).sort();
    expect(ids).toEqual(['TERM-BTN-SAVE', 'TERM-NAV-MYPAGE', 'TERM-NAV-SETTINGS']);
  });

  it('merges the same key across multiple locales into one term', async () => {
    const root = await tmpProject({
      'messages/en.json': { hello: 'Hello' },
      'messages/ko.json': { hello: '안녕' },
    });
    const files: DiscoveredI18nFile[] = [
      { locale: 'en', file: 'messages/en.json' },
      { locale: 'ko', file: 'messages/ko.json' },
    ];
    const out = extractLexiconCandidates({ rootDir: root, files });
    expect(out).toHaveLength(1);
    const t = out[0]!;
    expect(t.key).toBe('hello');
    expect(t.supported_locales.sort()).toEqual(['en', 'ko']);
    expect(t.files.sort()).toEqual(['messages/en.json', 'messages/ko.json']);
    expect(t.sample_locales).toEqual({ en: 'Hello', ko: '안녕' });
  });

  it('skips non-string values (arrays, objects-as-values, numbers)', async () => {
    const root = await tmpProject({
      'messages/en.json': {
        ok: 'OK',
        list: ['a', 'b'], // array — skipped
        count: 5, // number — skipped
        nested_obj: { only_when_leaf_string: 'v' },
      },
    });
    const out = extractLexiconCandidates({
      rootDir: root,
      files: [{ locale: 'en', file: 'messages/en.json' }],
    });
    const keys = out.map((c) => c.key).sort();
    expect(keys).toEqual(['nested_obj.only_when_leaf_string', 'ok']);
  });

  it('skips files that fail to parse (records nothing for them)', async () => {
    const root = await tmpProject({
      'messages/en.json': '{ not valid json',
    });
    const out = extractLexiconCandidates({
      rootDir: root,
      files: [{ locale: 'en', file: 'messages/en.json' }],
    });
    expect(out).toEqual([]);
  });

  it('produces RoleId-style term_ids that satisfy the TermId regex', async () => {
    const root = await tmpProject({
      'messages/en.json': {
        'with-dash': 'X',
        'with_underscore': 'Y',
        'with.dots.deep': 'Z',
      },
    });
    const out = extractLexiconCandidates({
      rootDir: root,
      files: [{ locale: 'en', file: 'messages/en.json' }],
    });
    for (const t of out) {
      expect(t.term_id).toMatch(/^TERM-[A-Z][A-Z0-9_-]*$/);
    }
  });

  it('integration: discoverI18nFiles output works directly as extractLexiconCandidates input', async () => {
    const root = await tmpProject({
      'messages/en.json': { btn: { save: 'Save' }, btn2: { cancel: 'Cancel' } },
      'messages/ko.json': { btn: { save: '저장' }, btn2: { cancel: '취소' } },
    });
    const files = discoverI18nFiles(root);
    const terms = extractLexiconCandidates({ rootDir: root, files });
    expect(terms.map((t) => t.key).sort()).toEqual(['btn.save', 'btn2.cancel']);
    for (const t of terms) {
      expect(t.supported_locales.sort()).toEqual(['en', 'ko']);
    }
  });
});

describe('collectI18nSampleValues', () => {
  it('collects unique trimmed values across locales, capped', async () => {
    const root = await tmpProject({
      'messages/ko.json': { nav: { home: '홈' }, milestone: { title: '마일스톤', desc: '마일스톤' } },
      'messages/en.json': { nav: { home: 'Home' }, milestone: { title: 'Milestone', desc: '  ' } },
    });
    const files = discoverI18nFiles(root);
    const values = collectI18nSampleValues({ rootDir: root, files });
    expect(values).toContain('홈');
    expect(values).toContain('마일스톤');
    expect(values.filter((v) => v === '마일스톤')).toHaveLength(1); // dedupe
    expect(values).not.toContain('  '); // blank skipped
    const capped = collectI18nSampleValues({ rootDir: root, files, cap: 2 });
    expect(capped).toHaveLength(2);
  });
});
